/**
 * Последовательный тест Вальда (SPRT) — решающий механизм инкубатора.
 *
 * После каждой закрытой бумажной сделки логарифм отношения правдоподобий
 * сдвигается к одной из границ: H1 «край есть» (μ = μ1) или H0 «края нет»
 * (μ = 0). Вальд–Вулфовиц: SPRT минимизирует ожидаемое число наблюдений при
 * заданных ошибках — тем же способом Stockfish принимает патчи движка.
 *
 * μ1 = ПОЛОВИНА бэктест-матожидания: Бентер — «лучшие модели завышают край
 * примерно вдвое», скептичная альтернатива защищает от самообмана.
 */

export const SPRT_ALPHA = 0.05;
export const SPRT_BETA = 0.1;
/** ln((1−β)/α) = ln 18 ≈ +2.890 — принять H1 (край есть). */
export const SPRT_A = Math.log((1 - SPRT_BETA) / SPRT_ALPHA);
/** ln(β/(1−α)) = ln(2/19) ≈ −2.251 — принять H0 (край не доказан). */
export const SPRT_B = Math.log(SPRT_BETA / (1 - SPRT_ALPHA));

export type SprtDecision = "accept" | "reject" | "continue";

export interface SprtResult {
  llr: number;
  decision: SprtDecision;
  /** Номер сделки, на которой тест остановился (0 = не остановился). */
  stoppedAt: number;
  observations: number;
}

/** Приращение LLR для нормальной модели с известным σ: μ0=0 против μ1. */
export function llrIncrement(x: number, mu1: number, sigma: number): number {
  return (mu1 / (sigma * sigma)) * (x - mu1 / 2);
}

/**
 * Последовательный проход по сделкам В ПОРЯДКЕ ЗАКРЫТИЯ: тест останавливается
 * на первом пересечении границы, дальнейшие сделки решения не меняют — иначе
 * это уже не SPRT, а подглядывание за пределом остановки.
 */
export function sprtDecide(
  netRMultiples: readonly number[],
  mu1: number,
  sigma: number,
): SprtResult {
  let llr = 0;
  for (let i = 0; i < netRMultiples.length; i++) {
    llr += llrIncrement(netRMultiples[i], mu1, sigma);
    if (llr >= SPRT_A) return { llr, decision: "accept", stoppedAt: i + 1, observations: netRMultiples.length };
    if (llr <= SPRT_B) return { llr, decision: "reject", stoppedAt: i + 1, observations: netRMultiples.length };
  }
  return { llr, decision: "continue", stoppedAt: 0, observations: netRMultiples.length };
}

/**
 * E₁[N] — ожидаемое число сделок до решения, если край настоящий:
 * ((1−β)·lnA + β·lnB) / K₁, K₁ = δ²/2, δ = μ1/σ.
 * При δ=0.25 ≈ 76 сделок (проверено пересчётом в ресёрче).
 */
export function expectedAcceptSampleSize(mu1: number, sigma: number): number {
  const delta = mu1 / sigma;
  if (delta <= 0) return Number.POSITIVE_INFINITY;
  const k1 = (delta * delta) / 2;
  return ((1 - SPRT_BETA) * SPRT_A + SPRT_BETA * SPRT_B) / k1;
}
