/**
 * Единые пути данных исследователя.
 *
 * База и артефакты живут в ~/.chartlab — ВНЕ Desktop/Documents: macOS TCC не
 * пускает launchd-агентов в защищённые папки, а журнал обязан быть одним и
 * тем же для демона и интерактивных запусков (два журнала = раздвоенный счёт
 * попыток = сломанная дефляция).
 *
 * Вольт Obsidian — на Рабочем столе, демону он недоступен; демон пишет в
 * outbox, интерактивные сессии переносят в вольт (sync-outbox.sh).
 */
import { homedir } from "node:os";
import { join } from "node:path";

export const CHARTLAB_HOME = join(homedir(), ".chartlab");
export const DATA_DIR = process.env.RESEARCHER_DATA_DIR ?? join(CHARTLAB_HOME, "data");
export const DB_PATH = process.env.RESEARCHER_DB_PATH ?? join(DATA_DIR, "trials.sqlite");
export const OUTBOX_DIR = join(CHARTLAB_HOME, "outbox");
export const DEFAULT_VAULT_DIR =
  process.env.RESEARCHER_VAULT_DIR ??
  "/Users/user/Desktop/obsidian vault/obsidian vault/ChartLab";

/**
 * Публичный агрегат статуса — единственное, что уходит наружу для монитора в
 * приложении. Лежит ОТДЕЛЬНО от журнала: журнал приватен, статус обезличен и
 * коммитится в публичный репозиторий (см. status.ts).
 */
export const STATUS_DIR = process.env.RESEARCHER_STATUS_DIR ?? join(CHARTLAB_HOME, "status");
export const STATUS_PATH = join(STATUS_DIR, "status.json");
