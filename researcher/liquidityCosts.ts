/**
 * Проскальзывание как функция ликвидности символа В МОМЕНТ СДЕЛКИ.
 *
 * Две причины, обе замерены.
 *
 * 1. ОДНА СТАВКА НА ВСЮ ВСЕЛЕННУЮ НЕВЕРНА. Оборот символов различается в
 *    3270 раз: BTCUSDT 88.4 млн $/час против 27 тыс. у хвоста. Плоские 5 б.п.
 *    вчетверо пессимистичны на BTC и в 8.8 раза оптимистичны на девятом
 *    дециле. Значит поиск систематически переоценивает неликвидную половину —
 *    ровно ту, где живёт возврат к среднему.
 *
 * 2. ТИР СЧИТАЛСЯ ЗАДНИМ ЧИСЛОМ. `liquidityTiers` берёт оборот за последние
 *    180 дней in-окна и применяет его ко ВСЕЙ истории с 2019 года. В январе
 *    2022 знать оборот монеты за 2025-й было нельзя. Здесь оборот считается
 *    ПОМЕСЯЧНО, и сделке ставится оборот её собственного месяца.
 *
 * Модель — закон квадратного корня (Almgren и др.): impact ≈ σ·√(Q/V).
 * Пре-регистрация: docs/liquidity-costs-preregistration.md.
 */
import type { Candle, TradeResult } from "../src/core/types/index.ts";
import { DEFAULT_SLIPPAGE_RATE } from "../src/core/committee/costModel.ts";
import type { SignalTf } from "./grammar.ts";

/**
 * Наш нотионал на сделку, $. Считается от реального размера, а не назначен:
 * счёт $50 000 (план Breakout 1-Step), риск 0.5% на сделку, стоп ≈2% от цены
 * ⇒ позиция ≈ $12 500. При изменении размера счёта это число надо
 * пересчитать — оно входит в издержки под корнем.
 */
export const ORDER_NOTIONAL_USD = 12_500;

/**
 * Часовая волатильность вселенной, доли цены. Замер по 37 символам:
 * медиана 105 б.п. Не константа из литературы — см. `cost-floor.ts`.
 */
export const UNIVERSE_HOURLY_SIGMA = 0.0105;

/** Ключ месяца по времени бара — единица, в которой считается оборот. */
export function monthKey(timeSec: number): string {
  return new Date(timeSec * 1000).toISOString().slice(0, 7);
}

/**
 * Средний оборот символа по месяцам, $/бар.
 *
 * Помесячно, а не одним числом на всю историю: ликвидность монеты меняется на
 * порядки за год, и единая оценка означала бы заглядывание в будущее для
 * ранних сделок и в прошлое — для поздних.
 */
export function monthlyNotional(candles: readonly Candle[]): Map<string, number> {
  const acc = new Map<string, { sum: number; bars: number }>();
  for (const bar of candles) {
    const key = monthKey(bar.time);
    const cur = acc.get(key) ?? { sum: 0, bars: 0 };
    cur.sum += bar.volume * bar.close;
    cur.bars += 1;
    acc.set(key, cur);
  }
  const out = new Map<string, number>();
  for (const [key, v] of acc) out.set(key, v.sum / v.bars);
  return out;
}

/**
 * Проскальзывание одной стороны при данном обороте за бар.
 *
 * ⚠️ ПОЛ на текущей плоской ставке принципиален. Модель применяется только
 * ВВЕРХ: удешевить BTC до 1.2 б.п. значило бы ослабить проверку для ликвидных
 * символов, а это запрещено. Плюс честная причина: 5 б.п. покрывают не только
 * импакт, но и разброс комиссий, задержку и то, что реальных филлов мы не
 * измеряли ни разу. Модель без пола притворялась бы знанием, которого нет.
 *
 * Оборот неизвестен или нулевой ⇒ берётся десятикратная ставка: отсутствие
 * данных о ликвидности — повод быть осторожнее, а не смелее.
 */
export function slippageForNotional(
  notionalPerBar: number,
  barsPerHour: number,
  orderNotional = ORDER_NOTIONAL_USD,
  sigmaHourly = UNIVERSE_HOURLY_SIGMA,
): number {
  if (!(notionalPerBar > 0)) return DEFAULT_SLIPPAGE_RATE * 10;
  // Приводим оборот бара к часу: закон записан для одного интервала с σ.
  const hourly = notionalPerBar * barsPerHour;
  const impact = sigmaHourly * Math.sqrt(orderNotional / hourly);
  return Math.max(DEFAULT_SLIPPAGE_RATE, impact);
}

export interface SlippageTable {
  /** Проскальзывание для сделки; годится прямо в `CostAssumptions.slippageFor`. */
  slippageFor: (trade: TradeResult) => number;
  /** Сколько символов покрыто — для отчёта и предохранителя. */
  symbols: number;
}

/**
 * Таблица проскальзываний по вселенной: символ × месяц → ставка.
 *
 * Строится один раз на прогон, потому что читает свечи всей вселенной.
 * Неизвестный символ или месяц ⇒ консервативная ставка, а не плоская.
 */
export function buildSlippageTable(
  tf: SignalTf,
  symbols: readonly string[],
  candlesFor: (symbol: string) => readonly Candle[] | null | undefined,
): SlippageTable {
  const barsPerHour = tf === "1h" ? 1 : tf === "4h" ? 0.25 : 1 / 24;
  const table = new Map<string, Map<string, number>>();
  for (const symbol of symbols) {
    const candles = candlesFor(symbol);
    if (!candles || candles.length === 0) continue;
    const byMonth = monthlyNotional(candles);
    const rates = new Map<string, number>();
    for (const [key, notional] of byMonth) {
      rates.set(key, slippageForNotional(notional, barsPerHour));
    }
    table.set(symbol, rates);
  }
  return {
    symbols: table.size,
    slippageFor: (trade) =>
      table.get(trade.symbol)?.get(monthKey(trade.entryTime)) ?? DEFAULT_SLIPPAGE_RATE * 10,
  };
}
