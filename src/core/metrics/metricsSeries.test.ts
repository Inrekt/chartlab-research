import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Candle } from "../types";
import {
  clearMetricsCache,
  crowdTopDivergence,
  crowdTopDivergencePercentile,
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

/** crowdRatio/topRatio — ratio long/short как у Binance, НЕ доля. */
function setCrowdTop(symbol: string, hours: Array<[number, number, number]>): void {
  store.set(symbol, {
    hourStarts: Float64Array.from(hours.map(([h]) => T0 + h * HOUR)),
    takerRatio: Float64Array.from(hours.map(() => 1)),
    globalLsAccounts: Float64Array.from(hours.map(([, crowd]) => crowd)),
    topLsPositions: Float64Array.from(hours.map(([, , top]) => top)),
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

describe("расхождение толпы и крупных", () => {
  it("толпа лонгует сильнее крупных → положительное расхождение", () => {
    // Толпа (аккаунты) ratio=3 → доля лонга 0.75. Крупные (позиции) ratio=1
    // → доля 0.5. Расхождение 0.25 — толпа более лонгует, чем крупные.
    setCrowdTop("XT", [[0, 3.0, 1.0], [1, 3.0, 1.0]]);
    const div = crowdTopDivergence(bars(2), "XT");
    expect(div[0]).toBeCloseTo(0.25, 9);
  });

  it("крупные лонгуют сильнее толпы → отрицательное расхождение (зеркало)", () => {
    setCrowdTop("XT", [[0, 1.0, 3.0], [1, 1.0, 3.0]]);
    const div = crowdTopDivergence(bars(2), "XT");
    expect(div[0]).toBeCloseTo(-0.25, 9);
  });

  it("равное позиционирование — расхождение ровно ноль", () => {
    setCrowdTop("XT", [[0, 2.0, 2.0], [1, 2.0, 2.0]]);
    const div = crowdTopDivergence(bars(2), "XT");
    expect(div[0]).toBeCloseTo(0, 9);
  });

  it("дырка в источнике — NaN, без интерполяции", () => {
    setCrowdTop("XT", [
      [0, 3.0, 1.0],
      [2, 3.0, 1.0], // час 1 пропущен
    ]);
    const div = crowdTopDivergence(bars(3), "XT");
    expect(div[0]).toBeCloseTo(0.25, 9);
    expect(Number.isNaN(div[1])).toBe(true);
  });

  it("символ без метрик — весь ряд NaN, не бросает", () => {
    const div = crowdTopDivergence(bars(3), "НЕТ");
    expect([...div].every(Number.isNaN)).toBe(true);
  });

  it("старая фикстура без globalLsAccounts/topLsPositions — NaN, не падение на undefined", () => {
    setRatios("XT", [[0, 1.0], [1, 1.0]]); // фикстура из блока takerImbalance, без новых полей
    const div = crowdTopDivergence(bars(2), "XT");
    expect(Number.isNaN(div[0])).toBe(true);
  });

  it("процентиль: экстремальное расхождение попадает в верхний хвост своей истории", () => {
    const hours: Array<[number, number, number]> = Array.from({ length: 48 }, (_, h) => [
      h,
      h === 47 ? 4.0 : 1.0, // толпа резко лонгует на последнем часе
      1.0,
    ]);
    setCrowdTop("XT", hours);
    const pct = crowdTopDivergencePercentile(bars(48), "XT", 1);
    expect(pct[47]).toBeCloseTo(((23 + 0.5) / 24) * 100, 6);
    expect(pct[46]).toBe(50); // плоское окно до всплеска — середина
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

describe("CVD-дивергенция", () => {
  /** Свечи с управляемыми максимумами; минимумы и объём фиксированы. */
  function candlesHL(highs: number[]): Candle[] {
    return highs.map((high, i) => ({
      time: T0 + i * HOUR,
      open: 100,
      high,
      low: 90,
      close: 100,
      volume: 10,
    }));
  }

  it("медвежья: цена ставит новый максимум, накопленная дельта — нет", () => {
    // Пивоты максимумов на барах 4 (high 110) и 10 (high 115, выше). До
    // первого пика агрессивно покупают (ratio 3), после — продают (ratio 1/3):
    // CVD на втором пике НИЖЕ, чем на первом. Классическая медвежья картина:
    // цену тянут выше, а агрессивный спрос уже кончился.
    const highs = [100, 101, 102, 103, 110, 103, 102, 101, 102, 103, 115, 103, 102, 101, 100];
    const ratios: Array<[number, number]> = highs.map((_, h) => [h, h <= 4 ? 3.0 : 1 / 3]);
    setRatios("XT", ratios);
    const candles = candlesHL(highs);
    const ctx = new EvaluationContext(candles, "XT");

    const atom = { kind: "divergence", osc: "cvd", direction: "bearish", lookback: 12 } as const;
    // бар подтверждения второго пивота = 10 + 2
    expect(ctx.evaluateAtom(atom, 12)).toBe(true);
    // на соседних барах сигнал не горит повторно
    expect(ctx.evaluateAtom(atom, 11)).toBe(false);
    expect(ctx.evaluateAtom(atom, 13)).toBe(false);
  });

  it("дивергенции нет, когда дельта подтверждает новый максимум", () => {
    // Тот же ценовой рисунок, но покупают ВСЮ дорогу — CVD на втором пике выше.
    const highs = [100, 101, 102, 103, 110, 103, 102, 101, 102, 103, 115, 103, 102, 101, 100];
    setRatios("XT", highs.map((_, h) => [h, 3.0]));
    const ctx = new EvaluationContext(candlesHL(highs), "XT");
    expect(
      ctx.evaluateAtom({ kind: "divergence", osc: "cvd", direction: "bearish", lookback: 12 }, 12),
    ).toBe(false);
  });

  it("без символа CVD-дивергенция ложна, rsi-путь не задет", () => {
    const highs = [100, 101, 102, 103, 110, 103, 102, 101, 102, 103, 115, 103, 102, 101, 100];
    setRatios("XT", highs.map((_, h) => [h, 3.0]));
    const noSymbol = new EvaluationContext(candlesHL(highs));
    expect(
      noSymbol.evaluateAtom({ kind: "divergence", osc: "cvd", direction: "bearish", lookback: 12 }, 12),
    ).toBe(false);
    // rsi-дивергенция без символа обязана работать как раньше (не бросать)
    expect(() =>
      noSymbol.evaluateAtom({ kind: "divergence", osc: "rsi", direction: "bearish", lookback: 12 }, 12),
    ).not.toThrow();
  });
});
