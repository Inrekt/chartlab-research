/**
 * Помесячное членство символа во вселенной семейства (P1, search-v4).
 *
 * Принцип: символ входит во вселенную месяца M ТОЛЬКО по данным до M. Нотионал
 * берётся за месяц M−1 (никогда не M), история — бары до начала M, данные —
 * ряды, существующие в M. Прежний срез по ликвидности считался один раз по
 * последним 180 дням окна и подглядывал в будущее для всех ранних сделок.
 *
 * Модуль чистый: профили символов приходят снаружи (из свечей корпуса), чтобы
 * правило тестировалось синтетикой. Пре-регистрация:
 * docs/search-v4-preregistration.md, раздел P1.
 */
import type { Candle } from "../src/core/types/index.ts";
import type { ResolvedUniverse } from "./grammar.ts";
import { monthKey, monthlyNotional } from "./liquidityCosts.ts";
import { readFundingCsv } from "./fundingCsv.ts";
import { readMetricsCsv } from "./metricsCsv.ts";
import { readFlowCsv } from "./flowCsv.ts";

/** Год в секундах для порога истории (365 суток, без високосных поправок). */
const YEAR_SEC = 365 * 86_400;

/**
 * Виды данных, которые выводятся из самих свечей и потому есть у любого
 * символа с барами: названия семейств фильтров (requiresContext по умолчанию —
 * это ИМЕННО они) и слово "candles". Проверять нечего.
 */
export const CANDLE_DERIVED_KINDS: ReadonlySet<string> = new Set([
  "candles",
  "trend",
  "momentum",
  "volatility",
  "volume",
  "location",
]);

/**
 * Внешние ряды, наличие которых проверяется по месяцам: фандинг (ставки),
 * метрики (открытый интерес, лонг/шорт, тейкер-отношение) и поток. Любой
 * другой вид данных считается НЕДОСТУПНЫМ (символ не член): опечатка в
 * requiresData должна давать пустую вселенную на виду, а не молчаливо
 * снимать требование.
 */
export const EXTERNAL_DATA_KINDS = ["funding", "metrics", "flow"] as const;

export interface SymbolProfile {
  symbol: string;
  /** Время первого бара ОКНА ПОИСКА, сек; undefined — в окне нет баров. */
  firstBarSec?: number;
  /** Средний нотионал за бар по месяцам ("YYYY-MM"), вся история символа. */
  notional: ReadonlyMap<string, number>;
  /** Месяцы, в которых есть ряд данного вида; null — ряда нет вовсе. */
  dataMonths: (kind: string) => ReadonlySet<string> | null;
}

export interface Membership {
  isMember(symbol: string, month: string): boolean;
  /** Месяцы членства символа. */
  monthsOf(symbol: string): ReadonlySet<string>;
  /** Символы, члены хотя бы одного месяца, прошедшего фильтр (по умолчанию любого). */
  symbolsEver(monthFilter?: (month: string) => boolean): string[];
}

