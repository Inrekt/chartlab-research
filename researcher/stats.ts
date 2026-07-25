/**
 * Закрытые статистические формулы жерновов: Φ, Φ⁻¹, дефлированный Шарп (DSR),
 * Бенджамини–Хохберг. Ни одной внешней зависимости — вся «добавленная
 * математика» ночи стоит меньше миллисекунды.
 *
 * Зачем DSR: при N перебранных вариантах ЛУЧШИЙ чисто случайный покажет
 * E[max] ≈ √V[SR]·((1−γ)Φ⁻¹(1−1/N)+γΦ⁻¹(1−1/(N·e))) — планка, растущая с
 * числом попыток. Журнал испытаний даёт честное N (по кластерам), и кандидат
 * обязан быть значим ПОСЛЕ этой поправки (Bailey & López de Prado, 2014).
 */

/** Постоянная Эйлера–Маскерони — входит в формулу E[max] порядковых статистик. */
const EULER_GAMMA = 0.5772156649015329;

/** Стандартная нормальная CDF: Φ(x) = ½(1+erf(x/√2)),
 * erf — Abramowitz–Stegun 7.1.26 (~1e-7). */
export function normCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const poly =
    t *
    (0.254829592 +
      t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/**
 * Обратная нормальная CDF — алгоритм Акляма (|ошибка| < 1.15e-9).
 * Нужна для порога E[max]: Φ⁻¹(1−1/N) при N в тысячах.
 */
export function normInv(p: number): number {
  if (!(p > 0 && p < 1)) throw new Error(`normInv: p вне (0,1): ${p}`);
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269,
    -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197,
    -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373,
    4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const pLow = 0.02425;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pLow) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export interface Moments {
  n: number;
  mean: number;
  stdDev: number;
  /** γ₃ — асимметрия. */
  skewness: number;
  /** γ₄ — эксцесс БЕЗ вычитания 3 (у нормального = 3), как в формуле DSR. */
  kurtosis: number;
}

export function moments(values: readonly number[]): Moments {
  const n = values.length;
  if (n === 0) return { n: 0, mean: 0, stdDev: 0, skewness: 0, kurtosis: 3 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const v of values) {
    const d = v - mean;
    m2 += d * d;
    m3 += d * d * d;
    m4 += d * d * d * d;
  }
  m2 /= n;
  m3 /= n;
  m4 /= n;
  const stdDev = Math.sqrt(m2);
  const skewness = m2 > 0 ? m3 / m2 ** 1.5 : 0;
  const kurtosis = m2 > 0 ? m4 / (m2 * m2) : 3;
  return { n, mean, stdDev, skewness, kurtosis };
}

/**
 * Честная медиана: при чётном n — среднее двух центральных. Приём
 * sorted[floor(n/2)] даёт ВЕРХНЮЮ медиану и систематически смягчал пороги
 * (z≥3, плато, p-value для FDR) — поймано адверсарной ревизией с репро.
 */
export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Пер-трейдовый Шарп: mean(R)/std(R). Единицы согласованы с E[max] и DSR. */
export function tradeSharpe(rMultiples: readonly number[]): number {
  const m = moments(rMultiples);
  return m.stdDev > 0 ? m.mean / m.stdDev : 0;
}

/**
 * E[max SR] среди nTrials случайных стратегий с дисперсией оценок varSharpe.
 * Это «сколько Шарпа даёт чистое везение при таком переборе» — порог SR₀.
 */
export function expectedMaxSharpe(nTrials: number, varSharpe: number): number {
  if (nTrials <= 1 || varSharpe <= 0) return 0;
  const sd = Math.sqrt(varSharpe);
  return sd * ((1 - EULER_GAMMA) * normInv(1 - 1 / nTrials) +
    EULER_GAMMA * normInv(1 - 1 / (nTrials * Math.E)));
}

/**
 * Дефлированный Шарп: P(SR настоящий > SR₀ | асимметрия, эксцесс, T наблюдений).
 * Ворота жерновов требуют ≥ 0.95.
 */
export function deflatedSharpe(
  sharpe: number,
  sr0: number,
  observations: number,
  skewness: number,
  kurtosis: number,
): number {
  if (observations < 2) return 0;
  const denomSq = 1 - skewness * sharpe + ((kurtosis - 1) / 4) * sharpe * sharpe;
  // Отрицательный знаменатель = патологическое распределение доходностей;
  // честный ответ — «не доказано», а не NaN, просочившийся в вердикт.
  if (!(denomSq > 0)) return 0;
  const z = ((sharpe - sr0) * Math.sqrt(observations - 1)) / Math.sqrt(denomSq);
  return normCdf(z);
}

/** Односторонний p-value для z-оценки нуль-модели. */
export function zToPValue(z: number): number {
  return 1 - normCdf(z);
}

/**
 * Бенджамини–Хохберг при уровне q: какие из p-value остаются значимыми с
 * контролем доли ложных открытий по всей ночной партии. Возвращает маску
 * в исходном порядке.
 */
export function benjaminiHochberg(pValues: readonly number[], q: number): boolean[] {
  const n = pValues.length;
  if (n === 0) return [];
  const order = pValues
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p - b.p);
  let cutoffIndex = -1;
  for (let k = 0; k < n; k++) {
    if (order[k].p <= ((k + 1) / n) * q) cutoffIndex = k;
  }
  const keep = new Array<boolean>(n).fill(false);
  for (let k = 0; k <= cutoffIndex; k++) keep[order[k].i] = true;
  return keep;
}

/** Годовая раскладка R: для ворот «плюс в ≥3 из 5 календарных лет». */
export function profitByYear(
  trades: readonly { entryTime: number; rMultiple: number }[],
): Map<number, number> {
  const byYear = new Map<number, number>();
  for (const t of trades) {
    const year = new Date(t.entryTime * 1000).getUTCFullYear();
    byYear.set(year, (byYear.get(year) ?? 0) + t.rMultiple);
  }
  return byYear;
}
