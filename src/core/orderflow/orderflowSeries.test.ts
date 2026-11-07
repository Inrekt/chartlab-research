import { afterEach, describe, expect, it } from "vitest";
import type { Candle, ConditionAtom } from "../types";
import { EvaluationContext } from "../strategy/evaluator";
import {
  absorptionSeries,
  cachedAbsorptionPercentile,
  clearOrderflowCache,
  equalLevelSweeps,
  setOrderflowLoader,
  type OrderflowHistory,
} from "./orderflowSeries";

const STEP = 4 * 3600; // 4h
const Q = 900; // 15m
const T0 = 1_700_000_000 - (1_700_000_000 % STEP);

/** Ордерфлоу подаётся в памяти: модуль браузерный, диск ему запрещён. */
const store = new Map<string, OrderflowHistory>();
setOrderflowLoader((s) => store.get(s) ?? null);
afterEach(() => {
  store.clear();
  clearOrderflowCache();
});

function setFlow(symbol: string, rows: Array<[number, number, number]>): void {
  store.set(symbol, {
    barStarts: Float64Array.from(rows.map(([t]) => t)),
    buyUsd: Float64Array.from(rows.map(([, b]) => b)),
    sellUsd: Float64Array.from(rows.map(([, , s]) => s)),
  });
  clearOrderflowCache();
}

function candle(i: number, o: number, h: number, l: number, c: number): Candle {
  return { time: T0 + i * STEP, open: o, high: h, low: l, close: c, volume: 1 } as Candle;
}

/**
 * Цикл с периодом 12 баров: вершины (и впадины) повторяются почти на одном
 * уровне — равные экстремумы; на каждом пятом цикле — прокол фитилём с
 * закрытием обратно (свип). Плюс медленный дрейф, чтобы уровни менялись.
 */
