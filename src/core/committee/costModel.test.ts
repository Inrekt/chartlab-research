import { describe, expect, it } from "vitest";
import type { TradeFill, TradeResult } from "../types";
import {
  MAKER_FEE_RATE,
  TAKER_FEE_RATE,
  scaleCosts,
  tradeCostInR,
  type CostAssumptions,
} from "./costModel";

const costs: CostAssumptions = { feeRate: TAKER_FEE_RATE, slippageRate: 0.0005 };

function trade(exit: "target" | "stop"): TradeResult {
  const fills: TradeFill[] = [
    { side: "entry", price: 100, qty: 1, liquidity: "taker", time: 0 },
    { side: "exit", price: 110, qty: 1, liquidity: exit === "target" ? "maker" : "taker", time: 1 },
  ];
  return {
    symbol: "X", direction: "long", entryTime: 0, entryPrice: 100, exitTime: 1, exitPrice: 110,
    stopPrice: 95, targetPrice: 110, rMultiple: 0, riskBudget: 5, won: false, barsHeld: 1,
    exitReason: exit, fills,
  };
}

describe("издержки по ногам", () => {
  it("тейк-выход дешевле стопового ровно на (тейкер+проскальзывание − мейкер)·цена/риск", () => {
    const diff = tradeCostInR(trade("stop"), costs) - tradeCostInR(trade("target"), costs);
    const expected = (TAKER_FEE_RATE + 0.0005 - MAKER_FEE_RATE) * 110 / 5;
    expect(diff).toBeCloseTo(expected, 12);
    // абсолютно: вход 0.001·100/5 + мейкер 0.0002·110/5
    expect(tradeCostInR(trade("target"), costs)).toBeCloseTo((0.001 * 100 + 0.0002 * 110) / 5, 12);
  });

  it("без fills — прежняя формула; фандинг прибавляется", () => {
    const t = { ...trade("stop"), fills: undefined };
    expect(tradeCostInR(t, costs)).toBeCloseTo((2 * 0.001 * 100) / 5, 12);
    expect(tradeCostInR(t, { ...costs, fundingFor: () => 0.03 })).toBeCloseTo(0.04 + 0.03, 12);
  });

  it("scaleCosts ×2 удваивает комиссии (в т.ч. мейкер) и проскальзывание, но не фандинг", () => {
    const scaled = scaleCosts({ ...costs, fundingFor: () => 0.03 }, 2);
    expect(scaled.makerFeeRate).toBeCloseTo(0.0004, 12);
    const base = tradeCostInR(trade("target"), costs);
    expect(tradeCostInR(trade("target"), scaled)).toBeCloseTo(2 * base + 0.03, 12);
  });
});
