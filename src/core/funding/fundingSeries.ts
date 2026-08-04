import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Candle } from "../types";

/**
 * Ставки финансирования перпетуалов: 157 символов, выплата каждые 8 часов,
 * история с 2020-01-01.
 *
 * Ставка используется НЕ как источник дохода (см.
 * `researcher/docs/family-funding-preregistration.md`), а как измеритель
 * перегруженности плеча: экстремальная ставка означает, что одна сторона
 * рынка платит за право оставаться в позиции.
 */

/** Binance рассчитывает фандинг в 00/08/16 UTC — три выплаты в сутки. */
export const FUNDING_PAYOUTS_PER_DAY = 3;

export interface FundingHistory {
  /** Время выплаты, мс. Возрастает. */
  times: Float64Array;
  /** Ставка за период (доля, не проценты). */
  rates: Float64Array;
}

function fundingDir(): string {
  const base =
    process.env.COLLECT_DIR ?? join(process.env.HOME ?? "", ".chartlab", "data-repo", "market");
  return join(base, "funding");
}

const historyCache = new Map<string, FundingHistory | null>();

/** Читает историю ставок символа. `null`, если истории нет — это не ошибка. */
export function loadFundingHistory(symbol: string): FundingHistory | null {
  const cached = historyCache.get(symbol);
  if (cached !== undefined) return cached;

  const path = join(fundingDir(), `${symbol}.csv`);
  if (!existsSync(path)) {
    historyCache.set(symbol, null);
    return null;
  }

  const lines = readFileSync(path, "utf8").split("\n");
  const times: number[] = [];
  const rates: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const comma = line.indexOf(",");
    if (comma < 0) continue;
    const time = Date.parse(line.slice(0, comma));
    const rate = Number(line.slice(comma + 1));
    if (!Number.isFinite(time) || !Number.isFinite(rate)) continue;
    times.push(time);
    rates.push(rate);
  }

  const history =
    times.length > 0
      ? { times: Float64Array.from(times), rates: Float64Array.from(rates) }
      : null;
  historyCache.set(symbol, history);
  return history;
}

/** Только для тестов: сбрасывает кэш прочитанных файлов. */
export function clearFundingCache(): void {
  historyCache.clear();
  percentileCache = new WeakMap();
}

/**
 * Процентиль ставки в скользящем окне последних `windowSamples` выплат.
 *
 * ПРИЧИННОСТЬ. Для бара, закрывающегося в момент t, берётся последняя выплата
 * со временем СТРОГО МЕНЬШЕ t. Выплата со штампом t в этот момент ещё не
 * известна, и использовать её — это ровно тот способ, которым знание будущего
 * просачивается в бэктест.
 *
 * NaN означает «неизвестно»: нет истории у символа либо в окне ещё не
 * накопилось нужного числа выплат. Недостаток истории не должен молча
 * превращаться в сигнал, поэтому подставлять ноль или среднее нельзя.
 */
export function fundingPercentile(
  candles: readonly Candle[],
  symbol: string,
  windowSamples: number,
): Float64Array {
  const out = new Float64Array(candles.length).fill(NaN);
  const history = loadFundingHistory(symbol);
  if (!history || windowSamples < 2) return out;

  const { times, rates } = history;

  // Процентиль считается ОДИН раз на выплату, а не на бар: выплаты приходят
  // трижды в сутки, баров на порядки больше.
  const ranks = new Float64Array(times.length).fill(NaN);
  for (let s = windowSamples - 1; s < times.length; s++) {
    const current = rates[s];
    let atOrBelow = 0;
    for (let k = s - windowSamples + 1; k <= s; k++) {
      if (rates[k] <= current) atOrBelow++;
    }
    ranks[s] = (atOrBelow / windowSamples) * 100;
  }

  // Оба ряда отсортированы по времени — сводим их одним проходом.
  let s = -1;
  for (let i = 0; i < candles.length; i++) {
    const t = candles[i].time * 1000;
    while (s + 1 < times.length && times[s + 1] < t) s++;
    if (s >= 0) out[i] = ranks[s];
  }
  return out;
}

let percentileCache = new WeakMap<readonly Candle[], Map<string, Float64Array>>();

/** Тот же ряд, но с кэшем на (свечи, символ, окно) — ряд один на всю ночь. */
export function cachedFundingPercentile(
  candles: readonly Candle[],
  symbol: string,
  windowSamples: number,
): Float64Array {
  let perCandles = percentileCache.get(candles);
  if (!perCandles) {
    perCandles = new Map();
    percentileCache.set(candles, perCandles);
  }
  const key = `${symbol}:${windowSamples}`;
  let series = perCandles.get(key);
  if (!series) {
    series = fundingPercentile(candles, symbol, windowSamples);
    perCandles.set(key, series);
  }
  return series;
}
