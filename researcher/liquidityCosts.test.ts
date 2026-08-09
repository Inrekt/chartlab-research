import { describe, expect, test } from "vitest";
import { DEFAULT_SLIPPAGE_RATE } from "../src/core/committee/costModel.ts";
import type { Candle, TradeResult } from "../src/core/types/index.ts";
import {
  buildSlippageTable,
  monthKey,
  monthlyNotional,
  slippageForNotional,
} from "./liquidityCosts.ts";

const bar = (iso: string, close: number, volume: number): Candle => ({
  time: Date.parse(iso) / 1000,
  open: close,
  high: close,
  low: close,
  close,
  volume,
});

describe("проскальзывание по ликвидности", () => {
  test("ПОЛ на текущей ставке: ликвидный символ не становится дешевле", () => {
    // Принципиально. Модель даёт для BTC 1.2 б.п., но удешевить его значило бы
    // ОСЛАБИТЬ проверку для ликвидных символов — это запрещено. Плюс 5 б.п.
    // покрывают не только импакт, но и разброс комиссий с задержкой, а
    // реальных филлов мы не измеряли ни разу.
    const btc = slippageForNotional(88.4e6, 1);
    expect(btc).toBe(DEFAULT_SLIPPAGE_RATE);
  });

  test("неликвидный символ дороже, и тем сильнее, чем тоньше рынок", () => {
    const median = slippageForNotional(446e3, 1);
    const thin = slippageForNotional(72e3, 1);
    const thinnest = slippageForNotional(27e3, 1);
    expect(median).toBeGreaterThan(DEFAULT_SLIPPAGE_RATE);
    expect(thin).toBeGreaterThan(median);
    expect(thinnest).toBeGreaterThan(thin);
    // Порядок величины из пре-регистрации: медиана ≈17.6 б.п., p90 ≈43.8.
    expect(median * 1e4).toBeGreaterThan(12);
    expect(median * 1e4).toBeLessThan(25);
    expect(thin * 1e4).toBeGreaterThan(30);
  });

  test("оборот неизвестен → ОСТОРОЖНЕЕ, а не как обычно", () => {
    // Отсутствие данных о ликвидности — повод заложить больше издержек, а не
    // молча подставить ставку ликвидной пары.
    expect(slippageForNotional(0, 1)).toBeGreaterThan(DEFAULT_SLIPPAGE_RATE * 5);
    expect(slippageForNotional(Number.NaN, 1)).toBeGreaterThan(DEFAULT_SLIPPAGE_RATE * 5);
  });

  test("оборот считается ПОМЕСЯЧНО — иначе это заглядывание в будущее", () => {
    // Монета, ставшая ликвидной в 2024-м, в 2021-м обязана считаться
    // неликвидной: тогда она такой и была. Единая оценка на всю историю
    // переносит будущую ликвидность в прошлое.
    const candles = [
      bar("2021-03-01T00:00:00Z", 1, 1_000),
      bar("2021-03-02T00:00:00Z", 1, 1_000),
      bar("2024-03-01T00:00:00Z", 1, 10_000_000),
      bar("2024-03-02T00:00:00Z", 1, 10_000_000),
    ];
    const byMonth = monthlyNotional(candles);
    expect(byMonth.get("2021-03")).toBe(1_000);
    expect(byMonth.get("2024-03")).toBe(10_000_000);

    const table = buildSlippageTable("1h", ["X"], () => candles);
    const trade = (iso: string): TradeResult =>
      ({ symbol: "X", entryTime: Date.parse(iso) / 1000 }) as TradeResult;
    // В 2021-м дороже, в 2024-м — по полу: ликвидность выросла.
    expect(table.slippageFor(trade("2021-03-15T00:00:00Z"))).toBeGreaterThan(
      table.slippageFor(trade("2024-03-15T00:00:00Z")),
    );
  });

  test("неизвестный символ или месяц не получает ставку ликвидной пары", () => {
    const table = buildSlippageTable("1h", ["X"], () => [bar("2024-01-01T00:00:00Z", 1, 1e6)]);
    const unknown = { symbol: "НЕТ", entryTime: Date.parse("2024-01-05") / 1000 } as TradeResult;
    expect(table.slippageFor(unknown)).toBeGreaterThan(DEFAULT_SLIPPAGE_RATE * 5);
  });

  test("ключ месяца в UTC — иначе сделка у полуночи уедет в соседний месяц", () => {
    expect(monthKey(Date.parse("2024-03-31T23:59:00Z") / 1000)).toBe("2024-03");
    expect(monthKey(Date.parse("2024-04-01T00:01:00Z") / 1000)).toBe("2024-04");
  });
});

describe("согласованность модели издержек по всей воронке", () => {
  test("стресс выводится из ДЕЙСТВУЮЩЕЙ модели, а не из плоской", async () => {
    // Если база считает по ликвидности, а стресс — по плоской ставке, то на
    // неликвидной половине «удвоенные издержки» окажутся ДЕШЕВЛЕ обычных, и
    // ворота начнут пропускать именно тех, кого обязаны резать.
    const { setActiveCosts, DEFAULT_COSTS } = await import("../src/core/committee/costModel.ts");
    const { stressedCosts } = await import("./gates.ts");
    const restore = setActiveCosts({
      ...DEFAULT_COSTS,
      slippageFor: () => 0.004, // 40 б.п. — неликвидный символ
    });
    const stressed = stressedCosts();
    const trade = { symbol: "X", entryTime: 0 } as TradeResult;
    expect(stressed.slippageFor!(trade)).toBeCloseTo(0.008, 10);
    expect(stressed.slippageFor!(trade)).toBeGreaterThan(0.004);
    restore();
  });

  test("модель откатывается — иначе таблица чужой вселенной поедет дальше", async () => {
    const { setActiveCosts, activeCosts, DEFAULT_COSTS } = await import(
      "../src/core/committee/costModel.ts"
    );
    const before = activeCosts();
    const restore = setActiveCosts({ ...DEFAULT_COSTS, slippageFor: () => 0.01 });
    expect(activeCosts().slippageFor).toBeDefined();
    restore();
    expect(activeCosts()).toBe(before);
  });
});
