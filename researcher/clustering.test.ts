import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  alignedPearson,
  CLUSTER_RHO,
  CorrelationClusterer,
  weeklyFingerprint,
  type Fingerprint,
} from "./clustering.ts";

const series = (weeks: number, gen: (w: number) => number, startWeek = 0): Fingerprint => ({
  startWeek,
  values: Array.from({ length: weeks }, (_, w) => gen(w)),
});

describe("weeklyFingerprint", () => {
  test("buckets daily sums by ABSOLUTE week so nights align", () => {
    const a = weeklyFingerprint([1, 1, 1, 1, 1, 1, 1, 2, 2], 0); // дни 0..8
    expect(a.startWeek).toBe(0);
    expect(a.values).toEqual([7, 4]);
    // те же данные, но ряд начинается со дня 3 — недельные границы совпадают
    const b = weeklyFingerprint([1, 1, 1, 1, 2, 2], 3);
    expect(b.startWeek).toBe(0);
    expect(b.values[0]).toBe(4);
  });
});

describe("alignedPearson", () => {
  test("identical series → 1, inverted → −1", () => {
    const a = series(40, (w) => Math.sin(w / 3));
    expect(alignedPearson(a, a)).toBeCloseTo(1, 10);
    expect(alignedPearson(a, series(40, (w) => -Math.sin(w / 3)))).toBeCloseTo(-1, 10);
  });

  test("insufficient overlap or zero variance → null (not comparable)", () => {
    const a = series(40, (w) => w % 3);
    expect(alignedPearson(a, series(40, (w) => w % 3, 30))).toBeNull(); // 10 общих недель
    expect(alignedPearson(a, series(40, () => 0.5))).toBeNull();
  });
});

describe("CorrelationClusterer", () => {
  const db = () => join(mkdtempSync(join(tmpdir(), "clu-")), "t.sqlite");

  test("same idea joins the same cluster, orthogonal founds a new one", () => {
    const c = new CorrelationClusterer(db());
    const wave = series(52, (w) => Math.sin(w / 4));
    const key = c.clusterFor(wave, "1h");
    // слегка зашумлённая та же идея — корреляция выше порога
    const noisy = series(52, (w) => Math.sin(w / 4) + 0.05 * Math.cos(w * 7));
    expect(c.clusterFor(noisy, "1h")).toBe(key);
    // ортогональная идея — новый кластер
    const other = c.clusterFor(series(52, (w) => (w % 2 === 0 ? 1 : -1)), "1h");
    expect(other).not.toBe(key);
    c.close();
  });

  test("identical fingerprints on DIFFERENT timeframes never share a cluster", () => {
    const c = new CorrelationClusterer(db());
    const wave = series(52, (w) => Math.sin(w / 4));
    const h1 = c.clusterFor(wave, "1h");
    const h4 = c.clusterFor(wave, "4h");
    // суточные PnL часового и четырёхчасового прогонов — разные ряды;
    // эпоха-1 смешивала их в одном пространстве без обоснования
    expect(h1).not.toBe(h4);
    expect(h1).toContain(":1h:");
    expect(h4).toContain(":4h:");
    c.close();
  });

  test("representatives persist across reopen and are append-only", () => {
    const path = db();
    const c1 = new CorrelationClusterer(path);
    const key = c1.clusterFor(series(52, (w) => Math.cos(w / 5)), "1h");
    c1.close();
    const c2 = new CorrelationClusterer(path);
    expect(c2.clusterFor(series(52, (w) => Math.cos(w / 5)), "1h")).toBe(key);
    const raw = (c2 as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    expect(() => raw.exec("UPDATE cluster_reps SET values_json='[]'")).toThrow(/append-only/);
    expect(() => raw.exec("DELETE FROM cluster_reps")).toThrow(/append-only/);
    c2.close();
  });

  test("legacy epoch-1 representatives (tf NULL) are never matched", () => {
    const path = db();
    const c1 = new CorrelationClusterer(path);
    // представитель эпохи-1: вставлен без tf, как это делал старый код
    const raw = (c1 as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    raw
      .prepare(
        "INSERT INTO cluster_reps(cluster_key, start_week, values_json, created_at) VALUES (?, ?, ?, ?)",
      )
      .run("corr:7", 0, JSON.stringify(series(52, (w) => Math.sin(w / 4)).values), "2026-07-25");
    c1.close();
    const c2 = new CorrelationClusterer(path);
    // тот же отпечаток НЕ прилипает к legacy-представителю — основывает свой
    const key = c2.clusterFor(series(52, (w) => Math.sin(w / 4)), "1h");
    expect(key).not.toBe("corr:7");
    c2.close();
  });

  test("threshold is the documented CLUSTER_RHO", () => {
    expect(CLUSTER_RHO).toBe(0.7);
  });
});
