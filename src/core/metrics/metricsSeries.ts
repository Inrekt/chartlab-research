import type { Candle } from "../types";

/**
 * Почасовые futures-метрики Binance (пока используется тейкерский поток).
 *
 * Источник ПОДКЛЮЧАЕТСЯ, как у фандинга: ноде ставит CSV-загрузчик
 * (researcher/metricsCsv.ts), браузеру подключать нечего — условия по
 * метрикам там просто ложны. Прямое чтение диска в этом модуле запрещено:
 * он тянется вычислителем условий, а тот живёт и в браузере.
 *
 * Пре-регистрация атома: researcher/docs/atoms-taker-flow-preregistration.md.
 */

export interface MetricsHistory {
  /** Начало часа, СЕКУНДЫ unix. Возрастает. */
  hourStarts: Float64Array;
  /** takerBuySellVol — отношение объёма агрессивных покупок к продажам. */
  takerRatio: Float64Array;
  /**
   * globalLsAccounts — лонг/шорт по ЧИСЛУ аккаунтов (толпа: масса розничных
   * счетов). topLsPositions — лонг/шорт по ОБЪЁМУ позиций топ-трейдеров
   * (куда направлен капитал крупных, а не сколько у них счетов). Опциональны:
   * старые загрузчики/фикстуры, собранные до расхождения толпы/крупных, их
   * не знают — отсутствие поля равносильно ряду без данных, а не ошибке
   * типов. Внутри массива NaN там, где бэкфилл не заполнил колонку.
   * Пре-регистрация: researcher/docs/family-crowd-top-divergence-preregistration.md.
   */
  globalLsAccounts?: Float64Array;
  topLsPositions?: Float64Array;
}

export type MetricsLoader = (symbol: string) => MetricsHistory | null;

let loader: MetricsLoader = () => null;
const historyCache = new Map<string, MetricsHistory | null>();

/** Подключает источник метрик. Сбрасывает кэши: источник сменился. */
export function setMetricsLoader(fn: MetricsLoader): void {
  loader = fn;
  clearMetricsCache();
}

export function loadMetricsHistory(symbol: string): MetricsHistory | null {
  const cached = historyCache.get(symbol);
  if (cached !== undefined) return cached;
  const history = loader(symbol);
  historyCache.set(symbol, history);
  return history;
}

export function clearMetricsCache(): void {
  historyCache.clear();
  seriesCache = new WeakMap();
}

/**
 * Дисбаланс тейкеров бара: (ratio − 1) / (ratio + 1) ∈ (−1, 1), где ratio —
 * среднее отношение покупок/продаж по часам бара.
 *
 * Нормировка убирает масштаб отношения: ratio 2.0 и 0.5 симметричны (±1/3).
 *
 * Причинность здесь проще фандинга: часы бара полностью известны в момент
 * его закрытия, сдвига не требуется. Честность про дыры: если хотя бы один
 * час бара отсутствует в метриках — NaN, без интерполяции. Пропущенные данные
 * не должны молча превращаться в сигнал.
 */
export function takerImbalance(candles: readonly Candle[], symbol: string): Float64Array {
  const out = new Float64Array(candles.length).fill(NaN);
  const history = loadMetricsHistory(symbol);
  if (!history || candles.length < 2) return out;

  const byHour = new Map<number, number>();
  for (let i = 0; i < history.hourStarts.length; i++) {
    byHour.set(history.hourStarts[i], history.takerRatio[i]);
  }

  const step = candles[1].time - candles[0].time;
  const hours = Math.max(1, Math.round(step / 3600));

  for (let i = 0; i < candles.length; i++) {
    let sum = 0;
    let ok = true;
    for (let h = 0; h < hours; h++) {
      const ratio = byHour.get(candles[i].time + h * 3600);
      if (ratio === undefined || !Number.isFinite(ratio)) {
        ok = false;
        break;
      }
      sum += ratio;
    }
    if (!ok) continue;
    const mean = sum / hours;
    out[i] = (mean - 1) / (mean + 1);
  }
  return out;
}

/**
 * Процентиль дисбаланса текущего бара в его скользящей истории.
 *
 * Окно задаётся в ДНЯХ и пересчитывается в бары по шагу свечей. Ранг — доля
 * конечных значений окна, не превосходящих текущее. Окно с дырами терпимо до
 * 10% пропусков: одна недостающая пятиминутка у Binance не должна выжигать
 * месяц баров, но окно, где данных меньше 90%, честно даёт NaN.
 */
export function takerImbalancePercentile(
  candles: readonly Candle[],
  symbol: string,
  windowDays: number,
): Float64Array {
  const out = new Float64Array(candles.length).fill(NaN);
  if (candles.length < 2) return out;
  const imb = cachedImbalance(candles, symbol);
  const step = candles[1].time - candles[0].time;
  const windowBars = Math.max(2, Math.round((windowDays * 86400) / step));
  const minFinite = Math.ceil(windowBars * 0.9);

  for (let i = windowBars - 1; i < candles.length; i++) {
    const current = imb[i];
    if (!Number.isFinite(current)) continue;
    let finite = 0;
    let below = 0;
    let equal = 0;
    for (let k = i - windowBars + 1; k <= i; k++) {
      const v = imb[k];
      if (!Number.isFinite(v)) continue;
      finite++;
      if (v < current) below++;
      else if (v === current) equal++;
    }
    if (finite < minFinite) continue;
    // Средний ранг при равенствах. Наивное «доля ≤ текущего» на ПЛОСКОМ окне
    // даёт каждому бару ранг 100 — и атом «верхние 10%» горел бы на ряду
    // вообще без событий. Средний ранг ставит плоское окно на 50.
    out[i] = ((below + equal / 2) / finite) * 100;
  }
  return out;
}

