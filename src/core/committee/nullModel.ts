import type { Candle, StrategyConfig, TradeResult } from "../types";
import { computeStats } from "../backtest/stats";
import { simulateExits } from "../backtest/engine";

/**
 * Null-model significance test — the committee's defence against
 * multiple-comparisons illusion.
 *
 * 8 templates across 170 symbols is 1360 tests. At a 5% threshold, roughly 68
 * of them will look good by chance alone. A fixed expectancy cutoff does not
 * address this at all: it is exactly the filter that lets the lucky 68 through.
 *
 * So instead of asking "is this expectancy above a number?", ask "is this
 * expectancy above what the SAME exit rules would have earned entering at
 * random on this same instrument?". That null distribution absorbs whatever
 * drift, volatility and trend the symbol happened to have — which is precisely
 * what a naive threshold mistakes for edge.
 *
 * Fully deterministic: entries are drawn from a hash seeded by symbol +
 * template, so the same candidate always gets the same null distribution and
 * a verdict is reproducible.
 */

export const NULL_RUNS = 20;

/**
 * Required margin over the null mean, in standard DEVIATIONS of the null
 * distribution — not standard errors of its mean.
 *
 * The distinction decides whether this module works at all. Standard error
 * shrinks as √runs, so a threshold built from it gets easier to clear the more
 * null runs you do: raising NULL_RUNS from 20 to 100 would have made every
 * borderline candidate "significant" without a single price changing. You could
 * buy significance with CPU. The reference class we actually care about is the
 * spread of individual random-entry outcomes, which is what the strategy has to
 * stand out from.
 */
export const SIGNIFICANCE_SIGMA_MULTIPLE = 2;

/**
 * Below this, relative to the magnitude of the null outcomes, the null has no
 * measurable spread — dividing by it yields z-scores in the 1e15 range, which
 * the UI would print as a confidence figure. "Unmeasurable" is the honest answer.
 */
const DEGENERATE_SPREAD_RATIO = 1e-9;

const NULL_SEED = 0x85ebca6b;

/** Same integer-hash construction the optimizer uses for its seeded sampling. */
function hashInt(value: number): number {
  let h = (value + NULL_SEED) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface NullModelResult {
  /** Mean expectancy of the random-entry runs. */
  nullMean: number;
  nullStdDev: number;
  /** Threshold the real strategy had to beat: mean + k * standard error. */
  threshold: number;
  actualExpectancy: number;
  /** How many standard errors above the null mean the real result sits. */
  zScore: number;
  significant: boolean;
  runs: number;
  /** Set when the test could not be run (too few trades or bars). */
  skipped?: string;
}

/**
 * Runs the same exits from pseudo-random entry bars, `runs` times, and reports
 * whether the real strategy clears the resulting null distribution.
 *
 * `tradeCount` should be the real strategy's trade count so the null runs are
 * sampled at comparable size — a null built from 5 trades would have a wildly
 * wider distribution than one built from 500 and would wave anything through.
 */
export function runNullModel(
  candles: Candle[],
  config: StrategyConfig,
  symbol: string,
  tradeCount: number,
  actualExpectancy: number,
  runs: number = NULL_RUNS,
): NullModelResult {
  const empty: NullModelResult = {
    nullMean: 0,
    nullStdDev: 0,
    threshold: 0,
    actualExpectancy,
    zScore: 0,
    significant: false,
    runs: 0,
  };

  // Below this the null distribution is too noisy to mean anything, and a wide
  // null would pass everything — the opposite of what this guard is for.
  if (tradeCount < 10 || candles.length < 400) {
    return { ...empty, skipped: "недостаточно данных для нуль-модели" };
  }

  const base = hashString(`${symbol}|${config.id}`);
  const firstEligible = 200; // SMA200 warmup, matching the regime module
  const lastEligible = candles.length - 2; // engine fills at i+1
  const span = lastEligible - firstEligible;
  if (span <= tradeCount) return { ...empty, skipped: "слишком короткая история" };

  const expectancies: number[] = [];

  for (let run = 0; run < runs; run++) {
    // Draw `tradeCount` distinct entry bars deterministically.
    const picked = new Set<number>();
    let counter = 0;
    while (picked.size < tradeCount && counter < tradeCount * 20) {
      const h = hashInt(base ^ hashInt(run * 7919 + counter));
      picked.add(firstEligible + (h % span));
      counter += 1;
    }

    const entryIndices = [...picked].sort((a, b) => a - b);
    const trades: TradeResult[] = simulateExits(candles, config, symbol, entryIndices);
    if (trades.length === 0) continue;
    expectancies.push(computeStats(trades).expectancy);
  }

  if (expectancies.length < 2) return { ...empty, skipped: "нуль-модель не дала сделок" };

  const nullMean = expectancies.reduce((a, b) => a + b, 0) / expectancies.length;
  const variance = expectancies.reduce((a, b) => a + (b - nullMean) ** 2, 0) / expectancies.length;
  const nullStdDev = Math.sqrt(variance);

  // A perfectly uniform series makes every random entry earn the same result,
  // leaving only float noise as "spread". Certifying against that would be
  // measuring rounding error, so refuse rather than emit a huge z-score.
  const scale = Math.max(Math.abs(nullMean), 1e-6);
  if (!Number.isFinite(nullStdDev) || nullStdDev <= scale * DEGENERATE_SPREAD_RATIO) {
    return {
      ...empty,
      nullMean,
      nullStdDev: Number.isFinite(nullStdDev) ? nullStdDev : 0,
      runs: expectancies.length,
      skipped: "нуль-модель без разброса — значимость неизмерима",
    };
  }

  const threshold = nullMean + SIGNIFICANCE_SIGMA_MULTIPLE * nullStdDev;

  return {
    nullMean,
    nullStdDev,
    threshold,
    actualExpectancy,
    zScore: (actualExpectancy - nullMean) / nullStdDev,
    significant: actualExpectancy > threshold,
    runs: expectancies.length,
  };
}
