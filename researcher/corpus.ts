/**
 * Доступ к корпусу истории для жерновов (Node-сторона).
 *
 * Ключевая честность здесь — ОТЛОЖЕННЫЙ набор символов: 20% вселенной,
 * выбранные детерминированным хэшем имени, никогда не участвуют ни в выборе
 * кандидатов, ни в делении пополам. Это бесплатный out-of-sample, который
 * невозможно подсмотреть: разбиение — чистая функция имени символа, а не
 * список, который можно «подправить».
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import type { Candle } from "../src/core/types/index.ts";
import { useCsvFunding } from "./fundingCsv.ts";
import { useCsvMetrics } from "./metricsCsv.ts";
import type { SignalTf } from "./grammar.ts";

// Через корпус проходит ЛЮБОЙ исследовательский вход, поэтому источник ставок
// фандинга подключается здесь. Подключать его в каждой точке входа отдельно —
// значит однажды забыть в одной, и целое семейство молча перестанет давать
// сделки, не сломав при этом ни одного теста.
useCsvFunding();
useCsvMetrics();

const __dirname = dirname(fileURLToPath(import.meta.url));
/**
 * Каталог корпуса свечей.
 *
 * Переопределяется `RESEARCHER_HISTORY_DIR`, потому что корпус — это
 * ВОСПРОИЗВОДИМЫЙ артефакт, а не хранимый актив: сборщик (collect-candles)
 * скачивает его с биржи заново и дозаписывает хвост. Хранить его в git
 * вредно вдвойне — каждое обновление переписывает все 324 сжатых файла
 * целиком, и репозиторий растёт на ~100 МБ за раз, ничего не выигрывая.
 *
 * Журнал испытаний невосполним и потому хранится; корпус восполним и потому
 * кэшируется. Разные вещи — разное обращение.
 */
export const HISTORY_DIR =
  process.env.RESEARCHER_HISTORY_DIR ?? join(__dirname, "..", "public", "data", "history");

/** Доля вселенной, уходящая в отложенный набор (holdout). */
export const HOLDOUT_FRACTION = 5; // каждый пятый ≈ 20%

function safeFilename(symbol: string): string {
  return symbol.replace(/[^a-zA-Z0-9]/g, "_");
}

/** Все символы, у которых в корпусе есть файл данного таймфрейма. */
export function listUniverse(tf: SignalTf, historyDir = HISTORY_DIR): string[] {
  const suffix = `_${tf}.json.gz`;
  // Каталога может не быть вовсе — в облаке корпус живёт в кэше раннера, и на
  // промахе кэша `actions/cache/restore` каталог не создаёт. «Корпуса нет» —
  // законное состояние (часовой тик его не читает), и отвечать на него
  // исключением значит ронять того, кто просто спросил состав вселенной.
  // Тот, кому корпус НУЖЕН, ловит пустоту предполётной проверкой.
  if (!existsSync(historyDir)) return [];
  return readdirSync(historyDir)
    .filter((f) => f.endsWith(suffix))
    .map((f) => f.slice(0, -suffix.length))
    .sort();
}

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface UniverseSplit {
  /** Символы, доступные перебору и делению пополам. */
  search: string[];
  /** Отложенные — только финальная проверка ширины, никогда не в переборе. */
  holdout: string[];
}

/** Детерминированное разбиение: hash(symbol) % 5 == 0 → holdout. */
/**
 * Отпечаток корпуса — что именно измеряли.
 *
 * Записывается в каждое испытание и НИКОГДА не меняется задним числом.
 * Нужен потому, что спотовый корпус и фьючерсный — РАЗНЫЕ рынки: цена одна,
 * а микроструктура (фандинг, открытый интерес, ликвидации) существует только
 * у вторых. Смешивать испытания разных корпусов в одном счётчике проб —
 * значит поднимать планку дефляции измерениями чужого рынка.
 *
 * Формат: `<источник>:<число символов>:<самый ранний бар>`, например
 * `perp:162:2019-09-08`. Из манифеста, если он есть; иначе — по каталогу,
 * чтобы поле никогда не было пустым.
 */
