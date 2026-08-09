import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { halvingSubset, liquidityTiers } from "./corpus.ts";
import { enumerateAll, frozenFamilies, sampleCandidates, setupFamily, setupTier } from "./grammar.ts";
import { tradeEconomics } from "./screen.ts";
import type { TradeResult } from "../src/core/types/index.ts";

/** Мини-корпус: свечи с заданным нотионалом, всё в in-окне (2024 год). */
function writeSymbol(dir: string, symbol: string, notionalPerBar: number): void {
  const t0 = Date.parse("2024-01-01T00:00:00Z") / 1000;
  const candles = Array.from({ length: 300 }, (_, i) => ({
    time: t0 + i * 3600,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: notionalPerBar / 100, // volume × close = notionalPerBar
  }));
  writeFileSync(join(dir, `${symbol}_1h.json.gz`), gzipSync(JSON.stringify(candles)));
}

describe("срез вселенной по ликвидности", () => {
  it("верхняя половина по нотионалу — ликвидные, нижняя — нет", () => {
    const dir = mkdtempSync(join(tmpdir(), "tiers-"));
    try {
      writeSymbol(dir, "BIG", 1_000_000);
      writeSymbol(dir, "MID", 10_000);
      writeSymbol(dir, "TINY", 100);
      const tiers = liquidityTiers("1h", ["BIG", "MID", "TINY"], dir);
      expect(tiers.get("BIG")).toBe("liquid");
      expect(tiers.get("MID")).toBe("liquid"); // ceil(3/2)=2 в верхней половине
      expect(tiers.get("TINY")).toBe("illiquid");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("префиксное свойство стадий выживает фильтрацию пула", () => {
    // Внутри среза стадия-16 обязана быть префиксом стадии-128 — иначе
    // кандидат «пересдаёт» другие символы и журнал становится несравним.
    const pool = Array.from({ length: 40 }, (_, i) => `SYM${i}`);
    const filtered = pool.filter((_, i) => i % 2 === 0);
    const a = halvingSubset(filtered, 8, 0xc0ffee);
    const b = halvingSubset(filtered, 16, 0xc0ffee);
    expect(b.slice(0, a.length)).toEqual(a);
  });
});

describe("срезы семейств", () => {
  it("разворот живёт на неликвиде, моментум — на ликвиде, остальные — везде", () => {
    expect(setupTier("meanrev_keltner_20")).toBe("illiquid");
    expect(setupTier("meanrev_bollinger_20")).toBe("illiquid");
    expect(setupTier("momentum_roc_zero")).toBe("liquid");
    expect(setupTier("momentum_macd_signal")).toBe("liquid");
    expect(setupTier("trend_cross_50")).toBeUndefined();
    expect(setupTier("нет_такого")).toBeUndefined();
  });
});

describe("экономика испытания", () => {
  const trade = (r: number, entryTime: number): TradeResult => ({
    symbol: "X",
    direction: "long",
    entryTime,
    entryPrice: 100,
    exitTime: entryTime + 3600,
    exitPrice: 100 + r,
    stopPrice: 99, // риск 1 → издержки в R измеримы
    targetPrice: 103,
    rMultiple: r,
    won: r > 0,
    barsHeld: 1,
  });

  it("порог безубыточности равен валовому ожиданию", () => {
    const t0 = 1_700_000_000;
    const eco = tradeEconomics([trade(1, t0), trade(-0.5, t0 + 86400)]);
    expect(eco.grossExpectancy).toBeCloseTo(0.25, 9);
    expect(eco.breakevenCostR).toBeCloseTo(0.25, 9);
    expect(eco.costR).toBeGreaterThan(0);
    // 2 сделки за 1 день
    expect(eco.tradesPerDay).toBeCloseTo(2, 9);
  });

  it("пустой список не делит на ноль", () => {
    const eco = tradeEconomics([]);
    expect(eco.tradesPerDay).toBe(0);
    expect(eco.grossExpectancy).toBe(0);
  });
});

describe("политика бюджета (пункт 6)", () => {
  it("новые кандидаты — только семействам с платящей стороной", () => {
    const specs = sampleCandidates(123, 300, undefined, { tf: "4h" });
    expect(specs.length).toBeGreaterThan(0);
    const families = new Set(specs.map((s) => setupFamily(s.setup)));
    for (const f of families) {
      // Белый список НАМЕРЕННО жёсткий: новое семейство попадает сюда только
      // вместе с пре-регистрацией и полем «кто платит». Падение этого теста —
      // сигнал, что кто-то расширил пространство проб, не назвав плательщика.
      expect([
        "liquidity_magnet",
        "funding_pressure",
        "funding_hours",
        "range_sweep",
        "range_sweep_v2",
      ]).toContain(f);
    }
  });

  it("слепой перебор заморожен, но ПРОСТРАНСТВО не сужено", () => {
    // Дедуп и дефляция продолжают считать всё пространство: enumerateAll
    // обязан по-прежнему видеть замороженные семейства.
    const families = new Set([...enumerateAll()].map((s) => setupFamily(s.setup)));
    expect(families.has("trend_following")).toBe(true);
    expect(families.has("breakout")).toBe(true);
    expect(frozenFamilies()).toContain("trend_following");
    expect(frozenFamilies()).not.toContain("liquidity_magnet");
  });
});
