import type { Candle } from "../types";

export interface KeltnerPoint {
  time: number;
  middle: number;
  upper: number;
  lower: number;
}

/**
 * Keltner Channel: EMA(period) basis over closes, bands at basis ± mult * ATR(atrPeriod).
 * ATR (Wilder RMA over true range) is computed locally so this module stays self-contained.
 * The first point appears once BOTH windows are filled: index max(period - 1, atrPeriod).
 */
export function keltner(
  candles: Candle[],
  period = 20,
  atrPeriod = 10,
  mult = 2
): KeltnerPoint[] {
  const emaValues = emaByIndex(candles, period);
  const atrValues = atrByIndex(candles, atrPeriod);

  const out: KeltnerPoint[] = [];
  const start = Math.max(period - 1, atrPeriod);
  for (let i = start; i < candles.length; i++) {
    const middle = emaValues[i];
    const range = atrValues[i];
    if (middle === null || range === null) continue;
    out.push({
      time: candles[i].time,
      middle,
      upper: middle + mult * range,
      lower: middle - mult * range,
    });
  }
  return out;
}

/** EMA of closes aligned by candle index; null until the SMA seed window fills at period-1. */
function emaByIndex(candles: Candle[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  const k = 2 / (period + 1);
  let prev: number | null = null;
  for (let i = 0; i < candles.length; i++) {
    if (prev === null) {
      if (i === period - 1) {
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) sum += candles[j].close;
        prev = sum / period;
        out[i] = prev;
      }
      continue;
    }
    prev = candles[i].close * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder ATR aligned by candle index; null until seeded at index `period` (needs period+1 candles). */
function atrByIndex(candles: Candle[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return out;

  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }

  let sum = 0;
  for (let i = 0; i < period; i++) sum += trueRanges[i];
  let prev = sum / period;
  out[period] = prev;

  for (let i = period; i < trueRanges.length; i++) {
    prev = (prev * (period - 1) + trueRanges[i]) / period;
    out[i + 1] = prev;
  }
  return out;
}
