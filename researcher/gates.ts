/**
 * Ворота ночного гаунтлета — чистые функции над уже посчитанными сделками.
 * Порядок применения (дешёвое → дорогое) живёт в screen.ts; здесь — только
 * решения и числа, чтобы каждое ворото тестировалось синтетикой без корпуса.
 *
 * Каждое ворото возвращает reason на языке журнала: строка попадает в
 * transitions.reason и должна читаться человеком через полгода.
 */
import type { BacktestStats, TradeResult } from "../src/core/types/index.ts";
import {
  activeCosts,
  statsAfterCosts,
  tradeCostInR,
  DEFAULT_COSTS,
  type CostAssumptions,
} from "../src/core/committee/costModel.ts";
import { runWalkForward } from "../src/core/committee/walkForward.ts";
import { wilsonInterval } from "../src/core/committee/wilson.ts";
import {
  deflatedSharpe,
  expectedMaxSharpe,
  median,
  moments,
  profitByYear,
  tradeSharpe,
} from "./stats.ts";

export interface GateResult {
  pass: boolean;
  reason?: string;
  metrics: Record<string, number | string | boolean>;
}

const pass = (metrics: GateResult["metrics"]): GateResult => ({ pass: true, metrics });
const fail = (reason: string, metrics: GateResult["metrics"]): GateResult => ({
  pass: false,
  reason,
  metrics,
});

// ── Ворота 1: активность ────────────────────────────────────────────────────
export const MIN_TOTAL_TRADES = 100;
export const MIN_ACTIVE_SYMBOLS = 8;
export const MIN_TRADES_PER_ACTIVE = 5;

export interface SymbolNet {
  symbol: string;
  trades: number;
  netExpectancy: number;
}

export function gateActivity(perSymbol: readonly SymbolNet[]): GateResult {
  const total = perSymbol.reduce((a, s) => a + s.trades, 0);
  const active = perSymbol.filter((s) => s.trades >= MIN_TRADES_PER_ACTIVE).length;
  const metrics = { totalTrades: total, activeSymbols: active };
  if (total < MIN_TOTAL_TRADES) return fail(`активность: ${total} сделок < ${MIN_TOTAL_TRADES}`, metrics);
  if (active < MIN_ACTIVE_SYMBOLS) {
    return fail(`активность: ${active} символов с ≥${MIN_TRADES_PER_ACTIVE} сделками < ${MIN_ACTIVE_SYMBOLS}`, metrics);
  }
  return pass(metrics);
}

// ── Ворота 2: ширина + отложенный набор ─────────────────────────────────────
export const BREADTH_SHARE = 0.6;
export const HOLDOUT_MIN_TRADES = 20;

export function gateBreadth(
  perSymbol: readonly SymbolNet[],
  holdout: { netExpectancy: number; trades: number },
): GateResult {
  const traded = perSymbol.filter((s) => s.trades > 0);
  const positive = traded.filter((s) => s.netExpectancy > 0).length;
  const share = traded.length > 0 ? positive / traded.length : 0;
  const metrics = {
    tradedSymbols: traded.length,
    positiveShare: Number(share.toFixed(3)),
    holdoutTrades: holdout.trades,
    holdoutNet: Number(holdout.netExpectancy.toFixed(4)),
  };
  if (share < BREADTH_SHARE) {
    return fail(`ширина: прибыльна на ${(share * 100).toFixed(0)}% символов < 60%`, metrics);
  }
  if (holdout.trades < HOLDOUT_MIN_TRADES) {
    return fail(`ширина: на отложенных символах лишь ${holdout.trades} сделок — не проверить`, metrics);
  }
  if (holdout.netExpectancy <= 0) {
    return fail("ширина: на отложенном наборе символов матожидание ≤ 0", metrics);
  }
  return pass(metrics);
}

// ── Ворота 3: стресс издержек ×2 ────────────────────────────────────────────
/**
 * Стресс выводится из ДЕЙСТВУЮЩЕЙ модели, а не из плоской.
 *
 * Если базовый расчёт идёт по ликвидности символа, а стресс — по плоской
 * ставке, то на неликвидной половине «удвоенные издержки» окажутся ДЕШЕВЛЕ
 * обычных, и ворота начнут пропускать именно тех, кого обязаны резать. Такое
 * рассогласование не роняет тесты и ничего не пишет в лог.
 */
