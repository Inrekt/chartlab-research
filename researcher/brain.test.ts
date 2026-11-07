import { describe, expect, it } from "vitest";
import {
  DEFAULT_NIGHTLY_LIMIT,
  evaluateDraft,
  generate,
  promote,
  saveProposals,
  type BrainContext,
} from "./brain.ts";
import { hintToHypotheses, parseHint } from "./hint.ts";
import { TrialLedger } from "./ledger.ts";
import { CORE_CUBES, MECHANISMS, isDeadMechanism, mechanismById, type Mechanism } from "./mechanisms.ts";

const ALL_DATA = new Set(["candles", "funding", "metrics", "flow", "orderflow15m", "announcements", "hlWhales"] as const);

function ctx(over: Partial<BrainContext> = {}): BrainContext {
  return { availableData: ALL_DATA, availableCubes: new Set(CORE_CUBES), universeSize: 129, ...over };
}

function openMech(over: Partial<Mechanism> = {}): Mechanism {
  return {
    ...mechanismById("trapped_new_positions")!,
    ...over,
  };
}

describe("каталог механизмов", () => {
  it("у каждого механизма есть плательщик, выход и хотя бы один набор кубиков", () => {
    for (const m of MECHANISMS) {
      expect(m.whoPays.length, m.id).toBeGreaterThanOrEqual(40);
      expect(m.naturalExit.length, m.id).toBeGreaterThan(0);
      expect(m.cubeSets.length, m.id).toBeGreaterThan(0);
      if (isDeadMechanism(m)) expect(m.refutedBy?.length, m.id).toBeGreaterThan(0);
    }
  });

  it("опровергнутые семейства журнала помечены опровергнутыми", () => {
    for (const id of ["stops_beyond_level", "forced_liquidations", "crowd_vs_whales", "funding_extreme_fade"]) {
      expect(isDeadMechanism(mechanismById(id)!), id).toBe(true);
    }
  });
});

describe("генератор", () => {
  it("не предлагает опровергнутое, закрытое и уже живущее", () => {
    const report = generate(ctx());
    const proposed = new Set([...report.accepted, ...report.rejected].map((e) => e.draft.mechanism.id));
    for (const m of MECHANISMS) {
      if (m.status !== "open") expect(proposed.has(m.id), m.id).toBe(false);
    }
    expect(report.skipped.map((s) => s.mechanism)).toContain("forced_liquidations");
  });

  it("свинг впереди 1h и годное из готовых кубиков авто-одобряемо", () => {
    const { accepted } = generate(ctx());
    expect(accepted.length).toBeGreaterThan(0);
    const firstH = accepted.findIndex((e) => e.draft.timeframe === "1h");
    if (firstH >= 0) {
      expect(accepted.slice(firstH).every((e) => e.draft.timeframe === "1h")).toBe(true);
    }
    expect(accepted.some((e) => e.adequacy.autoApprovable)).toBe(true);
  });
});

describe("адекватность", () => {
  const base = { cubes: ["oiChange", "funding"] as const, timeframe: "4h" as const, source: "generator" as const };

  it("без данных — отказ", () => {
    const ev = evaluateDraft({ ...base, mechanism: openMech() }, ctx({ availableData: new Set(["candles"]) }));
    expect(ev.adequacy.passed).toBe(false);
    expect(ev.adequacy.checks.find((c) => c.name === "data")?.ok).toBe(false);
  });

  it("мало сделок — отказ", () => {
    const ev = evaluateDraft({ ...base, mechanism: openMech({ eventsPerSymbolYear: { "4h": 0.2 } }) }, ctx());
    expect(ev.adequacy.checks.find((c) => c.name === "trades")?.ok).toBe(false);
    expect(ev.adequacy.passed).toBe(false);
  });

  it("край ниже пола издержек — отказ", () => {
    const ev = evaluateDraft({ ...base, mechanism: openMech({ plausibleEdgeBp: { "4h": 5 } }) }, ctx());
    expect(ev.adequacy.checks.find((c) => c.name === "cost_floor")?.ok).toBe(false);
  });

  it("мёртвый срез в журнале — отказ", () => {
    const ev = evaluateDraft(
      { ...base, mechanism: openMech() },
      ctx({ sliceOutcome: () => ({ trials: 40, survivors: 0 }) }),
    );
    expect(ev.adequacy.checks.find((c) => c.name === "dead_cluster")?.ok).toBe(false);
  });

  it("нет «кто платит» — отказ", () => {
    const ev = evaluateDraft({ ...base, mechanism: openMech({ whoPays: "кто-то" }) }, ctx());
    expect(ev.adequacy.passed).toBe(false);
  });

  it("недостающий кубик — предложить можно, авто-одобрять нельзя", () => {
    const ev = evaluateDraft(
      { ...base, mechanism: openMech(), cubes: ["oiChange", "crossSectionRank"] },
      ctx(),
    );
    expect(ev.adequacy.passed).toBe(true);
    expect(ev.adequacy.autoApprovable).toBe(false);
  });
});

