import { describe, expect, test } from "vitest";
import {
  candidateId,
  defaultClusterKey,
  enumerateAll,
  EXITS,
  FILTERS,
  filterCombosFor,
  grammarSize,
  MAX_FILTERS,
  sampleCandidates,
  SETUPS,
  toStrategyConfig,
  type CandidateSpec,
} from "./grammar.ts";

const filterFamily = new Map(FILTERS.map((f) => [f.id, f.family]));

describe("closed grammar", () => {
  test("grammarSize equals actual enumeration count", () => {
    let count = 0;
    for (const _ of enumerateAll()) count++;
    expect(count).toBe(grammarSize());
  });

  test("space is countable and in the documented hundreds of thousands", () => {
    const size = grammarSize();
    expect(size).toBeGreaterThan(100_000);
    expect(size).toBeLessThan(1_000_000);
  });

  test("every combo has at most MAX_FILTERS filters, one per family", () => {
    for (const setup of SETUPS) {
      for (const combo of filterCombosFor(setup.id)) {
        expect(combo.length).toBeLessThanOrEqual(MAX_FILTERS);
        const families = combo.map((id) => filterFamily.get(id));
        expect(new Set(families).size).toBe(families.length);
      }
    }
  });

  test("context-required setups never appear without a context filter", () => {
    for (const setup of SETUPS) {
      if (!setup.requiresContext) continue;
      for (const combo of filterCombosFor(setup.id)) {
        const families = combo.map((id) => filterFamily.get(id));
        expect(
          families.some((f) => setup.requiresContext!.includes(f!)),
          `${setup.id} с комбо [${combo.join(",")}] без контекста`,
        ).toBe(true);
      }
    }
  });

  test("squeeze setups exclude the redundant volatility family", () => {
    for (const id of ["squeeze_break_donchian", "squeeze_break_keltner"]) {
      for (const combo of filterCombosFor(id)) {
        expect(combo.map((f) => filterFamily.get(f))).not.toContain("volatility");
      }
    }
  });
});

describe("sampling", () => {
  test("deterministic: same seed, same batch", () => {
    const a = sampleCandidates(42, 200);
    const b = sampleCandidates(42, 200);
    expect(a).toEqual(b);
  });

  test("returns unique ids and honours the exclude set", () => {
    const first = sampleCandidates(7, 300);
    const ids = new Set(first.map(candidateId));
    expect(ids.size).toBe(first.length);
    const second = sampleCandidates(8, 300, ids);
    for (const spec of second) expect(ids.has(candidateId(spec))).toBe(false);
  });

  test("evidence priors: momentum-family setups sampled far more than seasonality", () => {
    const batch = sampleCandidates(1, 2000);
    const byFamily = new Map<string, number>();
    for (const spec of batch) {
      const family = SETUPS.find((s) => s.id === spec.setup)!.family;
      byFamily.set(family, (byFamily.get(family) ?? 0) + 1);
    }
    expect(byFamily.get("momentum") ?? 0).toBeGreaterThan(3 * (byFamily.get("seasonality") ?? 0));
  });
});

describe("mapping to StrategyConfig", () => {
  test("every sampled spec produces a runnable config with parity id", () => {
    for (const spec of sampleCandidates(3, 500)) {
      const config = toStrategyConfig(spec);
      expect(config.id).toBe(`researcher:${candidateId(spec)}`);
      expect(config.timeframe).toBe(spec.timeframe);
      expect(config.direction).toBe(spec.direction);
      expect(config.entry.conditions.length).toBeGreaterThan(0);
      if (!("kind" in spec.exit) || spec.exit.kind !== "liquidity") {
        const rr = spec.exit as { stopAtr: number; takeR: number };
        expect(config.exit.stopLoss).toEqual({ type: "atr", value: rr.stopAtr });
        expect(config.exit.takeProfit).toEqual({ type: "rr", value: rr.takeR });
      }
      expect(config.exit.maxBarsInTrade).toBe(spec.exit.maxBars);
      if (spec.filters.length === 0) expect(config.filters).toBeUndefined();
      else expect(config.filters!.conditions).toHaveLength(spec.filters.length);
    }
  });

  test("direction mirrors the atoms, not just the label", () => {
    const base: Omit<CandidateSpec, "direction"> = {
      setup: "trend_cross_50",
      timeframe: "1h",
      filters: ["trend_sma200"],
      exit: { stopAtr: 2, takeR: 2, maxBars: 20 },
    };
    const long = toStrategyConfig({ ...base, direction: "long" });
    const short = toStrategyConfig({ ...base, direction: "short" });
    expect(long.entry).not.toEqual(short.entry);
    expect(long.filters).not.toEqual(short.filters);
  });

  test("candidateId is canonical: distinct specs, distinct ids (10k sample)", () => {
    const ids = new Set<string>();
    let taken = 0;
    for (const spec of enumerateAll()) {
      ids.add(candidateId(spec));
      if (++taken >= 10_000) break;
    }
    expect(ids.size).toBe(taken);
  });

  test("defaultClusterKey groups by setup family × tf × direction", () => {
    const spec: CandidateSpec = {
      setup: "donchian_breakout_20",
      direction: "long",
      timeframe: "4h",
      filters: [],
      exit: EXITS[0],
    };
    expect(defaultClusterKey(spec)).toBe("breakout:4h:long");
  });
});