export function stressedCosts(base: CostAssumptions = activeCosts()): CostAssumptions {
  return {
    feeRate: base.feeRate * 2,
    slippageRate: base.slippageRate * 2,
    slippageFor: base.slippageFor ? (t) => base.slippageFor!(t) * 2 : undefined,
  };
}

/** Обратная совместимость: плоский стресс, когда модель по умолчанию. */
export const STRESSED_COSTS: CostAssumptions = {
  feeRate: DEFAULT_COSTS.feeRate * 2,
  slippageRate: DEFAULT_COSTS.slippageRate * 2,
};

export function gateCostStress(allTrades: readonly TradeResult[]): GateResult {
  const stressed = statsAfterCosts([...allTrades], stressedCosts());
  const metrics = { stressedExpectancy: Number(stressed.expectancy.toFixed(4)) };
  return stressed.expectancy > 0
    ? pass(metrics)
    : fail("стресс: при 2× издержках (0.20%/сторона) матожидание ≤ 0", metrics);
}

// ── Ворота 4: плато (принцип Пардо) ─────────────────────────────────────────
export const PLATEAU_NEIGHBOR_SHARE = 0.7;
export const PLATEAU_PEAK_RATIO = 1.5;
export const PLATEAU_MIN_NEIGHBORS = 3;
/**
 * v3: абсолютный допуск пика. Медиана соседей на 16 символах шумная; при
 * медиане 0.02R любой кандидат выше 0.03R браковался «за успех» — 74 из 117
 * смертей плато в эпохах 1-2. Пик карается только когда превышение ЗАМЕТНО
 * в абсолюте. Пре-регистрация: docs/gates-v3-preregistration.md.
 */
export const PLATEAU_ABS_TOLERANCE = 0.05;

export function gatePlateau(candidateNet: number, neighborNets: readonly number[]): GateResult {
  const metrics = {
    neighbors: neighborNets.length,
    positiveNeighbors: neighborNets.filter((n) => n > 0).length,
    candidateNet: Number(candidateNet.toFixed(4)),
  };
  if (neighborNets.length < PLATEAU_MIN_NEIGHBORS) {
    return fail("плато: соседей по сетке меньше трёх — пик не проверить", metrics);
  }
  const positiveShare = metrics.positiveNeighbors / neighborNets.length;
  if (positiveShare < PLATEAU_NEIGHBOR_SHARE) {
    return fail(`плато: лишь ${(positiveShare * 100).toFixed(0)}% соседей прибыльны — одинокий пик`, metrics);
  }
  const neighborMedian = median(neighborNets);
  if (
    neighborMedian > 0 &&
    candidateNet > PLATEAU_PEAK_RATIO * neighborMedian &&
    candidateNet - neighborMedian > PLATEAU_ABS_TOLERANCE
  ) {
    return fail(
      `плато: кандидат ${candidateNet.toFixed(3)} > 1.5× медианы соседей ${neighborMedian.toFixed(3)} (+>${PLATEAU_ABS_TOLERANCE}R)`,
      { ...metrics, neighborMedian: Number(neighborMedian.toFixed(4)) },
    );
  }
  return pass({ ...metrics, neighborMedian: Number(neighborMedian.toFixed(4)) });
}

// ── Ворота 5: нуль-модель (z ≥ 3 по медиане символов) ───────────────────────
export const NULL_Z_MIN = 3;
export const MIN_NULL_SAMPLES = 3;

export function gateNull(zScores: readonly number[]): GateResult {
  const usable = zScores.filter((z) => Number.isFinite(z));
  if (usable.length < MIN_NULL_SAMPLES) {
    return fail(`нуль-модель: только ${usable.length} измеримых символов < ${MIN_NULL_SAMPLES}`, {
      usable: usable.length,
    });
  }
  const medianZ = median(usable);
  const metrics = { usable: usable.length, medianZ: Number(medianZ.toFixed(2)) };
  return medianZ >= NULL_Z_MIN
    ? pass(metrics)
    : fail(`нуль-модель: медианный z=${medianZ.toFixed(2)} < ${NULL_Z_MIN}`, metrics);
}

// ── Ворота 7: временна́я устойчивость ────────────────────────────────────────
export const MIN_POSITIVE_YEARS = 3;
export const MIN_COVERED_YEARS = 4;
export const WF_MIN_CONSISTENCY = 0.5;

