import type { Candle, StrategyConfig, TradeResult } from "../types";
import { EvaluationContext } from "../strategy/evaluator";
import { atr as atrIndicator } from "../indicators";

interface OpenPosition {
  direction: "long" | "short";
  entryTime: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  barsHeld: number;
  entryIndex: number;
}

/**
 * Runs one strategy against one instrument's historical candles, bar by bar.
 * No look-ahead: entry conditions are evaluated using only data available at
 * bar close, and fills happen at the NEXT bar's open — the earliest price a
 * real order could realistically have filled at.
 */
export function runBacktest(candles: Candle[], config: StrategyConfig, symbol: string): TradeResult[] {
  if (candles.length < 2) return [];

  const ctx = new EvaluationContext(candles);
  const atrSeries = atrSeriesFor(candles, config);

  const trades: TradeResult[] = [];
  let open: OpenPosition | null = null;

  for (let i = 0; i < candles.length - 1; i++) {
    if (open) {
      const closed = advanceOpenPosition(candles, config, symbol, open, i);
      if (closed) {
        trades.push(closed);
        open = null;
      }
      continue;
    }

    const passesFilters = !config.filters || ctx.evaluateGroup(config.filters, i);
    if (passesFilters && ctx.evaluateGroup(config.entry, i)) {
      open = openPositionAt(candles, config, i, atrSeries);
    }
  }

  return trades;
}

/**
 * Replays the SAME exit rules from a caller-supplied list of signal bars,
 * ignoring the strategy's entry conditions entirely.
 *
 * Exists for the committee's null model: to tell whether a template's edge is
 * real, you compare it against what these exits would have earned entering at
 * random on the same instrument. That comparison is only fair if the exit
 * machinery is byte-identical to the real backtest's — hence sharing
 * `openPositionAt` / `advanceOpenPosition` rather than reimplementing them.
 *
 * `entryIndices` are SIGNAL bars; fills happen at the next bar's open, exactly
 * as in `runBacktest`. Signals arriving while a position is open are skipped,
 * again matching the real engine — otherwise the null could stack overlapping
 * trades the strategy itself could never have taken.
 */
export function simulateExits(
  candles: Candle[],
  config: StrategyConfig,
  symbol: string,
  entryIndices: number[],
): TradeResult[] {
  if (candles.length < 2) return [];

  const atrSeries = atrSeriesFor(candles, config);
  const wanted = new Set(entryIndices);
  const trades: TradeResult[] = [];
  let open: OpenPosition | null = null;

  for (let i = 0; i < candles.length - 1; i++) {
    if (open) {
      const closed = advanceOpenPosition(candles, config, symbol, open, i);
      if (closed) {
        trades.push(closed);
        open = null;
      }
      continue;
    }
    if (wanted.has(i)) open = openPositionAt(candles, config, i, atrSeries);
  }

  return trades;
}

function atrSeriesFor(candles: Candle[], config: StrategyConfig): (number | null)[] | null {
  return config.exit.stopLoss.type === "atr" ? alignAtr(candles, atrIndicator(candles)) : null;
}

/** Opens a position filled at `signalIndex + 1`'s open, or null if risk is unknowable. */
function openPositionAt(
  candles: Candle[],
  config: StrategyConfig,
  signalIndex: number,
  atrSeries: (number | null)[] | null,
): OpenPosition | null {
  const fillBar = candles[signalIndex + 1];
  const entryPrice = fillBar.open;
  const risk = computeRisk(config, entryPrice, atrSeries?.[signalIndex] ?? null);
  if (risk === null) return null;

  const stopPrice = config.direction === "long" ? entryPrice - risk : entryPrice + risk;
  const rewardDistance =
    config.exit.takeProfit.type === "rr"
      ? risk * config.exit.takeProfit.value
      : config.exit.takeProfit.type === "percent"
        ? entryPrice * (config.exit.takeProfit.value / 100)
        : config.exit.takeProfit.value;
  const targetPrice = config.direction === "long" ? entryPrice + rewardDistance : entryPrice - rewardDistance;

  return {
    direction: config.direction,
    entryTime: fillBar.time,
    entryPrice,
    stopPrice,
    targetPrice,
    barsHeld: 0,
    entryIndex: signalIndex + 1,
  };
}

/** Advances an open position by one bar; returns the closed trade, or null if still open. */
function advanceOpenPosition(
  candles: Candle[],
  config: StrategyConfig,
  symbol: string,
  open: OpenPosition,
  index: number,
): TradeResult | null {
  const bar = candles[index];
  open.barsHeld += 1;

  const hitStop = open.direction === "long" ? bar.low <= open.stopPrice : bar.high >= open.stopPrice;
  const hitTarget = open.direction === "long" ? bar.high >= open.targetPrice : bar.low <= open.targetPrice;
  const timedOut = config.exit.maxBarsInTrade != null && open.barsHeld >= config.exit.maxBarsInTrade;

  if (!hitStop && !hitTarget && !timedOut) return null;
  const exitPrice = hitStop ? open.stopPrice : hitTarget ? open.targetPrice : bar.close;
  return closeTrade(symbol, open, bar.time, exitPrice);
}

function computeRisk(config: StrategyConfig, entryPrice: number, atrValue: number | null): number | null {
  const { stopLoss } = config.exit;
  if (stopLoss.type === "atr") {
    if (atrValue === null) return null;
    return atrValue * stopLoss.value;
  }
  if (stopLoss.type === "percent") {
    return entryPrice * (stopLoss.value / 100);
  }
  return stopLoss.value; // fixed absolute price distance
}

function closeTrade(symbol: string, open: OpenPosition, exitTime: number, exitPrice: number): TradeResult {
  const risk = Math.abs(open.entryPrice - open.stopPrice);
  const pnl = open.direction === "long" ? exitPrice - open.entryPrice : open.entryPrice - exitPrice;
  const rMultiple = risk === 0 ? 0 : pnl / risk;

  return {
    symbol,
    direction: open.direction,
    entryTime: open.entryTime,
    entryPrice: open.entryPrice,
    exitTime,
    exitPrice,
    stopPrice: open.stopPrice,
    targetPrice: open.targetPrice,
    rMultiple,
    won: rMultiple > 0,
    barsHeld: open.barsHeld,
  };
}

function alignAtr(candles: Candle[], points: { time: number; value: number }[]): (number | null)[] {
  const byTime = new Map(points.map((p) => [p.time, p.value]));
  return candles.map((c) => byTime.get(c.time) ?? null);
}
