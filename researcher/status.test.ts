import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { FILTERS, SETUPS, sampleCandidates, type CandidateSpec } from "./grammar.ts";
import { IncubationBook } from "./incubationBook.ts";
import { STATES, TrialLedger } from "./ledger.ts";
import type { ScreenSummary } from "./screen.ts";
import { buildStatus, nextNightUtc, publicRef } from "./status.ts";

const NOW = new Date("2026-07-26T09:00:00.000Z");

const spec = (over: Partial<CandidateSpec> = {}): CandidateSpec => ({
  setup: "donchian_breakout_20",
  direction: "long",
  timeframe: "1h",
  filters: ["trend_sma200"],
  exit: { stopAtr: 2, takeR: 2, maxBars: 20 },
  ...over,
});

const screen = (tf: string, batch: number, passed16: number, passed128: number): ScreenSummary =>
  ({
    tf,
    seed: 1,
    registered: batch,
    universe: { search: 128, holdout: 42 },
    stages: {
      halving_16: { evaluated: batch, passed: passed16 },
      halving_128: { evaluated: passed16, passed: passed128 },
      gauntlet: { evaluated: passed128, passed: 0 },
    },
    rejectedByGate: { halving_16: batch - passed16, gate_breadth: 3 },
    validated: [],
    ledgerCounts: { trials: 0, clusters: 0 },
    diagnostics: {
      realityCheck: { observedStat: 0.1, pValue: 0.938, bootstraps: 500 },
      pbo: { pbo: 0.19, combinations: 924 },
    },
  }) as unknown as ScreenSummary;

const emptyIncubation = {
  seeded: 0,
  rejectedAtEntry: 0,
  checked: 0,
  newTrades: 0,
  graduated: [] as string[],
  killed: [] as string[],
};
const emptySupervision = {
  supervised: 0,
  newTrades: 0,
  decayed: [] as string[],
  requalified: [] as string[],
  retired: [] as string[],
};

describe("publicRef — обезличивание", () => {
  test("формула превращается в семейство · ТФ · направление", () => {
    expect(publicRef(spec())).toBe("пробой · 1h · long");
    expect(publicRef(spec({ setup: "pullback_rsi_40", timeframe: "4h", direction: "short" }))).toBe(
      "откат · 4h · short",
    );
    expect(publicRef(spec({ setup: "momentum_macd_zero" }))).toBe("импульс · 1h · long");
  });

  test("ни один разделитель формулы наружу не проходит", () => {
    for (const candidate of sampleCandidates(11, 300)) {
      const ref = publicRef(candidate);
      expect(ref).not.toContain("|");
      expect(ref).not.toContain("+");
      expect(ref.split(" · ")).toHaveLength(3);
    }
  });

  test("разные формулы одного семейства неразличимы — восстановить нельзя", () => {
    const a = publicRef(spec({ setup: "donchian_breakout_20", filters: ["trend_sma200"] }));
    const b = publicRef(spec({ setup: "donchian_breakout_55", filters: ["vol_squeeze"] }));
    expect(a).toBe(b);
  });
});

describe("nextNightUtc", () => {
  test("до 21:37 UTC — сегодня, после — завтра", () => {
    expect(nextNightUtc(new Date("2026-07-26T09:00:00Z"))).toBe("2026-07-26T21:37:00.000Z");
    expect(nextNightUtc(new Date("2026-07-26T22:00:00Z"))).toBe("2026-07-27T21:37:00.000Z");
  });
});

