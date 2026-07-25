import type { TradeResult } from "../types";
import { computeStats } from "../backtest/stats";

/**
 * Walk-forward стабильность во времени.
 *
 * ЧЕСТНАЯ ОГОВОРКА О ТОМ, ЧТО ЭТО НЕ ТАКОЕ. Классический walk-forward
 * валидирует ПРОЦЕДУРУ ПОДБОРА: на обучающем окне подбираются параметры, на
 * следующем — проверяются, и так со сдвигом. У комитета подбора нет вообще:
 * параметры шаблонов зафиксированы и одинаковы для всех инструментов, это его
 * центральный инвариант. Значит обучающему окну здесь нечего обучать, и
 * изображать его — значит исполнять ритуал ради слова «walk-forward» в отчёте.
 *
 * Поэтому здесь считается то, на что ответ действительно нужен: держится ли
 * эффект В КАЖДОМ отрезке истории или он весь собран из одного удачного куска.
 * Стратегия с прекрасным средним матожиданием, которое целиком заработано за
 * три месяца 2021 года и отрицательно во всех остальных окнах, — это не
 * стратегия, это воспоминание, и среднее по всей истории это скрывает.
 *
 * Окна нарезаются по КАЛЕНДАРЮ, а не по количеству сделок: равные по числу
 * сделок окна растянулись бы по времени неравномерно и сравнивать их между
 * собой было бы нельзя.
 */

/** Минимум сделок в окне, ниже которого статистика окна — шум. */
export const MIN_TRADES_PER_WINDOW = 8;

/** Минимум содержательных окон, иначе вывод о стабильности не делается. */
export const MIN_WINDOWS = 4;

export interface WalkForwardWindow {
  index: number;
  /** Границы окна, unix-секунды. */
  startTime: number;
  endTime: number;
  trades: number;
  expectancy: number;
  profitFactor: number;
  winRate: number;
  /** Слишком мало сделок — окно не участвует в выводах. */
  sparse: boolean;
}

export type WalkForwardVerdict = "stable" | "decaying" | "unstable" | "insufficient";

export interface WalkForwardResult {
  windows: WalkForwardWindow[];
  /** Окна с достаточным числом сделок. */
  evaluatedWindows: number;
  /** Доля содержательных окон с положительным матожиданием, 0..1. */
  consistency: number;
  meanExpectancy: number;
  stdDevExpectancy: number;
  /**
   * Наклон OLS матожидания по номеру окна: отрицательный означает, что эффект
   * слабеет со временем. В единицах R за окно.
   */
  slope: number;
  /**
   * Матожидание последней четверти истории против всей — прямая проверка на
   * «работало раньше, не работает сейчас».
   */
  lastQuarterExpectancy: number;
  overallExpectancy: number;
  verdict: WalkForwardVerdict;
  explanation: string;
}

/**
 * @param windowCount на сколько равных календарных окон резать историю сделок.
 *   8 окон на 5 годах — это примерно по 7 месяцев, достаточно длинно, чтобы в
 *   окно попадали разные фазы рынка, и достаточно коротко, чтобы увидеть распад.
 */