/**
 * Год считается ПОЛНЫМ, если корпус покрывает его хотя бы столько дней.
 * 300 — не круглое число из головы: замеренные обрубки окна это 114 дней
 * (2019) и 212 (2025), а все полные — 365–366. Порог лежит в пустом
 * промежутке между этими группами.
 */
export const FULL_YEAR_MIN_DAYS = 300;

/** Календарные годы, покрытые окном корпуса не меньше чем на FULL_YEAR_MIN_DAYS. */
export function fullYearsIn(fromSec: number, toSec: number): Set<number> {
  const out = new Set<number>();
  if (!(toSec > fromSec)) return out;
  const first = new Date(fromSec * 1000).getUTCFullYear();
  const last = new Date(toSec * 1000).getUTCFullYear();
  for (let y = first; y <= last; y++) {
    const start = Math.max(fromSec, Date.UTC(y, 0, 1) / 1000);
    const end = Math.min(toSec, Date.UTC(y + 1, 0, 1) / 1000);
    if ((end - start) / 86_400 >= FULL_YEAR_MIN_DAYS) out.add(y);
  }
  return out;
}

/**
 * @param corpusSpan границы окна корпуса. Заданы — обрубки лет не голосуют:
 * год в 114 дней может стать «прибыльным» с одной удачной сделки, и кандидат
 * с тремя честными плюсовыми годами проходил или падал из-за месяца данных на
 * краю окна. Полнота года — свойство КОРПУСА, а не кандидата, поэтому
 * приходит извне: торговавший только в январе полного года этот год имел.
 * Пре-регистрация: docs/temporal-stub-years-preregistration.md.
 */
export function gateTemporal(
  allTrades: readonly TradeResult[],
  corpusSpan?: { fromSec: number; toSec: number },
): GateResult {
  // NET-сделки: на брутто год «плюс 2R» при издержках 0.1R/сделку на деле
  // бывает минусовым, и оба порога ворот мягче заявленных (поймано ревизией —
  // все остальные ворота считают после издержек, это обязано тоже).
  const netTrades = allTrades.map((t) => ({ ...t, rMultiple: t.rMultiple - tradeCostInR(t) }));
  const all = profitByYear(netTrades);
  const full = corpusSpan ? fullYearsIn(corpusSpan.fromSec, corpusSpan.toSec) : null;

  // Дефект КОРПУСА, а не приговор кандидату. На спотовом окне (2021-07…2025-07)
  // полных лет всего три, и без этой ветки ворота молча отвергали бы всех «по
  // существу», хотя причина — короткая история.
  if (full && full.size < MIN_COVERED_YEARS) {
    return fail(
      `время: в КОРПУСЕ лишь ${full.size} полных лет < ${MIN_COVERED_YEARS} — ` +
        "это нехватка истории, а не свойство кандидата",
      { fullYearsInCorpus: full.size, corpusTooShort: true },
    );
  }

  const byYear = full ? new Map([...all].filter(([y]) => full.has(y))) : all;
  const covered = byYear.size;
  const positive = [...byYear.values()].filter((v) => v > 0).length;
  const wf = runWalkForward(netTrades);
  const metrics = {
    coveredYears: covered,
    positiveYears: positive,
    // Сколько лет отброшено как обрубки — чтобы отказ был читаем без догадок.
    stubYearsDropped: full ? all.size - byYear.size : 0,
    wfVerdict: wf.verdict,
    wfConsistency: Number(wf.consistency.toFixed(3)),
  };
  if (covered < MIN_COVERED_YEARS) {
    return fail(`время: история покрывает лишь ${covered} года(лет) < ${MIN_COVERED_YEARS}`, metrics);
  }
  if (positive < MIN_POSITIVE_YEARS) {
    return fail(`время: плюс только в ${positive} годах < ${MIN_POSITIVE_YEARS}`, metrics);
  }
  if (wf.verdict === "insufficient" || wf.verdict === "unstable" || wf.verdict === "decaying") {
    return fail(`время: walk-forward вердикт «${wf.verdict}»`, metrics);
  }
  if (wf.consistency < WF_MIN_CONSISTENCY) {
    return fail(`время: только ${(wf.consistency * 100).toFixed(0)}% окон в плюсе < 50%`, metrics);
  }
  return pass(metrics);
}

// ── Ворота 8: дефлированный Шарп ────────────────────────────────────────────
export const DSR_MIN = 0.95;

