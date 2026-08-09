import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { sampleCandidates, setupFamily } from "./grammar.ts";
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

  test("записывает происхождение испытания и не переписывает его при повторе", () => {
    // Без этих четырёх полей результат конкретной ночи невоспроизводим, а
    // испытания разных эпох (спотовый корпус против фьючерсного) неразличимы
    // в счётчике проб — то есть планка дефляции считается по чужому рынку.
    ledger.registerCandidates(specs.slice(0, 3), {
      gitSha: "abc1234",
      batchSeed: 42,
      gateVersion: 5,
      corpusVersion: "perp:162:2019-09-08",
    });
    const rows = ledger.byState("CANDIDATE");
    expect(rows).toHaveLength(3);

    const raw = ledger.provenanceOf(rows[0]!.candidateId);
    expect(raw).toEqual({
      gitSha: "abc1234",
      batchSeed: 42,
      gateVersion: 5,
      corpusVersion: "perp:162:2019-09-08",
    });

    // Повторная подача той же спеки молча пропускается (попытка уже
    // посчитана) — и происхождение обязано остаться ПЕРВЫМ. Иначе поздний
    // прогон переписал бы историю измерений задним числом.
    ledger.registerCandidates(specs.slice(0, 3), {
      gitSha: "deadbee",
      batchSeed: 999,
      gateVersion: 6,
      corpusVersion: "spot:170:2021-07-11",
    });
    expect(ledger.provenanceOf(rows[0]!.candidateId)).toEqual(raw);
  });

  test("старые записи без происхождения читаются как пустые, а не падают", () => {
    // Журнал append-only: 56 374 записи существуют без этих полей, и это
    // ЧЕСТНО — у них этих данных действительно не было.
    ledger.registerCandidates(specs.slice(0, 2));
    const row = ledger.byState("CANDIDATE")[0]!;
    expect(ledger.provenanceOf(row.candidateId)).toEqual({
      gitSha: null,
      batchSeed: null,
      gateVersion: null,
      corpusVersion: null,
    });
  });

  test("карантин возвращает отравленные комбинации в поиск, не трогая журнал", () => {
    // Авария COLLECT_DIR записала 216 испытаний funding_pressure с нулём
    // сделок. Записи честны, удалять их нельзя. Но сэмплер исключает всё
    // когда-либо поданное — и эти комбинации оказались закрыты НАВСЕГДА
    // вердиктом, который измерением не был. Семейство стёрли не рынком, а багом.
    ledger.registerCandidates(specs.slice(0, 5));
    const rows = ledger.byState("CANDIDATE");
    const family = setupFamily(ledger.getTrial(rows[0]!.candidateId)!.spec.setup);

    expect(ledger.resamplableExclusions().size).toBe(ledger.allCandidateIds().size);

    ledger.quarantineEpoch(
      family,
      "1970-01-01T00:00:00.000Z",
      "2100-01-01T00:00:00.000Z",
      "нет каталога фандинга на раннере",
    );

    // Журнал НЕ уменьшился — карантин это запись, а не удаление.
    expect(ledger.counts().trials).toBe(5);
    expect(ledger.allCandidateIds().size).toBe(5);
    // А сэмплеру эти комбинации снова доступны.
    expect(ledger.resamplableExclusions().size).toBeLessThan(5);
    expect(ledger.quarantines()[0]!.reason).toMatch(/фандинг/);
  });

  test("карантин append-only: переписать и удалить нельзя", () => {
    ledger.registerCandidates(specs.slice(0, 2));
    ledger.quarantineEpoch("x", "2020-01-01", "2020-12-31", "тест");
    const raw = (ledger as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    expect(() => raw.exec("UPDATE quarantine SET reason = 'другое'")).toThrow(/append-only/);
    expect(() => raw.exec("DELETE FROM quarantine")).toThrow(/append-only/);
  });

  test("карантин ограничен окном дат, а не списком id", () => {
    // Перечисление id позволило бы вычеркнуть отдельные НЕУДОБНЫЕ испытания —
    // это была бы подгонка. Причина отравления всегда временна́я.
    ledger.registerCandidates(specs.slice(0, 3));
    const family = setupFamily(ledger.getTrial(ledger.byState("CANDIDATE")[0]!.candidateId)!.spec.setup);
    ledger.quarantineEpoch(family, "1990-01-01", "1990-12-31", "окно в прошлом");
    expect(ledger.quarantinedIds().size).toBe(0);
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
