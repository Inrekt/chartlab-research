import type {
  BacktestStats,
  ConditionAtom,
  ConditionGroup,
  IndicatorRef,
  StrategyConfig,
} from "../types";

/** One evaluated variation of the user's strategy, ready to rank/apply. */
export interface OptimizeCandidate {
  config: StrategyConfig;
  /** Human-readable summary of what changed vs the base config. */
  delta: string;
  /** Stats aggregated over ALL symbols' trades combined. */
  aggregate: BacktestStats;
  score: number;
  /** True for the unchanged input config (always candidate 0 of the search space). */
  isBaseline: boolean;
}

export const MAX_CANDIDATES = 60;

const FAST_PERIODS = [5, 8, 10, 12, 15, 20];
const SLOW_PERIODS = [20, 26, 30, 40, 50, 60];
const RSI_PERIODS = [7, 10, 14, 21];
const RSI_THRESHOLD_SPAN = 15;
const RSI_THRESHOLD_STEP = 5;
const ATR_MULTIPLIERS = [1, 1.5, 2, 2.5, 3];
const RR_TARGETS = [1, 1.5, 2, 2.5, 3];
/** ±50% grid used for percent/fixed stop & target values. */
const VALUE_GRID_FACTORS = [0.5, 0.75, 1.25, 1.5];
const SAMPLING_SEED = 0x9e3779b9;
const VALUE_EPSILON = 1e-9;

/** Blended-score normalization ceilings (values at/above these saturate). */
const RR_NORMALIZATION_CEILING = 3;
const DD_NORMALIZATION_CEILING = 20;

type StopLoss = StrategyConfig["exit"]["stopLoss"];
type TakeProfit = StrategyConfig["exit"]["takeProfit"];

/**
 * Generates candidate StrategyConfigs by varying entry indicator parameters,
 * stop-loss size, and take-profit target. Candidate 0 is always the unchanged
 * base config. When the full cartesian grid exceeds MAX_CANDIDATES the grid is
 * down-sampled deterministically (seeded integer hash — never Math.random or
 * the clock), so two runs over the same config produce the same candidates in
 * the same order.
 */
