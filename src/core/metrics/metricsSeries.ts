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
  /**
   * Открытый интерес (oi) часа — ПОСЛЕДНИЙ 5-минутный сэмпл внутри часа
   * (backfill-metrics.aggregateHourly), то есть известен к концу часа, а не к
   * его началу. Строка с меткой H описывает интервал [H, H+1ч). Опционален по той же причине, что и
   * поля выше: старые фикстуры его не несут. Нужен семейству «Принудительный
   * поток»: падение OI отличает делеверидж (закрывают позиции) от нового
   * позиционирования (открывают). Пре-регистрация:
   * researcher/docs/family-forced-flow-preregistration.md.
   */
  oi?: Float64Array;
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
  if (candles.length < 2) return new Float64Array(candles.length).fill(NaN);
  return rollingPercentile(cachedImbalance(candles, symbol), candles, windowDays);
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
  if (candles.length < 2) return new Float64Array(candles.length).fill(NaN);
  return rollingPercentile(cachedCrowdTopDivergence(candles, symbol), candles, windowDays);
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

/**
 * Скользящий процентиль ряда со СРЕДНИМ рангом при равенствах. Окно в днях
 * пересчитывается в бары по шагу свечей; окно с < 90% конечных значений даёт
 * NaN. Общий для всех атомов метрик — один и тот же ранг, одни и те же
 * правила дыр, чтобы новый атом не изобретал свою терпимость.
 */
function rollingPercentile(
  values: Float64Array,
  candles: readonly Candle[],
  windowDays: number,
): Float64Array {
  const out = new Float64Array(candles.length).fill(NaN);
  if (candles.length < 2) return out;
  const step = candles[1].time - candles[0].time;
  const windowBars = Math.max(2, Math.round((windowDays * 86400) / step));
  const minFinite = Math.ceil(windowBars * 0.9);

  for (let i = windowBars - 1; i < candles.length; i++) {
    const current = values[i];
    if (!Number.isFinite(current)) continue;
    let finite = 0;
    let below = 0;
    let equal = 0;
    for (let k = i - windowBars + 1; k <= i; k++) {
      const v = values[k];
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

/** Часов в баре по шагу свечей (минимум 1). */
function hoursPerBar(candles: readonly Candle[]): number {
  return Math.max(1, Math.round((candles[1].time - candles[0].time) / 3600));
}

/**
 * Изменение открытого интереса за `bars` баров: d_i = ln(OI_i / OI_{i−bars}).
 *
 * OI бара — значение ПОСЛЕДНЕГО часа бара (OI — уровень, а не поток:
 * усреднение размазало бы событие). Логарифм — ради сравнимости монет, у
 * каждой свой масштаб контрактов. Считается по `oi` в КОНТРАКТАХ, не по
 * `oiValue`: долларовый OI падает уже от падения цены, и «падение OI» на нём
 * было бы тавтологией (замер в DRAFT-family-liquidation-cascade.md §4.4).
 *
 * Причинность: часы бара [T, T+шаг) полностью известны на его закрытии; ряд
 * НИКОГДА не берёт час T+шаг и позже. Дыры: нет хотя бы одного часа бара
 * (у бара или у бара i−bars) → NaN; бары i и i−bars обязаны отстоять ровно
 * на `bars` шагов (дыра в свечах не превращается в скачок OI).
 */
export function oiLogChange(candles: readonly Candle[], symbol: string, bars: number): Float64Array {
  const out = new Float64Array(candles.length).fill(NaN);
  const history = loadMetricsHistory(symbol);
  if (!history || !history.oi || candles.length < 2 || bars < 1) return out;
  const { oi } = history;

  const byHour = new Map<number, number>();
  for (let i = 0; i < history.hourStarts.length; i++) byHour.set(history.hourStarts[i], oi[i]);

  const step = candles[1].time - candles[0].time;
  const hours = hoursPerBar(candles);
  const barOi = new Float64Array(candles.length).fill(NaN);
  for (let i = 0; i < candles.length; i++) {
    let last = NaN;
    let ok = true;
    for (let h = 0; h < hours; h++) {
      const v = byHour.get(candles[i].time + h * 3600);
      if (v === undefined || !Number.isFinite(v) || v <= 0) {
        ok = false;
        break;
      }
      last = v;
    }
    if (ok) barOi[i] = last;
  }

  for (let i = bars; i < candles.length; i++) {
    if (candles[i].time - candles[i - bars].time !== bars * step) continue;
    const now = barOi[i];
    const then = barOi[i - bars];
    if (!Number.isFinite(now) || !Number.isFinite(then)) continue;
    out[i] = Math.log(now / then);
  }
  return out;
}

/** Процентиль изменения OI текущего бара в его скользящей истории. */
export function oiChangePercentile(
  candles: readonly Candle[],
  symbol: string,
  bars: number,
  windowDays: number,
): Float64Array {
  const change = remember(candles, `oichg:${symbol}:${bars}`, () => oiLogChange(candles, symbol, bars));
  return rollingPercentile(change, candles, windowDays);
}

/** Кэш процентиля: ряд один на (свечи, символ, горизонт, окно) на всю ночь. */
export function cachedOiChangePercentile(
  candles: readonly Candle[],
  symbol: string,
  bars: number,
  windowDays: number,
): Float64Array {
  return remember(candles, `oichgpct:${symbol}:${bars}:${windowDays}`, () =>
    oiChangePercentile(candles, symbol, bars, windowDays),
  );
}

/**
 * Доля лонга топ-трейдеров бара по ОБЪЁМУ позиций (topLsPositions):
 * mean(ratio)/(mean(ratio)+1) по часам бара ∈ (0, 1). Доля, а не голый ratio
 * — по той же причине, что у расхождения толпы/крупных: ratio 3 и 1/3
 * симметричны относительно доли. Причинность и дыры — как у takerImbalance.
 */
export function topLongShare(candles: readonly Candle[], symbol: string): Float64Array {
  const out = new Float64Array(candles.length).fill(NaN);
  const history = loadMetricsHistory(symbol);
  if (!history || !history.topLsPositions || candles.length < 2) return out;
  const { topLsPositions } = history;

  const byHour = new Map<number, number>();
  for (let i = 0; i < history.hourStarts.length; i++) {
    byHour.set(history.hourStarts[i], topLsPositions[i]);
  }

  const hours = hoursPerBar(candles);
  for (let i = 0; i < candles.length; i++) {
    let sum = 0;
    let ok = true;
    for (let h = 0; h < hours; h++) {
      const v = byHour.get(candles[i].time + h * 3600);
      if (v === undefined || !Number.isFinite(v) || v < 0) {
        ok = false;
        break;
      }
      sum += v;
    }
    if (!ok) continue;
    const mean = sum / hours;
    out[i] = mean / (mean + 1);
  }
  return out;
}

/** Процентиль доли лонга топ-трейдеров текущего бара в его скользящей истории. */
export function topLongSharePercentile(
  candles: readonly Candle[],
  symbol: string,
  windowDays: number,
): Float64Array {
  const share = remember(candles, `tls:${symbol}`, () => topLongShare(candles, symbol));
  return rollingPercentile(share, candles, windowDays);
}

/** Кэш процентиля: ряд один на (свечи, символ, окно) на всю ночь. */
export function cachedTopLongSharePercentile(
  candles: readonly Candle[],
  symbol: string,
  windowDays: number,
): Float64Array {
  return remember(candles, `tlspct:${symbol}:${windowDays}`, () =>
    topLongSharePercentile(candles, symbol, windowDays),
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
