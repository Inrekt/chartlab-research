import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { sampleCandidates } from "./grammar.ts";
import { TrialLedger } from "./ledger.ts";

let ledger: TrialLedger;
let tick = 0;

beforeEach(() => {
  tick = 0;
  ledger = new TrialLedger(":memory:", {
    now: () => new Date(1_700_000_000_000 + ++tick * 1000).toISOString(),
  });
});

afterEach(() => ledger.close());

const specs = sampleCandidates(99, 20);
const id = (i: number) => ledger.byState("CANDIDATE")[i]?.candidateId ?? firstId();
const firstId = () => {
  const all = [
    ...ledger.byState("CANDIDATE"),
    ...ledger.byState("SCREENED"),
    ...ledger.byState("VALIDATED"),
    ...ledger.byState("INCUBATING"),
    ...ledger.byState("GRADUATED"),
    ...ledger.byState("DECAYING"),
  ];
  return all[0]!.candidateId;
};

describe("registration", () => {
  test("inserts a batch once, silently skips resubmission", () => {
    expect(ledger.registerCandidates(specs)).toEqual({ inserted: 20, skipped: 0 });
    expect(ledger.registerCandidates(specs)).toEqual({ inserted: 0, skipped: 20 });
    expect(ledger.counts().trials).toBe(20);
  });

  test("counts clusters distinctly for DSR N_eff", () => {
    ledger.registerCandidates(specs);
    const { trials, clusters } = ledger.counts();
    expect(clusters).toBeGreaterThan(0);
    expect(clusters).toBeLessThanOrEqual(trials);
  });
});

describe("state machine", () => {
  beforeEach(() => ledger.registerCandidates(specs));

  test("forward path CANDIDATE→…→GRADUATED works and is journaled", () => {
    const candidate = id(0);
    ledger.transition(candidate, "SCREENED", "прошёл ночной скрин");
    ledger.transition(candidate, "VALIDATED", "прошёл гаунтлет");
    ledger.transition(candidate, "INCUBATING", "запущен в инкубатор");
    ledger.transition(candidate, "GRADUATED", "SPRT принял H1");
    expect(ledger.getTrial(candidate)!.state).toBe("GRADUATED");
  });

  test("backward and skipping transitions are rejected", () => {
    const candidate = id(0);
    ledger.transition(candidate, "SCREENED", "ok");
    expect(() => ledger.transition(candidate, "CANDIDATE", "назад")).toThrow(/запрещённый/);
    expect(() => ledger.transition(candidate, "INCUBATING", "перепрыгнуть")).toThrow(/запрещённый/);
  });

  test("terminal states accept nothing", () => {
    const candidate = id(0);
    ledger.transition(candidate, "REJECTED", "нуль-модель не пройдена");
    expect(() => ledger.transition(candidate, "SCREENED", "воскрешение")).toThrow(/запрещённый/);
  });

  test("requalification DECAYING→GRADUATED is allowed exactly once", () => {
    const candidate = id(0);
    for (const [to, why] of [
      ["SCREENED", "скрин"],
      ["VALIDATED", "гаунтлет"],
      ["INCUBATING", "инкубатор"],
      ["GRADUATED", "выпуск"],
      ["DECAYING", "CUSUM сигналит"],
      ["GRADUATED", "реквалификация"],
      ["DECAYING", "CUSUM снова"],
    ] as const) {
      ledger.transition(candidate, to, why);
    }
    expect(() => ledger.transition(candidate, "GRADUATED", "вторая реквалификация")).toThrow(
      /уже использована/,
    );
  });

  test("unknown candidate cannot transition or record evals", () => {
    expect(() => ledger.transition("no-such-id", "SCREENED", "x")).toThrow(/незарегистрированного/);
    expect(() => ledger.recordEval("no-such-id", "screen", {})).toThrow(/незарегистрированного/);
  });
});

describe("append-only enforcement (triggers, not discipline)", () => {
  beforeEach(() => {
    ledger.registerCandidates(specs);
    ledger.recordEval(firstId(), "screen", { sharpe: 1.2, trades: 44 });
    ledger.transition(firstId(), "SCREENED", "ok");
  });

  const raw = () =>
    (ledger as unknown as { db: import("node:sqlite").DatabaseSync }).db;

  test("evals reject UPDATE and DELETE", () => {
    expect(() => raw().exec("UPDATE evals SET metrics_json = '{}'")).toThrow(/append-only/);
    expect(() => raw().exec("DELETE FROM evals")).toThrow(/append-only/);
  });

  test("transitions reject UPDATE and DELETE", () => {
    expect(() => raw().exec("UPDATE transitions SET to_state = 'GRADUATED'")).toThrow(
      /append-only/,
    );
    expect(() => raw().exec("DELETE FROM transitions")).toThrow(/append-only/);
  });

  test("trial identity is immutable, rows are never deleted", () => {
    expect(() => raw().exec("UPDATE trials SET spec_json = '{}'")).toThrow(/immutable/);
    expect(() => raw().exec("UPDATE trials SET created_at = '1970-01-01'")).toThrow(/immutable/);
    expect(() => raw().exec("DELETE FROM trials")).toThrow(/never deleted/);
  });

  test("cluster_key refinement is the one allowed trial edit", () => {
    const candidate = firstId();
    ledger.setClusterKey(candidate, "real-cluster-7");
    expect(ledger.getTrial(candidate)!.clusterKey).toBe("real-cluster-7");
  });
});
