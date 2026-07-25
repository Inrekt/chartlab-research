import type { Candle } from "../types";

export interface IndicatorPoint {
  time: number;
  value: number;
}

function field(c: Candle, key: keyof Candle = "close"): number {
  return c[key] as number;
}

export function sma(candles: Candle[], period: number, key: keyof Candle = "close"): IndicatorPoint[] {
  const out: IndicatorPoint[] = [];
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += field(candles[i], key);
    if (i >= period) sum -= field(candles[i - period], key);
    if (i >= period - 1) out.push({ time: candles[i].time, value: sum / period });
  }
  return out;
}

export function ema(candles: Candle[], period: number, key: keyof Candle = "close"): IndicatorPoint[] {
  const out: IndicatorPoint[] = [];
  const k = 2 / (period + 1);
  let prev: number | null = null;
  for (let i = 0; i < candles.length; i++) {
    const v = field(candles[i], key);
    if (prev === null) {
      if (i === period - 1) {
        // seed with SMA of first `period` values
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) sum += field(candles[j], key);
        prev = sum / period;
        out.push({ time: candles[i].time, value: prev });
      }
      continue;
    }
    prev = v * k + prev * (1 - k);
    out.push({ time: candles[i].time, value: prev });
  }
  return out;
}

export function rsi(candles: Candle[], period = 14): IndicatorPoint[] {
  const out: IndicatorPoint[] = [];
  if (candles.length < period + 1) return out;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const delta = candles[i].close - candles[i - 1].close;
    if (delta >= 0) avgGain += delta;
    else avgLoss -= delta;
  }
  avgGain /= period;
  avgLoss /= period;
  out.push({ time: candles[period].time, value: rsiFromAvg(avgGain, avgLoss) });

  for (let i = period + 1; i < candles.length; i++) {
    const delta = candles[i].close - candles[i - 1].close;
    const gain = delta >= 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out.push({ time: candles[i].time, value: rsiFromAvg(avgGain, avgLoss) });
  }
  return out;
}

