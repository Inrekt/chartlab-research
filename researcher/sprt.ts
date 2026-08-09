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

/** Дневное наблюдение: среднее net-R за сутки и сколько сделок в нём. */
export interface DailyObservation {
  day: number;
  mean: number;
  count: number;
}

/**
 * Сделки → ДНЕВНЫЕ наблюдения, сутки по времени ВЫХОДА.
 *
 * Существует потому, что SPRT предполагает независимые наблюдения, а наши
 * сделки таковыми не являются: холд (медиана 15 ч на 1ч-ТФ) длиннее интервала
 * между входами, позиции перекрываются, и внутри дня их двигает общий
 * рыночный фактор. Замер по реальным прогонам: ρ внутри дня 0.20 (1h) и 0.44
 * (4h), отношение эффективного числа сделок к номинальному ≈ 0.53.
 *
 * Цена наивного счёта измерена на 600 симуляциях: при ρ=0.44 ложное принятие
 * 14.5% вместо заявленных ≤5.6%, то есть тест ВТРОЕ мягче вывески, и при этом
 * теряет 13 пунктов мощности. Пре-регистрация: docs/sprt-daily-preregistration.md.
 */
export function toDailyObservations(
  netRs: readonly { day: number; net: number }[],
): DailyObservation[] {
  const byDay = new Map<number, { sum: number; count: number }>();
  for (const { day, net } of netRs) {
    const cur = byDay.get(day) ?? { sum: 0, count: 0 };
    cur.sum += net;
    cur.count += 1;
    byDay.set(day, cur);
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, v]) => ({ day, mean: v.sum / v.count, count: v.count }));
}

/**
 * Внутридневная корреляция ρ разложением дисперсии (ICC).
 *
 * Считается по ФАКТИЧЕСКОМУ потоку кандидата, а не берётся константой: на
 * 1ч и 4ч она различается вдвое, и подстановка «среднего по больнице»
 * означала бы ту же ошибку, что и наивный счёт, только тише.
 *
 * `null` — данных не хватает (меньше `MIN_GROUPS` дней с ≥2 сделками); тогда
 * вызывающий обязан взять консервативную оценку, а не считать ρ нулём.
 */
export function withinDayIcc(
  netRs: readonly { day: number; net: number }[],
  minGroups = 20,
): { rho: number; meanPerDay: number } | null {
  const byDay = new Map<number, number[]>();
  for (const { day, net } of netRs) {
    (byDay.get(day) ?? byDay.set(day, []).get(day)!).push(net);
  }
  const groups = [...byDay.values()].filter((g) => g.length >= 2);
  if (groups.length < minGroups) return null;

  const all = groups.flat();
  const grand = all.reduce((a, b) => a + b, 0) / all.length;
  let ssBetween = 0;
  let ssWithin = 0;
  let dfWithin = 0;
  for (const g of groups) {
    const m = g.reduce((a, b) => a + b, 0) / g.length;
    ssBetween += g.length * (m - grand) ** 2;
    for (const x of g) ssWithin += (x - m) ** 2;
    dfWithin += g.length - 1;
  }
  const msBetween = ssBetween / Math.max(groups.length - 1, 1);
  const msWithin = ssWithin / Math.max(dfWithin, 1);
  /*
   * ДВЕ РАЗНЫЕ средние, и путать их нельзя.
   *
   * `iccMean` — среднее по многосделочным дням; только они несут информацию о
   * внутридневной корреляции, и формула ICC требует именно их.
   *
   * `meanPerDay` — среднее по ВСЕМ дням с хотя бы одной сделкой. Именно оно
   * уходит в `dailySigma`, потому что дневные наблюдения строятся по всем
   * дням, а не только по многосделочным.
   *
   * Раньше возвращалась первая под именем второй — параметр в чужой
   * семантике. При пуассоновском потоке λ=2.5 это 3.22 вместо 2.72: σ_день
   * занижалась, шаги LLR росли примерно на 17%, границы Вальда эффективно
   * сжимались, и ложное принятие уходило к 5.5–6% против заявленных 3.5% —
   * то есть к порогу, который пре-регистрация сама объявила критерием провала.
   * Ошибка была В ПОЛЬЗУ стратегии.
   *
   * Отдельная ирония: запасной путь в incubate.ts считал средную ПРАВИЛЬНО,
   * по всем дням. Тест становился мягче ровно в тот момент, когда набиралось
   * достаточно данных и он переключался на «измеренное».
   */
  const iccMean = all.length / groups.length;
  const meanPerDay = netRs.length / byDay.size;
  const denom = msBetween + (iccMean - 1) * msWithin;
  if (!(denom > 0)) return null;
  // ρ может выйти отрицательной при малой выборке — это шум, не отрицательная
  // корреляция; клипуем в ноль, иначе σ_день окажется меньше честной.
  return { rho: Math.max(0, (msBetween - msWithin) / denom), meanPerDay };
}

/**
 * σ дневного наблюдения при известных ρ и среднем числе сделок в дне.
 *
 * σ_день = σ · √((1 + (m̄−1)·ρ) / m̄). При ρ=0 это σ/√m̄ (полная
 * независимость), при ρ=1 — сам σ (день = одна ставка).
 */
export function dailySigma(sigma: number, meanPerDay: number, rho: number): number {
  const m = Math.max(meanPerDay, 1);
  return sigma * Math.sqrt((1 + (m - 1) * rho) / m);
}