function walk(n: number, noise = 0): Candle[] {
  // Детерминированный шум (LCG): пивоты появляются и в «неудобных» местах,
  // где заглядывание вперёд поменяло бы ответ.
  const eps = Array.from({ length: n + 1 }, (_, k) => (((k * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5) * noise);
  const price = (i: number) =>
    100 + 5 * Math.sin((2 * Math.PI * i) / 12) + 0.02 * Math.sin(i * 0.05) * i * 0.1 + (eps[i + 1] ?? 0);
  return Array.from({ length: n }, (_, i) => {
    const o = price(i - 1);
    const c = price(i);
    const cycle = Math.floor(i / 12);
    const phase = i % 12;
    const wick = cycle % 5 === 4 && (phase === 3 || phase === 9) ? 1.2 : 0.3;
    return candle(i, o, Math.max(c + wick, o + wick / 2), Math.min(c - wick, o - wick / 2), c);
  });
}

function flowFor(candles: readonly Candle[]): Array<[number, number, number]> {
  const rows: Array<[number, number, number]> = [];
  for (let i = 0; i < candles.length; i++) {
    for (let p = 0; p < STEP / Q; p++) {
      const k = i * 16 + p;
      rows.push([candles[i].time + p * Q, 1000 + 400 * Math.sin(k * 0.37), 1000 + 400 * Math.cos(k * 0.29)]);
    }
  }
  return rows;
}

const LEVEL = { pivotBars: 3, lookback: 50, tolAtr: 0.25 } as const;

describe("equalLevels: свип равных максимумов", () => {
  it("находит вынос двух равных пивотов и отдаёт младший пивот", () => {
    // 20 баров разгона ATR, затем две вершины 110.0 и 110.1, вынос на баре 40.
    const cs: Candle[] = [];
    for (let i = 0; i < 40; i++) {
      const top = i === 25 ? 110 : i === 33 ? 110.1 : 105 + (i % 2);
      cs.push(candle(i, 104, top, 102, 104.5));
    }
    cs.push(candle(40, 105, 111, 104, 109)); // хай выше 110.1, закрытие ниже
    const sw = equalLevelSweeps(cs, { side: "highs", ...LEVEL });
    expect(sw[40]).toBe(33);
    expect(Array.from(sw.slice(0, 40)).every((v) => v === -1)).toBe(true);
  });

  it("закрытие выше уровня — не свип, а пробой", () => {
    const cs: Candle[] = [];
    for (let i = 0; i < 40; i++) {
      const top = i === 25 ? 110 : i === 33 ? 110.1 : 105 + (i % 2);
      cs.push(candle(i, 104, top, 102, 104.5));
    }
    cs.push(candle(40, 105, 111, 104, 110.5));
    expect(equalLevelSweeps(cs, { side: "highs", ...LEVEL })[40]).toBe(-1);
  });

  it("нет look-ahead: значение бара не зависит от баров после него", () => {
    const cs = walk(300, 2.5);
    for (const side of ["highs", "lows"] as const) {
      const full = equalLevelSweeps(cs, { side, ...LEVEL });
      expect(full.some((v) => v >= 0)).toBe(true); // тест не пустой
      for (let i = 0; i < cs.length; i++) {
        expect(equalLevelSweeps(cs.slice(0, i + 1), { side, ...LEVEL })[i]).toBe(full[i]);
      }
    }
  });
});

describe("ордерфлоу: поглощение и дивергенция CVD", () => {
  it("бар без полного набора 15m-баров — NaN, а не ноль", () => {
    const cs = walk(5);
    setFlow("X", flowFor(cs).filter((_, k) => k !== 20)); // дыра во втором баре
    const a = absorptionSeries(cs, "X");
    expect(Number.isNaN(a[1])).toBe(true);
    expect(Number.isFinite(a[0])).toBe(true);
  });

  it("поглощение считается по сумме 15m и OHLC свечи", () => {
    const cs = [candle(0, 100, 104, 99, 101), candle(1, 101, 102, 100, 101)];
    const rows: Array<[number, number, number]> = [];
    for (let i = 0; i < 2; i++) for (let p = 0; p < 16; p++) rows.push([cs[i].time + p * Q, 30, 10]);
    setFlow("X", rows);
    const a = absorptionSeries(cs, "X");
    expect(a[0]).toBeCloseTo((320 / 640) * (1 - 1 / 5), 12);
  });

  it("нет look-ahead: атомы на баре не зависят от сделок и свечей после его закрытия", () => {
    const cs = walk(400, 2.5);
    const rows = flowFor(cs);
    setFlow("X", rows);
    const atoms: ConditionAtom[] = [
      { kind: "equalLevels", side: "highs", ...LEVEL },
      { kind: "orderflowDelta", side: "highs", ...LEVEL },
      { kind: "orderflowDelta", side: "lows", ...LEVEL },
      { kind: "absorption", direction: "buy", percentile: 80, windowDays: 30 },
      { kind: "absorption", direction: "sell", percentile: 80, windowDays: 30 },
    ];
    const ctx = new EvaluationContext(cs, "X");
    const full = atoms.map((a) => cs.map((_, i) => ctx.evaluateAtom(a, i)));
    for (const f of full) expect(f.some(Boolean)).toBe(true); // каждый атом хоть раз сработал
    const fullAbs = cachedAbsorptionPercentile(cs, "X", 30);
    const absorb = Float64Array.from(fullAbs.absorb);
    const rank = Float64Array.from(fullAbs.rank);
    // С бара 1: по одной свече шаг ТФ не определить, ряды там пусты по построению.
    for (let i = 1; i < cs.length; i++) {
      const close = cs[i].time + STEP;
      setFlow("X", rows.filter(([t]) => t < close));
      const head = cs.slice(0, i + 1);
      const cut = new EvaluationContext(head, "X");
      atoms.forEach((a, k) => expect(cut.evaluateAtom(a, i)).toBe(full[k][i]));
      const c = cachedAbsorptionPercentile(head, "X", 30);
      expect(Object.is(c.absorb[i], absorb[i])).toBe(true);
      expect(Object.is(c.rank[i], rank[i])).toBe(true);
    }
  });

  it("без символа или без данных — ложь", () => {
    const cs = walk(200);
    const atom: ConditionAtom = { kind: "absorption", direction: "buy", percentile: 0, windowDays: 5 };
    expect(cs.some((_, i) => new EvaluationContext(cs).evaluateAtom(atom, i))).toBe(false);
    expect(cs.some((_, i) => new EvaluationContext(cs, "NONE").evaluateAtom(atom, i))).toBe(false);
  });
});
