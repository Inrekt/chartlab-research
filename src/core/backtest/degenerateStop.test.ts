import { describe, expect, it } from "vitest";
import { runBacktest } from "./engine";
import type { Candle, StrategyConfig } from "../types";

/*
 * Уровневый стоп без уровня — сделки нет.
 *
 * Раньше в этом случае подставлялась цена входа, и стоп получался шириной
 * «запаса»: 0.25–1 ATR против обычного пула 1.5–3, то есть в три-двенадцать
 * раз у́же. Замер на боевом корпусе: 11.8% сделок семейства шли с таким стопом,
 * их МЕДИАННЫЙ результат был ровно −1R, а вклад в матожидание −0.045R при всём
 * измеренном крае +0.0245R — дефект был больше предмета исследования.
 *
 * Ошибка была смысловая: величина «запас ЗА уровень» использовалась как
 * «ширина стопа». Типы и единицы совпадают, смысл — нет. Такое не ловится
 * ни типами, ни падениями; ловится только тестом на СМЫСЛ.
 */

const HOUR = 3600;

function bars(spec: Array<[number, number, number, number]>): Candle[] {
  return spec.map(([open, high, low, close], i) => ({
    time: 1_700_000_000 + i * HOUR,
    open,
    high,
    low,
    close,
    volume: 100,
  }));
}

/** Вход по «цена выше предыдущего максимума» — простой и всегда исполнимый. */
const cfg = (): StrategyConfig => ({
  id: "t",
  ownerId: "test",
  name: "t",
  timeframe: "1h",
  direction: "long",
  symbols: [],
  entry: {
    operator: "AND",
    conditions: [
      {
        kind: "comparison",
        left: { kind: "close" },
        op: ">",
        right: { kind: "donchian", period: 10, line: "upper", shift: 1 },
      },
    ],
  },
  exit: {
    // Именно уровневый стоп — «за всей ликвидностью против сделки».
    stopLoss: { type: "liquidity", value: 0.5 },
    takeProfit: { type: "rr", value: 2 },
    maxBarsInTrade: 20,
  },
});

describe("уровневый стоп без уровня", () => {
  it("строго растущий ряд не даёт НИ ОДНОЙ сделки: пивот-лоу нет, стопу не за что зацепиться", () => {
    // В монотонно растущем ряду нет подтверждённых свинг-минимумов, значит
    // скоплений ПРОТИВ лонга не существует. Правило «стоп за всей
    // ликвидностью» в такой ситуации не определено — и сделки быть не должно.
    const rising = Array.from(
      { length: 120 },
      (_, i) => [100 + i, 100.6 + i, 99.8 + i, 100.5 + i] as [number, number, number, number],
    );
    expect(runBacktest(bars(rising), cfg(), "X")).toHaveLength(0);
  });

  it("ряд с настоящим минимумом внизу сделки даёт — правка не выключила семейство целиком", () => {
    // Контроль: если бы правка резала всё подряд, первый тест проходил бы
    // «бесплатно», и мы бы этого не заметили.
    const spec: Array<[number, number, number, number]> = [];
    // Пила: создаёт подтверждённые пивот-минимумы ниже будущего входа.
    for (let i = 0; i < 80; i++) {
      const base = 100 + (i % 8 < 4 ? i % 8 : 8 - (i % 8));
      spec.push([base, base + 0.8, base - 0.8, base + 0.4]);
    }
    // Затем импульс вверх — пробой канала и вход.
    for (let i = 0; i < 40; i++) {
      const p = 110 + i * 0.5;
      spec.push([p, p + 0.6, p - 0.2, p + 0.5]);
    }
    expect(runBacktest(bars(spec), cfg(), "X").length).toBeGreaterThan(0);
  });
});
