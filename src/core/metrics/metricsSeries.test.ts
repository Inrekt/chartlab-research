import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Candle } from "../types";
import {
  clearMetricsCache,
  setMetricsLoader,
  takerImbalance,
  takerImbalancePercentile,
  type MetricsHistory,
} from "./metricsSeries";
import { EvaluationContext } from "../strategy/evaluator";

const HOUR = 3600;
const T0 = 1_700_000_000 - (1_700_000_000 % HOUR);

/** Ставки подаются в памяти: это тест браузерного модуля, диск ему запрещён. */
const store = new Map<string, MetricsHistory>();

function setRatios(symbol: string, hours: Array<[number, number]>): void {
  store.set(symbol, {
    hourStarts: Float64Array.from(hours.map(([h]) => T0 + h * HOUR)),
    takerRatio: Float64Array.from(hours.map(([, r]) => r)),
  });
  clearMetricsCache();
}

function bars(count: number, stepHours = 1, startHour = 0): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    time: T0 + (startHour + i * stepHours) * HOUR,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 10,
  }));
}

beforeEach(() => {
  store.clear();
  setMetricsLoader((symbol) => store.get(symbol) ?? null);
});

afterEach(() => {
  store.clear();
  clearMetricsCache();
});

describe("дисбаланс тейкеров", () => {
  it("нормировка симметрична: ratio 2.0 и 0.5 дают ±1/3", () => {
    setRatios("XT", [
      [0, 2.0],
      [1, 0.5],
      [2, 1.0],
    ]);
    const imb = takerImbalance(bars(3), "XT");
    expect(imb[0]).toBeCloseTo(1 / 3, 9);
    expect(imb[1]).toBeCloseTo(-1 / 3, 9);
    expect(imb[2]).toBeCloseTo(0, 9);
  });

  it("4h-бар усредняет ЧЕТЫРЕ своих часа", () => {
    // Часы 1.0, 1.0, 1.0, 3.0 → средний ratio 1.5 → imb = 0.2.
    setRatios("XT", [
      [0, 1.0],
      [1, 1.0],
      [2, 1.0],
      [3, 3.0],
      [4, 1.0],
      [5, 1.0],
      [6, 1.0],
      [7, 1.0],
    ]);
    const imb = takerImbalance(bars(2, 4), "XT");
    expect(imb[0]).toBeCloseTo(0.2, 9);
    expect(imb[1]).toBeCloseTo(0, 9);
  });

  it("пропущенный час бара — NaN, без интерполяции", () => {
    // У 4h-бара есть только 3 часа из 4: дырка не должна молча закрываться.
    setRatios("XT", [
      [0, 1.0],
      [1, 1.0],
      [3, 1.0],
      [4, 1.0],
      [5, 1.0],
      [6, 1.0],
      [7, 1.0],
    ]);
    const imb = takerImbalance(bars(2, 4), "XT");
    expect(Number.isNaN(imb[0])).toBe(true);
    expect(Number.isNaN(imb[1])).toBe(false);
  });

  it("символ без метрик — весь ряд NaN", () => {
    const imb = takerImbalance(bars(5), "НЕТ");
    expect([...imb].every(Number.isNaN)).toBe(true);
  });
});

describe("процентиль дисбаланса", () => {
  it("экстремальный бар попадает в верхний хвост своей истории", () => {
    // 47 спокойных часов и один с перекосом в покупки.
    const hours: Array<[number, number]> = Array.from({ length: 48 }, (_, h) => [
      h,
      h === 47 ? 3.0 : 1.0,
    ]);
    setRatios("XT", hours);
    // окно 1 день = 24 бара на 1h
    const pct = takerImbalancePercentile(bars(48), "XT", 1);
    // средний ранг: 23 ниже + половина самого себя из окна в 24 бара
    expect(pct[47]).toBeCloseTo(((23 + 0.5) / 24) * 100, 6);
    // ПЛОСКОЕ окно до всплеска — ровно середина, а не «верхние 10%»
    expect(pct[46]).toBe(50);
  });

  it("пока окно не накопилось — NaN, а не ноль", () => {
    setRatios("XT", [
      [0, 1.0],
      [1, 2.0],
    ]);
    const pct = takerImbalancePercentile(bars(2), "XT", 1);
    expect(Number.isNaN(pct[0])).toBe(true);
    expect(Number.isNaN(pct[1])).toBe(true);
  });
});

describe("атом takerFlow", () => {
  const spikeAtEnd = (): void => {
    const hours: Array<[number, number]> = Array.from({ length: 48 }, (_, h) => [
      h,
      h === 47 ? 3.0 : 1.0,
    ]);
    setRatios("XT", hours);
  };

  it("ловит покупательский экстремум и не путает стороны", () => {
    spikeAtEnd();
    const ctx = new EvaluationContext(bars(48), "XT");
    expect(
      ctx.evaluateAtom({ kind: "takerFlow", direction: "buy", percentile: 97, windowDays: 1 }, 47),
    ).toBe(true);
    expect(
      ctx.evaluateAtom({ kind: "takerFlow", direction: "sell", percentile: 97, windowDays: 1 }, 47),
    ).toBe(false);
  });

  it("без символа в контексте — ложь, а не сигнал", () => {
    spikeAtEnd();
    const ctx = new EvaluationContext(bars(48));
    expect(
      ctx.evaluateAtom({ kind: "takerFlow", direction: "buy", percentile: 90, windowDays: 1 }, 47),
    ).toBe(false);
  });
});
