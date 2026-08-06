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
export const HISTORY_DIR = join(__dirname, "..", "public", "data", "history");

/** Доля вселенной, уходящая в отложенный набор (holdout). */
export const HOLDOUT_FRACTION = 5; // каждый пятый ≈ 20%

function safeFilename(symbol: string): string {
  return symbol.replace(/[^a-zA-Z0-9]/g, "_");
}

/** Все символы, у которых в корпусе есть файл данного таймфрейма. */
export function listUniverse(tf: SignalTf, historyDir = HISTORY_DIR): string[] {
  const suffix = `_${tf}.json.gz`;
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
