import { describe, expect, it } from "vitest";
import { plantedBreadthCheck } from "./selfcheck.ts";
import { releaseV9 } from "./calibrate-pipeline.ts";
import { generateStream } from "./calibrate.ts";

// Доказательства пре-регистрации поиска v4 (docs/search-v4-preregistration.md).
describe("поиск v4: контрольные края ширины (P3)", () => {
  const [rare, leftTail] = plantedBreadthCheck(200, 7);

  it("край «35% винрейт, 3R» на редких входах проходит ширину", () => {
    expect(rare.passRate).toBeGreaterThanOrEqual(0.9);
  });

  it("край «75% винрейт, левый хвост» ширину не проходит", () => {
    expect(leftTail.passRate).toBeLessThanOrEqual(0.1);
  });
});

describe("поиск v4: конвейер отсева на чистом нуле", () => {
  it("малое семейство без деления на нуле выпускается редко", () => {
    let released = 0;
    const n = 200;
    for (let i = 0; i < n; i++) {
      const s = generateStream({ mu: 0, sigma: 1.1, rho: 0.3, nSym: 40, tradesPerSym: 12, days: 1800, seed: 1000 + i });
      if (releaseV9(s, true)) released += 1;
    }
    expect(released / n).toBeLessThanOrEqual(0.03);
  });

  it("явный край 0.15R на плотном мире проходит конвейер чаще нуля", () => {
    let edge = 0;
    let zero = 0;
    for (let i = 0; i < 60; i++) {
      const p = { sigma: 1.1, rho: 0.3, nSym: 250, tradesPerSym: 35, days: 1800, seed: 5000 + i };
      if (releaseV9(generateStream({ ...p, mu: 0.15 }))) edge += 1;
      if (releaseV9(generateStream({ ...p, mu: 0 }))) zero += 1;
    }
    expect(edge).toBeGreaterThan(zero + 20);
  });
});
