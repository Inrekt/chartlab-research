import type { Candle } from "../types";
import { loadMetricsHistory } from "../metrics/metricsSeries";

/**
 * Честный поток тейкеров (доля агрессивных ПРОДАЖ за час) для семейства
 * «Принудительный поток».
 *
 * Источник ПОДКЛЮЧАЕТСЯ, как метрики и фандинг: ноде ставит CSV-загрузчик
 * (researcher/flowCsv.ts), браузеру подключать нечего. Прямое чтение диска
 * здесь запрещено — модуль тянется вычислителем условий, а тот живёт и в
 * браузере.
 *
 * Почему отдельно от metricsSeries: честный поток лежит в ДРУГОМ файле
 * (flow-1h/, поле klines[9]), а не в metrics-1h. Старая колонка
 * takerBuySellVol в метриках измерена порочно (её хвосты выбирают тонкие часы,
 * а не события) — эта серия её заменяет.
 * Пре-регистрация: researcher/docs/family-forced-flow-preregistration.md.
 */
export interface FlowHistory {
  /** Начало часа, СЕКУНДЫ unix. Возрастает. */
  hourStarts: Float64Array;
  /** Доля агрессивных ПРОДАЖ за час = 1 − takerBuyVolume/volume ∈ [0, 1]. */
  sellFrac: Float64Array;
}

export type FlowLoader = (symbol: string) => FlowHistory | null;

let loader: FlowLoader = () => null;
const historyCache = new Map<string, FlowHistory | null>();

/** Подключает источник потока. Сбрасывает кэши: источник сменился. */
export function setFlowLoader(fn: FlowLoader): void {
  loader = fn;
  clearFlowCache();
}

export function loadFlowHistory(symbol: string): FlowHistory | null {
  const cached = historyCache.get(symbol);
  if (cached !== undefined) return cached;
  const history = loader(symbol);
  historyCache.set(symbol, history);
  return history;
}

export function clearFlowCache(): void {
  historyCache.clear();
  seriesCache = new WeakMap();
}

/**
 * Две выровненные к свечам серии для атома forcedFlow:
 * - `sellFrac` — усреднённая доля продаж за бар (NaN, если хоть один час бара
 *   отсутствует: дыра не должна молча становиться сигналом);
 * - `oiChg` — относительное изменение открытого интереса через СМЕЖНЫЙ час
 *   (NaN, если предыдущий час отсутствует).
 *
 * ⚠️ Guard смежности (из верификации провенанса OI 2026-08-14): oiChg берётся
 * ТОЛЬКО когда час, предшествующий бару, реально есть в ряду OI. В ряду ~16–20%
 * дыр дискретными блоками; без guard'а дыра давала бы ложный скачок OI, а с ним
 * — ложный «делеверидж». При дыре атом молчит.
 *
 * Причинность: часы бара полностью известны на его закрытии, сдвига в будущее
 * нет; OI берётся на начало часа, задним числом не ревизуется (проверено).
 */
export interface ForcedFlowSeries {
  sellFrac: Float64Array;
  oiChg: Float64Array;
}

export function forcedFlowSeries(candles: readonly Candle[], symbol: string): ForcedFlowSeries {
  const n = candles.length;
  const sellFrac = new Float64Array(n).fill(NaN);
  const oiChg = new Float64Array(n).fill(NaN);
  if (n < 2) return { sellFrac, oiChg };

  const step = candles[1].time - candles[0].time;
  const hours = Math.max(1, Math.round(step / 3600));

  const flow = loadFlowHistory(symbol);
  if (flow) {
    const bySell = new Map<number, number>();
    for (let i = 0; i < flow.hourStarts.length; i++) {
      bySell.set(flow.hourStarts[i], flow.sellFrac[i]);
    }
    for (let i = 0; i < n; i++) {
      let sum = 0;
      let ok = true;
      for (let h = 0; h < hours; h++) {
        const v = bySell.get(candles[i].time + h * 3600);
        if (v === undefined || !Number.isFinite(v)) {
          ok = false;
          break;
        }
        sum += v;
      }
      if (ok) sellFrac[i] = sum / hours;
    }
  }

  const metrics = loadMetricsHistory(symbol);
  if (metrics?.oi) {
    const byOi = new Map<number, number>();
    for (let i = 0; i < metrics.hourStarts.length; i++) {
      byOi.set(metrics.hourStarts[i], metrics.oi[i]);
    }
    for (let i = 0; i < n; i++) {
      const lastHour = candles[i].time + (hours - 1) * 3600;
      const prevHour = candles[i].time - 3600; // смежный час ДО бара
      const cur = byOi.get(lastHour);
      const prev = byOi.get(prevHour);
      // Дыра в OI (нет смежного часа) → нет сигнала: guard смежности.
      if (cur === undefined || prev === undefined) continue;
      if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev <= 0) continue;
      oiChg[i] = cur / prev - 1;
    }
  }

  return { sellFrac, oiChg };
}

let seriesCache = new WeakMap<readonly Candle[], Map<string, ForcedFlowSeries>>();

/** Кэш серии: один расчёт на (свечи, символ) на всю ночь. */
export function cachedForcedFlowSeries(
  candles: readonly Candle[],
  symbol: string,
): ForcedFlowSeries {
  let perCandles = seriesCache.get(candles);
  if (!perCandles) {
    perCandles = new Map();
    seriesCache.set(candles, perCandles);
  }
  let series = perCandles.get(symbol);
  if (!series) {
    series = forcedFlowSeries(candles, symbol);
    perCandles.set(symbol, series);
  }
  return series;
}
