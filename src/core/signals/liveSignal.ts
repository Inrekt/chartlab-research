import type { Candle, StrategyConfig } from "../types";
import { EvaluationContext } from "../strategy/evaluator";
import { atrSeriesFor, exitNeedsLiquidity, planEntryLevels } from "../backtest/engine";
import { cachedLiquidityFeatures } from "../liquidations/clusterSeries";

/**
 * Живой сигнал: то же правило, что гонялось в бэктесте, применённое к
 * последнему ЗАКРЫТОМУ бару.
 *
 * Уровни считаются той же функцией `planEntryLevels`, что и в бэктесте. Это не
 * удобство, а требование: скопированная логика однажды разъедется с проверенной
 * молча, и торговать мы будем не то, что проверяли.
 */

export interface LiveSignal {
  symbol: string;
  direction: "long" | "short";
  /** Время закрытого бара, на котором сработало условие. */
  signalBarTime: number;
  /** Цена, от которой посчитаны уровни, — закрытие сигнального бара. */
  referencePrice: number;
  stopPrice: number;
  targetPrice: number;
  /** Расстояние до стопа в цене: одна единица риска. */
  riskPerUnit: number;
  /** Во сколько раз цель дальше стопа. */
  rewardToRisk: number;
  /**
   * Сдвинутся ли уровни вместе с реальной ценой входа.
   *
   * Бэктест входит по открытию СЛЕДУЮЩЕГО бара, а его ещё не существует.
   * Для стопа от ATR фиксировано расстояние, поэтому уровень поедет вместе со
   * входом. Для стопа от ликвидности уровень абсолютный (за скоплением) и не
   * поедет вовсе — поедет только величина риска.
   */
  levelsMoveWithEntry: boolean;
}

/**
 * Ищет сигнал на последнем закрытом баре.
 *
 * `candles` обязан заканчиваться ЗАКРЫТЫМ баром: незакрытый ещё меняется, и
 * сигнал по нему — это подглядывание в будущее ровно в том же смысле, в каком
 * бэктест никогда не оценивает последний бар.
 */
export function detectSignal(
  candles: Candle[],
  config: StrategyConfig,
  symbol: string,
): LiveSignal | null {
  if (candles.length < 2) return null;
  const i = candles.length - 1;

  const ctx = new EvaluationContext(candles, symbol);
  const passesFilters = !config.filters || ctx.evaluateGroup(config.filters, i);
  if (!passesFilters || !ctx.evaluateGroup(config.entry, i)) return null;

  const atrSeries = atrSeriesFor(candles, config);
  const liq = exitNeedsLiquidity(config) ? cachedLiquidityFeatures(candles) : null;

  // Цена входа неизвестна (бар ещё не открылся), поэтому уровни считаются от
  // закрытия сигнального бара — ближайшей известной цены.
  const referencePrice = candles[i].close;
  const levels = planEntryLevels(config, i, referencePrice, atrSeries, liq);
  if (!levels) return null;

  const reward = Math.abs(levels.targetPrice - referencePrice);
  return {
    symbol,
    direction: config.direction,
    signalBarTime: candles[i].time,
    referencePrice,
    stopPrice: levels.stopPrice,
    targetPrice: levels.targetPrice,
    riskPerUnit: levels.risk,
    rewardToRisk: levels.risk > 0 ? reward / levels.risk : 0,
    levelsMoveWithEntry: config.exit.stopLoss.type !== "liquidity",
  };
}

export interface Confluence {
  symbol: string;
  direction: "long" | "short";
  /** Сколько независимых стратегий указывают в одну сторону. */
  count: number;
  signals: LiveSignal[];
}

/**
 * Сколько стратегий сошлось на одной монете и стороне.
 *
 * Осторожно с трактовкой: совпадение НЕ означает подтверждения. Наши стратегии
 * растут из общей грамматики и часто смотрят на одно и то же под разными
 * именами, поэтому «три сигнала» — это скорее одна идея, увиденная трижды, чем
 * три независимых свидетельства. Число полезно как повод присмотреться, а не
 * как множитель уверенности.
 */
export function confluence(signals: readonly LiveSignal[]): Confluence[] {
  const groups = new Map<string, Confluence>();
  for (const s of signals) {
    const key = `${s.symbol}|${s.direction}`;
    const found = groups.get(key);
    if (found) {
      found.count++;
      found.signals.push(s);
    } else {
      groups.set(key, { symbol: s.symbol, direction: s.direction, count: 1, signals: [s] });
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}
