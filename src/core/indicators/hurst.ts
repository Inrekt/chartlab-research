import type { Candle } from "../types";
import type { IndicatorPoint } from "./index";

/**
 * Показатель Хёрста на скользящем окне, упрощённая R/S-оценка.
 *
 * На каждом баре начиная с window−1: берём log-доходности окна, для набора
 * под-масштабов n считаем среднее R/S (размах кумулятивных отклонений /
 * стандартное отклонение) по неперекрывающимся блокам длины n, и оцениваем H
 * как наклон регрессии log(R/S) ~ log(n).
 *
 * Интерпретация: ~0.5 — случайное блуждание, >0.55 — персистентность (тренды
 * продолжаются), <0.45 — антиперсистентность (возврат к среднему). Это
 * ОЦЕНКА с скромной точностью на коротких окнах — сравнивать имеет смысл
 * относительные уровни на одном и том же ТФ, а не абсолютное значение против
 * академического порога.
 */
export function hurst(candles: Candle[], window = 100): IndicatorPoint[] {
  const out: IndicatorPoint[] = [];
  if (candles.length < window + 1) return out;

  const scales = subScales(window);
  for (let i = window; i < candles.length; i++) {
    const returns: number[] = [];
    for (let j = i - window + 1; j <= i; j++) {
      const prev = candles[j - 1].close;
      const curr = candles[j].close;
      if (prev <= 0 || curr <= 0) continue;
      returns.push(Math.log(curr / prev));
    }
    if (returns.length < window * 0.9) continue;

    const points: { logN: number; logRS: number }[] = [];
    for (const n of scales) {
      const rs = meanRescaledRange(returns, n);
      if (rs !== null && rs > 0) points.push({ logN: Math.log(n), logRS: Math.log(rs) });
    }
    if (points.length < 3) continue;

    out.push({ time: candles[i].time, value: slope(points) });
  }
  return out;
}

/** Под-масштабы, делящие окно на ≥2 блока: для 100 это [10, 20, 25, 50]. */
function subScales(window: number): number[] {
  const candidates = [8, 10, 16, 20, 25, 32, 50, 64, 100, 128];
  return candidates.filter((n) => n >= 8 && n <= window / 2);
}

/** Среднее R/S по неперекрывающимся блокам длины n; null, если σ блока — ноль везде. */
function meanRescaledRange(returns: number[], n: number): number | null {
  const blocks = Math.floor(returns.length / n);
  if (blocks === 0) return null;
  let sumRS = 0;
  let counted = 0;
  for (let b = 0; b < blocks; b++) {
    const block = returns.slice(b * n, (b + 1) * n);
    const mean = block.reduce((a, v) => a + v, 0) / n;
    let cum = 0;
    let min = 0;
    let max = 0;
    let sumSq = 0;
    for (const v of block) {
      cum += v - mean;
      if (cum < min) min = cum;
      if (cum > max) max = cum;
      sumSq += (v - mean) ** 2;
    }
    const stdev = Math.sqrt(sumSq / n);
    if (stdev === 0) continue;
    sumRS += (max - min) / stdev;
    counted += 1;
  }
  return counted > 0 ? sumRS / counted : null;
}

/** Наклон OLS-регрессии logRS ~ logN. */
function slope(points: { logN: number; logRS: number }[]): number {
  const n = points.length;
  const meanX = points.reduce((a, p) => a + p.logN, 0) / n;
  const meanY = points.reduce((a, p) => a + p.logRS, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.logN - meanX) * (p.logRS - meanY);
    den += (p.logN - meanX) ** 2;
  }
  return den === 0 ? 0.5 : num / den;
}
