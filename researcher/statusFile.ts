/**
 * Файловая обвязка публичного статуса: чтение предыдущего, сборка, запись.
 *
 * Отдельно от status.ts (тот чистый и тестируется без диска) и отдельно от
 * nightly.ts — у того `await main()` на верхнем уровне модуля, поэтому импорт
 * из часового тика запускал бы полный ночной перебор.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { IncubationSummary } from "./incubate.ts";
import { IncubationBook } from "./incubationBook.ts";
import { STATES, TrialLedger } from "./ledger.ts";
import { DB_PATH, STATUS_PATH } from "./paths.ts";
import type { ScreenSummary } from "./screen.ts";
import { buildStatus, type ResearcherStatus } from "./status.ts";
import type { SupervisionSummary } from "./supervise.ts";

export function readStatus(path = STATUS_PATH): ResearcherStatus | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ResearcherStatus;
  } catch {
    // Битый файл не должен ронять ночь — перезапишем свежим.
    return null;
  }
}

/**
 * `screens` пустой ⇒ это часовая догонка: воронка прошлой ночи переносится
 * из предыдущего файла, а не затирается (см. buildStatus).
 */
export function writeStatus(args: {
  screens: readonly ScreenSummary[];
  incubation: IncubationSummary;
  supervision: SupervisionSummary;
  durationMin?: number | null;
  dbPath?: string;
  statusPath?: string;
}): void {
  const statusPath = args.statusPath ?? STATUS_PATH;
  const previous = readStatus(statusPath);
  const ledger = new TrialLedger(args.dbPath ?? DB_PATH);
  const book = new IncubationBook(args.dbPath ?? DB_PATH);
  try {
    const status = buildStatus({ ...args, ledger, book, states: STATES, previous });
    mkdirSync(dirname(statusPath), { recursive: true });
    writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`, "utf-8");
  } finally {
    ledger.close();
    book.close();
  }
}
