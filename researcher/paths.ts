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
/**
 * По умолчанию — зеркало ПРИВАТНОГО data-репо, то есть ровно тот журнал, в
 * который пишет облако (там воркфлоу задают RESEARCHER_DATA_DIR=<repo>/ledger).
 *
 * Раньше дефолтом был ~/.chartlab/data, и это молча создало ВТОРОЙ журнал:
 * 6231 кандидат с 2026-07-24 в локальном против 56374 в облачном. Ровно та
 * авария, от которой предостерегает комментарий выше: раздвоенный счёт попыток
 * = сломанная дефляция, потому что каждая половина считает планку по своей
 * части испытаний и обе занижают её.
 *
 * Разовый прогон, который НЕ должен тратить бюджет проб, обязан явно задать
 * RESEARCHER_DB_PATH на временный файл — и его результаты нельзя использовать
 * для отбора кандидатов, только для проверки «код не падает».
 */
export const DATA_DIR =
  process.env.RESEARCHER_DATA_DIR ?? join(CHARTLAB_HOME, "data-repo", "ledger");
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
