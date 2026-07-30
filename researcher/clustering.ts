/**
 * Кластеризация испытаний по КОРРЕЛЯЦИИ доходностей — честный N_eff для
 * дефляции (формула DSR считает независимые испытания, а не строки журнала).
 *
 * Ключевая проблема, которую это решает: статические ключи
 * «семейство×ТФ×направление» насыщаются на 54, а сырое число строк завышает
 * N (две вариации одной идеи — не два независимых испытания). Здесь каждый
 * кандидат получает недельный отпечаток доходностей (стадия-16 — одни и те
 * же символы каждую ночь, отпечатки сравнимы между ночами), и попадает в
 * первый кластер, с представителем которого коррелирует ρ ≥ 0.7; иначе
 * основывает новый. Представители append-only — историю кластеров нельзя
 * переписать, как и сам журнал.
 */
import { DatabaseSync } from "node:sqlite";

/** Порог «это та же идея»: |ρ| недельных доходностей. */
export const CLUSTER_RHO = 0.7;
/** Минимальное пересечение недель для сравнимости; меньше — считаем разными. */
export const MIN_OVERLAP_WEEKS = 26;

export interface Fingerprint {
  /** Абсолютный номер первой недели (unix-день / 7). */
  startWeek: number;
  values: number[];
}

/** Суточный ряд → недельные суммы по абсолютной неделе (выравнивание ночей). */
export function weeklyFingerprint(daily: ArrayLike<number>, startDay: number): Fingerprint {
  const startWeek = Math.floor(startDay / 7);
  const endWeek = Math.floor((startDay + daily.length - 1) / 7);
  const values = new Array<number>(endWeek - startWeek + 1).fill(0);
  for (let d = 0; d < daily.length; d++) {
    values[Math.floor((startDay + d) / 7) - startWeek] += daily[d];
  }
  return { startWeek, values: values.map((v) => Number(v.toFixed(6))) };
}

/** Пирсон по пересекающимся неделям; null — ряды несравнимы или вырождены. */
export function alignedPearson(a: Fingerprint, b: Fingerprint): number | null {
  const from = Math.max(a.startWeek, b.startWeek);
  const to = Math.min(a.startWeek + a.values.length, b.startWeek + b.values.length);
  const n = to - from;
  if (n < MIN_OVERLAP_WEEKS) return null;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    sa += a.values[from - a.startWeek + i];
    sb += b.values[from - b.startWeek + i];
  }
  const ma = sa / n;
  const mb = sb / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a.values[from - a.startWeek + i] - ma;
    const db = b.values[from - b.startWeek + i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (va === 0 || vb === 0) return null;
  return cov / Math.sqrt(va * vb);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cluster_reps (
  cluster_key TEXT PRIMARY KEY,
  start_week INTEGER NOT NULL,
  values_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS cluster_reps_append_only BEFORE UPDATE ON cluster_reps
BEGIN SELECT RAISE(ABORT, 'cluster_reps is append-only'); END;
CREATE TRIGGER IF NOT EXISTS cluster_reps_no_delete BEFORE DELETE ON cluster_reps
BEGIN SELECT RAISE(ABORT, 'cluster_reps is append-only'); END;
`;

export class CorrelationClusterer {
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private reps: { key: string; tf: string | null; fp: Fingerprint }[] | null = null;

  constructor(path: string, opts?: { now?: () => string }) {
    this.db = new DatabaseSync(path);
    this.now = opts?.now ?? (() => new Date().toISOString());
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    // Миграция эпохи-2: колонка ТФ. ALTER не трогает append-only триггеры
    // (они защищают строки, не схему); старые представители остаются с NULL —
    // это смешанная эпоха-1, к ней новые отпечатки не примеряются.
    const cols = this.db.prepare("PRAGMA table_info(cluster_reps)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "tf")) {
      this.db.exec("ALTER TABLE cluster_reps ADD COLUMN tf TEXT");
    }
  }

  private loadReps(): { key: string; tf: string | null; fp: Fingerprint }[] {
    if (this.reps) return this.reps;
    const rows = this.db
      .prepare("SELECT cluster_key, tf, start_week, values_json FROM cluster_reps ORDER BY rowid")
      .all() as { cluster_key: string; tf: string | null; start_week: number; values_json: string }[];
    this.reps = rows.map((r) => ({
      key: r.cluster_key,
      tf: r.tf,
      fp: { startWeek: r.start_week, values: JSON.parse(r.values_json) as number[] },
    }));
    return this.reps;
  }

  /**
   * Возвращает ключ кластера для отпечатка: первый представитель ТОГО ЖЕ ТФ
   * с |ρ| ≥ 0.7, иначе отпечаток сам становится представителем нового
   * кластера. Сравнение только внутри ТФ: суточные PnL часового и
   * четырёхчасового прогонов — разные ряды, эпоха-1 смешивала их в одном
   * жадном проходе без обоснования.
   */
  clusterFor(fp: Fingerprint, tf: string): string {
    const reps = this.loadReps();
    let sameTf = 0;
    for (const rep of reps) {
      if (rep.tf !== tf) continue;
      sameTf += 1;
      const rho = alignedPearson(fp, rep.fp);
      if (rho !== null && Math.abs(rho) >= CLUSTER_RHO) return rep.key;
    }
    const key = `corr:${tf}:${sameTf + 1}`;
    this.db
      .prepare(
        "INSERT INTO cluster_reps(cluster_key, tf, start_week, values_json, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(key, tf, fp.startWeek, JSON.stringify(fp.values), this.now());
    reps.push({ key, tf, fp });
    return key;
  }

  close(): void {
    this.db.close();
  }
}