function rsiFromAvg(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export interface MacdPoint {
  time: number;
  macd: number;
  signal: number;
  histogram: number;
}

export function macd(
  candles: Candle[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9
): MacdPoint[] {
  const fastEma = ema(candles, fastPeriod);
  const slowEma = ema(candles, slowPeriod);
  const slowByTime = new Map(slowEma.map((p) => [p.time, p.value]));

  const macdLine: IndicatorPoint[] = [];
  for (const f of fastEma) {
    const s = slowByTime.get(f.time);
    if (s !== undefined) macdLine.push({ time: f.time, value: f.value - s });
  }

  const signalLine = emaOfSeries(macdLine, signalPeriod);
  const signalByTime = new Map(signalLine.map((p) => [p.time, p.value]));

  return macdLine
    .filter((m) => signalByTime.has(m.time))
    .map((m) => {
      const signal = signalByTime.get(m.time)!;
      return { time: m.time, macd: m.value, signal, histogram: m.value - signal };
    });
}

function emaOfSeries(series: IndicatorPoint[], period: number): IndicatorPoint[] {
  const out: IndicatorPoint[] = [];
  const k = 2 / (period + 1);
  let prev: number | null = null;
  for (let i = 0; i < series.length; i++) {
    if (prev === null) {
      if (i === period - 1) {
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) sum += series[j].value;
        prev = sum / period;
        out.push({ time: series[i].time, value: prev });
      }
      continue;
    }
    prev = series[i].value * k + prev * (1 - k);
    out.push({ time: series[i].time, value: prev });
  }
  return out;
}

export interface BollingerPoint {
  time: number;
  upper: number;
  middle: number;
  lower: number;
}

export function bollinger(candles: Candle[], period = 20, stdDevMultiplier = 2): BollingerPoint[] {
  const out: BollingerPoint[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += candles[j].close;
    const mean = sum / period;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (candles[j].close - mean) ** 2;
    const stdDev = Math.sqrt(variance / period);
    out.push({
      time: candles[i].time,
      middle: mean,
      upper: mean + stdDev * stdDevMultiplier,
      lower: mean - stdDev * stdDevMultiplier,
    });
  }
  return out;
}

export function atr(candles: Candle[], period = 14): IndicatorPoint[] {
  const out: IndicatorPoint[] = [];
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
  let prevAtr = sum / period;
  out.push({ time: candles[period].time, value: prevAtr });

  for (let i = period; i < trueRanges.length; i++) {
    prevAtr = (prevAtr * (period - 1) + trueRanges[i]) / period;
    out.push({ time: candles[i + 1].time, value: prevAtr });
  }
  return out;
}

function rollingHigh(candles: Candle[], i: number, period: number): number {
  let hi = -Infinity;
  for (let j = Math.max(0, i - period + 1); j <= i; j++) hi = Math.max(hi, candles[j].high);
  return hi;
}

function rollingLow(candles: Candle[], i: number, period: number): number {
  let lo = Infinity;
  for (let j = Math.max(0, i - period + 1); j <= i; j++) lo = Math.min(lo, candles[j].low);
  return lo;
}

export interface StochasticPoint {
  time: number;
  k: number;
  d: number;
}

function rollingMean(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}

export function stochastic(candles: Candle[], kPeriod = 14, dPeriod = 3): StochasticPoint[] {
  if (candles.length < kPeriod) return [];
  const kValues: IndicatorPoint[] = [];
  for (let i = kPeriod - 1; i < candles.length; i++) {
    const hi = rollingHigh(candles, i, kPeriod);
    const lo = rollingLow(candles, i, kPeriod);
    const range = hi - lo;
    const k = range === 0 ? 50 : ((candles[i].close - lo) / range) * 100;
    kValues.push({ time: candles[i].time, value: k });
  }
  const dRaw = rollingMean(
    kValues.map((p) => p.value),
    dPeriod,
  );
  const out: StochasticPoint[] = [];
  for (let i = 0; i < kValues.length; i++) {
    const d = dRaw[i];
    if (d !== null) out.push({ time: kValues[i].time, k: kValues[i].value, d });
  }
  return out;
}

export interface AdxPoint {
  time: number;
  plusDI: number;
  minusDI: number;
  adx: number;
}

/** Wilder's ADX/+DI/-DI — smoothing follows the same seed-then-recur pattern as {@link atr}. */
export function adx(candles: Candle[], period = 14): AdxPoint[] {
  if (candles.length < period * 2) return [];

  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const tr: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(
      Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close),
      ),
    );
  }

  function wilderSmooth(values: number[]): number[] {
    const out: number[] = [];
    let sum = 0;
    for (let i = 0; i < period; i++) sum += values[i];
    let prev = sum;
    out.push(prev);
    for (let i = period; i < values.length; i++) {
      prev = prev - prev / period + values[i];
      out.push(prev);
    }
    return out;
  }

  const smoothedPlusDM = wilderSmooth(plusDM);
  const smoothedMinusDM = wilderSmooth(minusDM);
  const smoothedTR = wilderSmooth(tr);

  const dx: number[] = [];
  const plusDIs: number[] = [];
  const minusDIs: number[] = [];
  for (let i = 0; i < smoothedTR.length; i++) {
    const plusDI = smoothedTR[i] === 0 ? 0 : (100 * smoothedPlusDM[i]) / smoothedTR[i];
    const minusDI = smoothedTR[i] === 0 ? 0 : (100 * smoothedMinusDM[i]) / smoothedTR[i];
    plusDIs.push(plusDI);
    minusDIs.push(minusDI);
    const sum = plusDI + minusDI;
    dx.push(sum === 0 ? 0 : (100 * Math.abs(plusDI - minusDI)) / sum);
  }

  if (dx.length < period) return [];
  const out: AdxPoint[] = [];
  let adxSum = 0;
  for (let i = 0; i < period; i++) adxSum += dx[i];
  let adxPrev = adxSum / period;
  // smoothedTR[i] corresponds to candles[i + period] (period raw TR values consumed by the seed).
  out.push({
    time: candles[period + period - 1]!.time,
    plusDI: plusDIs[period - 1],
    minusDI: minusDIs[period - 1],
    adx: adxPrev,
  });
  for (let i = period; i < dx.length; i++) {
    adxPrev = (adxPrev * (period - 1) + dx[i]) / period;
    out.push({ time: candles[period + i]!.time, plusDI: plusDIs[i], minusDI: minusDIs[i], adx: adxPrev });
  }
  return out;
}

