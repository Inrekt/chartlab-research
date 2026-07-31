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
import type { SignalTf } from "./grammar.ts";

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
 * Мемо-кэш распакованных свечей. Гаунтлет v3 (нуль-модель по всем символам
 * кандидата) и плато перечитывают одни и те же файлы десятки раз за ночь;
 * gunzip+parse на файл — сотни мс. Вся вселенная одного ТФ ≈ 0.7 ГБ — на
 * раннере помещается, но между вселенными кэш чистится (см. clearCandleCache
 * в runScreen), чтобы 1h и 4h не жили в памяти одновременно.
 */
const candleCache = new Map<string, Candle[] | null>();

export function clearCandleCache(): void {
  candleCache.clear();
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
  candleCache.set(key, candles);
  return candles;
}
