import type { BacktestStats, TradeResult } from "../types";

export function computeStats(trades: TradeResult[]): BacktestStats {
  if (trades.length === 0) {
    return {
      totalTrades: 0,
      winRate: 0,
      avgRR: 0,
      profitFactor: 0,
      expectancy: 0,
      maxDrawdownR: 0,
      avgBarsHeld: 0,
    };
  }

  const wins = trades.filter((t) => t.won);
  const losses = trades.filter((t) => !t.won);

  const grossWin = wins.reduce((sum, t) => sum + t.rMultiple, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.rMultiple, 0));

  const winRate = wins.length / trades.length;
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const avgRR = avgLoss === 0 ? avgWin : avgWin / avgLoss;
  const profitFactor = grossLoss === 0 ? (grossWin > 0 ? Infinity : 0) : grossWin / grossLoss;
  const expectancy = winRate * avgWin - (1 - winRate) * avgLoss;

  const avgBarsHeld = trades.reduce((sum, t) => sum + t.barsHeld, 0) / trades.length;

  return {
    totalTrades: trades.length,
    winRate,
    avgRR,
    profitFactor,
    expectancy,
    maxDrawdownR: computeMaxDrawdown(trades),
    avgBarsHeld,
  };
}

/**
 * Equity curve in R-multiples, starting from an arbitrary base of 1.0.
 * Duplicate exit timestamps (common when many symbols close trades on the
 * same bar) are collapsed to one point — charting libs require strictly
 * ascending unique times.
 */
export function computeEquityCurve(trades: TradeResult[]): { time: number; equity: number }[] {
  const sorted = trades.slice().sort((a, b) => a.exitTime - b.exitTime);
  const out: { time: number; equity: number }[] = [];
  let equity = 1;
  for (const t of sorted) {
    equity += t.rMultiple;
    const last = out[out.length - 1];
    if (last && last.time === t.exitTime) {
      last.equity = equity;
    } else {
      out.push({ time: t.exitTime, equity });
    }
  }
  return out;
}

/**
 * Max drawdown expressed in R units (peak-to-trough of the R-based equity
 * curve), not percent — the curve starts from an arbitrary base of 1R, so a
 * percent-of-peak figure would be meaningless once equity dips near zero.
 */
function computeMaxDrawdown(trades: TradeResult[]): number {
  const curve = computeEquityCurve(trades);
  let peak = 1;
  let maxDrawdown = 0;
  for (const point of curve) {
    peak = Math.max(peak, point.equity);
    maxDrawdown = Math.max(maxDrawdown, peak - point.equity);
  }
  return maxDrawdown;
}

export interface DrawdownWindow {
  peakTime: number;
  troughTime: number;
  drawdownR: number;
}

/**
 * Finds the peak→trough interval of the single worst drawdown on the R-based
 * equity curve — the "when did it hurt the most" window the AI Analyst report
 * cites when explaining a bad stretch.
 */
export function findWorstDrawdownWindow(trades: TradeResult[]): DrawdownWindow | null {
  const curve = computeEquityCurve(trades);
  if (curve.length === 0) return null;

  let peak = 1;
  let peakTime = curve[0].time;
  let worst: DrawdownWindow | null = null;

  for (const point of curve) {
    if (point.equity > peak) {
      peak = point.equity;
      peakTime = point.time;
    }
    const drawdown = peak - point.equity;
    if (!worst || drawdown > worst.drawdownR) {
      worst = { peakTime, troughTime: point.time, drawdownR: drawdown };
    }
  }
  return worst && worst.drawdownR > 0 ? worst : null;
}
