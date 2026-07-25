import { describe, expect, test } from "vitest";
import { calibrateSprt } from "./selfcheck.ts";

describe("SPRT self-calibration", () => {
  const thin = calibrateSprt(600, 0.15, 1, 42);
  const fat = calibrateSprt(600, 0.25, 1, 42);

  test("false accepts of pure noise stay near α (Wald bound ≈5.6%)", () => {
    expect(thin.falseAcceptRate).toBeLessThanOrEqual(0.09);
    expect(fat.falseAcceptRate).toBeLessThanOrEqual(0.09);
  });

  test("power for a fat edge (δ=0.25, E[N]≈76 < cap 150) is near 1−β", () => {
    expect(fat.powerRate).toBeGreaterThanOrEqual(0.8);
  });

  test("thin edge mostly dies by truncation — deliberate conservatism, pinned", () => {
    // δ=0.15 ⇒ E[N]≈211 > cap 150: у 150 сделок просто нет 2.9 единиц
    // доказательства для края такого размера. Тонкий край чаще гибнет
    // усечением, чем выпускается, — и это дизайн, а не поломка. Тест
    // прибивает факт, чтобы будущий «фикс» не поднял мощность втихую
    // за счёт α.
    expect(thin.powerRate).toBeLessThan(0.6);
    expect(thin.powerRate + thin.falseAcceptRate).toBeGreaterThan(0.2);
  });

  test("deterministic: same seed, same rates", () => {
    expect(calibrateSprt(600, 0.15, 1, 42)).toEqual(thin);
  });

  test("a fatter edge is easier to prove (power grows with μ1)", () => {
    expect(fat.powerRate).toBeGreaterThanOrEqual(thin.powerRate);
    expect(calibrateSprt(600, 0.4, 1, 42).powerRate).toBeGreaterThanOrEqual(fat.powerRate);
  });
});