export function runWalkForward(trades: TradeResult[], windowCount = 8): WalkForwardResult {
  const empty: WalkForwardResult = {
    windows: [],
    evaluatedWindows: 0,
    consistency: 0,
    meanExpectancy: 0,
    stdDevExpectancy: 0,
    slope: 0,
    lastQuarterExpectancy: 0,
    overallExpectancy: 0,
    verdict: "insufficient",
    explanation: "недостаточно сделок для оценки стабильности во времени",
  };

  if (trades.length < MIN_TRADES_PER_WINDOW * MIN_WINDOWS) return empty;

  const sorted = [...trades].sort((a, b) => a.entryTime - b.entryTime);
  const first = sorted[0].entryTime;
  const last = sorted[sorted.length - 1].entryTime;
  const span = last - first;
  if (span <= 0) return empty;

  const step = span / windowCount;
  const windows: WalkForwardWindow[] = [];

  for (let w = 0; w < windowCount; w++) {
    const startTime = first + step * w;
    // Последнее окно включает правую границу, иначе последняя сделка выпадает.
    const endTime = w === windowCount - 1 ? last + 1 : first + step * (w + 1);
    const slice = sorted.filter((t) => t.entryTime >= startTime && t.entryTime < endTime);
    const stats = computeStats(slice);
    windows.push({
      index: w,
      startTime: Math.round(startTime),
      endTime: Math.round(endTime),
      trades: slice.length,
      expectancy: stats.expectancy,
      profitFactor: stats.profitFactor,
      winRate: stats.winRate,
      sparse: slice.length < MIN_TRADES_PER_WINDOW,
    });
  }

  const dense = windows.filter((w) => !w.sparse);
  if (dense.length < MIN_WINDOWS) {
    return { ...empty, windows, explanation: "слишком мало окон с достаточным числом сделок" };
  }

  const expectancies = dense.map((w) => w.expectancy);
  const meanExpectancy = mean(expectancies);
  const stdDevExpectancy = Math.sqrt(mean(expectancies.map((e) => (e - meanExpectancy) ** 2)));
  const consistency = dense.filter((w) => w.expectancy > 0).length / dense.length;
  const slope = olsSlope(dense.map((w, i) => ({ x: i, y: w.expectancy })));

  const overallExpectancy = computeStats(sorted).expectancy;
  const quarterStart = last - span / 4;
  const lastQuarter = sorted.filter((t) => t.entryTime >= quarterStart);
  const lastQuarterExpectancy =
    lastQuarter.length >= MIN_TRADES_PER_WINDOW ? computeStats(lastQuarter).expectancy : Number.NaN;

  const { verdict, explanation } = judge({
    consistency,
    slope,
    meanExpectancy,
    stdDevExpectancy,
    lastQuarterExpectancy,
    overallExpectancy,
  });

  return {
    windows,
    evaluatedWindows: dense.length,
    consistency,
    meanExpectancy,
    stdDevExpectancy,
    slope,
    lastQuarterExpectancy,
    overallExpectancy,
    verdict,
    explanation,
  };
}

interface JudgeInput {
  consistency: number;
  slope: number;
  meanExpectancy: number;
  stdDevExpectancy: number;
  lastQuarterExpectancy: number;
  overallExpectancy: number;
}

/**
 * Порядок проверок намеренный: сначала распад (это худший диагноз, потому что
 * он означает «эффект был, но кончился»), потом разброс, и только потом
 * похвала. Стратегия, у которой всё хорошо в среднем, но последняя четверть
 * ушла в минус, НЕ должна получать «stable» из-за хорошего среднего.
 */
function judge(input: JudgeInput): { verdict: WalkForwardVerdict; explanation: string } {
  const { consistency, slope, meanExpectancy, stdDevExpectancy, lastQuarterExpectancy, overallExpectancy } = input;

  const decayedRecently =
    Number.isFinite(lastQuarterExpectancy) && overallExpectancy > 0 && lastQuarterExpectancy < 0;

  if (decayedRecently || (slope < 0 && Math.abs(slope) > Math.abs(meanExpectancy) * 0.25)) {
    return {
      verdict: "decaying",
      explanation: decayedRecently
        ? `эффект распадается: в среднем ${meanExpectancy.toFixed(3)}R, но последняя четверть истории уже ${lastQuarterExpectancy.toFixed(3)}R`
        : `эффект слабеет от окна к окну (наклон ${slope.toFixed(3)}R за окно)`,
    };
  }

  if (consistency < 0.5) {
    return {
      verdict: "unstable",
      explanation: `положительны лишь ${Math.round(consistency * 100)}% окон — результат держится не на эффекте, а на нескольких удачных отрезках`,
    };
  }

  // Разброс между окнами больше самого среднего — среднее ничего не описывает.
  if (stdDevExpectancy > Math.abs(meanExpectancy) * 2) {
    return {
      verdict: "unstable",
      explanation: `разброс по окнам (${stdDevExpectancy.toFixed(3)}R) вдвое с лишним превышает само среднее (${meanExpectancy.toFixed(3)}R)`,
    };
  }

  return {
    verdict: "stable",
    explanation: `эффект держится: ${Math.round(consistency * 100)}% окон в плюсе, наклон ${slope.toFixed(3)}R за окно`,
  };
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function olsSlope(points: { x: number; y: number }[]): number {
  if (points.length < 2) return 0;
  const meanX = mean(points.map((p) => p.x));
  const meanY = mean(points.map((p) => p.y));
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - meanX) * (p.y - meanY);
    den += (p.x - meanX) ** 2;
  }
  return den === 0 ? 0 : num / den;
}
