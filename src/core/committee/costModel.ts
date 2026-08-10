import type { BacktestStats, TradeResult } from "../types";
import { computeStats } from "../backtest/stats";

/**
 * Trading-cost haircut.
 *
 * The backtest engine models neither fees nor slippage — it fills at the bar's
 * open, exactly. So every expectancy the committee computes is systematically
 * optimistic, and the thinner the stop, the worse the distortion: a setup
 * risking 0.4% per trade loses a quarter of its edge to a 0.1% round trip.
 *
 * This is the single strongest deterministic argument the bear side has, and
 * it converts an opinion ("costs will eat it") into a number. A setup whose
 * expectancy flips negative once costs are charged is not a marginal call —
 * it is a setup that loses money.
 */

/** Binance spot taker is 0.10% a side; 0.05% covers a typical maker/BNB path. */
export const DEFAULT_FEE_RATE = 0.0005;
/** Slippage on a liquid pair at retail size. Deliberately not optimistic. */
export const DEFAULT_SLIPPAGE_RATE = 0.0005;

export interface CostAssumptions {
  feeRate: number;
  slippageRate: number;
  /**
   * Проскальзывание для КОНКРЕТНОЙ сделки, если оно известно точнее плоской
   * ставки. Задано — используется оно, иначе `slippageRate`.
   *
   * Существует потому, что одна ставка на нашу вселенную не может быть верной
   * нигде, кроме одной точки: оборот символов различается в 3270 раз (BTC
   * 88.4 млн $/час против 27 тыс. у хвоста). Плоские 5 б.п. вчетверо
   * пессимистичны на BTC и в 8.8 раза оптимистичны на девятом дециле.
   * Пре-регистрация: researcher/docs/liquidity-costs-preregistration.md.
   */
  slippageFor?: (trade: TradeResult) => number;
}

export const DEFAULT_COSTS: CostAssumptions = {
  feeRate: DEFAULT_FEE_RATE,
  slippageRate: DEFAULT_SLIPPAGE_RATE,
};

/**
 * Действующая модель издержек прогона.
 *
 * Модуль-уровневая изменяемая переменная — сознательный выбор, а не лень.
 * Издержки считаются в ДВЕНАДЦАТИ местах воронки; протаскивание параметра
 * через все означало бы, что однажды одно из них забудут, и половина отбора
 * поедет на одной модели, а половина на другой. Такое рассогласование не
 * роняет тесты и не пишет в лог ничего — то есть относится к главному классу
 * ошибок этого проекта. Единая точка делает его невозможным по построению.
 */
let active: CostAssumptions = DEFAULT_COSTS;

export function activeCosts(): CostAssumptions {
  return active;
}

/** Установить модель на прогон. Возвращает функцию отката — для тестов. */
export function setActiveCosts(costs: CostAssumptions): () => void {
  const previous = active;
  active = costs;
  return () => {
    active = previous;
  };
}

/**
 * Вернуть модель издержек к умолчанию, чем бы её ни подменили.
 *
 * Страховка на случай, когда `restoreCosts()` не был вызван: в `runScreen` он
 * стоит ПОСЛЕ прогона и не в `finally`, поэтому исключение в любых воротах
 * оставляет таблицу по ликвидности активной на весь процесс. Последствие
 * молчаливое и дорогое: инкубатор и карточки строят псевдо-сделку без символа,
 * поиск в таблице промахивается и подставляет консервативную ставку ×10 —
 * каждой форвард-сделке, без единой записи в лог.
 *
 * Вызывается там, где прогон уже признан упавшим.
 */
export function resetActiveCosts(): void {
  active = DEFAULT_COSTS;
}

export interface CostAdjustedResult {
  /** Cost of a round trip expressed in R — i.e. as a fraction of the risk taken. */
  costR: number;
  grossExpectancy: number;
  netExpectancy: number;
  /** True when costs alone turn a profitable setup into a losing one. */
  flipsNegative: boolean;
  assumptions: CostAssumptions;
}

/**
 * Converts a per-trade round-trip cost into R units.
 *
 * A trade's risk distance is |entry - stop|. Cost is charged on notional at
 * both entry and exit, so `2 * rate * entryPrice`, divided by the risk distance
 * to express it in the same units expectancy is measured in.
 */
