import type { Candle } from "../types";
import type { IndicatorPoint } from "./index";

const DEFAULT_ROC_PERIOD = 12;

function field(c: Candle, key: keyof Candle): number {
  return c[key] as number;
}

/**
 * Rate of Change over an arbitrary candle field:
 * `100 * (value[i] - value[i - period]) / value[i - period]`.
 *
 * The first point appears once the lookback value exists (i >= period),
 * mirroring the warmup convention of {@link rsi}/{@link atr}. A zero base
 * value yields 0 instead of dividing by zero.
 */
export function rocSeries(
  candles: Candle[],
  period = DEFAULT_ROC_PERIOD,
  key: keyof Candle = "close",
): IndicatorPoint[] {
  const out: IndicatorPoint[] = [];
  if (period <= 0) return out;
  for (let i = period; i < candles.length; i++) {
    const base = field(candles[i - period], key);
    const current = field(candles[i], key);
    const value = base === 0 ? 0 : (100 * (current - base)) / base;
    out.push({ time: candles[i].time, value });
  }
  return out;
}

/** Rate of Change of close price: `100 * (close[i] - close[i - period]) / close[i - period]`. */
export function roc(candles: Candle[], period = DEFAULT_ROC_PERIOD): IndicatorPoint[] {
  return rocSeries(candles, period, "close");
}