export interface IchimokuPoint {
  time: number;
  tenkan: number;
  kijun: number;
  /** Raw (undisplaced) values — the chart layer applies the traditional ±kijunPeriod forward/backward shift for rendering. */
  senkouA: number;
  senkouB: number;
  chikou: number;
}

export function ichimoku(
  candles: Candle[],
  tenkanPeriod = 9,
  kijunPeriod = 26,
  senkouBPeriod = 52,
): IchimokuPoint[] {
  const out: IchimokuPoint[] = [];
  for (let i = senkouBPeriod - 1; i < candles.length; i++) {
    const tenkan = (rollingHigh(candles, i, tenkanPeriod) + rollingLow(candles, i, tenkanPeriod)) / 2;
    const kijun = (rollingHigh(candles, i, kijunPeriod) + rollingLow(candles, i, kijunPeriod)) / 2;
    const senkouB = (rollingHigh(candles, i, senkouBPeriod) + rollingLow(candles, i, senkouBPeriod)) / 2;
    out.push({
      time: candles[i].time,
      tenkan,
      kijun,
      senkouA: (tenkan + kijun) / 2,
      senkouB,
      chikou: candles[i].close,
    });
  }
  return out;
}

export interface SuperTrendPoint {
  time: number;
  value: number;
  direction: "up" | "down";
}

export function superTrend(candles: Candle[], period = 10, multiplier = 3): SuperTrendPoint[] {
  if (candles.length < period + 1) return [];
  const atrPoints = atr(candles, period);
  const atrByTime = new Map(atrPoints.map((p) => [p.time, p.value]));

  const out: SuperTrendPoint[] = [];
  let finalUpper = 0;
  let finalLower = 0;
  let trend: 1 | -1 = 1;

  for (let i = 0; i < candles.length; i++) {
    const a = atrByTime.get(candles[i].time);
    if (a === undefined) continue;
    const hl2 = (candles[i].high + candles[i].low) / 2;
    const basicUpper = hl2 + multiplier * a;
    const basicLower = hl2 - multiplier * a;

    if (out.length === 0) {
      finalUpper = basicUpper;
      finalLower = basicLower;
      trend = candles[i].close >= hl2 ? 1 : -1;
    } else {
      const prevClose = candles[i - 1].close;
      finalUpper = basicUpper < finalUpper || prevClose > finalUpper ? basicUpper : finalUpper;
      finalLower = basicLower > finalLower || prevClose < finalLower ? basicLower : finalLower;
      if (trend === 1 && candles[i].close < finalLower) trend = -1;
      else if (trend === -1 && candles[i].close > finalUpper) trend = 1;
    }

    out.push({
      time: candles[i].time,
      value: trend === 1 ? finalLower : finalUpper,
      direction: trend === 1 ? "up" : "down",
    });
  }
  return out;
}