export function tradeCostInR(trade: TradeResult, costs: CostAssumptions = active): number {
  /*
   * Единица риска берётся из `riskBudget`, а НЕ из |entryPrice − stopPrice|.
   *
   * `stopPrice` в отчёте — стоп ТЕКУЩИЙ, и он мутирует: перенос в безубыток
   * приравнивает его к средней цене входа. Разность становилась ровно нулём
   * (точно, не приблизительно: доли — степени двойки), и издержки обнулялись у
   * КАЖДОЙ сделки, дошедшей до частичного тейка. Замер: 35.2% сделок семейств
   * с сопровождением получали нулевые издержки, средняя издержка падала вдвое
   * (0.0086R против 0.0181R у того же семейства без сопровождения). Ошибка
   * была В ПОЛЬЗУ стратегии и текла во всю воронку — халвинги, ворота ширины,
   * стресс издержек (удвоение нуля есть ноль), нуль-модель, DSR, Уилсон, OOT
   * и решение SPRT о выпуске.
   *
   * `riskBudget` — та же величина, которой движок считает сам R-множитель,
   * поэтому издержки и результат теперь меряются одной линейкой.
   * Запасной путь по старой формуле оставлен для отчётов, записанных до
   * появления поля.
   */
  const riskDistance = Number.isFinite(trade.riskBudget)
    ? Math.abs(trade.riskBudget)
    : Math.abs(trade.entryPrice - trade.stopPrice);
  if (!Number.isFinite(riskDistance) || riskDistance <= 0) return 0;
  const slippage = costs.slippageFor?.(trade) ?? costs.slippageRate;
  const roundTripRate = 2 * (costs.feeRate + slippage);
  return (roundTripRate * trade.entryPrice) / riskDistance;
}

/**
 * Mean per-trade cost in R, over the trades whose risk is actually measurable.
 *
 * A trade whose stop sits at its entry has an undefined cost in R, and
 * {@link tradeCostInR} reports 0 for it. Averaging those zeros in would make a
 * setup look CHEAPER the more unmeasurable trades it contains — costs are a
 * veto input, so that would turn a data problem into a free pass.
 */
export function averageCostInR(trades: TradeResult[], costs: CostAssumptions = active): number {
  let sum = 0;
  let measurable = 0;
  for (const trade of trades) {
    /*
     * Измеримость проверяется ТОЙ ЖЕ величиной, что и сам расчёт.
     *
     * Здесь оставалась вторая копия исправленной ошибки: фильтр смотрел на
     * |entryPrice − stopPrice|, и сделка с переносом стопа в безубыток (где
     * эта разность ровно ноль) ВЫБРАСЫВАЛАСЬ из средней целиком — при том что
     * её издержка прекрасно определена через riskBudget.
     *
     * Смещение было направленным, а не случайным: выбрасывались как раз
     * сделки, дошедшие до частичного тейка, а до тейка в R легче доходят
     * сделки с УЗКИМ стопом, у которых издержка в R максимальна. То есть
     * средняя занижалась систематически.
     */
    const riskDistance = Number.isFinite(trade.riskBudget)
      ? Math.abs(trade.riskBudget)
      : Math.abs(trade.entryPrice - trade.stopPrice);
    if (!Number.isFinite(riskDistance) || riskDistance <= 0) continue;
    sum += tradeCostInR(trade, costs);
    measurable += 1;
  }
  return measurable === 0 ? 0 : sum / measurable;
}

export function applyCosts(
  trades: TradeResult[],
  stats: BacktestStats,
  costs: CostAssumptions = active,
): CostAdjustedResult {
  const costR = averageCostInR(trades, costs);
  const grossExpectancy = stats.expectancy;
  const netExpectancy = grossExpectancy - costR;
  return {
    costR,
    grossExpectancy,
    netExpectancy,
    flipsNegative: grossExpectancy > 0 && netExpectancy <= 0,
    assumptions: costs,
  };
}

/**
 * Recomputes full stats on cost-adjusted trades. Heavier than {@link applyCosts}
 * but gives an honest profit factor and win rate too — a trade that cleared its
 * target by less than the cost was not actually a winner.
 */
export function statsAfterCosts(trades: TradeResult[], costs: CostAssumptions = active): BacktestStats {
  const adjusted = trades.map((trade) => {
    const net = trade.rMultiple - tradeCostInR(trade, costs);
    return { ...trade, rMultiple: net, won: net > 0 };
  });
  return computeStats(adjusted);
}
