import type { Candle, StrategyConfig, TradeResult } from "../types";
import { EvaluationContext, sharedSeriesCacheFor } from "../strategy/evaluator";
import { cachedLiquidityFeatures, type LiquidityFeatures } from "../liquidations/clusterSeries";
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
  const liq = exitNeedsLiquidity(config) ? cachedLiquidityFeatures(candles) : null;

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
      open = openPositionAt(candles, config, i, atrSeries, liq);
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
  const liq = exitNeedsLiquidity(config) ? cachedLiquidityFeatures(candles) : null;
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
    if (wanted.has(i)) open = openPositionAt(candles, config, i, atrSeries, liq);
  }

  return trades;
}

function atrSeriesFor(candles: Candle[], config: StrategyConfig): (number | null)[] | null {
  if (config.exit.stopLoss.type !== "atr") return null;
  // ATR(14) не зависит от конфига вообще — но пересчитывался на КАЖДОГО
  // кандидата (2000 раз на символ за ночь). Живёт в общем кэше серий символа.
  const cache = sharedSeriesCacheFor(candles);
  let series = cache.get("engine:atr14");
  if (!series) {
    series = alignAtr(candles, atrIndicator(candles));
    cache.set("engine:atr14", series);
  }
  return series;
}

/** Нужны ли выходам уровни ликвидности (тогда ряд считается один раз на символ). */
export function exitNeedsLiquidity(config: StrategyConfig): boolean {
  return config.exit.stopLoss.type === "liquidity" || config.exit.takeProfit.type === "liquidity";
}

/** Opens a position filled at `signalIndex + 1`'s open, or null if risk is unknowable. */
function openPositionAt(
  candles: Candle[],
  config: StrategyConfig,
  signalIndex: number,
  atrSeries: (number | null)[] | null,
  liq: LiquidityFeatures | null,
): OpenPosition | null {
  const fillBar = candles[signalIndex + 1];
  const entryPrice = fillBar.open;
  const long = config.direction === "long";

  // ── Стоп ────────────────────────────────────────────────────────────────
  let stopPrice: number;
  if (config.exit.stopLoss.type === "liquidity") {
    const atrValue = liq?.atrAt[signalIndex] ?? NaN;
    if (!Number.isFinite(atrValue) || atrValue <= 0) return null;
    const buffer = config.exit.stopLoss.value * atrValue;
    // «За всей ликвидностью»: за самым дальним живым скоплением ПРОТИВ сделки.
    const far = long ? liq!.farBelow[signalIndex] : liq!.farAbove[signalIndex];
    // Скоплений против сделки нет — стоп вырождается в обычный ATR-стоп той
    // же ширины. Иначе правило молча стало бы «без стопа».
    const base = Number.isFinite(far) ? far : entryPrice;
    stopPrice = long ? base - buffer : base + buffer;
  } else {
    const risk = computeRisk(config, entryPrice, atrSeries?.[signalIndex] ?? null);
    if (risk === null) return null;
    stopPrice = long ? entryPrice - risk : entryPrice + risk;
  }
  const risk = Math.abs(entryPrice - stopPrice);
  if (!(risk > 0)) return null;

  // ── Цель ────────────────────────────────────────────────────────────────
  let targetPrice: number;
  if (config.exit.takeProfit.type === "liquidity") {
    const atrValue = liq?.atrAt[signalIndex] ?? NaN;
    if (!Number.isFinite(atrValue) || atrValue <= 0) return null;
    const near = long ? liq!.nearAbove[signalIndex] : liq!.nearBelow[signalIndex];
    // Нет магнита впереди — сделки нет: у этой стратегии цель НЕ произвольна,
    // она и есть смысл входа.
    if (!Number.isFinite(near)) return null;
    // Отступ не доходя до уровня: толпа целится в сам уровень, исполнение там
    // худшее.
    const pull = config.exit.takeProfit.value * atrValue;
    targetPrice = long ? near - pull : near + pull;
    if (long ? targetPrice <= entryPrice : targetPrice >= entryPrice) return null;
  } else {
    const rewardDistance =
      config.exit.takeProfit.type === "rr"
        ? risk * config.exit.takeProfit.value
        : config.exit.takeProfit.type === "percent"
          ? entryPrice * (config.exit.takeProfit.value / 100)
          : config.exit.takeProfit.value;
    targetPrice = long ? entryPrice + rewardDistance : entryPrice - rewardDistance;
  }

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
