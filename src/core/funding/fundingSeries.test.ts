import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Candle, StrategyConfig } from "../types";
import {
  clearFundingCache,
  fundingPercentile,
  setFundingLoader,
  type FundingHistory,
} from "./fundingSeries";
import { EvaluationContext } from "../strategy/evaluator";

/**
 * Ставки подаются В ПАМЯТИ, а не через файлы. Это тест браузерного модуля, и он
 * не должен уметь читать диск — ровно поэтому чтение CSV и живёт отдельно, в
 * researcher/fundingCsv.ts.
 */
const store = new Map<string, FundingHistory>();

const HOUR = 3600;
const EIGHT_HOURS = 8 * HOUR;


function writeFunding(symbol: string, rows: Array<[number, number]>): void {
  store.set(symbol, {
    times: Float64Array.from(rows.map(([sec]) => sec * 1000)),
    rates: Float64Array.from(rows.map(([, rate]) => rate)),
  });
  clearFundingCache();
}

function bars(count: number, startSec: number, stepSec = HOUR): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    time: startSec + i * stepSec,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 10,
  }));
}

beforeEach(() => {
  store.clear();
  setFundingLoader((symbol) => store.get(symbol) ?? null);
});

afterEach(() => {
  store.clear();
  clearFundingCache();
});

describe("ряд процентиля фандинга", () => {
  const T0 = 1_700_000_000 - (1_700_000_000 % EIGHT_HOURS); // ровно на границе выплаты

  it("выплата, помеченная временем бара, этому бару ЕЩЁ НЕ известна", () => {
    // Главный тест файла. Ставка со штампом T публикуется в момент T, поэтому
    // бар, закрывающийся ровно в T, обязан видеть предыдущую выплату. Иначе в
    // бэктест просачивается знание будущего.
    // Все ставки одинаковы, кроме выплаты №5 — она уникально НИЗКАЯ. Тогда её
    // появление в окне резко меняет процентиль, и тест различает «увидели» и
    // «не увидели», а не совпадает случайно.
    const rates: Array<[number, number]> = [];
    for (let i = 0; i < 10; i++) rates.push([T0 + i * EIGHT_HOURS, i === 5 ? 0 : 1]);
    writeFunding("XT", rates);

    const at = T0 + 5 * EIGHT_HOURS; // момент этой выплаты
    const candles = bars(3, at - HOUR, HOUR); // бары: at-1ч, at, at+1ч
    const pct = fundingPercentile(candles, "XT", 3);

    // до выплаты в окне только одинаковые ставки
    expect(pct[0]).toBe(100);
    // бар РОВНО в момент выплаты её ещё не видит — иначе это знание будущего
    expect(pct[1]).toBe(pct[0]);
    // и только следующий бар видит: низкая ставка становится минимумом окна
    expect(pct[2]).toBeCloseTo(100 / 3, 6);
    expect(pct[2]).toBeLessThan(pct[1]);
  });

  it("процентиль считает долю выплат окна, не превосходящих текущую", () => {
    // Ставки 0,1,2,3,4 — последняя максимальна, значит 5 из 5 не превосходят её.
    const rates: Array<[number, number]> = [0, 1, 2, 3, 4].map((v, i) => [
      T0 + i * EIGHT_HOURS,
      v,
    ]);
    writeFunding("XT", rates);
    const candles = bars(1, T0 + 4 * EIGHT_HOURS + HOUR);
    expect(fundingPercentile(candles, "XT", 5)[0]).toBe(100);

    // А если последняя ставка минимальна — только она сама, 1 из 5 → 20.
    clearFundingCache();
    writeFunding("XT2", [4, 3, 2, 1, 0].map((v, i) => [T0 + i * EIGHT_HOURS, v]));
    expect(fundingPercentile(candles, "XT2", 5)[0]).toBe(20);
  });

  it("пока окно не заполнено — NaN, а не ноль", () => {
    // Нехватка истории не должна молча превращаться в «низкий фандинг».
    writeFunding("XT", [0, 1].map((v, i) => [T0 + i * EIGHT_HOURS, v]));
    const candles = bars(1, T0 + 2 * EIGHT_HOURS);
    expect(Number.isNaN(fundingPercentile(candles, "XT", 5)[0])).toBe(true);
  });

  it("у символа без истории ряд пустой, а не нулевой", () => {
    const candles = bars(3, T0);
    const pct = fundingPercentile(candles, "НЕТ-ТАКОГО", 3);
    expect([...pct].every(Number.isNaN)).toBe(true);
  });
});

describe("атом фандинга", () => {
  const T0 = 1_700_000_000 - (1_700_000_000 % EIGHT_HOURS);

  const highRates = (): Array<[number, number]> =>
    Array.from({ length: 10 }, (_, i) => [T0 + i * EIGHT_HOURS, i] as [number, number]);

  it("срабатывает на верхнем хвосте и не срабатывает на нижнем", () => {
    writeFunding("XT", highRates());
    const candles = bars(1, T0 + 9 * EIGHT_HOURS + HOUR);
    const ctx = new EvaluationContext(candles, "XT");

    // последняя ставка максимальна в окне → верхний хвост
    expect(ctx.evaluateAtom({ kind: "funding", direction: "above", percentile: 90, windowDays: 1 }, 0)).toBe(true);
    expect(ctx.evaluateAtom({ kind: "funding", direction: "below", percentile: 90, windowDays: 1 }, 0)).toBe(false);
  });

  it("без символа в контексте условие ложно, а не истинно", () => {
    // Неизвестность не должна становиться сигналом: контекст без символа
    // раньше просто не мог знать про фандинг.
    writeFunding("XT", highRates());
    const candles = bars(1, T0 + 9 * EIGHT_HOURS + HOUR);
    const ctx = new EvaluationContext(candles);
    expect(ctx.evaluateAtom({ kind: "funding", direction: "above", percentile: 90, windowDays: 1 }, 0)).toBe(false);
  });

  it("движок доносит символ до атома — иначе семейство молча не торгует", () => {
    // Регрессия на конкретную поломку: EvaluationContext создавался без
    // символа, и любое условие по фандингу возвращало false на всём корпусе.
    writeFunding("XT", highRates());
    const candles = bars(1, T0 + 9 * EIGHT_HOURS + HOUR);
    const withSymbol = new EvaluationContext(candles, "XT");
    const config: StrategyConfig["entry"] = {
      operator: "AND",
      conditions: [{ kind: "funding", direction: "above", percentile: 80, windowDays: 1 }],
    };
    expect(withSymbol.evaluateGroup(config, 0)).toBe(true);
  });
});
