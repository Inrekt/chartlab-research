/**
 * Эпохи журнала — граница между записями, сделанными кривым прибором, и
 * новыми.
 *
 * Эпоха-1 (до 2026-07-31): метка ТФ в спеке была фикцией — сэмплер тянул её
 * случайно из трёх значений, движок поле не читал, и правило гонялось на
 * корпусе ночи независимо от ярлыка. Следствия: одна идея жила под тремя id,
 * «проверено на 1d» не значило вообще ничего, а блокировка повторов держала
 * ярлыки, а не факты.
 *
 * Этот модуль НЕ переписывает историю (журнал append-only и должен таким
 * остаться — это честный счётчик попыток). Он её ЧИТАЕТ правильно:
 *
 * 1. `reconstructRunTf` восстанавливает фактический ТФ каждой старой партии.
 *    Опора — устройство nightly.ts: партии регистрируются одной транзакцией
 *    (у всей партии один created_at), ночь гоняет ТФ строго по порядку
 *    RESEARCHER_TFS ("1h,4h"), то есть внутри одной ночи первая партия — 1h,
 *    вторая — 4h. Партии одной ночи отстоят друг от друга на минуты-часы,
 *    разных ночей — на сутки.
 *
 * 2. `behavioralExclusionFor` отдаёт множество поведенческих id (спека без
 *    ТФ), уже РЕАЛЬНО прогнанных на корпусе данного ТФ. Именно этим множеством
 *    сэмплер обязан блокировать повторы: правило, сгоревшее в 1h-ночь под
 *    ярлыком «1d», на 1h-корпусе повторно не проверяется, но на 4h-корпусе —
 *    впервые в жизни, и это законно.
 *
 * 3. `markEpoch` ставит несмываемую отметку начала эпохи-2 в meta — любой
 *    последующий разбор журнала знает, каким прибором сделана запись
 *    (дополнительно каждая eval эпохи-2 несёт gateVersion).
 */
import { DatabaseSync } from "node:sqlite";
import { behavioralId, type CandidateSpec, type SignalTf } from "./grammar.ts";

/**
 * Версия прибора; пишется в каждую eval.
 * 2 — эпоха-2: честный ТФ, поведенческий дедуп, чистая планка (2026-07-31).
 * 3 — ворота v3: разностная нуль-модель с расписанием (t≥2.6 по дневному
 *     портфелю), допуск плато 0.05R, δ-вход инкубатора 0.18 (2026-07-31,
 *     пре-регистрация docs/gates-v3-preregistration.md).
 */
/**
 * v4 (2026-08-07): средний ранг в процентилях фандинга/тейкеров (наивный ранг
 * объявлял экстремумом плоские окна), срез вселенной по ликвидности для
 * mean_reversion (неликвид) и momentum (ликвид), экономика испытания в журнале
 * (grossExpectancy / costR / breakevenCostR / tradesPerDay).
 */
/**
 * v5 (2026-08-08): гэп через стоп исполняется по ОТКРЫТИЮ бара, а не по цене
 * стопа (engine.ts). Бар, открывшийся за стопом, раньше закрывался по цене,
 * которой в нём не было — левый хвост убытков был обрезан по построению, а
 * вместе с ним приукрашены skew выпускника и вероятность нарушить дневной
 * лимит проп-фирмы. Правка только ужесточает: ни одна сделка не стала лучше.
 * Плюс COLLECT_DIR в nightly/hourly — до этого фандинг и почасовые метрики
 * были НЕВИДИМЫ в облаке, и семейство funding_pressure получило 212 испытаний
 * со 100% нуля сделок (ложный вывод «фандинг не работает» + поднятая планка
 * дефляции всем остальным).
 *
 * Версия = один связный прибор. Следующий пакет правок ворот (nEffective по
 * родословной без фантомных 1d-кластеров, gate_temporal без огрызков лет,
 * издержки по тирам ликвидности, веса уникальности) поднимет её до 6 — так
 * измерения разных приборов не смешиваются в журнале.
 */
export const GATE_VERSION = 5;

/** Порядок ТФ внутри ночи эпохи-1 — дословно дефолт RESEARCHER_TFS. */
const EPOCH1_NIGHT_TFS: readonly SignalTf[] = ["1h", "4h"];

/** Партии ближе этого зазора считаются одной ночью (реально — минуты). */
const SAME_NIGHT_MS = 6 * 60 * 60 * 1000;

/**
 * created_at партий (в любом порядке, с дублями) → фактический ТФ прогона
 * каждой партии. Чистая функция — пинается тестами на реальной хронологии.
 */
export function reconstructRunTf(createdAts: readonly string[]): Map<string, SignalTf> {
  const distinct = [...new Set(createdAts)].sort();
  const result = new Map<string, SignalTf>();
  let nightStartMs = Number.NEGATIVE_INFINITY;
  let indexInNight = 0;
  for (const at of distinct) {
    const ms = Date.parse(at);
    if (ms - nightStartMs > SAME_NIGHT_MS) {
      nightStartMs = ms;
      indexInNight = 0;
    }
    // Третьей партии в ночи эпоха-1 не производила; если хронология когда-то
    // покажет иное — честнее прижать к последнему известному ТФ, чем упасть.
    const tf = EPOCH1_NIGHT_TFS[Math.min(indexInNight, EPOCH1_NIGHT_TFS.length - 1)];
    result.set(at, tf);
    indexInNight += 1;
  }
  return result;
}

/**
 * Поведенческие id всех правил, реально прогнанных на корпусе `tf`.
 *
 * Записи эпохи-2 (created_at ≥ метки эпохи) верят собственной метке ТФ —
 * сэмплер эпохи-2 пишет её честно. Записи эпохи-1 идут через реконструкцию.
 */
export function behavioralExclusionFor(dbPath: string, tf: SignalTf): Set<string> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const epochSince = readEpochSince(db);
    const rows = db
      .prepare("SELECT candidate_id, spec_json, created_at FROM trials")
      .all() as { candidate_id: string; spec_json: string; created_at: string }[];
    const runTfByBatch = reconstructRunTf(
      rows.filter((r) => epochSince === null || r.created_at < epochSince).map((r) => r.created_at),
    );
    const out = new Set<string>();
    for (const row of rows) {
      const spec = JSON.parse(row.spec_json) as CandidateSpec;
      const isEpoch2 = epochSince !== null && row.created_at >= epochSince;
      const runTf = isEpoch2 ? spec.timeframe : runTfByBatch.get(row.created_at);
      if (runTf === tf) out.add(behavioralId(spec));
    }
    return out;
  } finally {
    db.close();
  }
}

/** Однократно (INSERT OR IGNORE) фиксирует момент включения эпохи-2. */
export function markEpoch(dbPath: string, now?: () => string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    // Той же формы, что в ledger.ts — на случай вызова до первого открытия
    // журнала (в бою ledger открывается раньше, но порядок не должен ронять).
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
    db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('epoch2_since', ?)").run(
      (now ?? (() => new Date().toISOString()))(),
    );
  } finally {
    db.close();
  }
}

function readEpochSince(db: DatabaseSync): string | null {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'epoch2_since'").get() as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } catch {
    return null; // журнала ещё нет — исключать нечего
  }
}
