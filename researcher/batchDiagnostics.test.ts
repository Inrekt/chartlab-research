import { describe, expect, test } from "vitest";
import type { TradeResult } from "../src/core/types/index.ts";
import {
  buildDailyMatrix,
  cscvPbo,
  whiteRealityCheck,
  type DailyMatrix,
} from "./batchDiagnostics.ts";

const DAY = 86_400;
const T0 = 1_600_000_000;

const trade = (dayIdx: number, rMultiple: number): TradeResult => ({
  symbol: "TESTUSDT",
  direction: "long",
  entryTime: T0 + dayIdx * DAY,
  entryPrice: 100,
  exitTime: T0 + dayIdx * DAY + 3600,
  exitPrice: 100 + 2 * rMultiple,
  stopPrice: 98,
  targetPrice: 102,
  rMultiple,
  riskBudget: 2,
  won: rMultiple > 0,
  barsHeld: 3,
});

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Настоящий iid-шум с нулевым средним (детерминированный по сиду).
 * НЕ sin по решётке: периодическая «псевдослучайность» антиперсистентна —
 * чемпион одной половины времени системно провален в другой, и PBO честно
 * показывал на ней 0.94. Для iid-шума ожидание PBO ≈ 0.5.
 */
function noiseMatrix(
  n: number,
  days: number,
  seed: number,
  edge?: { candidate: number; shift: number },
): DailyMatrix {
  return {
    candidates: Array.from({ length: n }, (_, i) => `cand-${i}`),
    days,
    startDay: 0,
    returns: Array.from({ length: n }, (_, i) => {
      const rand = mulberry32(seed + i * 9973);
      const bonus = edge && edge.candidate === i ? edge.shift : 0;
      return Float64Array.from({ length: days }, () => rand() - 0.5 + bonus);
    }),
  };
}

describe("buildDailyMatrix", () => {
  test("groups net R by UTC day and spans the full range", () => {
    const byId = new Map<string, TradeResult[]>();
    for (let i = 0; i < 6; i++) {
      byId.set(`c${i}`, [trade(0, 1), trade(45, -1), trade(90, 0.5)]);
    }
    const matrix = buildDailyMatrix(byId)!;
    expect(matrix.days).toBe(91);
    expect(matrix.candidates).toHaveLength(6);
    // издержки: риск 2 от цены 100 → 0.1R на сделку
    expect(matrix.returns[0][0]).toBeCloseTo(0.9, 6);
    expect(matrix.returns[0][45]).toBeCloseTo(-1.1, 6);
  });

  test("refuses tiny batches and short histories", () => {
    const few = new Map([["a", [trade(0, 1), trade(80, 1)]]]);
    expect(buildDailyMatrix(few)).toBeNull();
    const short = new Map(
      Array.from({ length: 6 }, (_, i) => [`c${i}`, [trade(0, 1), trade(10, 1)]] as const),
    );
    expect(buildDailyMatrix(short)).toBeNull();
  });
});

describe("white reality check", () => {
  test("pure noise batch: the night found nothing, p is large", () => {
    const rc = whiteRealityCheck(noiseMatrix(30, 240, 1), 300, 11);
    expect(rc.pValue).toBeGreaterThan(0.1);
  });

  test("one real edge in the batch drives p small", () => {
    const rc = whiteRealityCheck(noiseMatrix(30, 240, 1, { candidate: 17, shift: 0.2 }), 300, 11);
    expect(rc.pValue).toBeLessThan(0.05);
  });

  test("deterministic for a fixed seed", () => {
    const matrix = noiseMatrix(10, 120, 3);
    expect(whiteRealityCheck(matrix, 200, 5)).toEqual(whiteRealityCheck(matrix, 200, 5));
  });
});

describe("cscv pbo", () => {
  test("iid-noise selection is overfit about half the time", () => {
    const result = cscvPbo(noiseMatrix(30, 240, 1))!;
    expect(result.combinations).toBe(924);
    expect(result.pbo).toBeGreaterThan(0.3);
    expect(result.pbo).toBeLessThan(0.7);
  });

  test("a genuinely consistent candidate keeps PBO low", () => {
    expect(cscvPbo(noiseMatrix(30, 240, 1, { candidate: 3, shift: 0.25 }))!.pbo).toBeLessThan(0.25);
  });

  test("refuses blocks shorter than 3 days", () => {
    expect(cscvPbo(noiseMatrix(6, 30, 2))).toBeNull();
  });
});