describe("buildStatus", () => {
  let dbPath: string;
  let ledger: TrialLedger;
  let book: IncubationBook;

  beforeEach(() => {
    dbPath = join(mkdtempSync(join(tmpdir(), "status-")), "trials.sqlite");
    ledger = new TrialLedger(dbPath);
    book = new IncubationBook(dbPath);
  });

  const build = (previous?: ReturnType<typeof buildStatus> | null) =>
    buildStatus({
      screens: [screen("1h", 2000, 86, 29), screen("4h", 2000, 893, 650)],
      incubation: emptyIncubation,
      supervision: emptySupervision,
      ledger,
      book,
      states: STATES,
      previous,
      durationMin: 121,
      now: NOW,
    });

  /** Часовая догонка: тех же данных, но БЕЗ прогона ночи. */
  const tick = (previous: ReturnType<typeof buildStatus>) =>
    buildStatus({
      screens: [],
      incubation: emptyIncubation,
      supervision: emptySupervision,
      ledger,
      book,
      states: STATES,
      previous,
      now: new Date("2026-07-26T11:07:00.000Z"),
    });

  test("упавшая ночь доносит причину, удачная её стирает, тик переносит", () => {
    // Упавшая ночь приходит с пустым screens и по этому признаку неотличима
    // от часового тика. Без явного поля её причина потерялась бы, а на экран
    // уехал бы вчерашний зелёный статус: снаружи всё хорошо, внутри машина
    // стоит. Ровно так корпус простоял две недели.
    const crashed = buildStatus({
      screens: [],
      incubation: emptyIncubation,
      supervision: emptySupervision,
      ledger,
      book,
      states: STATES,
      now: NOW,
      failure: "Пространство гипотез исчерпано: набрано 4 из 2000 запрошенных.",
    });
    expect(crashed.failure).toMatch(/исчерпано/);

    // Часовой тик о ночи не судит — переносит вердикт как есть.
    expect(tick(crashed).failure).toMatch(/исчерпано/);

    // Удачная ночь ОБЯЗАНА очистить поле: иначе одна авария навсегда красит
    // панель в красный и тревога перестаёт что-либо значить.
    expect(build(crashed).failure).toBeNull();
  });

  test("здоровье источников переносится тиком, а не обнуляется", () => {
    // Экран читает ОДИН файл. Если часовой тик, не мерявший источники, затрёт
    // их пустотой, панель свежести погаснет между ночами — то есть ровно тогда,
    // когда сборщик и умирает. Пустая панель читается как «данных нет», а не
    // как «мы не смотрели», и это неотличимо от исправной машины.
    const sources = {
      feeds: [{ name: "funding", files: 156, required: 50, ok: true }],
      corpus: {
        newestBar: "2026-07-25T18:00:00.000Z",
        ageDays: 14.6,
        laggingSymbols: 0,
        level: "fail" as const,
      },
    };
    const night = buildStatus({
      screens: [screen("1h", 2000, 86, 29)],
      incubation: emptyIncubation,
      supervision: emptySupervision,
      ledger,
      book,
      states: STATES,
      durationMin: 121,
      now: NOW,
      sources,
    });
    expect(night.sources).toEqual(sources);
    expect(tick(night).sources).toEqual(sources);
  });

  test("воронка и диагностика переносятся из прогона", () => {
    const status = build();
    expect(status.universes).toHaveLength(2);
    expect(status.universes[0].funnel).toEqual([
      { stage: "batch", n: 2000 },
      { stage: "halving_16", n: 86 },
      { stage: "halving_128", n: 29 },
      { stage: "gauntlet", n: 0 },
    ]);
    expect(status.universes[0].realityCheckP).toBe(0.938);
    expect(status.universes[0].pbo).toBe(0.19);
    expect(status.run.durationMin).toBe(121);
  });

  test("часовой тик не стирает воронку ночи и не портит историю", () => {
    const night = build();
    const ticked = tick(night);
    expect(ticked.universes).toEqual(night.universes);
    expect(ticked.run.durationMin).toBe(121);
    expect(ticked.history).toEqual(night.history);
    // но время последней догонки — новое
    expect(ticked.run.lastTickUtc).toBe("2026-07-26T11:07:00.000Z");
  });

  test("история дописывается, а повтор за ту же дату заменяется", () => {
    const status = build({
      history: [
        { date: "2026-07-26", batch: 1, validated: 1, graduated: 1 },
        { date: "2026-07-25", batch: 4000, validated: 0, graduated: 0 },
      ],
    } as ReturnType<typeof buildStatus>);
    expect(status.history[0]).toEqual({
      date: "2026-07-26",
      batch: 4000,
      validated: 0,
      graduated: 0,
    });
    expect(status.history.filter((h) => h.date === "2026-07-26")).toHaveLength(1);
    expect(status.history[1].date).toBe("2026-07-25");
  });

  test("лента журнала отдаёт причины дословно, но кандидатов — обезличенно", () => {
    ledger.registerCandidates([spec()]);
    const id = [...ledger.allCandidateIds()][0];
    ledger.transition(id, "REJECTED", "халвинг-16: матожидание −0.035R ≤ 0 после издержек");

    const status = build();
    expect(status.recentJournal).toHaveLength(1);
    expect(status.recentJournal[0].reason).toBe(
      "халвинг-16: матожидание −0.035R ≤ 0 после издержек",
    );
    expect(status.recentJournal[0].ref).toBe("пробой · 1h · long");
    expect(status.ledger.census.REJECTED).toBe(1);
  });

  test("инкубируемые показывают прогресс без формулы", () => {
    ledger.registerCandidates([spec({ setup: "pullback_rsi_45", timeframe: "4h" })]);
    const id = [...ledger.allCandidateIds()][0];
    for (const to of ["SCREENED", "VALIDATED", "INCUBATING"] as const) ledger.transition(id, to, "тест");
    ledger.recordEval(id, "incubation_check", { trades: 12, days: 30, llr: 0.6, decision: "continue" });
    book.start({
      candidateId: id,
      tf: "4h",
      symbols: ["BTCUSDT"],
      mu1: 0.15,
      sigma: 1,
      expectedN: 80,
      frozenAt: 1_700_000_000,
    });

    const status = build();
    expect(status.incubating).toEqual([
      { ref: "откат · 4h · long", trades: 12, needTrades: 40, days: 30, needDays: 120, llr: 0.6 },
    ]);
  });
});

