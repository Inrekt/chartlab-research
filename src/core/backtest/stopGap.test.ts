import { describe, expect, it } from "vitest";
import type { Candle, StrategyConfig } from "../types";
import { simulateExits } from "./engine";

const HOUR = 3600;
const SIGNAL = 5;

/**
 * Бары задаются полностью: гэп — это ОТКРЫТИЕ за стопом, а помощники, которые
 * выводят open из (low+high)/2, такой случай выразить не могут в принципе.
 */
function bars(spec: Array<[number, number, number, number]>, startSec = 1_700_000_000): Candle[] {
  return spec.map(([open, high, low, close], i) => ({
    time: startSec + i * HOUR,
    open,
    high,
    low,
    close,
    volume: 100,
  }));
}

const flat = (n: number): Array<[number, number, number, number]> =>
  Array.from({ length: n }, () => [100, 101, 99, 100] as [number, number, number, number]);

/** Стоп 5% и цель 2R: вход по 100 → стоп 95, цель 110, риск = 5. */
const cfg = (direction: "long" | "short"): StrategyConfig => ({
  id: "t",
  ownerId: "test",
  name: "t",
  timeframe: "1h",
  direction,
  symbols: [],
  entry: { operator: "AND", conditions: [] },
  exit: {
    stopLoss: { type: "percent", value: 5 },
    takeProfit: { type: "rr", value: 2 },
    maxBarsInTrade: 50,
  },
});

const run = (spec: Array<[number, number, number, number]>, direction: "long" | "short") =>
  simulateExits(bars(spec), cfg(direction), "X", [SIGNAL])[0];

describe("гэп через стоп исполняется по открытию, а не по цене стопа", () => {
  it("лонг: бар, открывшийся НИЖЕ стопа, даёт убыток больше 1R", () => {
    const spec = flat(12);
    // Вход по открытию бара 6 = 100, стоп 95.
    spec[7] = [90, 91, 88, 89]; // открылся сразу на 90 — цены 95 в этом баре не было
    const trade = run(spec, "long");

    expect(trade).toBeDefined();
    expect(trade.exitPrice).toBeCloseTo(90, 6);
    // (90 − 100) / 5 = −2R, а не −1R.
    expect(trade.rMultiple).toBeCloseTo(-2, 6);
  });

  it("шорт: бар, открывшийся ВЫШЕ стопа, даёт убыток больше 1R", () => {
    const spec = flat(12);
    // Шорт: вход 100, стоп 105, цель 90.
    spec[7] = [110, 112, 109, 111];
    const trade = run(spec, "short");

    expect(trade).toBeDefined();
    expect(trade.exitPrice).toBeCloseTo(110, 6);
    expect(trade.rMultiple).toBeCloseTo(-2, 6);
  });

  it("без гэпа исполнение по стопу не меняется — ровно 1R", () => {
    const spec = flat(12);
    // Бар открылся ВЫШЕ стопа (99) и только потом провалился к 94: цена 95
    // в этом баре реально была, выйти по ней можно.
    spec[7] = [99, 99.5, 94, 96];
    const trade = run(spec, "long");

    expect(trade).toBeDefined();
    expect(trade.exitPrice).toBeCloseTo(95, 6);
    expect(trade.rMultiple).toBeCloseTo(-1, 6);
  });

  it("гэп В НАШУ ПОЛЬЗУ через цель не улучшает выход — цель остаётся целью", () => {
    const spec = flat(12);
    // Открылись сразу на 115 при цели 110. Симметричную поправку здесь делать
    // НЕЛЬЗЯ: прибыль выросла бы из предположения о порядке тиков.
    spec[7] = [115, 116, 114, 115];
    const trade = run(spec, "long");

    expect(trade).toBeDefined();
    expect(trade.exitPrice).toBeCloseTo(110, 6);
    expect(trade.rMultiple).toBeCloseTo(2, 6);
  });
});