describe("очередь гипотез и счётчик множественности", () => {
  const now = "2026-11-07T20:00:00.000Z";

  function goodBatch(n: number) {
    return Array.from({ length: n }, (_, i) =>
      evaluateDraft(
        {
          mechanism: openMech({ id: `test_mech_${i}` }),
          cubes: ["oiChange", "funding"],
          timeframe: "4h",
          source: "generator",
        },
        ctx(),
      ),
    );
  }

  it("предложение не поднимает F, постановка — поднимает, лимит за ночь держится", () => {
    const ledger = new TrialLedger(":memory:", { now: () => now });
    expect(saveProposals(ledger, goodBatch(4), now)).toBe(4);
    expect(ledger.familiesTried()).toBe(0);

    const queued = promote(ledger, { night: "2026-11-07" });
    expect(queued).toHaveLength(DEFAULT_NIGHTLY_LIMIT);
    expect(ledger.familiesTried()).toBe(DEFAULT_NIGHTLY_LIMIT);
    expect(promote(ledger, { night: "2026-11-07" })).toHaveLength(0);
    expect(ledger.queueHypothesis(ledger.hypotheses("proposed")[0].id, "2026-11-07", DEFAULT_NIGHTLY_LIMIT)).toBe(false);

    expect(promote(ledger, { night: "2026-11-08", limit: 2 })).toHaveLength(2);
    expect(ledger.familiesTried()).toBe(DEFAULT_NIGHTLY_LIMIT + 2);
    ledger.close();
  });

  it("повтор не плодит строки; пре-регистрация и статус неизменны назад", () => {
    const ledger = new TrialLedger(":memory:", { now: () => now });
    const batch = goodBatch(1);
    expect(saveProposals(ledger, batch, now)).toBe(1);
    expect(saveProposals(ledger, batch, now)).toBe(0);
    const [h] = ledger.hypotheses();
    expect(JSON.parse(h.preregJson).whoPays).toBe(batch[0].draft.mechanism.whoPays);
    promote(ledger, { night: "2026-11-07" });
    expect(ledger.rejectHypothesis(h.id)).toBe(false);
    expect(ledger.hypotheses("queued")).toHaveLength(1);
    ledger.close();
  });

  it("не авто-одобряемое в прогон не уходит", () => {
    const ledger = new TrialLedger(":memory:", { now: () => now });
    const ev = evaluateDraft(
      { mechanism: openMech(), cubes: ["oiChange", "crossSectionRank"], timeframe: "4h", source: "generator" },
      ctx(),
    );
    saveProposals(ledger, [ev], now);
    expect(promote(ledger, { night: "2026-11-07", limit: 5 })).toHaveLength(0);
    ledger.close();
  });
});

describe("наводки владельца", () => {
  it("распознаёт механизм и таймфрейм", () => {
    const p = parseHint("шорт перед разлоками на дневках");
    expect(p.mechanisms.map((m) => m.id)).toEqual(["token_unlocks"]);
    expect(p.timeframes).toEqual(["1d"]);
  });

  it("разлоки без календаря не проходят проверку данных", () => {
    const { evaluated } = hintToHypotheses("разлоки на дневках", ctx());
    expect(evaluated.length).toBeGreaterThan(0);
    expect(evaluated.every((e) => !e.adequacy.passed)).toBe(true);
  });

  it("опровергнутое без новой гипотезы — отказ, с ней — только предложение", () => {
    const without = hintToHypotheses("толпа против китов на 4h", ctx()).evaluated;
    expect(without.every((e) => !e.adequacy.passed)).toBe(true);
    const withNew = hintToHypotheses("толпа против китов на 4h", ctx(), {
      newHypothesis: "Платят не все розничные, а только те, у кого плечо выше 20× на Hyperliquid — их ликвидирует движок.",
    }).evaluated;
    expect(withNew.some((e) => e.adequacy.passed)).toBe(true);
    expect(withNew.every((e) => !e.adequacy.autoApprovable)).toBe(true);
  });
});