export function deriveSearchSpace(config: StrategyConfig): StrategyConfig[] {
  const entries = buildEntryVariants(config.entry);
  const stops = buildStopVariants(config.exit.stopLoss);
  const targets = buildTargetVariants(config.exit.takeProfit);

  const total = entries.length * stops.length * targets.length;
  const combosPerEntry = stops.length * targets.length;

  const buildAt = (index: number): StrategyConfig => {
    const entryIndex = Math.floor(index / combosPerEntry);
    const remainder = index % combosPerEntry;
    const stopIndex = Math.floor(remainder / targets.length);
    const targetIndex = remainder % targets.length;
    return {
      ...config,
      entry: entries[entryIndex],
      exit: {
        ...config.exit,
        stopLoss: stops[stopIndex],
        takeProfit: targets[targetIndex],
      },
    };
  };

  // Index 0 is (base entry, base stop, base target) because every variant
  // list puts the unchanged value first — the baseline comes for free.
  if (total <= MAX_CANDIDATES) {
    return rangeIndices(total).map(buildAt);
  }

  const sampled = rangeIndices(total)
    .slice(1) // baseline handled separately
    .map((index) => ({ index, priority: hashIndex(index) }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .slice(0, MAX_CANDIDATES - 1)
    .map((entry) => entry.index)
    .sort((a, b) => a - b);

  return [0, ...sampled].map(buildAt);
}

/**
 * Primary objective: expectancy (average R per trade). Candidate sets with no
 * trades rank last — an untradeable "improvement" is worthless.
 */
export function scoreStats(stats: BacktestStats): number {
  if (stats.totalTrades === 0) return Number.NEGATIVE_INFINITY;
  return stats.expectancy;
}

/**
 * Secondary blended objective: winRate*0.4 + normalizedRR*0.4 - ddPenalty*0.2.
 * Avg R:R saturates at RR_NORMALIZATION_CEILING, drawdown penalty saturates at
 * DD_NORMALIZATION_CEILING R of peak-to-trough loss.
 */
export function scoreStatsBlended(stats: BacktestStats): number {
  if (stats.totalTrades === 0) return Number.NEGATIVE_INFINITY;
  const normalizedRR = Math.min(stats.avgRR / RR_NORMALIZATION_CEILING, 1);
  const ddPenalty = Math.min(stats.maxDrawdownR / DD_NORMALIZATION_CEILING, 1);
  return stats.winRate * 0.4 + normalizedRR * 0.4 - ddPenalty * 0.2;
}

/**
 * Short human description of how `candidate` differs from `base`, e.g.
 * "EMA 12→9 / 26→40, SL 1.5→2 ATR, TP 2→2.5R".
 */
export function describeDelta(base: StrategyConfig, candidate: StrategyConfig): string {
  const parts: string[] = [];

  const baseAtom = primaryAtom(base.entry);
  const candidateAtom = primaryAtom(candidate.entry);
  if (baseAtom && candidateAtom) {
    parts.push(...describeAtomDelta(baseAtom, candidateAtom));
  }

  parts.push(...describeStopDelta(base.exit.stopLoss, candidate.exit.stopLoss));
  parts.push(...describeTargetDelta(base.exit.takeProfit, candidate.exit.takeProfit));

  return parts.length > 0 ? parts.join(", ") : "Current settings";
}

// ---------------------------------------------------------------------------
// Entry variants
// ---------------------------------------------------------------------------

function isGroup(condition: ConditionAtom | ConditionGroup): condition is ConditionGroup {
  return "operator" in condition;
}

/** First top-level atom of the entry group — the one the optimizer varies. */
function primaryAtom(group: ConditionGroup): ConditionAtom | null {
  const found = group.conditions.find((c) => !isGroup(c));
  return found && !isGroup(found) ? found : null;
}

function buildEntryVariants(entry: ConditionGroup): ConditionGroup[] {
  const atomIndex = entry.conditions.findIndex((c) => !isGroup(c));
  if (atomIndex === -1) return [entry];

  const atom = entry.conditions[atomIndex] as ConditionAtom;
  return buildAtomVariants(atom).map((variant) =>
    variant === atom
      ? entry
      : {
          ...entry,
          conditions: entry.conditions.map((c, i) => (i === atomIndex ? variant : c)),
        },
  );
}

/** Unchanged atom always first; variations after (deduplicated against it). */
function buildAtomVariants(atom: ConditionAtom): ConditionAtom[] {
  if (
    atom.kind === "crossover" &&
    typeof atom.b === "object" &&
    atom.a.period != null &&
    atom.b.period != null
  ) {
    return buildCrossoverVariants(atom, atom.a.period, atom.b.period);
  }

  if (atom.kind === "comparison" && atom.left.kind === "rsi" && typeof atom.right === "number") {
    return buildRsiComparisonVariants(atom, atom.left.period ?? 14, atom.right);
  }

  return [atom];
}

function buildCrossoverVariants(
  atom: Extract<ConditionAtom, { kind: "crossover" }>,
  currentFast: number,
  currentSlow: number,
): ConditionAtom[] {
  const fasts = uniqueSorted([...FAST_PERIODS, currentFast]);
  const slows = uniqueSorted([...SLOW_PERIODS, currentSlow]);
  const variants: ConditionAtom[] = [atom];

  for (const fast of fasts) {
    for (const slow of slows) {
      if (fast >= slow) continue;
      if (fast === currentFast && slow === currentSlow) continue;
      variants.push({
        ...atom,
        a: { ...atom.a, period: fast },
        b: { ...(atom.b as IndicatorRef), period: slow },
      });
    }
  }
  return variants;
}

function buildRsiComparisonVariants(
  atom: Extract<ConditionAtom, { kind: "comparison" }>,
  currentPeriod: number,
  currentThreshold: number,
): ConditionAtom[] {
  const periods = uniqueSorted([...RSI_PERIODS, currentPeriod]);
  const thresholds: number[] = [];
  for (
    let t = currentThreshold - RSI_THRESHOLD_SPAN;
    t <= currentThreshold + RSI_THRESHOLD_SPAN;
    t += RSI_THRESHOLD_STEP
  ) {
    if (t >= 0 && t <= 100) thresholds.push(t);
  }

  const variants: ConditionAtom[] = [atom];
  for (const period of periods) {
    for (const threshold of thresholds) {
      if (period === currentPeriod && threshold === currentThreshold) continue;
      variants.push({ ...atom, left: { ...atom.left, period }, right: threshold });
    }
  }
  return variants;
}

// ---------------------------------------------------------------------------
// Exit variants
// ---------------------------------------------------------------------------

function buildStopVariants(stop: StopLoss): StopLoss[] {
  const values =
    stop.type === "atr"
      ? ATR_MULTIPLIERS
      : VALUE_GRID_FACTORS.map((factor) => roundTo(stop.value * factor, 4));

  const variants: StopLoss[] = [stop];
  for (const value of values) {
    if (!approxEqual(value, stop.value)) variants.push({ ...stop, value });
  }
  return variants;
}

function buildTargetVariants(target: TakeProfit): TakeProfit[] {
  const values =
    target.type === "rr"
      ? RR_TARGETS
      : VALUE_GRID_FACTORS.map((factor) => roundTo(target.value * factor, 4));

  const variants: TakeProfit[] = [target];
  for (const value of values) {
    if (!approxEqual(value, target.value)) variants.push({ ...target, value });
  }
  return variants;
}

// ---------------------------------------------------------------------------
// Delta descriptions
// ---------------------------------------------------------------------------

function describeAtomDelta(base: ConditionAtom, candidate: ConditionAtom): string[] {
  if (
    base.kind === "crossover" &&
    candidate.kind === "crossover" &&
    typeof base.b === "object" &&
    typeof candidate.b === "object"
  ) {
    const fastChanged = base.a.period !== candidate.a.period;
    const slowChanged = base.b.period !== candidate.b.period;
    if (fastChanged || slowChanged) {
      const label = base.a.kind.toUpperCase();
      return [
        `${label} ${fmt(base.a.period ?? 0)}→${fmt(candidate.a.period ?? 0)} / ${fmt(base.b.period ?? 0)}→${fmt(candidate.b.period ?? 0)}`,
      ];
    }
    return [];
  }

  if (base.kind === "comparison" && candidate.kind === "comparison") {
    const parts: string[] = [];
    if (base.left.period !== candidate.left.period) {
      parts.push(
        `${base.left.kind.toUpperCase()} ${fmt(base.left.period ?? 0)}→${fmt(candidate.left.period ?? 0)}`,
      );
    }
    if (
      typeof base.right === "number" &&
      typeof candidate.right === "number" &&
      base.right !== candidate.right
    ) {
      parts.push(`threshold ${fmt(base.right)}→${fmt(candidate.right)}`);
    }
    return parts;
  }

  return [];
}

function describeStopDelta(base: StopLoss, candidate: StopLoss): string[] {
  if (approxEqual(base.value, candidate.value)) return [];
  const suffix = candidate.type === "atr" ? " ATR" : candidate.type === "percent" ? "%" : "";
  return [`SL ${fmt(base.value)}→${fmt(candidate.value)}${suffix}`];
}

function describeTargetDelta(base: TakeProfit, candidate: TakeProfit): string[] {
  if (approxEqual(base.value, candidate.value)) return [];
  const suffix = candidate.type === "rr" ? "R" : candidate.type === "percent" ? "%" : "";
  return [`TP ${fmt(base.value)}→${fmt(candidate.value)}${suffix}`];
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(roundTo(n, 2));
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function approxEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < VALUE_EPSILON;
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function rangeIndices(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i);
}

/**
 * Deterministic 32-bit integer hash (xorshift-multiply avalanche) used to
 * pseudo-shuffle grid indices for down-sampling. Fixed seed — never wall
 * clock or Math.random — so candidate selection is stable between runs.
 */
function hashIndex(index: number): number {
  let h = (index + SAMPLING_SEED) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
