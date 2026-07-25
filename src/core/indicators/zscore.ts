import type { Candle } from "../types";
import type { IndicatorPoint } from "./index";

/**
 * Z-score цены относительно её скользящей средней: (close − SMA) / σ, где σ —
 * population-стандартное отклонение close за то же окно. Основа
 * mean-reversion шаблонов: вход при z < −2 — «цена статистически растянута
 * вниз относительно своего недавнего распределения».
 *
 * Бары, где σ == 0 (константная цена), пропускаются: z там не определён, и
 * честнее не иметь точки, чем выдумывать ноль.
 */
export function zscore(candles: Candle[], period = 20): IndicatorPoint[] {
  const out: IndicatorPoint[] = [];
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < candles.length; i++) {
    const v = candles[i].close;
    sum += v;
    sumSq += v * v;
    if (i >= period) {
      const old = candles[i - period].close;
      sum -= old;
      sumSq -= old * old;
    }
    if (i < period - 1) continue;
    const mean = sum / period;
    const variance = Math.max(0, sumSq / period - mean * mean);
    const stdev = Math.sqrt(variance);
    if (stdev === 0) continue;
    out.push({ time: candles[i].time, value: (v - mean) / stdev });
  }
  return out;
}

/**
 * Z-score произвольного числового ряда (для спреда парного трейдинга и любых
 * производных серий). Возвращает массив той же длины; позиции до наполнения
 * окна и позиции с σ == 0 заполнены NaN.
 */
export function zscoreOf(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(Number.NaN);
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    sum += v;
    sumSq += v * v;
    if (i >= period) {
      const old = values[i - period];
      sum -= old;
      sumSq -= old * old;
    }
    if (i < period - 1) continue;
    const mean = sum / period;
    const variance = Math.max(0, sumSq / period - mean * mean);
    const stdev = Math.sqrt(variance);
    if (stdev === 0) continue;
    out[i] = (v - mean) / stdev;
  }
  return out;
}