describe("СТРАЖ ПРИВАТНОСТИ", () => {
  test("в опубликованном JSON нет ни одной полной формулы — ни живой, ни мёртвой", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "guard-")), "trials.sqlite");
    const ledger = new TrialLedger(dbPath);
    const book = new IncubationBook(dbPath);

    // Кандидаты во ВСЕХ состояниях сразу: мёртвые, живые, выпускники.
    const batch = sampleCandidates(7, 12);
    ledger.registerCandidates(batch);
    const ids = [...ledger.allCandidateIds()];
    ledger.transition(ids[0], "REJECTED", "халвинг-16: матожидание ≤ 0 после издержек");
    ledger.transition(ids[1], "SCREENED", "прошёл деление пополам");
    ledger.transition(ids[2], "SCREENED", "прошёл");
    ledger.transition(ids[2], "VALIDATED", "прошёл гаунтлет");
    for (const to of ["SCREENED", "VALIDATED", "INCUBATING"] as const) ledger.transition(ids[3], to, "т");
    ledger.recordEval(ids[3], "incubation_check", { trades: 5, days: 9, llr: -0.4 });
    for (const to of ["SCREENED", "VALIDATED", "INCUBATING", "GRADUATED"] as const)
      ledger.transition(ids[4], to, "т");
    for (const to of ["SCREENED", "VALIDATED", "INCUBATING", "KILLED"] as const)
      ledger.transition(ids[5], to, "т");

    const json = JSON.stringify(
      buildStatus({
        screens: [screen("1h", 12, 5, 2)],
        incubation: emptyIncubation,
        supervision: emptySupervision,
        ledger,
        book,
        states: STATES,
        now: NOW,
      }),
    );

    // 1. Разделитель формулы не встречается вовсе.
    expect(json).not.toContain("|");
    // 2. Ни одного id сетапа или фильтра из грамматики.
    for (const setup of SETUPS) expect(json).not.toContain(setup.id);
    for (const filter of FILTERS) expect(json).not.toContain(filter.id);
    // 3. Ни одной закодированной сетки выхода (s2t2b20).
    expect(json).not.toMatch(/s\d+(\.\d+)?t\d+b\d+/);
    // 4. И при этом файл не пустой — обезличенные ссылки на месте.
    expect(json).toContain(" · ");

    ledger.close();
    book.close();
  });
});
