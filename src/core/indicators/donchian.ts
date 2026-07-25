import type { Candle } from "../types";

export interface DonchianPoint {
  time: number;
  upper: number;
  lower: number;
  middle: number;
}

/**
 * Donchian Channel — the classic breakout envelope behind Turtle-style systems.
 *
 * For each bar, over the last `period` closed bars up to and including the
 * current one:
 * - `upper`  = highest high
 * - `lower`  = lowest low
 * - `middle` = (upper + lower) / 2
 *
 * Breakout semantics: a long entry is a crossover of `close` above the Donchian
 * `upper` of the PREVIOUS bar (the current bar's high is itself part of the
 * current window, so comparing against the same bar's channel would never
 * trigger). This series is computed over the current window inclusive; the
 * evaluator applies the one-bar shift via its crossover semantics.
 */
export function donchian(candles: Candle[], period = 20): DonchianPoint[] {
  const out: DonchianPoint[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    let upper = -Infinity;
    let lower = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (candles[j].high > upper) upper = candles[j].high;
      if (candles[j].low < lower) lower = candles[j].low;
    }
    out.push({ time: candles[i].time, upper, lower, middle: (upper + lower) / 2 });
  }
  return out;
}
