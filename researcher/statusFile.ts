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
import { corpusFreshnessVerdict, dataSourceHealth } from "./preflight.ts";
import type { ScreenSummary } from "./screen.ts";
import { buildStatus, type ResearcherStatus, type StatusSources } from "./status.ts";
import type { SupervisionSummary } from "./supervise.ts";

/**
 * Снимок здоровья входов на момент записи статуса.
 *
 * Никогда не бросает: статус обязан публиковаться ДАЖЕ когда всё сломано —
 * именно тогда он и нужен. Упавший сбор здоровья, уронивший публикацию,
 * оставил бы на экране предыдущие зелёные цифры мёртвой машины.
 */
function sourcesSnapshot(): StatusSources | undefined {
  try {
    const fresh = corpusFreshnessVerdict();
    return {
      feeds: dataSourceHealth().map(({ name, files, required, ok }) => ({
        name,
        files,
        required,
        ok,
      })),
      corpus: {
        newestBar: fresh.newestIso,
        ageDays: fresh.ageDays === null ? null : Number(fresh.ageDays.toFixed(2)),
        laggingSymbols: fresh.laggingSymbols,
        level: fresh.level,
      },
    };
  } catch {
    return undefined;
  }
}

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
  /** Причина падения прогона; не задана — прогон дошёл до конца. */
  failure?: string | null;
}): void {
  const statusPath = args.statusPath ?? STATUS_PATH;
  const previous = readStatus(statusPath);
  const ledger = new TrialLedger(args.dbPath ?? DB_PATH);
  const book = new IncubationBook(args.dbPath ?? DB_PATH);
  try {
    const status = buildStatus({
      ...args,
      ledger,
      book,
      states: STATES,
      previous,
      sources: sourcesSnapshot(),
    });
    mkdirSync(dirname(statusPath), { recursive: true });
    writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`, "utf-8");
  } finally {
    ledger.close();
    book.close();
  }
}