/** Classic Wilder Parabolic SAR. */
export function parabolicSar(candles: Candle[], step = 0.02, max = 0.2): IndicatorPoint[] {
  if (candles.length < 2) return [];
  const out: IndicatorPoint[] = [];

  let trend: 1 | -1 = candles[1].close >= candles[0].close ? 1 : -1;
  let sar = trend === 1 ? candles[0].low : candles[0].high;
  let ep = trend === 1 ? candles[0].high : candles[0].low;
  let af = step;

  for (let i = 1; i < candles.length; i++) {
    sar = sar + af * (ep - sar);

    if (trend === 1) {
      const prevLow1 = candles[i - 1].low;
      const prevLow2 = i >= 2 ? candles[i - 2].low : prevLow1;
      sar = Math.min(sar, prevLow1, prevLow2);
      if (candles[i].low < sar) {
        trend = -1;
        sar = ep;
        ep = candles[i].low;
        af = step;
      } else if (candles[i].high > ep) {
        ep = candles[i].high;
        af = Math.min(af + step, max);
      }
    } else {
      const prevHigh1 = candles[i - 1].high;
      const prevHigh2 = i >= 2 ? candles[i - 2].high : prevHigh1;
      sar = Math.max(sar, prevHigh1, prevHigh2);
      if (candles[i].high > sar) {
        trend = 1;
        sar = ep;
        ep = candles[i].high;
        af = step;
      } else if (candles[i].low < ep) {
        ep = candles[i].low;
        af = Math.min(af + step, max);
      }
    }

    out.push({ time: candles[i].time, value: sar });
  }
  return out;
}

export function cci(candles: Candle[], period = 20): IndicatorPoint[] {
  const out: IndicatorPoint[] = [];
  const CCI_CONSTANT = 0.015;
  for (let i = period - 1; i < candles.length; i++) {
    const typicalPrices: number[] = [];
    for (let j = i - period + 1; j <= i; j++) {
      typicalPrices.push((candles[j].high + candles[j].low + candles[j].close) / 3);
    }
    const tp = typicalPrices[typicalPrices.length - 1];
    const mean = typicalPrices.reduce((a, b) => a + b, 0) / period;
    const meanDeviation = typicalPrices.reduce((a, b) => a + Math.abs(b - mean), 0) / period;
    out.push({
      time: candles[i].time,
      value: meanDeviation === 0 ? 0 : (tp - mean) / (CCI_CONSTANT * meanDeviation),
    });
  }
  return out;
}

export function williamsR(candles: Candle[], period = 14): IndicatorPoint[] {
  const out: IndicatorPoint[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    const hi = rollingHigh(candles, i, period);
    const lo = rollingLow(candles, i, period);
    const range = hi - lo;
    out.push({ time: candles[i].time, value: range === 0 ? -50 : ((hi - candles[i].close) / range) * -100 });
  }
  return out;
}

export function obv(candles: Candle[]): IndicatorPoint[] {
  const out: IndicatorPoint[] = [];
  let cum = 0;
  for (let i = 0; i < candles.length; i++) {
    if (i > 0) {
      if (candles[i].close > candles[i - 1].close) cum += candles[i].volume;
      else if (candles[i].close < candles[i - 1].close) cum -= candles[i].volume;
    }
    out.push({ time: candles[i].time, value: cum });
  }
  return out;
}

export function vwap(candles: Candle[]): IndicatorPoint[] {
  const out: IndicatorPoint[] = [];
  let cumPV = 0;
  let cumVol = 0;
  for (const c of candles) {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    cumPV += typicalPrice * c.volume;
    cumVol += c.volume;
    out.push({ time: c.time, value: cumVol === 0 ? c.close : cumPV / cumVol });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Индикаторы новых семейств шаблонов комитета живут в отдельных файлах —
// re-export отсюда, чтобы у evaluator и воркеров была одна точка импорта.
export { keltner, type KeltnerPoint } from "./keltner";
export { donchian, type DonchianPoint } from "./donchian";
export { atrChannel, type AtrChannelPoint } from "./atrChannel";
export { roc, rocSeries } from "./roc";
export { choppiness } from "./choppiness";
export { hurst } from "./hurst";
export { realizedVol, realizedVolPercentile } from "./realizedVol";
export { zscore, zscoreOf } from "./zscore";
