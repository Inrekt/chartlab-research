import { describe, expect, test } from "vitest";
import type { TradeResult } from "../src/core/types/index.ts";
import {
  gateActivity,
  gateBreadth,
  gateCostStress,
  gateDsr,
  gateNull,
  gatePlateau,
  gateTemporal,
  gateWilson,
  type SymbolNet,
} from "./gates.ts";
import { neighborSpecs } from "./screen.ts";
import type { CandidateSpec } from "./grammar.ts";

const sym = (symbol: string, trades: number, netExpectancy: number): SymbolNet => ({
  symbol,
  trades,
  netExpectancy,
});

/** Синтетическая сделка: риск 2 пункта от входа 100 → издержки измеримы. */
const trade = (entryTime: number, rMultiple: number): TradeResult => ({
  symbol: "TESTUSDT",
  direction: "long",
  entryTime,
  entryPrice: 100,
  exitTime: entryTime + 3600,
  exitPrice: 100 + rMultiple * 2,
  stopPrice: 98,
  targetPrice: 104,
  rMultiple,
  won: rMultiple > 0,
  barsHeld: 5,
});

describe("gateActivity", () => {
  test("needs 100 trades across 8 active symbols", () => {
    const thin = Array.from({ length: 7 }, (_, i) => sym(`S${i}`, 14, 0.1));
    expect(gateActivity(thin).pass).toBe(false); // 98 сделок, 7 активных
    const ok = Array.from({ length: 10 }, (_, i) => sym(`S${i}`, 12, 0.1));
    expect(gateActivity(ok).pass).toBe(true);
  });
});

describe("gateBreadth", () => {
  const wide = [
    ...Array.from({ length: 7 }, (_, i) => sym(`P${i}`, 10, 0.2)),
    ...Array.from({ length: 3 }, (_, i) => sym(`N${i}`, 10, -0.1)),
  ];
  test("passes at 70% positive with healthy holdout", () => {
    expect(gateBreadth(wide, { netExpectancy: 0.1, trades: 40 }).pass).toBe(true);
  });
  test("fails below 60% positive share", () => {
    const narrow = [
      ...Array.from({ length: 5 }, (_, i) => sym(`P${i}`, 10, 0.2)),
      ...Array.from({ length: 5 }, (_, i) => sym(`N${i}`, 10, -0.1)),
    ];
    expect(gateBreadth(narrow, { netExpectancy: 0.1, trades: 40 }).pass).toBe(false);
  });
  test("fails when holdout is negative OR too thin to judge", () => {
    expect(gateBreadth(wide, { netExpectancy: -0.05, trades: 40 }).pass).toBe(false);
    expect(gateBreadth(wide, { netExpectancy: 0.3, trades: 5 }).pass).toBe(false);
  });
});

describe("gateCostStress", () => {
  test("survives 2× costs only with real margin", () => {
    // риск 2 из цены 100 → стресс-издержки 2·(0.002)·100/2 = 0.2R на сделку
    const fat = Array.from({ length: 50 }, (_, i) => trade(i * 1000, i % 3 === 0 ? -1 : 1.5));
    expect(gateCostStress(fat).pass).toBe(true);
    const thin = Array.from({ length: 50 }, (_, i) => trade(i * 1000, i % 2 === 0 ? -1 : 1.15));
    expect(gateCostStress(thin).pass).toBe(false);
  });
});

describe("gatePlateau", () => {
  test("lone peak is rejected, plateau passes", () => {
    expect(gatePlateau(0.5, [-0.1, -0.2, 0.05, -0.3]).pass).toBe(false);
    expect(gatePlateau(0.3, [0.25, 0.2, 0.28, 0.22, -0.05, 0.19]).pass).toBe(true);
  });
  test("peak 1.5× above neighbor median is suspicious even if all positive", () => {
    expect(gatePlateau(0.9, [0.2, 0.25, 0.22, 0.21]).pass).toBe(false);
  });
  test("fewer than 3 neighbors cannot certify", () => {
    expect(gatePlateau(0.3, [0.2, 0.25]).pass).toBe(false);
  });
  test("even neighbor count uses the TRUE median (review repro)", () => {
    // Верхняя медиана 0.23 дала бы планку 0.345 и пропустила пик 0.34;
    // честная медиана 0.22 → планка 0.33 → одинокий пик отклонён.
    expect(gatePlateau(0.34, [0.2, 0.21, 0.23, 0.4]).pass).toBe(false);
  });
});

