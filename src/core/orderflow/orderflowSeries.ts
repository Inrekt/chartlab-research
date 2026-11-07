import type { Candle } from "../types";
import { atr } from "../indicators";

/**
 * Ордерфлоу (свёртка aggTrades в 15-минутные бары) и кубики семейства
 * «свип равных уровней, подтверждённый ордерфлоу».
 * Пре-регистрация: researcher/docs/family-orderflow-sweep-preregistration.md.
 *
 * Источник ПОДКЛЮЧАЕТСЯ, как у метрик: ноде ставит загрузчик
 * (researcher/orderflowCsv.ts), в браузере условия просто ложны. Чтения диска
 * здесь нет — модуль тянется вычислителем условий.
 *
 * Причинность: 15m-бар с меткой T описывает сделки [T, T+15м). Бар свечи
 * [S, S+шаг) берёт ТОЛЬКО свои 15m-бары и только при полном покрытии — дыра
 * → NaN, без интерполяции.
 */

export const ORDERFLOW_STEP_SEC = 900;

export interface OrderflowHistory {
  /** Начало 15m-бара, СЕКУНДЫ unix. Возрастает. */
  barStarts: Float64Array;
  /** Тейкер-покупки и тейкер-продажи бара, $. */
  buyUsd: Float64Array;
  sellUsd: Float64Array;
}

export type OrderflowLoader = (symbol: string) => OrderflowHistory | null;

let loader: OrderflowLoader = () => null;
const historyCache = new Map<string, OrderflowHistory | null>();
let seriesCache = new WeakMap<readonly Candle[], Map<string, Float64Array>>();
let sweepCache = new WeakMap<readonly Candle[], Map<string, Int32Array>>();

/** Подключает источник ордерфлоу. Сбрасывает кэши: источник сменился. */
export function setOrderflowLoader(fn: OrderflowLoader): void {
  loader = fn;
  clearOrderflowCache();
}

export function clearOrderflowCache(): void {
  historyCache.clear();
  seriesCache = new WeakMap();
  sweepCache = new WeakMap();
}

function loadHistory(symbol: string): OrderflowHistory | null {
  const cached = historyCache.get(symbol);
  if (cached !== undefined) return cached;
  const history = loader(symbol);
  historyCache.set(symbol, history);
  return history;
}

function remember(candles: readonly Candle[], key: string, make: () => Float64Array): Float64Array {
  let perCandles = seriesCache.get(candles);
  if (!perCandles) {
    perCandles = new Map();
    seriesCache.set(candles, perCandles);
  }
  let series = perCandles.get(key);
  if (!series) {
    series = make();
    perCandles.set(key, series);
  }
  return series;
}

/**
 * Покупки/продажи тейкеров бара свечи в $ — сумма его 15m-баров. Бар без
 * полного набора 15m-баров → NaN в обоих рядах.
 */
export function barFlow(
  candles: readonly Candle[],
  symbol: string,
): { buy: Float64Array; sell: Float64Array } {
  const buy = new Float64Array(candles.length).fill(NaN);
  const sell = new Float64Array(candles.length).fill(NaN);
  const history = loadHistory(symbol);
  if (!history || candles.length < 2) return { buy, sell };
  const step = candles[1].time - candles[0].time;
  const parts = Math.round(step / ORDERFLOW_STEP_SEC);
  if (parts < 1 || parts * ORDERFLOW_STEP_SEC !== step) return { buy, sell };

  const byStart = new Map<number, number>();
  for (let k = 0; k < history.barStarts.length; k++) byStart.set(history.barStarts[k], k);

  for (let i = 0; i < candles.length; i++) {
    let b = 0;
    let s = 0;
    let ok = true;
    for (let p = 0; p < parts; p++) {
      const k = byStart.get(candles[i].time + p * ORDERFLOW_STEP_SEC);
      if (k === undefined || !Number.isFinite(history.buyUsd[k]) || !Number.isFinite(history.sellUsd[k])) {
        ok = false;
        break;
      }
      b += history.buyUsd[k];
      s += history.sellUsd[k];
    }
    if (ok) {
      buy[i] = b;
      sell[i] = s;
    }
  }
  return { buy, sell };
}

