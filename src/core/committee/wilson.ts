/**
 * Wilson score interval for a binomial proportion.
 *
 * "58% винрейт" on 21 trades is a lie of omission: the honest reading of that
 * sample is "somewhere between 37% and 76%", which straddles break-even for
 * most R:R profiles. The committee quotes intervals rather than point estimates
 * so that a thin sample cannot masquerade as a finding.
 *
 * Wilson rather than the textbook normal approximation because the latter is
 * actively wrong exactly where the committee needs it most — small n and
 * proportions near 0 or 1, where it happily returns bounds outside [0, 1].
 */

/** 95% two-sided normal quantile — the default confidence level everywhere. */
export const Z_95 = 1.96;

export interface ProportionInterval {
  low: number;
  high: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function wilsonInterval(successes: number, total: number, z = Z_95): ProportionInterval {
  if (!Number.isFinite(total) || total <= 0) return { low: 0, high: 0 };

  const n = total;
  const p = clamp(successes, 0, n) / n;
  const z2 = z * z;

  // Wilson centres the interval on a shrunk proportion rather than p̂ itself,
  // which is what keeps it inside [0, 1] and honest at small n.
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const halfWidth = (z / denominator) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));

  return {
    low: clamp(centre - halfWidth, 0, 1),
    high: clamp(centre + halfWidth, 0, 1),
  };
}

/** Prepositional case: "на 21 сделке", but "на 22 сделках" and "на 11 сделках". */
function tradesWord(count: number): string {
  const abs = Math.abs(count);
  return abs % 10 === 1 && abs % 100 !== 11 ? "сделке" : "сделках";
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * One-line Russian summary of a win rate and its uncertainty, e.g.
 * "57% на 21 сделке — 95% ДИ [37%, 76%]".
 */
export function describeWinRateInterval(successes: number, total: number): string {
  if (!Number.isFinite(total) || total <= 0) return "нет сделок — винрейт не определён";

  const { low, high } = wilsonInterval(successes, total);
  const observed = percent(clamp(successes, 0, total) / total);
  const interval = `95% ДИ [${percent(low)}, ${percent(high)}]`;

  // A single trade carries no information about the underlying rate, and
  // printing a near-[0,100] interval as if it were a measurement invites the
  // reader to average the endpoints. Say the quiet part instead.
  if (total === 1) return `${observed} на 1 сделке — ${interval}, то есть неизвестно`;

  return `${observed} на ${total} ${tradesWord(total)} — ${interval}`;
}
