/**
 * Журнал испытаний — сердце честности исследователя.
 *
 * Каждый кандидат, КОГДА-ЛИБО поданный на скрин, остаётся здесь навсегда:
 * дефляция (DSR) берёт N из этого журнала, поэтому строки не удаляются и не
 * переписываются — append-only охраняют SQLite-триггеры, а не дисциплина.
 * Состояния движутся только вперёд (единственное исключение — одна
 * реквалификация DECAYING→GRADUATED за жизнь, как в архитектурном доке).
 *
 * SQLite через node:sqlite (Node ≥ 24, без внешних зависимостей), WAL —
 * демон пишет, утренний дайджест читает параллельно.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { candidateId, defaultClusterKey, setupFamily, type CandidateSpec } from "./grammar.ts";

export const STATES = [
  "CANDIDATE",
  "SCREENED",
  "VALIDATED",
  "INCUBATING",
  "GRADUATED",
  "DECAYING",
  "RETIRED",
  "REJECTED",
  "KILLED",
] as const;
export type TrialState = (typeof STATES)[number];

/** Переходы только вперёд; REJECTED/KILLED/RETIRED — терминальные. */
const ALLOWED: Readonly<Record<TrialState, readonly TrialState[]>> = {
  CANDIDATE: ["SCREENED", "REJECTED"],
  SCREENED: ["VALIDATED", "REJECTED"],
  VALIDATED: ["INCUBATING", "REJECTED"],
  INCUBATING: ["GRADUATED", "KILLED"],
  GRADUATED: ["DECAYING", "RETIRED"],
  DECAYING: ["RETIRED", "GRADUATED"],
  RETIRED: [],
  REJECTED: [],
  KILLED: [],
};

export interface TrialRow {
  candidateId: string;
  spec: CandidateSpec;
  setupFamily: string;
  clusterKey: string;
  state: TrialState;
  createdAt: string;
  updatedAt: string;
}