function cachedDelta(candles: readonly Candle[], symbol: string): Float64Array {
  return remember(candles, `delta:${symbol}`, () => {
    const { buy, sell } = barFlow(candles, symbol);
    return buy.map((b, i) => b - sell[i]);
  });
}

/**
 * Поглощение бара: (дельта/объём)·(1 − |close−open|/(high−low)), $ и OHLC
 * свечи. >0 — агрессивные покупки, а цена не продвинулась. Нулевой объём или
 * нулевой диапазон → NaN.
 */
export function absorptionSeries(candles: readonly Candle[], symbol: string): Float64Array {
  const { buy, sell } = barFlow(candles, symbol);
  const out = new Float64Array(candles.length).fill(NaN);
  for (let i = 0; i < candles.length; i++) {
    const vol = buy[i] + sell[i];
    const c = candles[i];
    const range = c.high - c.low;
    if (!(vol > 0) || !(range > 0)) continue;
    const body = Math.min(1, Math.abs(c.close - c.open) / range);
    out[i] = ((buy[i] - sell[i]) / vol) * (1 - body);
  }
  return out;
}

/**
 * Процентиль значения бара среди ПРОШЛЫХ баров окна (текущий бар в окно не
 * входит — так записано в пре-регистрации). Средний ранг при равенствах,
 * окно с < 90% конечных значений → NaN. Те же правила, что у общего
 * процентиля метрик.
 */
export function priorPercentile(values: Float64Array, candles: readonly Candle[], windowDays: number): Float64Array {
  const out = new Float64Array(candles.length).fill(NaN);
  if (candles.length < 2) return out;
  const step = candles[1].time - candles[0].time;
  const windowBars = Math.max(2, Math.round((windowDays * 86400) / step));
  const minFinite = Math.ceil(windowBars * 0.9);
  for (let i = windowBars; i < candles.length; i++) {
    const current = values[i];
    if (!Number.isFinite(current)) continue;
    let finite = 0;
    let below = 0;
    let equal = 0;
    for (let k = i - windowBars; k < i; k++) {
      const v = values[k];
      if (!Number.isFinite(v)) continue;
      finite++;
      if (v < current) below++;
      else if (v === current) equal++;
    }
    if (finite < minFinite) continue;
    out[i] = ((below + equal / 2) / finite) * 100;
  }
  return out;
}

export function cachedAbsorptionPercentile(
  candles: readonly Candle[],
  symbol: string,
  windowDays: number,
): { absorb: Float64Array; rank: Float64Array } {
  const absorb = remember(candles, `absorb:${symbol}`, () => absorptionSeries(candles, symbol));
  const rank = remember(candles, `absorbpct:${symbol}:${windowDays}`, () =>
    priorPercentile(absorb, candles, windowDays),
  );
  return { absorb, rank };
}

export interface EqualLevelParams {
  side: "highs" | "lows";
  pivotBars: number;
  lookback: number;
  tolAtr: number;
}

/**
 * Свип равных экстремумов. Для каждого бара i — индекс МЛАДШЕГО пивота
 * снесённой пары, или −1, если свипа нет. (Для `lows` — зеркально.)
 *
 * - пивот j: хай выше хаёв `pivotBars` баров слева и справа; подтверждён,
 *   только если j + pivotBars < i (все бары подтверждения закрыты до i);
 * - пара равных: два подтверждённых пивота в окне [i − lookback, i), хаи
 *   отличаются ≤ tolAtr · ATR(14) бара i − 1; уровень = старший хай пары;
 * - уровень цел: ни один бар от старшего пивота до i − 1 не поднимался выше
 *   него (иначе стопы за ним уже сняты, и это не «лежащая» ликвидность);
 * - свип: high_i > уровня и close_i < уровня. Из нескольких снесённых пар —
 *   с самым высоким уровнем.
 *
 * Всё, кроме high/close самого бара i, берётся строго из баров < i.
 */