/**
 * batchSharpeVariance ОБЯЗАН включать проигравших этой ночи: дисперсия только
 * по выжившим занижает V[SR] и планку E[max].
 *
 * nEffective — число КЛАСТЕРОВ журнала по корреляции недельных доходностей
 * (clustering.ts): две вариации одной идеи — одно испытание, а не два.
 * Кандидаты без отпечатка носят эвристический ключ (≤54 штук) — лёгкое
 * завышение N, то есть в строгую сторону.
 */
export function gateDsr(
  netRMultiples: readonly number[],
  nEffective: number,
  batchSharpeVariance: number,
  /**
   * ТОЛЬКО ДЛЯ ЗАПИСИ, на вердикт не влияет: прежняя (наивная) дисперсия
   * партии. Держим её рядом с боевой, чтобы ночи оставались сравнимыми, а
   * переход на очищенную оценку — обратимым и проверяемым по журналу.
   * Пре-регистрация: docs/dsr-variance-preregistration.md.
   */
  comparisonVariance?: number,
): GateResult {
  const T = netRMultiples.length;
  if (T < 2) return fail("DSR: меньше двух сделок", { T });
  const sr = tradeSharpe(netRMultiples);
  const m = moments(netRMultiples);
  // Нижняя граница V[SR] — теоретическая дисперсия оценки Шарпа при данном T:
  // партия из близнецов дала бы var≈0 и нулевую планку, что нечестно.
  const varFloor = (1 + (sr * sr) / 2) / Math.max(T, 2);
  const varSR = Math.max(batchSharpeVariance, varFloor);
  const sr0 = expectedMaxSharpe(Math.max(nEffective, 1), varSR);
  const dsr = deflatedSharpe(sr, sr0, T, m.skewness, m.kurtosis);
  const metrics: GateResult["metrics"] = {
    tradeSharpe: Number(sr.toFixed(4)),
    sr0: Number(sr0.toFixed(4)),
    nEffective,
    dsr: Number(dsr.toFixed(4)),
  };
  if (comparisonVariance !== undefined) {
    const varShadow = Math.max(comparisonVariance, varFloor);
    const sr0Shadow = expectedMaxSharpe(Math.max(nEffective, 1), varShadow);
    metrics.varSR = Number(varSR.toFixed(6));
    metrics.varSRnaive = Number(varShadow.toFixed(6));
    metrics.sr0naive = Number(sr0Shadow.toFixed(4));
    metrics.dsrNaive = Number(
      deflatedSharpe(sr, sr0Shadow, T, m.skewness, m.kurtosis).toFixed(4),
    );
  }
  return dsr >= DSR_MIN
    ? pass(metrics)
    : fail(`DSR: ${dsr.toFixed(3)} < 0.95 при планке E[max]=${sr0.toFixed(3)} (N=${nEffective})`, metrics);
}

// ── Ворота 9 (частично): Уилсон против безубытка ────────────────────────────
/**
 * payoffRatio — РЕАЛИЗОВАННОЕ отношение среднего выигрыша к среднему
 * проигрышу (stats.avgRR), а не номинальный takeR из спеки. Две причины:
 * у выходов от уровней риск переменный и takeR не существует в принципе, а
 * у обычных издержки делают фактический payoff НИЖЕ номинала — то есть
 * порог безубытка получается строже, а не мягче.
 */
export function gateWilson(netStats: BacktestStats, payoffRatio: number): GateResult {
  const total = netStats.totalTrades;
  const wins = Math.round(netStats.winRate * total);
  if (!(payoffRatio > 0)) {
    return fail("Уилсон: соотношение выигрыш/проигрыш не положительно", { payoffRatio });
  }
  const breakeven = 1 / (1 + payoffRatio);
  const interval = wilsonInterval(wins, total);
  const metrics = {
    winRate: Number(netStats.winRate.toFixed(3)),
    wilsonLower: Number(interval.low.toFixed(3)),
    breakeven: Number(breakeven.toFixed(3)),
    payoffRatio: Number(payoffRatio.toFixed(3)),
  };
  return interval.low > breakeven
    ? pass(metrics)
    : fail(
        `Уилсон: нижняя граница winrate ${(interval.low * 100).toFixed(0)}% ≤ безубытка ${(breakeven * 100).toFixed(0)}%`,
        metrics,
      );
}