/** Предыдущий календарный месяц: "2024-01" → "2023-12". */
export function prevMonthKey(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/** Начало месяца, unix-секунды UTC. */
export function monthStartSec(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return Date.UTC(y, m - 1, 1) / 1000;
}

/**
 * Членство по правилу вселенной. Порядок: сначала символ ранжируется по
 * нотионалу M−1 среди ВСЕХ символов, у которых в M−1 были бары (topN —
 * первые N; tier — первая половина ceil(n/2) «ликвидная», остальные
 * «неликвидная», как в прежнем срезе), потом независимо проверяются данные
 * месяца M и история до M. Символ без баров в M−1 членом M не бывает.
 */
export function computeMembership(
  profiles: readonly SymbolProfile[],
  universe: ResolvedUniverse,
): Membership {
  const months = new Set<string>();
  for (const p of profiles) for (const m of p.notional.keys()) months.add(m);
  const sortedMonths = [...months].sort();

  const memberMonths = new Map<string, Set<string>>(profiles.map((p) => [p.symbol, new Set<string>()]));
  const dataCache = new Map<string, ReadonlySet<string> | null>();
  const dataFor = (p: SymbolProfile, kind: string): ReadonlySet<string> | null => {
    const key = `${p.symbol}|${kind}`;
    if (!dataCache.has(key)) dataCache.set(key, p.dataMonths(kind));
    return dataCache.get(key)!;
  };

  for (const month of sortedMonths) {
    const prev = prevMonthKey(month);
    const ranked = profiles
      .filter((p) => p.notional.has(prev))
      .map((p) => ({ p, n: p.notional.get(prev)! }))
      .sort((a, b) => b.n - a.n || (a.p.symbol < b.p.symbol ? -1 : 1));
    const half = Math.ceil(ranked.length / 2);
    const startSec = monthStartSec(month);

    ranked.forEach(({ p }, rank) => {
      if (universe.topN !== undefined && rank >= universe.topN) return;
      if (universe.tier === "liquid" && rank >= half) return;
      if (universe.tier === "illiquid" && rank < half) return;
      if (p.firstBarSec === undefined) return; // нулевая история окна — никогда
      if (startSec - p.firstBarSec < universe.minHistoryYears * YEAR_SEC) return;
      for (const kind of universe.requiresData) {
        if (CANDLE_DERIVED_KINDS.has(kind)) continue;
        const have = dataFor(p, kind);
        if (!have || !have.has(month)) return;
      }
      memberMonths.get(p.symbol)!.add(month);
    });
  }

  const empty: ReadonlySet<string> = new Set();
  return {
    isMember: (symbol, month) => memberMonths.get(symbol)?.has(month) ?? false,
    monthsOf: (symbol) => memberMonths.get(symbol) ?? empty,
    symbolsEver: (monthFilter) =>
      profiles
        .filter((p) => {
          const set = memberMonths.get(p.symbol)!;
          if (!monthFilter) return set.size > 0;
          for (const m of set) if (monthFilter(m)) return true;
          return false;
        })
        .map((p) => p.symbol),
  };
}

/** Месяцы с данными вида `kind` для символа — по CSV-источникам корпуса. */
export function csvDataMonths(kind: string, symbol: string): ReadonlySet<string> | null {
  const toMonths = (secs: ArrayLike<number>): Set<string> => {
    const out = new Set<string>();
    for (let i = 0; i < secs.length; i++) out.add(monthKey(secs[i]));
    return out;
  };
  if (kind === "funding") {
    const h = readFundingCsv(symbol);
    return h && h.times.length > 0 ? toMonths(Array.from(h.times, (ms) => ms / 1000)) : null;
  }
  if (kind === "metrics") {
    const h = readMetricsCsv(symbol);
    return h && h.hourStarts.length > 0 ? toMonths(h.hourStarts) : null;
  }
  if (kind === "flow") {
    const h = readFlowCsv(symbol);
    return h && h.hourStarts.length > 0 ? toMonths(h.hourStarts) : null;
  }
  return null;
}

/**
 * Профиль символа из свечей: нотионал по ВСЕЙ истории (месяцы после границы
 * OOT нужны только чтобы членство OOT-месяцев считалось по их прошлому),
 * первый бар — по окну поиска.
 */
export function buildProfile(
  symbol: string,
  allCandles: readonly Candle[] | null,
  inWindowCandles: readonly Candle[] | null,
  dataMonths: SymbolProfile["dataMonths"] = (kind) => csvDataMonths(kind, symbol),
): SymbolProfile {
  return {
    symbol,
    firstBarSec: inWindowCandles && inWindowCandles.length > 0 ? inWindowCandles[0].time : undefined,
    notional: allCandles && allCandles.length > 0 ? monthlyNotional(allCandles) : new Map(),
    dataMonths,
  };
}