export function corpusVersion(historyDir = HISTORY_DIR): string {
  try {
    const manifest = JSON.parse(readFileSync(join(historyDir, "manifest.json"), "utf8")) as {
      source?: string;
      symbols?: number;
      coverage?: { tf: string; firstIso: string }[];
    };
    const earliest = (manifest.coverage ?? [])
      .filter((c) => c.tf === "1h")
      .reduce((a, c) => (c.firstIso < a ? c.firstIso : a), "9999");
    return `${manifest.source ?? "unknown"}:${manifest.symbols ?? 0}:${earliest.slice(0, 10)}`;
  } catch {
    // Манифеста нет — корпус собран не нашим сборщиком. Это тоже факт,
    // и его надо записать честно, а не подставить пустоту.
    //
    // ⚠️ Второй try обязателен, и это не перестраховка: раньше запасная ветка
    // сама бросала (каталога корпуса могло не быть вовсе — в облаке он живёт
    // в кэше раннера, а на промахе кэша `actions/cache/restore` каталога не
    // создаёт). Исключение из блока catch наружу и уронило часовой тик, хотя
    // корпус ему не нужен. Функция, описывающая происхождение данных, обязана
    // отвечать всегда — «не знаю» это тоже ответ.
    try {
      return `nomanifest:${listUniverse("1h", historyDir).length}:unknown`;
    } catch {
      return "nocorpus:0:unknown";
    }
  }
}

export interface CorpusFreshness {
  /** Самый свежий бар во всём корпусе, ISO. `null` — манифеста нет. */
  newestIso: string | null;
  /** Возраст этого бара в сутках; `null` при отсутствии манифеста. */
  ageDays: number | null;
  /** Сколько символов отстают от лидера больше чем на сутки. */
  laggingSymbols: number;
}

/**
 * Свежесть корпуса — по манифесту, а НЕ по mtime файлов.
 *
 * Разница принципиальная: `git checkout` и восстановление кэша ставят файлам
 * сегодняшнее время, то есть mtime врал бы «свежо» ровно в той ситуации, ради
 * которой проверка написана. Манифест хранит `lastIso` — таймстемп последнего
 * БАРА, и подделать его нельзя ничем, кроме реальной дозаписи данных.
 *
 * Существует из-за конкретной аварии: корпус простоял две недели, файлы были
 * на месте, число их не менялось — и никто не заметил. Счётчик файлов такое
 * не ловит по построению.
 *
 * `laggingSymbols` отделяет «сборщик умер» (отстали все) от «монету делистили»
 * (отстала одна) — это разные поломки с разным лечением.
 */
export function corpusFreshness(historyDir = HISTORY_DIR, now = Date.now()): CorpusFreshness {
  try {
    const manifest = JSON.parse(readFileSync(join(historyDir, "manifest.json"), "utf8")) as {
      coverage?: { tf: string; lastIso: string }[];
    };
    const hourly = (manifest.coverage ?? []).filter((c) => c.tf === "1h" && c.lastIso);
    if (hourly.length === 0) return { newestIso: null, ageDays: null, laggingSymbols: 0 };

    const newestIso = hourly.reduce((a, c) => (c.lastIso > a ? c.lastIso : a), "");
    const newestMs = Date.parse(newestIso);
    const dayMs = 86_400_000;
    return {
      newestIso,
      ageDays: (now - newestMs) / dayMs,
      laggingSymbols: hourly.filter((c) => newestMs - Date.parse(c.lastIso) > dayMs).length,
    };
  } catch {
    return { newestIso: null, ageDays: null, laggingSymbols: 0 };
  }
}

export function splitHoldout(symbols: readonly string[]): UniverseSplit {
  const search: string[] = [];
  const holdout: string[] = [];
  for (const s of symbols) {
    (fnv1a(s) % HOLDOUT_FRACTION === 0 ? holdout : search).push(s);
  }
  return { search, holdout };
}

