import type { Candle } from "../types";

export interface SessionRangePoint {
  time: number;
  /** Максимум тихой сессии текущих суток UTC, ДО текущего бара. */
  upper: number;
  /** Минимум тихой сессии текущих суток UTC, ДО текущего бара. */
  lower: number;
  middle: number;
  /** Ширина диапазона (upper − lower) в абсолютных единицах цены. */
  width: number;
  /**
   * Сколько баров сессии уже накоплено. Нужен для честной нормировки ширины:
   * диапазон 7-часовой сессии и диапазон одного бара несравнимы напрямую —
   * у случайного блуждания ширина растёт как √n, и без этого множителя порог
   * «сжатия» означал бы разное на разных сессиях и таймфреймах.
   */
  bars: number;
}

const HOUR = 3600;
const DAY = 86400;

/**
 * Диапазон торговой сессии — уровень, у которого есть ПРИЧИНА.
 *
 * Пре-регистрация: docs/family-session-sweep-preregistration.md.
 *
 * Отличие от Дончиана принципиальное, и ради него всё и написано: канал
 * Дончиана берёт экстремум последних N баров, то есть уровень определяется
 * самой ценой и сдвигается вместе с ней. Сессионный уровень задан ЧАСАМИ
 * работы рынков: «максимум азиатской сессии сегодня» — это место, где по
 * общему правилу стоят чужие стопы, и оно не подгоняется под данные.
 *
 * ПРИЧИННОСТЬ (главное здесь). Значение на баре i считается по барам той же
 * даты UTC, попадающим в окно `[fromHourUtc, toHourUtc)` и строго
 * ПРЕДШЕСТВУЮЩИМ бару i. Текущий бар в свой же уровень не входит — иначе
 * условие «цена вышла за максимум сессии» было бы невыполнимо по построению
 * (close ≤ high ≤ upper), ровно как у пробоя Дончиана без сдвига.
 *
 * Пока сессия текущих суток не дала ни одного закрытого бара, точки нет
 * вообще: пустое значение честнее, чем вчерашний уровень, выданный за
 * сегодняшний.
 *
 * @param fromHourUtc начало окна, час UTC (включительно)
 * @param toHourUtc   конец окна, час UTC (НЕ включительно), строго больше начала
 */
export function sessionRange(
  candles: Candle[],
  fromHourUtc: number,
  toHourUtc: number,
): SessionRangePoint[] {
  if (!Number.isInteger(fromHourUtc) || !Number.isInteger(toHourUtc)) {
    throw new Error("границы сессии задаются целыми часами UTC");
  }
  if (fromHourUtc < 0 || toHourUtc > 24 || fromHourUtc >= toHourUtc) {
    // Окно через полночь не поддерживается сознательно: у него две даты, и
    // «сессия текущих суток» перестаёт быть определённой без отдельного
    // правила. Ни одна сессия из пре-регистрации через полночь не идёт.
    throw new Error(`некорректное окно сессии: [${fromHourUtc}, ${toHourUtc})`);
  }

  const out: SessionRangePoint[] = [];
  let day = -1;
  let upper = -Infinity;
  let lower = Infinity;
  let bars = 0;

  for (const candle of candles) {
    const currentDay = Math.floor(candle.time / DAY);
    if (currentDay !== day) {
      // Новые сутки UTC — накопленный диапазон обнуляется. Без этого уровень
      // тянулся бы через дни и перестал быть сессионным.
      day = currentDay;
      upper = -Infinity;
      lower = Infinity;
      bars = 0;
    }

    // Сначала ОТДАЁМ значение, накопленное предыдущими барами суток, и только
    // потом подмешиваем текущий бар: порядок и есть причинность.
    if (upper > -Infinity) {
      out.push({
        time: candle.time,
        upper,
        lower,
        middle: (upper + lower) / 2,
        width: upper - lower,
        bars,
      });
    }

    const hour = Math.floor((candle.time % DAY) / HOUR);
    if (hour >= fromHourUtc && hour < toHourUtc) {
      if (candle.high > upper) upper = candle.high;
      if (candle.low < lower) lower = candle.low;
      bars += 1;
    }
  }

  return out;
}
