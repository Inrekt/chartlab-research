import type { Candle } from "../types";

/**
 * Место монеты в общем списке: кросс-секционный моментум.
 *
 * Сравнение монет между собой сжимается в ОДИН РЯД НА СИМВОЛ — процентиль
 * доходности за окно. Дальше условие входа становится обычным, посимвольным,
 * и движок, работающий по одному инструменту, переписывать не приходится.
 *
 * См. `researcher/docs/family-cross-momentum-preregistration.md`, в том числе
 * раздел про смещение выжившего: к нему это семейство уязвимее прочих.
 */

/** Процентиль на символ, выровненный по его собственным свечам. NaN — места нет. */
export type RankSeries = Map<string, Float64Array>;

/**
 * Сколько монет должно участвовать в сравнении, чтобы место вообще имело смысл.
 *
 * На ранней истории корпуса на баре бывает две-три монеты — процентиль среди
 * двух это не «место в списке», а подбрасывание монетки, и правило «верхние
 * 10%» там вырождается в «одна из двух». Такие бары дали бы ложные сигналы на
 * годы истории, причём выглядели бы совершенно нормально.
 *
 * Порог 20: дециль требует хотя бы десяти участников, чтобы существовать, а
 * двадцать дают по две монеты на дециль.
 */
export const MIN_UNIVERSE = 20;

/**
 * Доходность за `lookbackBars` баров на каждом баре символа.
 * NaN, пока истории не хватает: у монеты, торгующейся третий день, места в
 * списке за 90 дней быть не может.
 */
function trailingReturns(candles: readonly Candle[], lookbackBars: number): Float64Array {
  const out = new Float64Array(candles.length).fill(NaN);
  for (let i = lookbackBars; i < candles.length; i++) {
    const past = candles[i - lookbackBars].close;
    if (past > 0) out[i] = candles[i].close / past - 1;
  }
  return out;
}

/**
 * Процентиль каждой монеты в списке всех монет на каждом баре.
 *
 * ПРИЧИННОСТЬ: место на баре, закрывающемся в момент t, считается по
 * доходностям, известным до t включительно. Никакой доходности вперёд.
 *
 * Сравнение идёт по времени бара, а не по его номеру: у монет разные даты
 * листинга, и i-й бар BTC и i-й бар свежего альткоина — это разные дни.
 */
export function crossSectionRanks(
  universe: ReadonlyMap<string, readonly Candle[]>,
  lookbackBars: number,
): RankSeries {
  const returns = new Map<string, Float64Array>();
  for (const [symbol, candles] of universe) {
    returns.set(symbol, trailingReturns(candles, lookbackBars));
  }

  const ranks: RankSeries = new Map();
  for (const [symbol, candles] of universe) {
    ranks.set(symbol, new Float64Array(candles.length).fill(NaN));
  }

  // Значения группируются по ВРЕМЕНИ бара, а не по его номеру: у монет разные
  // даты листинга. Вместе со значением носим сразу и позицию в ряду символа —
  // тогда результат кладётся на место одним проходом, без обратного поиска.
  interface Entry {
    series: Float64Array;
    index: number;
    value: number;
  }
  const byTime = new Map<number, Entry[]>();

  for (const [symbol, candles] of universe) {
    const r = returns.get(symbol)!;
    const series = ranks.get(symbol)!;
    for (let i = 0; i < candles.length; i++) {
      const value = r[i];
      if (!Number.isFinite(value)) continue;
      const entry: Entry = { series, index: i, value };
      const bucket = byTime.get(candles[i].time);
      if (bucket) bucket.push(entry);
      else byTime.set(candles[i].time, [entry]);
    }
  }

  for (const bucket of byTime.values()) {
    if (bucket.length < MIN_UNIVERSE) continue;
    bucket.sort((a, b) => a.value - b.value);
    const n = bucket.length;
    for (let k = 0; k < n; k++) {
      // Доля монет, которых эта обошла или с которыми вровень: худшая получает
      // 100/n, лучшая — ровно 100.
      bucket[k].series[bucket[k].index] = ((k + 1) / n) * 100;
    }
  }

  return ranks;
}