describe("gateNull", () => {
  test("median z decides against 3σ bar", () => {
    expect(gateNull([3.4, 3.1, 4.0, 2.8, 3.6]).pass).toBe(true);
    expect(gateNull([2.4, 2.9, 3.5, 1.8, 2.6]).pass).toBe(false);
  });
  test("even n uses the TRUE median, not the softer upper one (review repro)", () => {
    // Верхняя медиана дала бы 3.0 и пропустила; честная — 2.75 < 3 → отказ.
    expect(gateNull([2.0, 2.5, 3.0, 4.0]).pass).toBe(false);
  });
  test("needs at least 3 measurable symbols", () => {
    expect(gateNull([5, 4]).pass).toBe(false);
  });
});

describe("gateTemporal", () => {
  const DAY = 86_400;
  const start = Date.UTC(2021, 0, 10) / 1000;
  test("multi-year profitable history passes", () => {
    const trades = Array.from({ length: 140 }, (_, i) =>
      trade(start + i * 12 * DAY, i % 3 === 0 ? -1 : 1.4),
    );
    const result = gateTemporal(trades);
    expect(result.pass).toBe(true);
    expect(Number(result.metrics.coveredYears)).toBeGreaterThanOrEqual(4);
  });
  test("short history fails honestly", () => {
    const trades = Array.from({ length: 140 }, (_, i) =>
      trade(start + i * DAY, i % 3 === 0 ? -1 : 1.4),
    );
    expect(gateTemporal(trades).pass).toBe(false);
  });
  test("years positive gross but negative NET are not profitable years (review repro)", () => {
    // +0.05R брутто на сделку при издержках ≈0.1R (риск 2 от цены 100):
    // каждый год «в плюсе» до издержек и в минусе после — ворота обязаны резать.
    const trades = Array.from({ length: 140 }, (_, i) => trade(start + i * 12 * DAY, 0.05));
    expect(gateTemporal(trades).pass).toBe(false);
  });
});

describe("gateDsr", () => {
  const strongRs = Array.from({ length: 300 }, (_, i) => (i % 3 === 0 ? -1 : 1.2));
  test("real edge passes a thousand-cluster bar at realistic batch dispersion", () => {
    expect(gateDsr(strongRs, 1000, 0.005).pass).toBe(true);
  });
  test("wide batch dispersion honestly raises the bar beyond even a strong edge", () => {
    // Разброс Шарпов по партии 0.02 при N=1000 даёт планку E[max] ≈ 0.46 —
    // выше per-trade SR≈0.45 этого края. Формула ОБЯЗАНА резать: чем шумнее
    // партия, тем больше лучший результат объясним отбором.
    expect(gateDsr(strongRs, 1000, 0.02).pass).toBe(false);
  });
  test("selection bar rises with cluster count", () => {
    const few = gateDsr(strongRs, 10, 0.02);
    const many = gateDsr(strongRs, 100_000, 0.02);
    expect(Number(many.metrics.sr0)).toBeGreaterThan(Number(few.metrics.sr0));
    expect(Number(many.metrics.dsr)).toBeLessThanOrEqual(Number(few.metrics.dsr));
  });
  test("noise-level sharpe fails", () => {
    const noise = Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? -1 : 1.02));
    expect(gateDsr(noise, 5000, 0.05).pass).toBe(false);
  });
});

describe("gateWilson", () => {
  const stats = (winRate: number, totalTrades: number) => ({
    totalTrades,
    winRate,
    avgRR: 1,
    profitFactor: 1.5,
    expectancy: 0.2,
    maxDrawdownR: -5,
    avgBarsHeld: 10,
  });
  test("wide sample above breakeven passes; marginal sample fails", () => {
    expect(gateWilson(stats(0.6, 200), 2).pass).toBe(true); // безубыток 33%
    expect(gateWilson(stats(0.55, 20), 1).pass).toBe(false); // безубыток 50%, ДИ широкий
  });
});

describe("neighborSpecs", () => {
  const spec = (stopAtr: number, takeR: number, maxBars: number): CandidateSpec => ({
    setup: "trend_cross_50",
    direction: "long",
    timeframe: "1h",
    filters: [],
    exit: { stopAtr, takeR, maxBars },
  });
  test("interior point has 6 grid neighbors, corner has 3", () => {
    expect(neighborSpecs(spec(2, 2, 20))).toHaveLength(6);
    expect(neighborSpecs(spec(1.5, 1, 10))).toHaveLength(3);
  });
  test("neighbors differ from the candidate in exactly one exit dimension", () => {
    const base = spec(2, 2, 20);
    for (const n of neighborSpecs(base)) {
      // у rr-семейств сетап не меняется, отличается ровно одно измерение выхода
      expect(n.setup).toBe(base.setup);
      const baseExit = base.exit as { stopAtr: number; takeR: number; maxBars: number };
      const nExit = n.exit as { stopAtr: number; takeR: number; maxBars: number };
      const diffs = (["stopAtr", "takeR", "maxBars"] as const).filter(
        (d) => nExit[d] !== baseExit[d],
      );
      expect(diffs).toHaveLength(1);
    }
  });
});
