import type { Candle } from "../types";
import type { IndicatorPoint } from "./index";

/**
 * Choppiness Index (Dreiss):
 * 100 * log10(sum(TR, period) / (maxHigh(period) - minLow(period))) / log10(period).
 *
 * Range 0-100: >61.8 suggests a choppy/ranging market, <38.2 a trending one.
 * True range needs the previous close, so the first point lands at candles[period]
 * (same warmup as {@link atr}). Windows where maxHigh === minLow are skipped to
 * avoid division by zero.
 */
export function choppiness(candles: Candle[], period = 14): IndicatorPoint[] {
  const out: IndicatorPoint[] = [];
  if (period < 2 || candles.length < period + 1) return out;

  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }

  const logPeriod = Math.log10(period);
  for (let i = period; i < candles.length; i++) {
    let trSum = 0;
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      trSum += trueRanges[j - 1];
      hi = Math.max(hi, candles[j].high);
      lo = Math.min(lo, candles[j].low);
    }
    const range = hi - lo;
    if (range === 0) continue;
    out.push({ time: candles[i].time, value: (100 * Math.log10(trSum / range)) / logPeriod });
  }
  return out;
}
