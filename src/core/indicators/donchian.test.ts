import { describe, expect, it } from "vitest";
import { donchian } from "./donchian";
import { EvaluationContext } from "../strategy/evaluator";
import type { Candle } from "../types";

/*
 * Канал Дончиана и его СДВИГ — фундамент, на котором стоит вся семья свипа:
 * три версии правила владельца, 432 кандидата, три вердикта. До этого файла
 * он не был покрыт ни одним тестом.
 *
 * Цена ошибки здесь максимальная и незаметная. Ряд Дончиана КОРОЧЕ массива
 * свечей (начинается с бара period−1), поэтому выравнивание и сдвиг легко
 * разъезжаются на period−1 баров. При окне 504 это сдвиг на полгода — и
 * правило «граница не обновлялась» проверяло бы совсем другой отрезок
 * истории, а вердикт выглядел бы обычным отрицательным результатом.
 */

const HOUR = 3600;
const T0 = 1_700_000_000;

/** Свеча с явно заданными хай/лоу — суть теста именно в них. */
const bar = (i: number, high: number, low: number): Candle => ({
  time: T0 + i * HOUR,
  open: (high + low) / 2,
  high,
  low,
  close: (high + low) / 2,
  volume: 1,
});

describe("канал Дончиана", () => {
  it("окно включает ТЕКУЩИЙ бар и начинается с period−1", () => {
    // Если бы окно исключало текущий бар, пробой был бы возможен по
    // построению на каждом новом максимуме — и «пробой» перестал бы что-либо
    // означать.
    const candles = [bar(0, 105, 95), bar(1, 110, 90), bar(2, 103, 97)];
    const out = donchian(candles, 2);
    expect(out).toHaveLength(2);
    expect(out[0].time).toBe(candles[1].time);
    expect(out[0].upper).toBe(110); // бары 0..1
    expect(out[0].lower).toBe(90);
    expect(out[1].upper).toBe(110); // бары 1..2
    expect(out[1].lower).toBe(90);
  });
});

describe("сдвиг канала в вычислителе условий", () => {
  /**
   * Ряд, у которого ответ известен наперёд:
   * бары 0..9   — максимумы 100…109 (растут),
   * бары 10..19 — максимумы 105…96 (падают, ни один не превышает 109).
   */
  const candles: Candle[] = [
    ...Array.from({ length: 10 }, (_, i) => bar(i, 100 + i, 50)),
    ...Array.from({ length: 10 }, (_, i) => bar(10 + i, 105 - i, 50)),
    bar(20, 90, 50),
  ];

  it("shift=k берёт значение с бара i−k, а не со сдвинутой позиции ряда", () => {
    // Ряд Дончиана короче свечей; если сдвиг применить к его собственному
    // индексу, промах составит period−1 баров и будет тем больше, чем длиннее
    // окно — то есть тем незаметнее на коротких проверках.
    const ctx = new EvaluationContext(candles, "X");
    const at19 = ctx.valueAt({ kind: "donchian", period: 10, line: "upper" }, 19);
    const at20shift1 = ctx.valueAt(
      { kind: "donchian", period: 10, line: "upper", shift: 1 },
      20,
    );
    expect(at19).toBe(105); // максимум баров 10..19
    expect(at20shift1).toBe(at19);
  });

  it("именно это выражает «граница не обновлялась» в правиле свипа", () => {
    // Правило сравнивает канал последних N баров с каналом ПРЕДЫДУЩИХ N.
    // Здесь: последние десять (макс 105) против предыдущих десяти (макс 109).
    // 105 ≤ 109 ⇒ верх не обновлён, боковик по этой стороне держится.
    const ctx = new EvaluationContext(candles, "X");
    const last = ctx.valueAt({ kind: "donchian", period: 10, line: "upper", shift: 1 }, 20);
    const prev = ctx.valueAt({ kind: "donchian", period: 10, line: "upper", shift: 11 }, 20);
    expect(last).toBe(105);
    expect(prev).toBe(109); // максимум баров 0..9
    expect(last! <= prev!).toBe(true);
  });

  it("до накопления истории — null, а НЕ ноль и не последнее известное", () => {
    // Ноль здесь означал бы «канал на нуле», и любое сравнение «цена выше
    // канала» стало бы истинным на прогреве. Тот же класс тихих ошибок, что
    // обнулённые издержки: подстановка неотличима от настоящего значения.
    const ctx = new EvaluationContext(candles, "X");
    expect(ctx.valueAt({ kind: "donchian", period: 10, line: "upper", shift: 11 }, 5)).toBeNull();
    expect(ctx.valueAt({ kind: "donchian", period: 10, line: "upper" }, 3)).toBeNull();
  });

  it("НЕ ЗАГЛЯДЫВАЕТ ВПЕРЁД: значение на баре i не зависит от баров после i", () => {
    // Самый ценный тест файла. Считаем на префиксе [0..i] и на полном ряду —
    // значение на баре i обязано совпасть. Заглядывание вперёд не роняет
    // тесты и не пишет в лог: оно просто рисует край, которого нет.
    const full = new EvaluationContext(candles, "X");
    for (const i of [12, 15, 19]) {
      const prefix = new EvaluationContext(candles.slice(0, i + 1), "X");
      const ref = { kind: "donchian" as const, period: 10, line: "upper" as const };
      expect(prefix.valueAt(ref, i), `бар ${i}`).toBe(full.valueAt(ref, i));
    }
  });
});
