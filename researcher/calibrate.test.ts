import { describe, expect, test } from "vitest";
import { CURRENT, evaluateGates, generateStream, V3 } from "./calibrate.ts";

const stream = (mu: number, seed: number) =>
  generateStream({ mu, sigma: 1.1, rho: 0.6, nSym: 103, tradesPerSym: 35, days: 1800, seed });

describe("калибровочный стенд", () => {
  test("детерминирован по сиду", () => {
    const a = generateStream({ mu: 0.1, sigma: 1.1, rho: 0.5, nSym: 10, tradesPerSym: 20, days: 300, seed: 7 });
    const b = generateStream({ mu: 0.1, sigma: 1.1, rho: 0.5, nSym: 10, tradesPerSym: 20, days: 300, seed: 7 });
    expect(a.perSymbol).toEqual(b.perSymbol);
  });

  test("кросс-корреляция реально наводится общим фактором дня", () => {
    const s = generateStream({ mu: 0, sigma: 1, rho: 0.8, nSym: 2, tradesPerSym: 400, days: 50, seed: 11 });
    // средние доходности по дням двух символов должны коррелировать
    const byDay = (i: number) => {
      const m = new Map<number, { sum: number; n: number }>();
      for (const t of s.perSymbol[i]) {
        const e = m.get(t.day) ?? { sum: 0, n: 0 };
        e.sum += t.r;
        e.n += 1;
        m.set(t.day, e);
      }
      return m;
    };
    const a = byDay(0);
    const b = byDay(1);
    const days = [...a.keys()].filter((d) => b.has(d));
    const xs = days.map((d) => a.get(d)!.sum / a.get(d)!.n);
    const ys = days.map((d) => b.get(d)!.sum / b.get(d)!.n);
    const mx = xs.reduce((p, c) => p + c, 0) / xs.length;
    const my = ys.reduce((p, c) => p + c, 0) / ys.length;
    let cov = 0, vx = 0, vy = 0;
    for (let i = 0; i < xs.length; i++) {
      cov += (xs[i] - mx) * (ys[i] - my);
      vx += (xs[i] - mx) ** 2;
      vy += (ys[i] - my) ** 2;
    }
    expect(cov / Math.sqrt(vx * vy)).toBeGreaterThan(0.4);
  });

  test("нулевые потоки почти не проходят pooledT; край 0.15R проходит", () => {
    let nullPass = 0;
    let edgePass = 0;
    const K = 60;
    for (let i = 0; i < K; i++) {
      if (evaluateGates(stream(0, 100 + i), 4700, 0.0063).pooledClusteredT) nullPass += 1;
      if (evaluateGates(stream(0.15, 500 + i), 4700, 0.0063).pooledClusteredT) edgePass += 1;
    }
    expect(nullPass / K).toBeLessThan(0.08);
    expect(edgePass / K).toBeGreaterThan(0.9);
  });

  test("константы текущих ворот в стенде совпадают с боевыми", async () => {
    const gates = await import("./gates.ts");
    expect(CURRENT.minTotalTrades).toBe(gates.MIN_TOTAL_TRADES);
    expect(CURRENT.minActiveSymbols).toBe(gates.MIN_ACTIVE_SYMBOLS);
    expect(CURRENT.breadthShare).toBe(gates.BREADTH_SHARE);
  });

  test("пре-регистрация: пороги v3 зафиксированы", () => {
    expect(V3.pooledTMin).toBe(2.6);
    expect(V3.breadthAlpha).toBe(0.05);
  });
});