/**
 * Расхождение позиционирования толпы и крупных трейдеров бара, в долях
 * лонга: `crowdLongShare(globalLsAccounts) − topLongShare(topLsPositions)`
 * ∈ (−1, 1). Положительное — толпа лонгует сильнее крупных.
 *
 * `ratio → longShare = ratio/(ratio+1)` вместо голого ratio: та же причина,
 * что у нормировки тейкерского дисбаланса — ratio 3.0 и 1/3 симметричны
 * относительно доли (0.75 и 0.25), а голая разница ratio их бы не уравняла.
 *
 * Причинность и честность про дыры — как у `takerImbalance`: час бара
 * полностью известен на закрытии, дырка в источнике даёт NaN без
 * интерполяции.
 */
export function crowdTopDivergence(candles: readonly Candle[], symbol: string): Float64Array {
  const out = new Float64Array(candles.length).fill(NaN);
  const history = loadMetricsHistory(symbol);
  // Источник без этих колонок вовсе (старая фикстура, загрузчик без
  // бэкфилла) — весь ряд NaN, а не тихое падение на undefined-индексации.
  if (!history || !history.globalLsAccounts || !history.topLsPositions || candles.length < 2) {
    return out;
  }
  const { globalLsAccounts, topLsPositions } = history;

  const byHour = new Map<number, { crowd: number; top: number }>();
  for (let i = 0; i < history.hourStarts.length; i++) {
    byHour.set(history.hourStarts[i], {
      crowd: globalLsAccounts[i],
      top: topLsPositions[i],
    });
  }

  const step = candles[1].time - candles[0].time;
  const hours = Math.max(1, Math.round(step / 3600));
  const longShare = (ratio: number): number => ratio / (ratio + 1);

  for (let i = 0; i < candles.length; i++) {
    let crowdSum = 0;
    let topSum = 0;
    let ok = true;
    for (let h = 0; h < hours; h++) {
      const row = byHour.get(candles[i].time + h * 3600);
      if (row === undefined || !Number.isFinite(row.crowd) || !Number.isFinite(row.top)) {
        ok = false;
        break;
      }
      crowdSum += row.crowd;
      topSum += row.top;
    }
    if (!ok) continue;
    out[i] = longShare(crowdSum / hours) - longShare(topSum / hours);
  }
  return out;
}

/** Процентиль расхождения текущего бара в его скользящей истории — см. `takerImbalancePercentile`. */
export function crowdTopDivergencePercentile(
  candles: readonly Candle[],
  symbol: string,
  windowDays: number,
): Float64Array {
  const out = new Float64Array(candles.length).fill(NaN);
  if (candles.length < 2) return out;
  const div = cachedCrowdTopDivergence(candles, symbol);
  const step = candles[1].time - candles[0].time;
  const windowBars = Math.max(2, Math.round((windowDays * 86400) / step));
  const minFinite = Math.ceil(windowBars * 0.9);

  for (let i = windowBars - 1; i < candles.length; i++) {
    const current = div[i];
    if (!Number.isFinite(current)) continue;
    let finite = 0;
    let below = 0;
    let equal = 0;
    for (let k = i - windowBars + 1; k <= i; k++) {
      const v = div[k];
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

function cachedCrowdTopDivergence(candles: readonly Candle[], symbol: string): Float64Array {
  return remember(candles, `ctd:${symbol}`, () => crowdTopDivergence(candles, symbol));
}

/** Кэш процентиля: ряд один на (свечи, символ, окно) на всю ночь. */
export function cachedCrowdTopPercentile(
  candles: readonly Candle[],
  symbol: string,
  windowDays: number,
): Float64Array {
  return remember(candles, `ctdpct:${symbol}:${windowDays}`, () =>
    crowdTopDivergencePercentile(candles, symbol, windowDays),
  );
}

let seriesCache = new WeakMap<readonly Candle[], Map<string, Float64Array>>();

function cachedImbalance(candles: readonly Candle[], symbol: string): Float64Array {
  return remember(candles, `imb:${symbol}`, () => takerImbalance(candles, symbol));
}

/** Кэш процентиля: ряд один на (свечи, символ, окно) на всю ночь. */
export function cachedTakerPercentile(
  candles: readonly Candle[],
  symbol: string,
  windowDays: number,
): Float64Array {
  return remember(candles, `pct:${symbol}:${windowDays}`, () =>
    takerImbalancePercentile(candles, symbol, windowDays),
  );
}

function remember(
  candles: readonly Candle[],
  key: string,
  make: () => Float64Array,
): Float64Array {
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
