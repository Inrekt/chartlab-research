import type { Candle } from "../types";
import type { IndicatorPoint } from "./index";

const MIN_PERCENTILE_LOOKBACK = 2;

/**
 * Realized volatility — population standard deviation of the log returns of
 * `close` over the trailing `period` returns, WITHOUT annualization:
 * annualization depends on the bar timeframe and is applied at the
 * presentation layer; this is the raw per-bar value.
 *
 * A window of `period` returns needs `period + 1` candles, so the first point
 * lands on `candles[period].time` (same warmup convention as `atr`/`rsi`).
 * Population stdev (divide by `period`) matches `bollinger`.
 */
export function realizedVol(candles: Candle[], period = 20): IndicatorPoint[] {
  const out: IndicatorPoint[] = [];
  if (candles.length < period + 1) return out;

  // logReturns[i] is the return into candles[i + 1].
  const logReturns: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    logReturns.push(Math.log(candles[i].close / candles[i - 1].close));
  }

  for (let i = period - 1; i < logReturns.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += logReturns[j];
    const mean = sum / period;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (logReturns[j] - mean) ** 2;
    out.push({ time: candles[i + 1].time, value: Math.sqrt(variance / period) });
  }
  return out;
}

/**
 * Percentile rank (0–100) of the current {@link realizedVol} value within the
 * last `lookback` vol values (current included): the share of the other
 * `lookback − 1` window values strictly below the current one. 0 = lowest in
 * the window (ties count as "not below"), 100 = strict maximum. Intended for
 * "low/high volatility" regime filters.
 *
 * Points appear only once `lookback` vol values exist, so the first point
 * lands on `candles[period + lookback - 1].time`. Requires `lookback >= 2`
 * (a single-value window has no rank), otherwise returns [].
 */
export function realizedVolPercentile(
  candles: Candle[],
  period = 20,
  lookback = 252,
): IndicatorPoint[] {
  const out: IndicatorPoint[] = [];
  if (lookback < MIN_PERCENTILE_LOOKBACK) return out;

  const vols = realizedVol(candles, period);
  for (let i = lookback - 1; i < vols.length; i++) {
    const current = vols[i].value;
    let below = 0;
    for (let j = i - lookback + 1; j <= i; j++) {
      if (vols[j].value < current) below++;
    }
    out.push({ time: vols[i].time, value: (100 * below) / (lookback - 1) });
  }
  return out;
}
