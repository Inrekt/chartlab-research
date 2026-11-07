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

export type HypothesisStatus = "proposed" | "queued" | "rejected";

/** Гипотеза «мозга» до вставки (см. researcher/brain.ts). */
export interface NewHypothesis {
  id: string;
  familyId: string;
  mechanismId: string;
  timeframe: string;
  direction: string;
  cubes: readonly string[];
  source: "generator" | "hint";
  hintText?: string | null;
  preregJson: string;
  preregHash: string;
  adequacy: unknown;
  status?: HypothesisStatus;
}

export interface HypothesisRow extends Omit<NewHypothesis, "status" | "cubes"> {
  cubes: string[];
  status: HypothesisStatus;
  night: string | null;
  createdAt: string;
  updatedAt: string;
}

function toHypothesisRow(r: Record<string, unknown>): HypothesisRow {
  return {
    id: r.id as string,
    familyId: r.family_id as string,
    mechanismId: r.mechanism_id as string,
    timeframe: r.timeframe as string,
    direction: r.direction as string,
    cubes: JSON.parse(r.cubes_json as string) as string[],
    source: r.source as "generator" | "hint",
    hintText: (r.hint_text as string | null) ?? null,
    preregJson: r.prereg_json as string,
    preregHash: r.prereg_hash as string,
    adequacy: JSON.parse(r.adequacy_json as string) as unknown,
    status: r.status as HypothesisStatus,
    night: (r.night as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

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

    /*
     * Очередь гипотез «мозга» (v4). Строка — идея «механизм × кубики ×
     * вселенная» с ПРЕ-РЕГИСТРАЦИЕЙ, записанной в момент постановки: после
     * вставки ни механизм, ни кубики, ни текст пре-регистрации поменять
     * нельзя (триггер), меняется только статус и только вперёд.
     *
     * ⚠️ Множественность. Предложенная гипотеза (proposed) — ещё не выстрел и
     * планку не поднимает. Поставленная в прогон (queued) — выстрел: её
     * family_id входит в F (`familiesTried`), даже если ни одного испытания
     * ещё нет. Поэтому постановки ограничены лимитом за ночь.
     */
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hypotheses (
        id TEXT PRIMARY KEY,
        family_id TEXT NOT NULL,
        mechanism_id TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        direction TEXT NOT NULL,
        cubes_json TEXT NOT NULL,
        source TEXT NOT NULL,
        hint_text TEXT,
        prereg_json TEXT NOT NULL,
        prereg_hash TEXT NOT NULL,
        adequacy_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'proposed',
        night TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_hypotheses_status ON hypotheses(status);
      CREATE TRIGGER IF NOT EXISTS hypotheses_identity_immutable BEFORE UPDATE ON hypotheses
      WHEN OLD.id != NEW.id OR OLD.family_id != NEW.family_id
        OR OLD.mechanism_id != NEW.mechanism_id OR OLD.timeframe != NEW.timeframe
        OR OLD.direction != NEW.direction OR OLD.cubes_json != NEW.cubes_json
        OR OLD.source != NEW.source OR OLD.prereg_json != NEW.prereg_json
        OR OLD.prereg_hash != NEW.prereg_hash OR OLD.adequacy_json != NEW.adequacy_json
        OR OLD.created_at != NEW.created_at
      BEGIN SELECT RAISE(ABORT, 'hypothesis identity is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS hypotheses_status_forward BEFORE UPDATE ON hypotheses
      WHEN OLD.status != NEW.status AND OLD.status != 'proposed'
      BEGIN SELECT RAISE(ABORT, 'hypothesis status moves only from proposed'); END;
      CREATE TRIGGER IF NOT EXISTS hypotheses_no_delete BEFORE DELETE ON hypotheses
      BEGIN SELECT RAISE(ABORT, 'hypotheses are never deleted'); END;
    `);

    this.db
      .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', '4')")
      .run();
  }

  /**
   * Предложить гипотезу. Повтор того же id молча игнорируется (false):
   * генератор каждую ночь пересобирает те же идеи, и дубль не должен ни
   * плодить строки, ни менять уже записанную пре-регистрацию.
   */
  proposeHypothesis(h: NewHypothesis): boolean {
    const now = this.now();
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO hypotheses(id, family_id, mechanism_id, timeframe, direction,
           cubes_json, source, hint_text, prereg_json, prereg_hash, adequacy_json, status,
           created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        h.id,
        h.familyId,
        h.mechanismId,
        h.timeframe,
        h.direction,
        JSON.stringify(h.cubes),
        h.source,
        h.hintText ?? null,
        h.preregJson,
        h.preregHash,
        JSON.stringify(h.adequacy),
        h.status ?? "proposed",
        now,
        now,
      );
    return Number(info.changes) > 0;
  }

  hypotheses(status?: HypothesisStatus): HypothesisRow[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM hypotheses WHERE status = ? ORDER BY created_at, id").all(status)
      : this.db.prepare("SELECT * FROM hypotheses ORDER BY created_at, id").all();
    return rows.map(toHypothesisRow);
  }

  /** Сколько гипотез уже поставлено в прогон в эту ночь. */
  queuedOnNight(night: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM hypotheses WHERE status = 'queued' AND night = ?")
      .get(night) as { n: number };
    return row.n;
  }

  /**
   * Поставить предложенную гипотезу в прогон. Лимит за ночь проверяется
   * ВНУТРИ транзакции: два параллельных запуска не превысят его вдвоём.
   * Возвращает false, если лимит исчерпан или гипотеза уже не proposed.
   */
  queueHypothesis(id: string, night: string, nightlyLimit: number): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.queuedOnNight(night) >= nightlyLimit) {
        this.db.exec("ROLLBACK");
        return false;
      }
      const info = this.db
        .prepare(
          "UPDATE hypotheses SET status = 'queued', night = ?, updated_at = ? WHERE id = ? AND status = 'proposed'",
        )
        .run(night, this.now(), id);
      this.db.exec("COMMIT");
      return Number(info.changes) > 0;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Исход среза семейства в журнале: сколько испытаний на этом ТФ и сколько
   * из них дошли хотя бы до валидации. Нужен «мозгу», чтобы не ставить идею,
   * чей статический кластер (семейство × ТФ) уже мёртв.
   */
  familySliceOutcome(setupFamily: string, timeframe: string): { trials: number; survivors: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS trials,
                SUM(CASE WHEN state IN ('VALIDATED','INCUBATING','GRADUATED','DECAYING') THEN 1 ELSE 0 END) AS survivors
           FROM trials
          WHERE setup_family = ? AND json_extract(spec_json,'$.timeframe') = ?`,
      )
      .get(setupFamily, timeframe) as { trials: number; survivors: number | null };
    return { trials: row.trials, survivors: row.survivors ?? 0 };
  }

  /** Отклонить предложенную гипотезу (владелец или повторная проверка). */
  rejectHypothesis(id: string): boolean {
    const info = this.db
      .prepare(
        "UPDATE hypotheses SET status = 'rejected', updated_at = ? WHERE id = ? AND status = 'proposed'",
      )
      .run(this.now(), id);
    return Number(info.changes) > 0;
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
    const at = this.now();
    this.db
      .prepare(
        "INSERT INTO quarantine(setup_family, from_iso, to_iso, reason, created_at) VALUES(?,?,?,?,?)",
      )
      .run(setupFamily, from, to, reason, at);

    /*
     * Испытание, вернувшееся в поиск, обязано вернуться и ПО СОСТОЯНИЮ.
     *
     * Дефект, который это чинит (поймала первая же настоящая ночь после
     * первого в истории карантина, 2026-08-18): карантин снимал испытания с
     * исключений сэмплера, тот честно выдавал их снова, скрин доходил до
     * вердикта и падал на `запрещённый переход REJECTED → REJECTED` —
     * REJECTED терминален. Ночь уходила красной, а комбинации оставались
     * непроверенными: карантин освобождал их только наполовину.
     *
     * История НЕ теряется: прежние eval-записи и переходы остаются на месте
     * (журнал append-only), возврат фиксируется отдельным переходом с
     * причиной, а сам факт карантина лежит в своей таблице. Это ровно тот
     * случай, ради которого карантин и существует: прошлый вердикт вынесен
     * сломанным прибором и измерением не был.
     */
    const affected = this.db
      .prepare(
        `SELECT candidate_id, state FROM trials
          WHERE setup_family = ? AND created_at >= ? AND created_at <= ? AND state != 'CANDIDATE'`,
      )
      .all(setupFamily, from, to) as { candidate_id: string; state: TrialState }[];
    this.returnToPool(affected, `карантин: ${reason}`, at);
    return this.quarantinedIds().size;
  }

  /**
   * Починка журнала, где карантин был объявлен СТАРЫМ кодом — до того, как он
   * научился возвращать состояние. Идемпотентна: испытания, уже вернувшиеся в
   * пул, не трогает и ничего не пишет.
   */
  repairQuarantinedStates(): number {
    const ids = [...this.quarantinedIds()];
    if (ids.length === 0) return 0;
    const stuck = ids
      .map((id) => ({ id, trial: this.getTrial(id) }))
      .filter((r) => r.trial && r.trial.state !== "CANDIDATE")
      .map((r) => ({ candidate_id: r.id, state: r.trial!.state }));
    this.returnToPool(stuck, "карантин: возврат состояния (починка)", this.now());
    return stuck.length;
  }

  /** Возврат испытаний в пул одной транзакцией, с переходом на каждое. */
  private returnToPool(
    rows: readonly { candidate_id: string; state: TrialState }[],
    reason: string,
    at: string,
  ): void {
    if (rows.length === 0) return;
    this.db.exec("BEGIN");
    try {
      for (const row of rows) {
        this.db
          .prepare(
            "INSERT INTO transitions(candidate_id, from_state, to_state, reason, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(row.candidate_id, row.state, "CANDIDATE", reason, at);
        this.db
          .prepare("UPDATE trials SET state = 'CANDIDATE', updated_at = ? WHERE candidate_id = ?")
          .run(at, row.candidate_id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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

  /**
   * Испытания, которым карантин ещё ДОЛЖЕН перемер.
   *
   * Карантин говорит «вердикт, вынесенный в отравленную эпоху, измерением не
   * был» — и ничего не говорит о вердикте, вынесенном ПОСЛЕ него. Раньше отбор
   * шёл только по окну `created_at`, а дата регистрации при перемере не
   * меняется: перемеренное испытание навсегда оставалось «карантинным»,
   * каждую ночь снова уходило в пул, и скрин падал на
   * «запрещённый переход REJECTED → REJECTED» (13 красных ночей с 2026-08-20
   * на 216 испытаниях funding_pressure, перемеренных 2026-08-19).
   *
   * Поэтому испытание освобождается, только пока у него нет оценки новее
   * записи карантина: одна отравленная эпоха — один перемер.
   */
  quarantinedIds(): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT t.candidate_id FROM trials t JOIN quarantine q
           ON t.setup_family = q.setup_family
          AND t.created_at >= q.from_iso
          AND t.created_at <= q.to_iso
          WHERE NOT EXISTS (
            SELECT 1 FROM evals e
             WHERE e.candidate_id = t.candidate_id AND e.created_at > q.created_at
          )`,
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
    // Поставленная гипотеза — уже выстрел, даже без испытаний; объединение,
    // а не сумма: когда её испытания попадут в trials под тем же family_id,
    // F не вырастет второй раз.
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT setup_family AS f FROM trials
           UNION
           SELECT family_id AS f FROM hypotheses WHERE status = 'queued'
         )`,
      )
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