/**
 * Детерминированный поднабор для деления пополам: хэш-перемешивание с фиксной
 * солью, чтобы стадия-16 была префиксом стадии-128 (кандидату не приходится
 * пересдавать те же символы).
 */
export function halvingSubset(symbols: readonly string[], n: number, salt: number): string[] {
  return [...symbols]
    .sort((a, b) => fnv1a(`${salt}:${a}`) - fnv1a(`${salt}:${b}`))
    .slice(0, n);
}

/**
 * ГРАНИЦА OUT-OF-TIME. Всё, что раньше этой даты, — материал поиска; всё, что
 * позже, кандидат видит РОВНО ОДИН РАЗ, последними воротами, и этот патрон
 * тратится навсегда.
 *
 * Зачем: символьный holdout (каждый пятый символ) оказался слабым OOS — за
 * всю жизнь журнала он убил 8 кандидатов из 1103 (0.7%). Причина понятна:
 * разбиение по символам не защищает от подгонки под ЭПОХУ рынка, а крипта
 * ходит одним стадом. Настоящая защита — разбиение по времени.
 *
 * Дата фиксированная, а не скользящая: скользящая граница означала бы, что
 * вчерашний out-of-time завтра становится материалом поиска, и «потрачен
 * один раз» перестаёт быть правдой. Сдвигать её можно только сознательно,
 * с новой пре-регистрацией и новой эпохой журнала.
 */
export const OOT_CUTOFF_ISO = "2025-08-01T00:00:00Z";
export const OOT_CUTOFF_SEC = Math.floor(Date.parse(OOT_CUTOFF_ISO) / 1000);

/**
 * Прогрев перед первым баром OOT-окна: индикаторам нужна предыстория
 * (SMA200 + окно волатильности), иначе первые ~300 баров окна не дают
 * сигналов вообще. Бары прогрева ЛЕЖАТ ДО границы и участвуют только как
 * контекст: сделки, открытые раньше границы, отбрасываются вызывающим.
 */
export const OOT_WARMUP_BARS = 600;


export type LiquidityTier = "liquid" | "illiquid";

const tierCache = new Map<string, Map<string, LiquidityTier>>();

/**
 * Срез вселенной по ликвидности: верхняя половина по среднему НОТИОНАЛУ
 * (volume × close) за последние 180 дней in-окна — «ликвидные», нижняя —
 * «неликвидные».
 *
 * Зачем: кросс-секционный разворот в крипте живёт в НЕликвидных монетах, а
 * моментум — в ликвидных (IRFA, 3600+ монет); усреднение по всей вселенной
 * гасит оба эффекта. Пункт 3 фазы 1, ранжирование критика №4.
 *
 * Нотионал, а не сырой объём: объём в штуках монеты несравним между BTC и
 * мем-коином. Считается по in-окну — OOT-год в определение среза не
 * подглядывает.
 */
export function liquidityTiers(
  tf: SignalTf,
  symbols: readonly string[],
  historyDir = HISTORY_DIR,
): Map<string, LiquidityTier> {
  const key = `${historyDir}|${tf}|${symbols.length}`;
  const cached = tierCache.get(key);
  if (cached) return cached;

  const barsPerDay = tf === "1d" ? 1 : Math.round(86400 / (tf === "1h" ? 3600 : 14400));
  const notional = new Map<string, number>();
  for (const symbol of symbols) {
    const candles = loadCandlesWindow(symbol, tf, "in", historyDir);
    if (!candles || candles.length === 0) {
      notional.set(symbol, 0);
      continue;
    }
    const tail = candles.slice(-180 * barsPerDay);
    let sum = 0;
    for (const bar of tail) sum += bar.volume * bar.close;
    notional.set(symbol, sum / tail.length);
  }

  const sorted = [...notional.entries()].sort((a, b) => b[1] - a[1]);
  const half = Math.ceil(sorted.length / 2);
  const tiers = new Map<string, LiquidityTier>();
  sorted.forEach(([symbol], i) => tiers.set(symbol, i < half ? "liquid" : "illiquid"));
  tierCache.set(key, tiers);
  return tiers;
}

