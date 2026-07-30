import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { behavioralExclusionFor, markEpoch, reconstructRunTf } from "./epochs.ts";
import { behavioralId, sampleCandidates, type CandidateSpec } from "./grammar.ts";
import { TrialLedger } from "./ledger.ts";

describe("reconstructRunTf", () => {
  test("two batches within one night → 1h then 4h; next night restarts", () => {
    const map = reconstructRunTf([
      "2026-07-24T22:38:00.000Z",
      "2026-07-24T23:41:00.000Z",
      "2026-07-25T22:40:00.000Z",
      "2026-07-25T23:44:00.000Z",
    ]);
    expect(map.get("2026-07-24T22:38:00.000Z")).toBe("1h");
    expect(map.get("2026-07-24T23:41:00.000Z")).toBe("4h");
    expect(map.get("2026-07-25T22:40:00.000Z")).toBe("1h");
    expect(map.get("2026-07-25T23:44:00.000Z")).toBe("4h");
  });

  test("a lone batch (pilot night) is the first tf of the night order", () => {
    const map = reconstructRunTf(["2026-07-24T10:00:00.000Z"]);
    expect(map.get("2026-07-24T10:00:00.000Z")).toBe("1h");
  });

  test("duplicates and unsorted input are tolerated", () => {
    const map = reconstructRunTf([
      "2026-07-24T23:41:00.000Z",
      "2026-07-24T22:38:00.000Z",
      "2026-07-24T22:38:00.000Z",
    ]);
    expect(map.size).toBe(2);
    expect(map.get("2026-07-24T22:38:00.000Z")).toBe("1h");
    expect(map.get("2026-07-24T23:41:00.000Z")).toBe("4h");
  });
});

describe("behavioralExclusionFor + sampler integration", () => {
  const freshDb = () => join(mkdtempSync(join(tmpdir(), "epo-")), "t.sqlite");

  const registerBatch = (
    dbPath: string,
    specs: CandidateSpec[],
    at: string,
  ): void => {
    const ledger = new TrialLedger(dbPath, { now: () => at });
    ledger.registerCandidates(specs);
    ledger.close();
  };

  test("a rule burned in an epoch-1 night blocks its ACTUAL corpus, not its label", () => {
    const dbPath = freshDb();
    // Эпоха-1: партия «1h-ночи» — метки ТФ случайные (без опции tf),
    // но реально всё гонялось на 1h-корпусе.
    const epoch1 = sampleCandidates(42, 50);
    registerBatch(dbPath, epoch1, "2026-07-24T22:38:00.000Z");

    const exclude1h = behavioralExclusionFor(dbPath, "1h");
    const exclude4h = behavioralExclusionFor(dbPath, "4h");

    // ВСЕ правила партии (независимо от ярлыка "1d"/"4h") считаются
    // прогнанными на 1h — и ни одно на 4h.
    for (const spec of epoch1) {
      expect(exclude1h.has(behavioralId(spec))).toBe(true);
      expect(exclude4h.has(behavioralId(spec))).toBe(false);
    }
  });

  test("epoch-2 rows trust their own tf label", () => {
    const dbPath = freshDb();
    markEpoch(dbPath, () => "2026-07-31T00:00:00.000Z");
    // meta существует только после первого ledger open? markEpoch создал БД —
    // но таблицы trials нет; создаём через ledger и регистрируем партию 4h.
    const epoch2 = sampleCandidates(7, 30, undefined, { tf: "4h" });
    registerBatch(dbPath, epoch2, "2026-07-31T21:40:00.000Z");
    markEpoch(dbPath, () => "2026-07-31T00:00:00.000Z");

    const exclude4h = behavioralExclusionFor(dbPath, "4h");
    const exclude1h = behavioralExclusionFor(dbPath, "1h");
    for (const spec of epoch2) {
      expect(exclude4h.has(behavioralId(spec))).toBe(true);
      expect(exclude1h.has(behavioralId(spec))).toBe(false);
    }
  });

  test("markEpoch is write-once", () => {
    const dbPath = freshDb();
    markEpoch(dbPath, () => "2026-07-31T00:00:00.000Z");
    markEpoch(dbPath, () => "2026-08-15T00:00:00.000Z");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT value FROM meta WHERE key='epoch2_since'").get() as {
      value: string;
    };
    db.close();
    expect(row.value).toBe("2026-07-31T00:00:00.000Z");
  });

  test("sampler with excludeBehavioral never re-emits a burned rule", () => {
    const dbPath = freshDb();
    const epoch1 = sampleCandidates(42, 100);
    registerBatch(dbPath, epoch1, "2026-07-24T22:38:00.000Z");
    const exclude = behavioralExclusionFor(dbPath, "1h");

    const fresh = sampleCandidates(1234, 200, undefined, { tf: "1h", excludeBehavioral: exclude });
    for (const spec of fresh) {
      expect(exclude.has(behavioralId(spec))).toBe(false);
      expect(spec.timeframe).toBe("1h");
    }
  });
});
