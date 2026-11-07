import type { FundingHistory } from "../src/core/funding/fundingSeries";
import type { TradeResult } from "../src/core/types";

/**
 * Фандинг как издержка сделки в R (P4, пре-регистрация search-v4).
 *
 * За каждую выплату t (00/08/16 UTC), пока позиция открыта (вход < t ≤ выход):
 * издержка_R += знак · ставка_t · цена_t · объём_t / riskBudget, где знак +1 у
 * лонга и −1 у шорта. Полученный фандинг даёт отрицательную издержку.
 */

/** Нет ряда — 0.01% за выплату ПРОТИВ позиции (всегда издержка). */
export const MISSING_FUNDING_RATE = 0.0001;

const PAYOUT_PERIOD_MS = 8 * 3600 * 1000;

type FundingLookup = (symbol: string) => FundingHistory | null | undefined;
type PriceLookup = (symbol: string, timeSec: number) => number | undefined;

/** Объём позиции на момент t (сек): входы строго до t минус выходы строго до t. */
function qtyAt(trade: TradeResult, tSec: number): number {
  if (!trade.fills || trade.fills.length === 0) return 1;
  let qty = 0;
  for (const fill of trade.fills) {
    if (fill.time >= tSec) continue;
    qty += fill.side === "entry" ? fill.qty : -fill.qty;
  }
  return Math.max(qty, 0);
}

export function buildFundingCost(
  loadFunding: FundingLookup,
  priceAt?: PriceLookup,
): (trade: TradeResult) => number {
  return (trade) => {
    if (!(Number.isFinite(trade.riskBudget) && trade.riskBudget > 0)) return 0;
    const sign = trade.direction === "long" ? 1 : -1;
    const fromMs = trade.entryTime * 1000;
    const toMs = trade.exitTime * 1000;
    if (!(toMs > fromMs)) return 0;

    const priceFor = (tMs: number): number => {
      const p = priceAt?.(trade.symbol, tMs / 1000);
      return p !== undefined && Number.isFinite(p) && p > 0 ? p : trade.entryPrice;
    };
    const legR = (tMs: number, rate: number, direction: number): number =>
      (direction * rate * priceFor(tMs) * qtyAt(trade, tMs / 1000)) / trade.riskBudget;

    const history = loadFunding(trade.symbol);
    const n = history ? history.times.length : 0;
    let cost = 0;

    // Измеренные выплаты окна.
    if (history && n > 0) {
      for (let k = lowerBound(history.times, fromMs + 1); k < n && history.times[k] <= toMs; k++) {
        cost += legR(history.times[k], history.rates[k], sign);
      }
    }

    // Выплаты расписания вне покрытия ряда (или ряда нет вовсе) — по запасной ставке.
    const covFrom = n > 0 ? history!.times[0] : Infinity;
    const covTo = n > 0 ? history!.times[n - 1] : -Infinity;
    let t = Math.floor(fromMs / PAYOUT_PERIOD_MS + 1) * PAYOUT_PERIOD_MS;
    for (; t <= toMs; t += PAYOUT_PERIOD_MS) {
      if (t >= covFrom && t <= covTo) continue;
      cost += legR(t, MISSING_FUNDING_RATE, 1);
    }
    return cost;
  };
}

/** Первый индекс с times[i] ≥ x. */
function lowerBound(times: Float64Array, x: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