export function equalLevelSweeps(candles: readonly Candle[], p: EqualLevelParams): Int32Array {
  const n = candles.length;
  const out = new Int32Array(n).fill(-1);
  if (n < p.pivotBars * 2 + 2) return out;
  const sign = p.side === "highs" ? 1 : -1;
  const ext = (i: number) => sign * (p.side === "highs" ? candles[i].high : candles[i].low);
  const closeX = (i: number) => sign * candles[i].close;

  const atrAt = new Float64Array(n).fill(NaN);
  const timeIndex = new Map<number, number>();
  candles.forEach((c, i) => timeIndex.set(c.time, i));
  for (const pt of atr(candles as Candle[], 14)) {
    const i = timeIndex.get(pt.time);
    if (i !== undefined) atrAt[i] = pt.value;
  }

  const isPivot = new Uint8Array(n);
  for (let j = p.pivotBars; j < n - p.pivotBars; j++) {
    let ok = true;
    for (let d = 1; d <= p.pivotBars && ok; d++) {
      if (!(ext(j) > ext(j - d) && ext(j) > ext(j + d))) ok = false;
    }
    if (ok) isPivot[j] = 1;
  }

  for (let i = 1; i < n; i++) {
    const tol = p.tolAtr * atrAt[i - 1];
    if (!Number.isFinite(tol)) continue;
    const from = Math.max(0, i - p.lookback);
    const pivots: number[] = [];
    for (let j = from; j + p.pivotBars < i; j++) if (isPivot[j]) pivots.push(j);
    let bestLevel = -Infinity;
    let bestYounger = -1;
    for (let a = 0; a < pivots.length; a++) {
      for (let b = a + 1; b < pivots.length; b++) {
        const older = pivots[a];
        const younger = pivots[b];
        if (Math.abs(ext(older) - ext(younger)) > tol) continue;
        const level = Math.max(ext(older), ext(younger));
        if (!(ext(i) > level && closeX(i) < level)) continue;
        let intact = true;
        for (let k = older; k < i && intact; k++) if (ext(k) > level) intact = false;
        if (intact && level > bestLevel) {
          bestLevel = level;
          bestYounger = younger;
        }
      }
    }
    out[i] = bestYounger;
  }
  return out;
}

export function cachedEqualLevelSweeps(candles: readonly Candle[], p: EqualLevelParams): Int32Array {
  const key = `eql:${p.side}:${p.pivotBars}:${p.lookback}:${p.tolAtr}`;
  let perCandles = sweepCache.get(candles);
  if (!perCandles) {
    perCandles = new Map();
    sweepCache.set(candles, perCandles);
  }
  let series = perCandles.get(key);
  if (!series) {
    series = equalLevelSweeps(candles, p);
    perCandles.set(key, series);
  }
  return series;
}

/**
 * Дивергенция CVD на свипе: CVD(i) − CVD(j) = Σ дельт баров j+1..i, где j —
 * младший пивот снесённой пары. Окно накопления CVD начинается раньше j,
 * поэтому общая часть сокращается и сравнение «CVD на выносе не выше, чем на
 * пивоте» есть ровно «нетто-дельта после пивота ≤ 0» (для минимумов — ≥ 0).
 * Любой бар j+1..i без полного ордерфлоу → нет сигнала.
 */
export function cvdDivergenceAt(
  candles: readonly Candle[],
  symbol: string,
  sweeps: Int32Array,
  side: "highs" | "lows",
  i: number,
): boolean {
  const j = sweeps[i];
  if (j < 0) return false;
  const delta = cachedDelta(candles, symbol);
  let net = 0;
  for (let k = j + 1; k <= i; k++) {
    if (!Number.isFinite(delta[k])) return false;
    net += delta[k];
  }
  return side === "highs" ? net <= 0 : net >= 0;
}