export interface TrialCounts {
  /** Всего испытаний за всю жизнь журнала — сырое N. */
  trials: number;
  /** Число корреляционных кластеров — N_eff для DSR. */
  clusters: number;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trials (
  candidate_id TEXT PRIMARY KEY,
  spec_json TEXT NOT NULL,
  setup_family TEXT NOT NULL,
  cluster_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'CANDIDATE',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trials_state ON trials(state);
CREATE INDEX IF NOT EXISTS idx_trials_cluster ON trials(cluster_key);
CREATE TABLE IF NOT EXISTS evals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id TEXT NOT NULL REFERENCES trials(candidate_id),
  stage TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evals_candidate ON evals(candidate_id);
CREATE TABLE IF NOT EXISTS transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id TEXT NOT NULL REFERENCES trials(candidate_id),
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transitions_candidate ON transitions(candidate_id);

-- Append-only не дисциплиной, а триггерами: UPDATE/DELETE падают в самой БД.
CREATE TRIGGER IF NOT EXISTS evals_append_only BEFORE UPDATE ON evals
BEGIN SELECT RAISE(ABORT, 'evals is append-only'); END;
CREATE TRIGGER IF NOT EXISTS evals_no_delete BEFORE DELETE ON evals
BEGIN SELECT RAISE(ABORT, 'evals is append-only'); END;
CREATE TRIGGER IF NOT EXISTS transitions_append_only BEFORE UPDATE ON transitions
BEGIN SELECT RAISE(ABORT, 'transitions is append-only'); END;
CREATE TRIGGER IF NOT EXISTS transitions_no_delete BEFORE DELETE ON transitions
BEGIN SELECT RAISE(ABORT, 'transitions is append-only'); END;
-- Личность испытания неизменна; менять можно state/updated_at и (однократно,
-- при настоящей кластеризации по доходностям) cluster_key.
CREATE TRIGGER IF NOT EXISTS trials_identity_immutable BEFORE UPDATE ON trials
WHEN OLD.candidate_id != NEW.candidate_id
  OR OLD.spec_json != NEW.spec_json
  OR OLD.setup_family != NEW.setup_family
  OR OLD.created_at != NEW.created_at
BEGIN SELECT RAISE(ABORT, 'trial identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trials_no_delete BEFORE DELETE ON trials
BEGIN SELECT RAISE(ABORT, 'trials are never deleted'); END;
`;

export class TrialLedger {
  private readonly db: DatabaseSync;
  private readonly now: () => string;

  constructor(path: string, opts?: { now?: () => string }) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // Демон и интерактивные запуски делят один файл: без busy_timeout второй
    // писатель падал бы SQLITE_BUSY вместо короткого ожидания.
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.now = opts?.now ?? (() => new Date().toISOString());
    this.db.exec(SCHEMA);
    this.db
      .prepare("INSERT OR IGNORE INTO meta(key, value) VALUES('schema_version', '1')")
      .run();
  }

  /**
   * Регистрирует партию кандидатов. Повторная подача того же id молча
   * пропускается — попытка уже посчитана, второй раз она N не увеличивает.
   */
  registerCandidates(specs: readonly CandidateSpec[]): { inserted: number; skipped: number } {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO trials
         (candidate_id, spec_json, setup_family, cluster_key, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'CANDIDATE', ?, ?)`,
    );
    let inserted = 0;
    const at = this.now();
    this.db.exec("BEGIN");
    try {
      for (const spec of specs) {
        const result = stmt.run(
          candidateId(spec),
          JSON.stringify(spec),
          setupFamily(spec.setup),
          defaultClusterKey(spec),
          at,
          at,
        );
        inserted += Number(result.changes);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { inserted, skipped: specs.length - inserted };
  }

  /** Записывает результат прогона стадии (скрин/гаунтлет/инкубатор). */
  recordEval(candidate: string, stage: string, metrics: Record<string, unknown>): void {
    const exists = this.getTrial(candidate);
    if (!exists) throw new Error(`eval для незарегистрированного кандидата: ${candidate}`);
    this.db
      .prepare("INSERT INTO evals(candidate_id, stage, metrics_json, created_at) VALUES (?, ?, ?, ?)")
      .run(candidate, stage, JSON.stringify(metrics), this.now());
  }

  /** Переход состояния — только по разрешённому ребру, с причиной в журнале. */
  transition(candidate: string, to: TrialState, reason: string): void {
    const trial = this.getTrial(candidate);
    if (!trial) throw new Error(`переход для незарегистрированного кандидата: ${candidate}`);
    const from = trial.state;
    if (!ALLOWED[from].includes(to)) {
      throw new Error(`запрещённый переход ${from} → ${to} для ${candidate}`);
    }
    if (from === "DECAYING" && to === "GRADUATED") {
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM transitions
           WHERE candidate_id = ? AND from_state = 'DECAYING' AND to_state = 'GRADUATED'`,
        )
        .get(candidate) as { n: number };
      if (row.n >= 1) {
        throw new Error(`реквалификация ${candidate} уже использована (одна за жизнь)`);
      }
    }
    const at = this.now();
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "INSERT INTO transitions(candidate_id, from_state, to_state, reason, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(candidate, from, to, reason, at);
      this.db
        .prepare("UPDATE trials SET state = ?, updated_at = ? WHERE candidate_id = ?")
        .run(to, at, candidate);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Однократное уточнение кластера после настоящей кластеризации доходностей. */
  setClusterKey(candidate: string, clusterKey: string): void {
    const trial = this.getTrial(candidate);
    if (!trial) throw new Error(`незарегистрированный кандидат: ${candidate}`);
    // «Однократное» — проверкой, а не комментарием: уточнять можно только
    // эвристический ключ по умолчанию, перезапись уточнённого запрещена.
    if (trial.clusterKey !== defaultClusterKey(trial.spec)) {
      throw new Error(`кластер ${candidate} уже уточнён — повторное уточнение запрещено`);
    }
    this.db
      .prepare("UPDATE trials SET cluster_key = ?, updated_at = ? WHERE candidate_id = ?")
      .run(clusterKey, this.now(), candidate);
  }

  getTrial(candidate: string): TrialRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM trials WHERE candidate_id = ?")
      .get(candidate) as Record<string, unknown> | undefined;
    return row ? toTrialRow(row) : undefined;
  }

  byState(state: TrialState): TrialRow[] {
    const rows = this.db
      .prepare("SELECT * FROM trials WHERE state = ? ORDER BY created_at")
      .all(state) as Record<string, unknown>[];
    return rows.map(toTrialRow);
  }

  /**
   * Последние переходы по всему журналу, свежие первыми — лента для монитора.
   * Отдаёт candidateId, но наружу он не уходит: status.ts обезличивает всё
   * через publicRef перед публикацией.
   */
  recentTransitions(
    limit: number,
  ): { candidateId: string; toState: TrialState; reason: string; createdAt: string }[] {
    const rows = this.db
      .prepare("SELECT * FROM transitions ORDER BY id DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      candidateId: r.candidate_id as string,
      toState: r.to_state as TrialState,
      reason: r.reason as string,
      createdAt: r.created_at as string,
    }));
  }

  /** История переходов кандидата — источник таймштампов заморозки/выпуска. */
  transitionsFor(
    candidate: string,
  ): { fromState: TrialState; toState: TrialState; reason: string; createdAt: string }[] {
    const rows = this.db
      .prepare("SELECT * FROM transitions WHERE candidate_id = ? ORDER BY id")
      .all(candidate) as Record<string, unknown>[];
    return rows.map((r) => ({
      fromState: r.from_state as TrialState,
      toState: r.to_state as TrialState,
      reason: r.reason as string,
      createdAt: r.created_at as string,
    }));
  }

  /** Записи оценок кандидата (опционально по стадии), в порядке появления. */
  evalsFor(
    candidate: string,
    stage?: string,
  ): { stage: string; metrics: Record<string, unknown>; createdAt: string }[] {
    const rows = (
      stage
        ? this.db
            .prepare("SELECT * FROM evals WHERE candidate_id = ? AND stage = ? ORDER BY id")
            .all(candidate, stage)
        : this.db.prepare("SELECT * FROM evals WHERE candidate_id = ? ORDER BY id").all(candidate)
    ) as Record<string, unknown>[];
    return rows.map((r) => ({
      stage: r.stage as string,
      metrics: JSON.parse(r.metrics_json as string) as Record<string, unknown>,
      createdAt: r.created_at as string,
    }));
  }

  /** Все id, когда-либо поданные, — чтобы генератор не выдавал повторов. */
  allCandidateIds(): Set<string> {
    const rows = this.db.prepare("SELECT candidate_id FROM trials").all() as {
      candidate_id: string;
    }[];
    return new Set(rows.map((r) => r.candidate_id));
  }

  /** N для дефляции: сырое число попыток и число кластеров (N_eff). */
  counts(): TrialCounts {
    const row = this.db
      .prepare("SELECT COUNT(*) AS trials, COUNT(DISTINCT cluster_key) AS clusters FROM trials")
      .get() as { trials: number; clusters: number };
    return { trials: row.trials, clusters: row.clusters };
  }

  close(): void {
    this.db.close();
  }
}

function toTrialRow(row: Record<string, unknown>): TrialRow {
  return {
    candidateId: row.candidate_id as string,
    spec: JSON.parse(row.spec_json as string) as CandidateSpec,
    setupFamily: row.setup_family as string,
    clusterKey: row.cluster_key as string,
    state: row.state as TrialState,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}
