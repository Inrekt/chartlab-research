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

/**
 * Происхождение испытания — четыре поля, без которых результат ночи
 * невоспроизводим, а испытания разных эпох неразличимы в счётчике проб.
 *
 * Заполняется при регистрации и больше НИКОГДА не меняется: журнал
 * append-only, и переписать происхождение задним числом означало бы
 * подделать историю измерений.
 */
export interface Provenance {
  /** Версия кода, которым считалось. */
  gitSha?: string;
  /** Сид партии — детерминизм выборки кандидатов. */
  batchSeed?: number;
  /** Версия ворот: испытания разных версий напрямую несравнимы. */
  gateVersion?: number;
  /**
   * Версия корпуса. Главное поле: спотовый и фьючерсный корпус — РАЗНЫЕ
   * рынки, и смешивать их испытания в одном счётчике множественности
   * нельзя. Без этого поля разделить эпохи задним числом невозможно.
   */
  corpusVersion?: string;
}

export interface OwnerTradeRow {
  id: number;
  symbol: string;
  direction: "long" | "short";
  entryIso: string;
  entryPrice: number;
  stopPrice: number | null;
  targetPrice: number | null;
  exitIso: string | null;
  exitPrice: number | null;
  note: string | null;
  setupLabel: string | null;
  context: unknown;
  source: string;
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
    this.migrate();
  }

  /**
   * Миграции схемы. Только ADD COLUMN — журнал append-only, и ни одна
   * миграция не имеет права переписывать историю: старые строки получают
   * NULL, и это ЧЕСТНО (у них этих данных действительно не было).
   */
  private migrate(): void {
    const columns = new Set(
      this.db.prepare("PRAGMA table_info(trials)").all().map((r) => String(r.name)),
    );
    // Воспроизводимость (v2). Без этих полей нельзя ни повторить результат
    // конкретной ночи, ни отделить испытания разных эпох при подсчёте
    // множественности. Окно закрывается НАВСЕГДА в момент смены корпуса:
    // задним числом уже не восстановить, на каких данных и каким кодом
    // считалось. Поэтому колонки добавляются ДО подмены корпуса.
    for (const [name, ddl] of [
      // Версия кода: без неё «результат ночи X» невоспроизводим.
      ["git_sha", "ALTER TABLE trials ADD COLUMN git_sha TEXT"],
      // Сид партии: детерминизм выборки кандидатов.
      ["batch_seed", "ALTER TABLE trials ADD COLUMN batch_seed INTEGER"],
      // Версия ворот: испытания разных версий несравнимы напрямую.
      ["gate_version", "ALTER TABLE trials ADD COLUMN gate_version INTEGER"],
      // Версия корпуса: ГЛАВНОЕ поле. Спотовый корпус и фьючерсный — разные
      // рынки, и смешивать их испытания в одном счётчике проб нельзя.
      ["corpus_version", "ALTER TABLE trials ADD COLUMN corpus_version TEXT"],
    ] as const) {
      if (!columns.has(name)) this.db.exec(ddl);
    }

    /**
     * Карантин отравленных эпох (v3).
     *
     * Задача, которую он решает. Авария инфраструктуры (не было каталога с
     * фандингом) записала 216 испытаний funding_pressure с нулём сделок. Сами
     * записи честны — их удалять нельзя и не нужно. Но сэмплер исключает из
     * выдачи ВСЁ, что когда-либо подавалось, и потому эти 216 комбинаций
     * оказались помечены как проверенные НАВСЕГДА — вердиктом, который
     * измерением не является. Семейство стёрто из поиска не рынком, а багом.
     *
     * Карантин — не удаление и не переписывание истории: это отдельная
     * append-only запись «вот эти испытания не были измерением», после которой
     * сэмплер снова вправе их предложить.
     *
     * ⚠️ На счётчик множественности карантин НЕ влияет намеренно. Соблазн
     * «раз это не измерение, пусть и планку не поднимает» ведёт прямо к
     * подкрутке неприкасаемых ворот через задний двор: любую неудобную партию
     * можно объявить отравленной. Планка остаётся выше, чем строго нужно, —
     * это консервативная сторона ошибки, и мы выбираем её сознательно.
     */
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS quarantine (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        setup_family TEXT NOT NULL,
        from_iso TEXT NOT NULL,
        to_iso TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS quarantine_append_only BEFORE UPDATE ON quarantine
      BEGIN SELECT RAISE(ABORT, 'quarantine is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS quarantine_no_delete BEFORE DELETE ON quarantine
      BEGIN SELECT RAISE(ABORT, 'quarantine is append-only'); END;
    `);

    /*
     * Сделки ВЛАДЕЛЬЦА — отдельный, самый ценный вид записи в этом журнале.
     *
     * Почему они здесь, а не в заметках. Три попытки формализовать его правило
     * провалились, и каждый раз выяснялось, что проверялось НЕ ТО: частота
     * вышла в 8 раз ниже реальной, сопровождение сделки было другим, издержки
     * считались сломанным прибором. Угадывать правило по описанию словами мы
     * пробовали трижды; здесь лежит то, по чему его можно ВОССТАНОВИТЬ —
     * фактические точки входа.
     *
     * `context_json` — снимок рыночной обстановки НА МОМЕНТ ВХОДА. Он
     * невосстановим задним числом даже приблизительно: скопления ликвидности,
     * фандинг, открытый интерес и фаза сессии меняются поминутно, и через
     * полгода останется только цена. Поэтому снимок делается при записи
     * сделки, а не при её анализе.
     *
     * Append-only, как и всё в этом журнале: сделка, записанная и потом
     * «уточнённая» задним числом, перестаёт быть свидетельством.
     */
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS owner_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        direction TEXT NOT NULL,
        entry_iso TEXT NOT NULL,
        entry_price REAL NOT NULL,
        stop_price REAL,
        target_price REAL,
        exit_iso TEXT,
        exit_price REAL,
        note TEXT,
        setup_label TEXT,
        context_json TEXT,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_owner_trades_symbol ON owner_trades(symbol, entry_iso);
      CREATE TRIGGER IF NOT EXISTS owner_trades_append_only BEFORE UPDATE ON owner_trades
      BEGIN SELECT RAISE(ABORT, 'owner_trades is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS owner_trades_no_delete BEFORE DELETE ON owner_trades
      BEGIN SELECT RAISE(ABORT, 'owner_trades is append-only'); END;
    `);

    this.db
      .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', '3')")
      .run();
  }

  /**
   * Записать сделку владельца. Возвращает id.
   *
   * ⚠️ Направление и цены НЕ проверяются на «разумность» намеренно: это
   * свидетельство, а не форма ввода. Если владелец записал стоп ниже входа у
   * шорта — значит так и было, и молча «исправлять» его данные значит
   * подделывать источник.
   */
  addOwnerTrade(t: {
    symbol: string;
    direction: "long" | "short";
    entryIso: string;
    entryPrice: number;
    stopPrice?: number | null;
    targetPrice?: number | null;
    exitIso?: string | null;
    exitPrice?: number | null;
    note?: string | null;
    setupLabel?: string | null;
    context?: unknown;
    source: string;
  }): number {
    const info = this.db
      .prepare(
        `INSERT INTO owner_trades(symbol, direction, entry_iso, entry_price, stop_price,
           target_price, exit_iso, exit_price, note, setup_label, context_json, source, created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        t.symbol,
        t.direction,
        t.entryIso,
        t.entryPrice,
        t.stopPrice ?? null,
        t.targetPrice ?? null,
        t.exitIso ?? null,
        t.exitPrice ?? null,
        t.note ?? null,
        t.setupLabel ?? null,
        t.context === undefined ? null : JSON.stringify(t.context),
        t.source,
        this.now(),
      );
    return Number(info.lastInsertRowid);
  }

  /** Сделки владельца, по возрастанию времени входа. */
  ownerTrades(): OwnerTradeRow[] {
    const rows = this.db
      .prepare("SELECT * FROM owner_trades ORDER BY entry_iso")
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      symbol: String(r.symbol),
      direction: r.direction as "long" | "short",
      entryIso: String(r.entry_iso),
      entryPrice: Number(r.entry_price),
      stopPrice: r.stop_price === null ? null : Number(r.stop_price),
      targetPrice: r.target_price === null ? null : Number(r.target_price),
      exitIso: r.exit_iso === null ? null : String(r.exit_iso),
      exitPrice: r.exit_price === null ? null : Number(r.exit_price),
      note: r.note === null ? null : String(r.note),
      setupLabel: r.setup_label === null ? null : String(r.setup_label),
      context: r.context_json === null ? null : JSON.parse(String(r.context_json)),
      source: String(r.source),
    }));
  }

  /**
   * Происхождение испытания. `null` в полях — законное состояние: записи,
   * сделанные до введения этих колонок, действительно не несут этих данных,
   * и подставлять им что-либо задним числом означало бы подделку.
   */
  provenanceOf(candidateId: string): {
    gitSha: string | null;
    batchSeed: number | null;
    gateVersion: number | null;
    corpusVersion: string | null;
  } {
    const row = this.db
      .prepare(
        "SELECT git_sha, batch_seed, gate_version, corpus_version FROM trials WHERE candidate_id = ?",
      )
      .get(candidateId) as
      | {
          git_sha: string | null;
          batch_seed: number | null;
          gate_version: number | null;
          corpus_version: string | null;
        }
      | undefined;
    return {
      gitSha: row?.git_sha ?? null,
      batchSeed: row?.batch_seed ?? null,
      gateVersion: row?.gate_version ?? null,
      corpusVersion: row?.corpus_version ?? null,
    };
  }

  /**
   * Регистрирует партию кандидатов. Повторная подача того же id молча
   * пропускается — попытка уже посчитана, второй раз она N не увеличивает.
   */
  registerCandidates(
    specs: readonly CandidateSpec[],
    provenance?: Provenance,
  ): { inserted: number; skipped: number } {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO trials
         (candidate_id, spec_json, setup_family, cluster_key, state, created_at, updated_at,
          git_sha, batch_seed, gate_version, corpus_version)
       VALUES (?, ?, ?, ?, 'CANDIDATE', ?, ?, ?, ?, ?, ?)`,
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
          provenance?.gitSha ?? null,
          provenance?.batchSeed ?? null,
          provenance?.gateVersion ?? null,
          provenance?.corpusVersion ?? null,
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

  /**
   * Объявить эпоху семейства отравленной: её испытания перестают закрывать
   * соответствующие комбинации для будущих партий.
   *
   * Границы задаются датами, а не списком id, намеренно: причина всегда
   * временна́я («в этот период не было источника»), и перечисление id
   * позволило бы вычеркнуть отдельные НЕУДОБНЫЕ испытания, а это уже подгонка.
   */
  quarantineEpoch(setupFamily: string, fromIso: string, toIso: string, reason: string): number {
    const [from, to] = normalizeWindow(fromIso, toIso);
    this.db
      .prepare(
        "INSERT INTO quarantine(setup_family, from_iso, to_iso, reason, created_at) VALUES(?,?,?,?,?)",
      )
      .run(setupFamily, from, to, reason, this.now());
    return this.quarantinedIds().size;
  }

  /**
   * Что БУДЕТ освобождено, если объявить такой карантин. Ничего не пишет.
   *
   * Без этого сухой прогон отвечал на вопрос «сколько сейчас в журнале», а не
   * «что изменится» — то есть не отвечал на единственный вопрос, ради которого
   * он существует, и владелец запускал бы необратимую операцию вслепую.
   */
  quarantinePreview(
    setupFamily: string,
    fromIso: string,
    toIso: string,
  ): { affected: number; freed: number; alreadyFree: number } {
    const [from, to] = normalizeWindow(fromIso, toIso);
    const rows = this.db
      .prepare(
        `SELECT candidate_id FROM trials
          WHERE setup_family = ? AND created_at >= ? AND created_at <= ?`,
      )
      .all(setupFamily, from, to) as { candidate_id: string }[];
    const excluded = this.resamplableExclusions();
    let freed = 0;
    for (const r of rows) if (excluded.has(r.candidate_id)) freed += 1;
    return { affected: rows.length, freed, alreadyFree: rows.length - freed };
  }

  /** Испытания, попавшие под карантин. */
  quarantinedIds(): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT t.candidate_id FROM trials t JOIN quarantine q
           ON t.setup_family = q.setup_family
          AND t.created_at >= q.from_iso
          AND t.created_at <= q.to_iso`,
      )
      .all() as { candidate_id: string }[];
    return new Set(rows.map((r) => r.candidate_id));
  }

  /**
   * Что сэмплер обязан НЕ выдавать повторно. Отличается от `allCandidateIds`
   * ровно на карантин: отравленное испытание измерением не было, и закрывать
   * им комбинацию навсегда — значит терять гипотезу из-за поломки, а не из-за
   * рынка.
   */
  resamplableExclusions(): Set<string> {
    const all = this.allCandidateIds();
    for (const id of this.quarantinedIds()) all.delete(id);
    for (const id of this.neverMeasuredIds()) all.delete(id);
    return all;
  }

  /**
   * Испытания, у которых НЕТ НИ ОДНОЙ записи оценки.
   *
   * Кандидаты регистрируются при наборе партии — до прогона, потому что
   * происхождение (git sha, сид, версия корпуса) задним числом не
   * восстановить. Из-за этого ЛЮБОЕ падение ночи после набора — нехватка
   * памяти, битый символ, отвалившийся источник, сработавший страж — навсегда
   * закрывает набранные комбинации, хотя измерения не было.
   *
   * Так уже сожгло 54 комбинации семейства владельца 2026-08-09: ночь набрала
   * партию, упала на страже недобора и записала её. Через восемь минут
   * следующая ночь набрала НОЛЬ — гипотезу закрыло собственной аварией.
   *
   * В отличие от карантина, здесь не нужно ничьё решение и невозможна
   * подтасовка: критерий не «выбрать неудобные испытания», а объективный факт
   * «оценивалось или нет». Испытание без единой оценки не участвовало ни в
   * одной статистике, поэтому повторить его — не второй взгляд на те же
   * данные, а ПЕРВЫЙ. Строка в журнале при этом не удаляется и не меняется:
   * `candidate_id` — первичный ключ, повторная регистрация переиспользует ту
   * же запись.
   */
  neverMeasuredIds(): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT t.candidate_id FROM trials t
          WHERE NOT EXISTS (SELECT 1 FROM evals e WHERE e.candidate_id = t.candidate_id)`,
      )
      .all() as { candidate_id: string }[];
    return new Set(rows.map((r) => r.candidate_id));
  }

  /** Активные записи карантина — для отчёта и статуса. */
  quarantines(): { setupFamily: string; fromIso: string; toIso: string; reason: string }[] {
    return (
      this.db.prepare("SELECT * FROM quarantine ORDER BY id").all() as Record<string, unknown>[]
    ).map((r) => ({
      setupFamily: String(r.setup_family),
      fromIso: String(r.from_iso),
      toIso: String(r.to_iso),
      reason: String(r.reason),
    }));
  }

  /**
   * Отметка «ночь дошла до конца» — сторож молчания.
   *
   * Ставится ТОЛЬКО после полного прогона, а не в начале: смысл отметки в том,
   * что ночь ЗАВЕРШИЛАСЬ, и упавшая на середине не должна выглядеть живой.
   *
   * Живёт в журнале, а не в статусе, потому что журнал лежит в приватном
   * дата-репозитории и восстанавливается обоими воркфлоу. Статус же
   * перезаписывается каждым тиком, и отличить в нём «ночь была» от «тик
   * переписал воронку прошлой ночи» нельзя.
   */
  markNightCompleted(atIso?: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('last_night_completed', ?)")
      .run(atIso ?? this.now());
  }

  /** Когда ночь в последний раз дошла до конца; null — ни разу. */
  lastNightCompleted(): string | null {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = 'last_night_completed'")
      .get() as { value: string } | undefined;
    return row?.value ?? null;
  }

  /** N для дефляции: сырое число попыток и число кластеров (N_eff). */
  counts(): TrialCounts {
    const row = this.db
      .prepare("SELECT COUNT(*) AS trials, COUNT(DISTINCT cluster_key) AS clusters FROM trials")
      .get() as { trials: number; clusters: number };
    return { trials: row.trials, clusters: row.clusters };
  }

  /**
   * N_eff ПО РОДОСЛОВНОЙ: кластеры внутри одного семейства, без фантомов.
   *
   * Зачем. Поправка на множественность обязана считать пробы того поиска,
   * который ПОРОДИЛ кандидата. Кандидат семейства свипа рождён перебором
   * пространства свипа (10 кластеров), а не перебором моментума (2061) — и
   * заставлять его платить за чужой слепой перебор значит поднимать планку
   * за то, к чему он не имеет отношения. Именно это и делало ворота глухими:
   * замер мощности дал 0% прохождения при любом реалистичном крае.
   *
   * Фантомные кластеры. В журнале 652 кластера состоят ИСКЛЮЧИТЕЛЬНО из
   * испытаний с меткой таймфрейма «1d». Такого корпуса не существует — метка
   * была фикцией эпохи-1, правила шли по 1h/4h. Эти кластеры не соответствуют
   * ни одной реально проверенной комбинации и завышают N всем. Удалить их
   * нельзя (журнал append-only), поэтому они ИСКЛЮЧАЮТСЯ ИЗ ВЗГЛЯДА, а не из
   * данных: это исправление учёта, а не переписывание истории.
   *
   * ⚠️ Честная граница: семейств тоже несколько, и множественность МЕЖДУ ними
   * этот счётчик не покрывает. Число семейств пишется в журнал рядом
   * (`familiesTried`), чтобы поправка на них была видимой и решалась своей
   * пре-регистрацией, а не потерялась молча.
   */
  clustersForFamily(setupFamily: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT cluster_key FROM trials
            WHERE setup_family = ?
            GROUP BY cluster_key
           HAVING SUM(CASE WHEN json_extract(spec_json,'$.timeframe') = '1d' THEN 0 ELSE 1 END) > 0
         )`,
      )
      .get(setupFamily) as { n: number };
    return row.n;
  }

  /** Сколько РАЗНЫХ семейств когда-либо подавалось — множественность между ними. */
  familiesTried(): number {
    const row = this.db
      .prepare("SELECT COUNT(DISTINCT setup_family) AS n FROM trials")
      .get() as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Границы окна карантина: голая дата означает ВЕСЬ день.
 *
 * `created_at` хранится полным ISO («2026-08-08T10:00:00.000Z»), а сравнение в
 * SQLite строковое. Поэтому `to = "2026-08-08"` отсекало ВЕСЬ день 8 августа:
 * у равного префикса более длинная строка больше. Проверено — из трёх записей
 * в окне ловилась одна.
 *
 * Дефект тихий вдвойне: карантин отчитывался об успехе, а последний день
 * отравленной эпохи оставался закрытым навсегда. Именно так и была написана
 * готовая команда в RUNBOOK.
 */
export function normalizeWindow(fromIso: string, toIso: string): [string, string] {
  const from = fromIso.includes("T") ? fromIso : `${fromIso}T00:00:00.000Z`;
  const to = toIso.includes("T") ? toIso : `${toIso}T23:59:59.999Z`;
  return [from, to];
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
