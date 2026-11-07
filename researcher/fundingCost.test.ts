import { describe, expect, it } from "vitest";
import type { TradeResult } from "../src/core/types";
import { MISSING_FUNDING_RATE, buildFundingCost } from "./fundingCost";

const H = 3600;
const P0 = 8 * H * 1000 * 100; // выплата, кратная 8 ч от эпохи, мс
const payoutMs = (k: number) => P0 + k * 8 * H * 1000;

function trade(direction: "long" | "short", extra: Partial<TradeResult> = {}): TradeResult {
  return {
    symbol: "X", direction, entryTime: payoutMs(0) / 1000 - 1 * H, entryPrice: 100,
    exitTime: payoutMs(2) / 1000 + 1 * H, exitPrice: 100, stopPrice: 98, targetPrice: 104,
    rMultiple: 0, riskBudget: 2, won: false, barsHeld: 20, ...extra,
  };
}

const history = {
  times: Float64Array.of(payoutMs(0), payoutMs(1), payoutMs(2)),
  rates: Float64Array.of(0.0001, -0.0002, 0.0003),
};
const prices = [100, 101, 102];
const priceAt = (_s: string, tSec: number) => prices[Math.round((tSec * 1000 - payoutMs(0)) / (8 * H * 1000))];

// Руками: (0.0001·100 − 0.0002·101 + 0.0003·102)/2 = (0.01 − 0.0202 + 0.0306)/2 = 0.0102
const HAND = 0.0102;

describe("фандинг в R", () => {
  it("лонг: три выплаты, посчитано руками = 0.0102R", () => {
    const cost = buildFundingCost(() => history, priceAt)(trade("long"));
    expect(cost).toBeCloseTo(HAND, 12);
  });

  it("шорт зеркален: знак противоположный (получил фандинг)", () => {
    const cost = buildFundingCost(() => history, priceAt)(trade("short"));
    expect(cost).toBeCloseTo(-HAND, 12);
  });

  it("выплата ровно в момент входа не считается, ровно в момент выхода — считается", () => {
    const t = trade("long", { entryTime: payoutMs(0) / 1000, exitTime: payoutMs(2) / 1000 });
    // выплаты 1 и 2: (−0.0002·101 + 0.0003·102)/2
    expect(buildFundingCost(() => history, priceAt)(t)).toBeCloseTo((-0.0202 + 0.0306) / 2, 12);
  });

  it("без цены закрытия берётся цена входа; объём — по fills (после частичного выхода меньше)", () => {
    const t = trade("long", {
      fills: [
        { side: "entry", price: 100, qty: 1, liquidity: "taker", time: payoutMs(0) / 1000 - H },
        { side: "exit", price: 101, qty: 0.5, liquidity: "maker", time: payoutMs(1) / 1000 - H },
      ],
    });
    // выплата 0 при qty 1, выплаты 1 и 2 при qty 0.5; цена = 100
    const expected = (0.0001 * 100 * 1 + (-0.0002) * 100 * 0.5 + 0.0003 * 100 * 0.5) / 2;
    expect(buildFundingCost(() => history)(t)).toBeCloseTo(expected, 12);
  });

  it("ряда нет: 0.01% за каждую выплату расписания ПРОТИВ позиции, даже у шорта", () => {
    const expected = (MISSING_FUNDING_RATE * 100 * 3) / 2; // 3 выплаты, цена входа 100
    expect(buildFundingCost(() => undefined)(trade("long"))).toBeCloseTo(expected, 12);
    expect(buildFundingCost(() => null)(trade("short"))).toBeCloseTo(expected, 12);
  });

  it("ряд есть, но не покрывает окно сделки — запасная ставка", () => {
    const old = { times: Float64Array.of(payoutMs(-50)), rates: Float64Array.of(0.01) };
    expect(buildFundingCost(() => old)(trade("short"))).toBeCloseTo((MISSING_FUNDING_RATE * 100 * 3) / 2, 12);
  });

  it("сделка внутри одной выплаты-свободной зоны — ноль", () => {
    const t = trade("long", { entryTime: payoutMs(0) / 1000 + H, exitTime: payoutMs(0) / 1000 + 2 * H });
    expect(buildFundingCost(() => undefined)(t)).toBe(0);
  });
});