export type CorpusWindow = "in" | "oot" | "all";

/**
 * Мемо-кэш распакованных свечей. Гаунтлет v3 (нуль-модель по всем символам
 * кандидата) и плато перечитывают одни и те же файлы десятки раз за ночь;
 * gunzip+parse на файл — сотни мс. Вся вселенная одного ТФ ≈ 0.7 ГБ — на
 * раннере помещается, но между вселенными кэш чистится (см. clearCandleCache
 * в runScreen), чтобы 1h и 4h не жили в памяти одновременно.
 *
 * Срезы окон кэшируются отдельно и НЕ пересоздаются: кэш индикаторных серий
 * движка привязан к идентичности массива свечей (WeakMap), поэтому свежий
 * slice на каждый вызов означал бы пересчёт всех индикаторов.
 */
/**
 * Кэш ОГРАНИЧЕН: держать весь корпус 1h (170 символов × 44к баров) вместе с
 * индикаторными рядами на каждый массив — верный путь в out-of-memory,
 * пойманный на гаунтлете 31.07. Обходы устроены символ-мажорно, поэтому
 * повторное использование живёт внутри одного символа, и маленького окна
 * достаточно; вытеснение освобождает и привязанные к массиву кэши серий
 * (они на WeakMap).
 */
const CACHE_SYMBOLS = 3;
const candleCache = new Map<string, Candle[] | null>();
const windowCache = new Map<string, Candle[] | null>();

function remember<T>(cache: Map<string, T>, key: string, value: T, limit: number): T {
  cache.set(key, value);
  while (cache.size > limit) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return value;
}

export function clearCandleCache(): void {
  candleCache.clear();
  windowCache.clear();
}

/** Индекс первого бара с временем ≥ cutoff (бинарный поиск). */
function firstIndexAtOrAfter(candles: readonly Candle[], timeSec: number): number {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time < timeSec) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Свечи символа в заданном окне:
 * - `in`  — строго до границы OOT (материал поиска и всех стадий);
 * - `oot` — граница и позже, ПЛЮС OOT_WARMUP_BARS баров контекста перед ней
 *   (сделки до границы обязан отфильтровать вызывающий по entryTime);
 * - `all` — вся история (инкубатор, надзор — там время идёт вперёд само).
 */
export function loadCandlesWindow(
  symbol: string,
  tf: SignalTf,
  window: CorpusWindow,
  historyDir = HISTORY_DIR,
): Candle[] | null {
  if (window === "all") return loadCandles(symbol, tf, historyDir);
  const key = `${historyDir}|${symbol}|${tf}|${window}`;
  const cached = windowCache.get(key);
  if (cached !== undefined) return cached;

  const full = loadCandles(symbol, tf, historyDir);
  let sliced: Candle[] | null = null;
  if (full) {
    const cut = firstIndexAtOrAfter(full, OOT_CUTOFF_SEC);
    sliced =
      window === "in" ? full.slice(0, cut) : full.slice(Math.max(0, cut - OOT_WARMUP_BARS));
  }
  // Окон два на символ ("in" и "oot"), поэтому лимит вдвое больше.
  return remember(windowCache, key, sliced, CACHE_SYMBOLS * 2);
}

export function loadCandles(
  symbol: string,
  tf: SignalTf,
  historyDir = HISTORY_DIR,
): Candle[] | null {
  const key = `${historyDir}|${symbol}|${tf}`;
  const cached = candleCache.get(key);
  if (cached !== undefined) return cached;
  const path = join(historyDir, `${safeFilename(symbol)}_${tf}.json.gz`);
  const candles = existsSync(path)
    ? (JSON.parse(gunzipSync(readFileSync(path)).toString("utf-8")) as Candle[])
    : null;
  return remember(candleCache, key, candles, CACHE_SYMBOLS);
}
