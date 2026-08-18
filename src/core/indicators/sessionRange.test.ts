import { describe, expect, test } from "vitest";
import { sessionRange } from "./sessionRange";
import type { Candle } from "../types";

const DAY = 86400;
/** Бар с открытием в час `hour` суток `day` (UTC). */
const bar = (day: number, hour: number, high: number, low: number): Candle => ({
  time: day * DAY + hour * 3600,
  open: low,
  high,
  low,
  close: high,
  volume: 1,
});

describe("sessionRange", () => {
  test("уровень — экстремумы тихой сессии, видимые в громком окне", () => {
    const candles = [
      bar(0, 1, 110, 90), // Азия
      bar(0, 3, 120, 95), // Азия — верх дня
      bar(0, 8, 130, 100), // Лондон: должен видеть 120/90
    ];
    const out = sessionRange(candles, 0, 7);
    const london = out.find((p) => p.time === candles[2].time);
    expect(london).toMatchObject({ upper: 120, lower: 90, width: 30, bars: 2 });
  });

  test("текущий бар в свой уровень НЕ входит — иначе пробой невозможен", () => {
    // Второй азиатский бар обязан видеть только первый: если бы он входил в
    // свой же уровень, условие «close выше максимума сессии» не срабатывало
    // бы никогда (close ≤ high ≤ upper).
    const candles = [bar(0, 1, 110, 90), bar(0, 2, 200, 80)];
    const out = sessionRange(candles, 0, 7);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ time: candles[1].time, upper: 110, lower: 90, bars: 1 });
  });

  test("в новых сутках UTC уровень обнуляется, вчерашний не протекает", () => {
    const candles = [
      bar(0, 1, 500, 400), // вчерашняя Азия — огромный диапазон
      bar(1, 1, 110, 90), // сегодняшняя Азия
      bar(1, 8, 130, 100), // сегодняшний Лондон
    ];
    const out = sessionRange(candles, 0, 7);
    const today = out.find((p) => p.time === candles[2].time);
    expect(today).toMatchObject({ upper: 110, lower: 90 });
    // Первый бар новых суток точки не даёт: сессия ещё пуста.
    expect(out.some((p) => p.time === candles[1].time)).toBe(false);
  });

  test("до первого бара сессии точки нет — вчерашний уровень не подставляется", () => {
    const candles = [bar(0, 9, 130, 100), bar(0, 10, 140, 110)];
    expect(sessionRange(candles, 0, 7)).toEqual([]);
  });

  test("бары вне окна расширяют диапазон НЕ считаются, но точки получают", () => {
    const candles = [
      bar(0, 1, 110, 90), // Азия
      bar(0, 9, 300, 10), // Лондон: экстремальный бар, в уровень не входит
      bar(0, 11, 120, 100), // Лондон: уровень всё ещё азиатский
    ];
    const out = sessionRange(candles, 0, 7);
    expect(out).toHaveLength(2);
    expect(out.every((p) => p.upper === 110 && p.lower === 90)).toBe(true);
  });

  test("окно через полночь и мусорные границы — ошибка, а не тихий результат", () => {
    expect(() => sessionRange([], 21, 2)).toThrow(/окно сессии/);
    expect(() => sessionRange([], 0, 25)).toThrow(/окно сессии/);
    expect(() => sessionRange([], 0.5, 7)).toThrow(/целыми часами/);
  });
});
