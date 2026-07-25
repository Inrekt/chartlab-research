/**
 * Диагностика ПРОЦЕССА отбора — не отдельных кандидатов, а самой машины.
 *
 * 1. Reality Check Уайта (2000): один p-value на всю ночь — «показал бы
 *    ЛУЧШИЙ из партии такой результат, если бы все были шумом?». Учитывает
 *    сам факт перебора: чем шире ночь, тем выше планка лучшего.
 * 2. PBO/CSCV (Bailey–Borwein–López de Prado–Zhu): время режется на S=12
 *    блоков, все C(12,6)=924 способа выбрать половину как in-sample; PBO —
 *    доля способов, где IS-чемпион оказывается НИЖЕ медианы out-of-sample.
 *    Тревога > 0.25, брак ночи > 0.5: значит, отбор выбирает шум.
 *
 * Оба работают на матрице суточных доходностей партии (стадия-16 — там есть
 * все кандидаты, включая проигравших: диагностика без проигравших — обман).
 */
import type { TradeResult } from "../src/core/types/index.ts";
import { tradeCostInR } from "../src/core/committee/costModel.ts";

const DAY = 86_400;
export const MIN_CANDIDATES = 5;
export const MIN_DAYS = 60;

export interface DailyMatrix {
  candidates: string[];
  days: number;
  /** Абсолютный номер первого дня (unix-день) — выравнивание между ночами. */
  startDay: number;
  /** returns[i][d] — суммарный net R кандидата i за день d. */
  returns: Float64Array[];
}

export function buildDailyMatrix(
  tradesById: ReadonlyMap<string, readonly TradeResult[]>,
): DailyMatrix | null {
  if (tradesById.size < MIN_CANDIDATES) return null;
  let minDay = Number.POSITIVE_INFINITY;
  let maxDay = 0;
  for (const trades of tradesById.values()) {
    for (const t of trades) {
      const d = Math.floor(t.exitTime / DAY);
      if (d < minDay) minDay = d;
      if (d > maxDay) maxDay = d;
    }
  }
  const days = maxDay - minDay + 1;
  if (!Number.isFinite(minDay) || days < MIN_DAYS) return null;

  const candidates: string[] = [];
  const returns: Float64Array[] = [];
  for (const [id, trades] of tradesById) {
    const row = new Float64Array(days);
    for (const t of trades) {
      row[Math.floor(t.exitTime / DAY) - minDay] += t.rMultiple - tradeCostInR(t);
    }
    candidates.push(id);
    returns.push(row);
  }
  return { candidates, days, startDay: minDay, returns };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RealityCheckResult {
  /** max по кандидатам √n·(средняя суточная доходность). */
  observedStat: number;
  pValue: number;
  bootstraps: number;
}

/**
 * RC Уайта со стационарным бутстрепом (Politis–Romano, геометрические блоки,
 * средняя длина meanBlock дней — сохраняет автокорреляцию суточных рядов).
 */
export function whiteRealityCheck(
  matrix: DailyMatrix,
  bootstraps = 500,
  seed = 1,
  meanBlock = 5,
): RealityCheckResult {
  const { returns, days } = matrix;
  const n = returns.length;
  const sqrtDays = Math.sqrt(days);
  const means = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let d = 0; d < days; d++) s += returns[i][d];
    means[i] = s / days;
  }
  let observedStat = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i++) observedStat = Math.max(observedStat, sqrtDays * means[i]);

  const rand = mulberry32(seed);
  const restart = 1 / meanBlock;
  let exceed = 0;
  const idx = new Int32Array(days);
  for (let b = 0; b < bootstraps; b++) {
    // стационарный бутстреп: цепочка дней с геометрическими перезапусками
    let cur = Math.floor(rand() * days);
    for (let d = 0; d < days; d++) {
      if (d > 0 && rand() >= restart) cur = (cur + 1) % days;
      else if (d > 0) cur = Math.floor(rand() * days);
      idx[d] = cur;
    }
    let bootMax = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < n; i++) {
      const row = returns[i];
      let s = 0;
      for (let d = 0; d < days; d++) s += row[idx[d]];
      // центрирование по своей средней — нулевая гипотеза «края нет»
      const stat = sqrtDays * (s / days - means[i]);
      if (stat > bootMax) bootMax = stat;
    }
    if (bootMax >= observedStat) exceed += 1;
  }
  return { observedStat, pValue: exceed / bootstraps, bootstraps };
}

export interface PboResult {
  /** Доля разбиений, где IS-чемпион ниже медианы OOS. */
  pbo: number;
  combinations: number;
}

function combinationsOf(pool: number, pick: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const walk = (start: number) => {
    if (cur.length === pick) {
      out.push([...cur]);
      return;
    }
    for (let i = start; i <= pool - (pick - cur.length); i++) {
      cur.push(i);
      walk(i + 1);
      cur.pop();
    }
  };
  walk(0);
  return out;
}

/** CSCV: S смежных блоков времени, все C(S, S/2) разбиений IS/OOS. */
export function cscvPbo(matrix: DailyMatrix, blocks = 12): PboResult | null {
  const { returns, days } = matrix;
  const n = returns.length;
  const blockLen = Math.floor(days / blocks);
  if (n < MIN_CANDIDATES || blockLen < 3) return null;

  // средняя суточная доходность кандидата в каждом блоке
  const blockMeans: Float64Array[] = returns.map((row) => {
    const bm = new Float64Array(blocks);
    for (let b = 0; b < blocks; b++) {
      let s = 0;
      for (let d = b * blockLen; d < (b + 1) * blockLen; d++) s += row[d];
      bm[b] = s / blockLen;
    }
    return bm;
  });

  const half = blocks / 2;
  const combos = combinationsOf(blocks, half);
  let below = 0;
  const inIs = new Array<boolean>(blocks);
  for (const combo of combos) {
    inIs.fill(false);
    for (const b of combo) inIs[b] = true;
    let bestIs = Number.NEGATIVE_INFINITY;
    let bestIdx = 0;
    const oos = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let isSum = 0;
      let oosSum = 0;
      for (let b = 0; b < blocks; b++) {
        if (inIs[b]) isSum += blockMeans[i][b];
        else oosSum += blockMeans[i][b];
      }
      oos[i] = oosSum;
      if (isSum > bestIs) {
        bestIs = isSum;
        bestIdx = i;
      }
    }
    let rank = 0;
    for (let i = 0; i < n; i++) if (oos[i] <= oos[bestIdx]) rank += 1;
    const relative = rank / (n + 1);
    if (relative < 0.5) below += 1;
  }
  return { pbo: below / combos.length, combinations: combos.length };
}
