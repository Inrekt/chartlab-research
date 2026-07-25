import type { Candle } from "../types";

export interface AtrChannelPoint {
  time: number;
  middle: number;
  upper: number;
  lower: number;
}

/**
 * ATR-канал от SMA-базиса: middle = SMA(period) по close, полосы =
 * middle ± mult·ATR(atrPeriod). Отличается от Кельтнера базисом (SMA, не EMA)
 * и типично более широким множителем — это chandelier-семейство, канал для
 * пробойных и trailing-логик на дневках, а не для fade внутри дня.
 *
 * ATR считается локально (Wilder RMA по true range) — файл самодостаточен.
 */
export function atrChannel(
  candles: Candle[],
  period = 20,
  atrPeriod = 14,
  mult = 3,
): AtrChannelPoint[] {
  if (candles.length === 0) return [];
  const atr = wilderAtr(candles, atrPeriod);

  const out: AtrChannelPoint[] = [];
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].close;
    if (i >= period) sum -= candles[i - period].close;
    if (i < period - 1) continue;
    const a = atr[i];
    if (a === null) continue;
    const middle = sum / period;
    out.push({
      time: candles[i].time,
      middle,
      upper: middle + mult * a,
      lower: middle - mult * a,
    });
  }
  return out;
}

/** ATR по Уайлдеру, выровнен по индексам свечей; null до наполнения окна. */
function wilderAtr(candles: Candle[], period: number): (number | null)[] {
  const out = new Array<number | null>(candles.length).fill(null);
  let prev: number | null = null;
  let trSum = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = i > 0 ? candles[i - 1].close : c.close;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
    if (prev === null) {
      trSum += tr;
      if (i === period - 1) {
        prev = trSum / period;
        out[i] = prev;
      }
      continue;
    }
    prev = (prev * (period - 1) + tr) / period;
    out[i] = prev;
  }
  return out;
}
