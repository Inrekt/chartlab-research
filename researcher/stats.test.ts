import { describe, expect, test } from "vitest";
import {
  benjaminiHochberg,
  deflatedSharpe,
  expectedMaxSharpe,
  moments,
  normCdf,
  normInv,
  profitByYear,
  tradeSharpe,
  zToPValue,
} from "./stats.ts";

describe("normal distribution", () => {
  test("normCdf matches table values", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normCdf(-1.96)).toBeCloseTo(0.025, 3);
    expect(normCdf(3)).toBeCloseTo(0.99865, 4);
  });

  test("normInv inverts normCdf", () => {
    for (const x of [-2.5, -1, 0, 0.5, 1.645, 3]) {
      expect(normInv(normCdf(x))).toBeCloseTo(x, 4);
    }
    expect(() => normInv(0)).toThrow();
    expect(() => normInv(1)).toThrow();
  });
});

describe("moments and sharpe", () => {
  test("known small set", () => {
    const m = moments([1, 2, 3, 4, 5]);
    expect(m.mean).toBe(3);
    expect(m.stdDev).toBeCloseTo(Math.sqrt(2), 10);
    expect(m.skewness).toBeCloseTo(0, 10);
    expect(m.kurtosis).toBeCloseTo(1.7, 10);
  });

  test("tradeSharpe is mean over std", () => {
    expect(tradeSharpe([1, -1, 1, -1])).toBe(0);
    expect(tradeSharpe([2, 2, 2])).toBe(0); // нулевой разброс — честный 0, не ∞
    expect(tradeSharpe([1, 0, 1, 0])).toBeCloseTo(1, 10);
  });
});

describe("expected max sharpe (the noise floor)", () => {
  test("N=5000 trials of pure noise expect ≈3.69σ — the research headline number", () => {
    const e = expectedMaxSharpe(5000, 1);
    expect(e).toBeGreaterThan(3.6);
    expect(e).toBeLessThan(3.8);
  });

  test("single trial has no selection bar; bar grows with N", () => {
    expect(expectedMaxSharpe(1, 1)).toBe(0);
    expect(expectedMaxSharpe(100, 1)).toBeLessThan(expectedMaxSharpe(10_000, 1));
  });
});

describe("deflated sharpe", () => {
  test("true edge with many observations approaches 1", () => {
    expect(deflatedSharpe(0.3, 0.05, 500, 0, 3)).toBeGreaterThan(0.99);
  });

  test("sharpe below the noise floor scores under 0.5", () => {
    expect(deflatedSharpe(0.05, 0.2, 200, 0, 3)).toBeLessThan(0.5);
  });

  test("pathological denominator returns honest 0, not NaN", () => {
    expect(deflatedSharpe(2, 0, 100, 5, 1)).toBe(0);
  });
});

describe("benjamini-hochberg", () => {
  test("textbook example at q=0.10", () => {
    const keep = benjaminiHochberg([0.01, 0.02, 0.03, 0.04, 0.2], 0.1);
    expect(keep).toEqual([true, true, true, true, false]);
  });

  test("nothing significant → all false; preserves input order", () => {
    expect(benjaminiHochberg([0.5, 0.9], 0.1)).toEqual([false, false]);
    const keep = benjaminiHochberg([0.9, 0.001], 0.1);
    expect(keep).toEqual([false, true]);
  });

  test("z→p is one-sided", () => {
    expect(zToPValue(0)).toBeCloseTo(0.5, 6);
    expect(zToPValue(3)).toBeLessThan(0.0015);
  });
});

describe("median", () => {
  test("odd n takes the middle, even n averages the central pair", async () => {
    const { median } = await import("./stats.ts");
    expect(median([3, 1, 2])).toBe(2);
    expect(median([2.0, 2.5, 3.0, 4.0])).toBe(2.75);
    expect(Number.isNaN(median([]))).toBe(true);
  });
});

describe("profit by year", () => {
  test("splits R by UTC year of entry", () => {
    const year = (y: number) => Date.UTC(y, 5, 15) / 1000;
    const byYear = profitByYear([
      { entryTime: year(2021), rMultiple: 2 },
      { entryTime: year(2021), rMultiple: -1 },
      { entryTime: year(2022), rMultiple: -0.5 },
    ]);
    expect(byYear.get(2021)).toBe(1);
    expect(byYear.get(2022)).toBe(-0.5);
  });
});
