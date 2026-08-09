import { describe, expect, it } from "vitest";
import type { Candle, StrategyConfig } from "../types";
import { simulateExits } from "./engine";

/*
 * Частичный тейк и перенос стопа в безубыток — золотые тесты.
 *
 * Зачем именно такие случаи. Замер на семействе свипа показал, что 78%
 * убыточных сделок сначала уходили в плюс на 0.3R: перенос стопа превращает
 * бо́льшую часть полных убытков в нули и меняет саму ФОРМУ распределения, а не
 * среднее на пару процентов. Значит проверять надо не «работает ли код», а те
 * три места, где легко приукрасить результат: спорный порядок тиков внутри
 * бара, гэп через переставленный стоп и складывание двух частей P&L.
 */

const HOUR = 3600;
const SIGNAL = 5;

function bars(spec: Array<[number, number, number, number]>, startSec = 1_700_000_000): Candle[] {
  return spec.map(([open, high, low, close], i) => ({
    time: startSec + i * HOUR,
    open,
    high,
    low,
    close,
    volume: 100,
  }));
}

const flat = (n: number): Array<[number, number, number, number]> =>
  Array.from({ length: n }, () => [100, 101, 99, 100] as [number, number, number, number]);

/** Стоп 5%, цель 3R: вход по 100 → стоп 95, цель 115, риск = 5. */
const cfg = (
  direction: "long" | "short",
  scaleOut?: StrategyConfig["exit"]["scaleOut"],
): StrategyConfig => ({
  id: "t",
  ownerId: "test",
  name: "t",
  timeframe: "1h",
  direction,
  symbols: [],
  entry: { operator: "AND", conditions: [] },
  exit: {
    stopLoss: { type: "percent", value: 5 },
    takeProfit: { type: "rr", value: 3 },
    maxBarsInTrade: 50,
    ...(scaleOut ? { scaleOut } : {}),
  },
});

const run = (
  spec: Array<[number, number, number, number]>,
  direction: "long" | "short",
  scaleOut?: StrategyConfig["exit"]["scaleOut"],
) => simulateExits(bars(spec), cfg(direction, scaleOut), "X", [SIGNAL])[0];

/** Половина на +0.5R, стоп в безубыток. Для лонга: тейк на 102.5, БУ на 100. */
const HALF_AT_HALF_R = { atR: 0.5, fraction: 0.5, toBreakeven: true } as const;

describe("частичный тейк + стоп в безубыток", () => {
  it("без настройки поведение прежнее — бит в бит", () => {
    const spec = flat(12);
    spec[8] = [100, 101, 94, 95]; // стоп 95
    expect(run(spec, "long")!.rMultiple).toBeCloseTo(-1, 6);
  });

  it("часть снята, остаток вынесен по БУ ⇒ итог = только реализованная часть", () => {
    const spec = flat(12);
    spec[7] = [100, 103, 99, 102]; // достали 102.5 → снята половина, стоп → 100
    spec[8] = [100, 100, 96, 97]; // ушли ниже 100 → остаток по безубытку
    // 0.5·0.5R + 0.5·0R = 0.25R
    expect(run(spec, "long", HALF_AT_HALF_R)!.rMultiple).toBeCloseTo(0.25, 6);
  });

  it("СПОРНЫЙ БАР: задет и стоп, и уровень тейка ⇒ засчитывается СТОП", () => {
    // Порядок тиков внутри бара неизвестен, и сомнение трактуется против
    // стратегии — иначе прибыль росла бы из предположения о порядке тиков.
    const spec = flat(12);
    spec[7] = [100, 103, 94, 96]; // и 102.5 (тейк), и 95 (стоп) на одном баре
    expect(run(spec, "long", HALF_AT_HALF_R)!.rMultiple).toBeCloseTo(-1, 6);
  });

  it("гэп через переставленный в БУ стоп исполняется по ОТКРЫТИЮ", () => {
    // Та же честность, что и для обычного стопа: если бар открылся ниже
    // безубытка, цены безубытка в этом баре не существовало.
    const spec = flat(12);
    spec[7] = [100, 103, 99, 102]; // снята половина, стоп → 100
    spec[8] = [97, 98, 96, 97]; // гэп: открытие 97 ниже БУ 100
    // 0.5·0.5R + 0.5·(97−100)/5 = 0.25 − 0.30 = −0.05R
    expect(run(spec, "long", HALF_AT_HALF_R)!.rMultiple).toBeCloseTo(-0.05, 6);
  });

  it("без переноса в БУ остаток идёт до прежнего стопа", () => {
    const spec = flat(12);
    spec[7] = [100, 103, 99, 102];
    spec[8] = [100, 101, 94, 95]; // прежний стоп 95
    // 0.5·0.5R + 0.5·(−1R) = −0.25R
    expect(
      run(spec, "long", { atR: 0.5, fraction: 0.5, toBreakeven: false })!.rMultiple,
    ).toBeCloseTo(-0.25, 6);
  });

  it("шорт зеркален", () => {
    const spec = flat(12);
    spec[7] = [100, 101, 97, 98]; // тейк шорта на 97.5 достигнут, стоп → 100
    spec[8] = [100, 104, 100, 103]; // вернулись выше 100 → остаток по БУ
    expect(run(spec, "short", HALF_AT_HALF_R)!.rMultiple).toBeCloseTo(0.25, 6);
  });

  it("часть снята, остаток дошёл до цели ⇒ складываются обе части", () => {
    const spec = flat(12);
    spec[7] = [100, 103, 99, 102]; // снята половина на 102.5
    spec[8] = [102, 116, 101, 115]; // цель 115 (3R)
    // 0.5·0.5R + 0.5·3R = 0.25 + 1.5 = 1.75R
    expect(run(spec, "long", HALF_AT_HALF_R)!.rMultiple).toBeCloseTo(1.75, 6);
  });

  it("кривая настройка падает громко, а не мерит месяцами не то", () => {
    for (const bad of [0, 1, 1.5, -0.5]) {
      expect(() => run(flat(12), "long", { atR: 0.5, fraction: bad, toBreakeven: true })).toThrow(
        /fraction/,
      );
    }
    expect(() => run(flat(12), "long", { atR: 0, fraction: 0.5, toBreakeven: true })).toThrow(/atR/);
  });
});
