/**
 * Книга инкубатора: бумажные сделки форвард-проверки.
 *
 * Честность держится на двух вещах:
 * 1) `frozen_at` — момент заморозки правил (переход VALIDATED в журнале).
 *    Любой бар, закрывшийся ПОСЛЕ него, — форвард-данные, даже если Mac спал
 *    и посчитал их позже: движок детерминирован, пересчёт даёт те же сделки.
 * 2) Сделки append-only на уровне БД: дедуп по (кандидат, символ, время
 *    входа), UPDATE/DELETE запрещены триггерами.
 *
 * Живёт в том же SQLite-файле, что журнал испытаний (WAL — два соединения
 * безопасны); курсоры — служебная таблица, не часть доказательства.
 */
import { DatabaseSync } from "node:sqlite";
import type { TradeResult } from "../src/core/types/index.ts";
import type { SignalTf } from "./grammar.ts";

export interface IncubationRow {
  candidateId: string;
  tf: SignalTf;
  symbols: string[];
  /** Скептичная альтернатива SPRT: половина бэктест-матожидания. */
  mu1: number;
  sigma: number;
  expectedN: number;
  /** Unix-секунды заморозки правил: форвард — всё, что закрылось позже. */
  frozenAt: number;
  startedAt: string;
}

export interface PaperTradeRow {
  symbol: string;
  direction: "long" | "short";
  entryTime: number;
  entryPrice: number;
  stopPrice: number;
  rMultiple: number;
  exitTime: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS incubations (
  candidate_id TEXT PRIMARY KEY,
  tf TEXT NOT NULL,
  symbols_json TEXT NOT NULL,
  mu1 REAL NOT NULL,
  sigma REAL NOT NULL,
  expected_n REAL NOT NULL,
  frozen_at INTEGER NOT NULL,
  started_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS incubations_append_only BEFORE UPDATE ON incubations
BEGIN SELECT RAISE(ABORT, 'incubations is append-only'); END;
CREATE TRIGGER IF NOT EXISTS incubations_no_delete BEFORE DELETE ON incubations
BEGIN SELECT RAISE(ABORT, 'incubations is append-only'); END;

CREATE TABLE IF NOT EXISTS paper_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL,
  entry_time INTEGER NOT NULL,
  entry_price REAL NOT NULL,
  stop_price REAL NOT NULL,
  target_price REAL NOT NULL,
  exit_time INTEGER NOT NULL,
  exit_price REAL NOT NULL,
  r_multiple REAL NOT NULL,
  bars_held INTEGER NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE(candidate_id, symbol, entry_time)
);
CREATE TRIGGER IF NOT EXISTS paper_trades_append_only BEFORE UPDATE ON paper_trades
BEGIN SELECT RAISE(ABORT, 'paper_trades is append-only'); END;
CREATE TRIGGER IF NOT EXISTS paper_trades_no_delete BEFORE DELETE ON paper_trades
BEGIN SELECT RAISE(ABORT, 'paper_trades is append-only'); END;

CREATE TABLE IF NOT EXISTS incubation_cursors (
  candidate_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  last_bar_time INTEGER NOT NULL,
  PRIMARY KEY (candidate_id, symbol)
);
`;

export class IncubationBook {
  private readonly db: DatabaseSync;
  private readonly now: () => string;

  constructor(path: string, opts?: { now?: () => string }) {
    this.db = new DatabaseSync(path);
    this.now = opts?.now ?? (() => new Date().toISOString());
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  /** Регистрирует инкубацию; повторный вызов молча игнорируется. */
  start(row: Omit<IncubationRow, "startedAt">): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO incubations
           (candidate_id, tf, symbols_json, mu1, sigma, expected_n, frozen_at, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.candidateId,
        row.tf,
        JSON.stringify(row.symbols),
        row.mu1,
        row.sigma,
        row.expectedN,
        row.frozenAt,
        this.now(),
      );
    return Number(result.changes) > 0;
  }

  get(candidateId: string): IncubationRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM incubations WHERE candidate_id = ?")
      .get(candidateId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      candidateId: row.candidate_id as string,
      tf: row.tf as SignalTf,
      symbols: JSON.parse(row.symbols_json as string) as string[],
      mu1: row.mu1 as number,
      sigma: row.sigma as number,
      expectedN: row.expected_n as number,
      frozenAt: row.frozen_at as number,
      startedAt: row.started_at as string,
    };
  }

  /** Дописывает закрытые сделки; дубли (тот же вход) игнорируются БД. */
  recordTrades(candidateId: string, trades: readonly TradeResult[]): number {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO paper_trades
         (candidate_id, symbol, direction, entry_time, entry_price, stop_price,
          target_price, exit_time, exit_price, r_multiple, bars_held, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let inserted = 0;
    const at = this.now();
    for (const t of trades) {
      const result = stmt.run(
        candidateId,
        t.symbol,
        t.direction,
        t.entryTime,
        t.entryPrice,
        t.stopPrice,
        t.targetPrice,
        t.exitTime,
        t.exitPrice,
        t.rMultiple,
        t.barsHeld,
        at,
      );
      inserted += Number(result.changes);
    }
    return inserted;
  }

  /** Все сделки кандидата в порядке ЗАКРЫТИЯ — вход SPRT. */
  trades(candidateId: string): PaperTradeRow[] {
    const rows = this.db
      .prepare(
        `SELECT symbol, direction, entry_time, entry_price, stop_price, r_multiple, exit_time
         FROM paper_trades WHERE candidate_id = ? ORDER BY exit_time, entry_time`,
      )
      .all(candidateId) as Record<string, unknown>[];
    return rows.map((r) => ({
      symbol: r.symbol as string,
      direction: r.direction as "long" | "short",
      entryTime: r.entry_time as number,
      entryPrice: r.entry_price as number,
      stopPrice: r.stop_price as number,
      rMultiple: r.r_multiple as number,
      exitTime: r.exit_time as number,
    }));
  }

  cursor(candidateId: string, symbol: string): number | undefined {
    const row = this.db
      .prepare("SELECT last_bar_time FROM incubation_cursors WHERE candidate_id = ? AND symbol = ?")
      .get(candidateId, symbol) as { last_bar_time: number } | undefined;
    return row?.last_bar_time;
  }

  setCursor(candidateId: string, symbol: string, lastBarTime: number): void {
    this.db
      .prepare(
        `INSERT INTO incubation_cursors (candidate_id, symbol, last_bar_time) VALUES (?, ?, ?)
         ON CONFLICT(candidate_id, symbol) DO UPDATE SET last_bar_time = excluded.last_bar_time`,
      )
      .run(candidateId, symbol, lastBarTime);
  }

  close(): void {
    this.db.close();
  }
}
