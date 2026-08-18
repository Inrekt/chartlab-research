import { describe, expect, test } from "vitest";
import { FX_UNIVERSE, gapRatio, mergeCandles, parseYahooChart } from "./collect-fx.ts";

const chart = (
  timestamp: number[],
  quote: Record<string, Array<number | null>>,
) => ({ chart: { result: [{ timestamp, indicators: { quote: [quote] } }] } });

describe("parseYahooChart", () => {
  test("собирает свечи и подставляет 0 вместо отсутствующего объёма (спотовый FX)", () => {
    const raw = chart([100, 3700], {
      open: [1, 2],
      high: [1.5, 2.5],
      low: [0.9, 1.9],
      close: [1.2, 2.2],
      volume: [null, 5],
    });
    expect(parseYahooChart(raw)).toEqual([
      { time: 100, open: 1, high: 1.5, low: 0.9, close: 1.2, volume: 0 },
      { time: 3700, open: 2, high: 2.5, low: 1.9, close: 2.2, volume: 5 },
    ]);
  });

  test("бар с null в OHLC ОТБРАСЫВАЕТСЯ, а не достраивается соседом", () => {
    // Выдуманная свеча на неторговом часе = выдуманная возможность входа.
    const raw = chart([100, 3700, 7300], {
      open: [1, null, 3],
      high: [1.5, null, 3.5],
      low: [0.9, null, 2.9],
      close: [1.2, null, 3.2],
      volume: [0, null, 0],
    });
    const out = parseYahooChart(raw);
    expect(out.map((c) => c.time)).toEqual([100, 7300]);
  });

  test("ответ без result — ошибка, а не пустой корпус", () => {
    // Молчаливый пустой массив выглядел бы как «рынка нет», а это отказ сети.
    expect(() => parseYahooChart({ chart: { result: null, error: "Not Found" } })).toThrow(/Yahoo/);
  });
});

describe("mergeCandles", () => {
  test("совпадающий бар берётся из СВЕЖЕЙ загрузки (старый мог быть незакрыт)", () => {
    const old = [{ time: 100, open: 1, high: 1.1, low: 1, close: 1.05, volume: 0 }];
    const fresh = [{ time: 100, open: 1, high: 1.9, low: 0.8, close: 1.7, volume: 0 }];
    expect(mergeCandles(old, fresh)[0].high).toBe(1.9);
  });

  test("результат отсортирован по времени независимо от порядка входа", () => {
    const bar = (time: number) => ({ time, open: 1, high: 1, low: 1, close: 1, volume: 0 });
    const merged = mergeCandles([bar(7300)], [bar(100), bar(3700)]);
    expect(merged.map((c) => c.time)).toEqual([100, 3700, 7300]);
  });
});

describe("gapRatio", () => {
  test("сплошной ряд — 0 дыр", () => {
    const bars = [0, 3600, 7200].map((time) => ({ time, open: 1, high: 1, low: 1, close: 1, volume: 0 }));
    expect(gapRatio(bars, 3600)).toBe(0);
  });

  test("выходной (>= сутки) дырой НЕ считается, а пропущенный час — считается", () => {
    const bar = (time: number) => ({ time, open: 1, high: 1, low: 1, close: 1, volume: 0 });
    const weekend = [bar(0), bar(3600), bar(3600 + 48 * 3600)];
    expect(gapRatio(weekend, 3600)).toBe(0);
    const missedHour = [bar(0), bar(7200)]; // два часа между барами — один пропущен
    expect(gapRatio(missedHour, 3600)).toBeCloseTo(0.5, 5);
  });
});

describe("FX_UNIVERSE", () => {
  test("имена корпуса не содержат суффиксов Yahoo и уникальны по тикеру", () => {
    const names = Object.keys(FX_UNIVERSE);
    expect(names.every((n) => !n.includes("="))).toBe(true);
    expect(new Set(Object.values(FX_UNIVERSE)).size).toBe(names.length);
  });
});
