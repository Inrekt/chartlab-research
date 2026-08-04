import { describe, expect, it } from "vitest";
import type { Candle, StrategyConfig } from "../types";
import { confluence, detectSignal, type LiveSignal } from "./liveSignal";
import { runBacktest } from "../backtest/engine";

const HOUR = 3600;

function bars(spec: Array<[number, number]>, startSec = 1_700_000_000): Candle[] {
  return spec.map(([low, high], i) => ({
    time: startSec + i * HOUR,
    open: (low + high) / 2,
    high,
    low,
    close: (low + high) / 2,
    volume: 100,
  }));
}

/** Ровный фон плюс лёгкий наклон — ATR определён, экстремумов нет. */
const ramp = (n: number): Candle[] =>
  bars(Array.from({ length: n }, (_, i) => [99 + i * 0.01, 101 + i * 0.01]));

const alwaysOn: StrategyConfig = {
  id: "t",
  ownerId: "test",
  name: "t",
  timeframe: "1h",
  direction: "long",
  symbols: [],
  entry: { operator: "AND", conditions: [] },
  exit: {
    stopLoss: { type: "atr", value: 2 },
    takeProfit: { type: "rr", value: 3 },
    maxBarsInTrade: 20,
  },
};

describe("живой сигнал", () => {
  it("уровни совпадают с бэктестом на том же баре", () => {
    // Главный тест файла. Сигнал и бэктест обязаны считать одно и то же —
    // иначе торгуем не то, что проверяли.
    const candles = ramp(120);

    // Бэктест входит по открытию следующего бара; чтобы сравнивать уровни,
    // подаём сигналу историю, обрезанную ровно на сигнальном баре, и берём
    // ту же цену входа — открытие следующего бара.
    const signalIndex = candles.length - 2;
    const trades = runBacktest(candles.slice(0, signalIndex + 2), alwaysOn, "X");
    expect(trades.length).toBeGreaterThan(0);

    const truncated = candles.slice(0, signalIndex + 1);
    const signal = detectSignal(truncated, alwaysOn, "X")!;
    expect(signal).toBeTruthy();

    // Стоп от ATR: расстояние фиксировано, поэтому сходится РАССТОЯНИЕ, а сам
    // уровень поедет вместе с реальной ценой входа.
    const first = trades[0];
    const backtestRisk = Math.abs(first.entryPrice - first.stopPrice);
    expect(signal.riskPerUnit).toBeCloseTo(backtestRisk, 6);
    expect(signal.levelsMoveWithEntry).toBe(true);
  });

  it("отношение цель/риск равно множителю стратегии", () => {
    const signal = detectSignal(ramp(120), alwaysOn, "X")!;
    expect(signal.rewardToRisk).toBeCloseTo(3, 6);
  });

  it("нет условия входа — нет сигнала", () => {
    const never: StrategyConfig = {
      ...alwaysOn,
      entry: {
        operator: "AND",
        conditions: [{ kind: "comparison", left: { kind: "rsi", period: 14 }, op: ">", right: 200 }],
      },
    };
    expect(detectSignal(ramp(120), never, "X")).toBeNull();
  });

  it("на голой истории сигнала нет — риск неизмерим", () => {
    // ATR ещё не посчитан, значит стоп поставить не от чего.
    expect(detectSignal(ramp(3), alwaysOn, "X")).toBeNull();
  });

  it("сигнал берётся с ПОСЛЕДНЕГО бара, а не с предпоследнего", () => {
    const candles = ramp(120);
    const signal = detectSignal(candles, alwaysOn, "X")!;
    expect(signal.signalBarTime).toBe(candles[candles.length - 1].time);
    expect(signal.referencePrice).toBeCloseTo(candles[candles.length - 1].close, 6);
  });
});

describe("схождение сигналов", () => {
  const make = (symbol: string, direction: "long" | "short"): LiveSignal => ({
    symbol,
    direction,
    signalBarTime: 1,
    referencePrice: 100,
    stopPrice: 98,
    targetPrice: 106,
    riskPerUnit: 2,
    rewardToRisk: 3,
    levelsMoveWithEntry: true,
  });

  it("группирует по монете и стороне и сортирует по числу совпадений", () => {
    const groups = confluence([
      make("BTCUSDT", "long"),
      make("ETHUSDT", "short"),
      make("BTCUSDT", "long"),
      make("BTCUSDT", "long"),
    ]);
    expect(groups[0]).toMatchObject({ symbol: "BTCUSDT", direction: "long", count: 3 });
    expect(groups[1]).toMatchObject({ symbol: "ETHUSDT", count: 1 });
  });

  it("противоположные стороны одной монеты не смешиваются", () => {
    const groups = confluence([make("BTCUSDT", "long"), make("BTCUSDT", "short")]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.count === 1)).toBe(true);
  });
});
