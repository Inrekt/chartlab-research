import { describe, expect, it } from "vitest";
import type { Candle, StrategyConfig } from "../types";
import { simulateExits } from "./engine";
import { liquidityFeatures } from "../liquidations/clusterSeries";
import { EvaluationContext } from "../strategy/evaluator";

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

/** По-настоящему ровный фон: одинаковые бары не образуют ни одного пивота. */
const constantBackground = (n: number): Array<[number, number]> =>
  Array.from({ length: n }, () => [99, 101] as [number, number]);

const background = (n: number): Array<[number, number]> =>
  Array.from({ length: n }, (_, i) => {
    const d = Math.sin(i / 9) * 0.3;
    return [100 - 1 + d, 100 + 1 + d] as [number, number];
  });

/** Фон + один максимум и один минимум — известные скопления с обеих сторон. */
function withLevels(): Candle[] {
  const spec = background(260);
  spec[40] = [99, 106]; // уровень выше рынка
  spec[90] = [94, 101]; // уровень ниже рынка
  return bars(spec);
}

const cfg = (over: Partial<StrategyConfig>): StrategyConfig => ({
  id: "t",
  ownerId: "test",
  name: "t",
  timeframe: "1h",
  direction: "short",
  symbols: [],
  entry: { operator: "AND", conditions: [] },
  exit: {
    stopLoss: { type: "liquidity", value: 0.5 },
    takeProfit: { type: "liquidity", value: 0.2 },
    maxBarsInTrade: 50,
  },
  ...over,
});

describe("выходы от уровней ликвидности", () => {
  const candles = withLevels();
  const f = liquidityFeatures(candles);
  const signal = 150;

  it("стоп стоит ЗА самым дальним скоплением против сделки, цель — не доходя до ближайшего", () => {
    const atr = f.atrAt[signal];
    expect(Number.isFinite(atr)).toBe(true);
    expect(Number.isFinite(f.farAbove[signal])).toBe(true);
    expect(Number.isFinite(f.nearBelow[signal])).toBe(true);

    const [trade] = simulateExits(candles, cfg({}), "X", [signal]);
    expect(trade).toBeDefined();

    // шорт: стоп выше самого дальнего скопления сверху, с запасом 0.5 ATR
    expect(trade.stopPrice).toBeCloseTo(f.farAbove[signal] + 0.5 * atr, 6);
    expect(trade.stopPrice).toBeGreaterThan(f.farAbove[signal]);
    // цель НЕ доходя до ближайшего скопления снизу, отступ 0.2 ATR
    expect(trade.targetPrice).toBeCloseTo(f.nearBelow[signal] + 0.2 * atr, 6);
    expect(trade.targetPrice).toBeGreaterThan(f.nearBelow[signal]);
    // и цель по правильную сторону от входа
    expect(trade.targetPrice).toBeLessThan(trade.entryPrice);
  });

  it("нет магнита впереди — сделки нет вообще", () => {
    // Ровный фон без экстремумов: скоплений не появляется, значит у стратегии
    // нет цели, а цель здесь и есть смысл входа.
    const flat = bars(constantBackground(260));
    const flatF = liquidityFeatures(flat);
    expect(Number.isNaN(flatF.nearBelow[signal]) || Number.isNaN(flatF.nearAbove[signal])).toBe(true);
    const trades = simulateExits(flat, cfg({}), "X", [signal]);
    expect(trades.length).toBe(0);
  });

  it("лонг зеркален: стоп под нижней ликвидностью, цель под верхним уровнем", () => {
    const atr = f.atrAt[signal];
    const [trade] = simulateExits(candles, cfg({ direction: "long" }), "X", [signal]);
    expect(trade).toBeDefined();
    expect(trade.stopPrice).toBeCloseTo(f.farBelow[signal] - 0.5 * atr, 6);
    expect(trade.targetPrice).toBeCloseTo(f.nearAbove[signal] - 0.2 * atr, 6);
    expect(trade.targetPrice).toBeGreaterThan(trade.entryPrice);
  });

  it("смешанный режим: ATR-стоп с уровневой целью работает", () => {
    const atr = f.atrAt[signal];
    const [trade] = simulateExits(
      candles,
      cfg({ exit: { stopLoss: { type: "atr", value: 2 }, takeProfit: { type: "liquidity", value: 0.2 }, maxBarsInTrade: 50 } }),
      "X",
      [signal],
    );
    expect(trade).toBeDefined();
    // стоп — обычный ATR-стоп, а не уровневый
    expect(Math.abs(trade.stopPrice - trade.entryPrice)).toBeCloseTo(2 * atr, 6);
    expect(trade.targetPrice).toBeCloseTo(f.nearBelow[signal] + 0.2 * atr, 6);
  });
});

describe("атом растянутости", () => {
  it("срабатывает только когда цена ушла от средней на заданное число ATR", () => {
    const spec = background(200);
    // резкий вынос вверх на последних барах — растянутость от SMA
    for (let i = 180; i < 200; i++) spec[i] = [104 + (i - 180) * 0.6, 106 + (i - 180) * 0.6];
    const candles = bars(spec);
    const ctx = new EvaluationContext(candles);

    const far = { kind: "stretch", period: 50, direction: "above", minAtr: 1 } as const;
    const absurd = { kind: "stretch", period: 50, direction: "above", minAtr: 50 } as const;
    const wrongWay = { kind: "stretch", period: 50, direction: "below", minAtr: 1 } as const;

    expect(ctx.evaluateAtom(far, 198)).toBe(true);
    expect(ctx.evaluateAtom(absurd, 198)).toBe(false); // порог недостижим
    expect(ctx.evaluateAtom(wrongWay, 198)).toBe(false); // растянут вверх, а не вниз
    expect(ctx.evaluateAtom(far, 100)).toBe(false); // на спокойном участке — нет
  });
});

describe("атом скопления ликвидности", () => {
  const candles = withLevels();
  const f = liquidityFeatures(candles);
  const at = 150;

  it("видит скопление в заданном коридоре расстояний и с нужным весом", () => {
    const ctx = new EvaluationContext(candles);
    const atr = f.atrAt[at];
    const distBelow = (candles[at].close - f.nearBelow[at]) / atr;

    const inRange = {
      kind: "liquidity",
      side: "below",
      minAtr: Math.max(0, distBelow - 0.5),
      maxAtr: distBelow + 0.5,
      minWeight: 1,
    } as const;
    expect(ctx.evaluateAtom(inRange, at)).toBe(true);

    // тот же уровень, но требуем, чтобы он был гораздо дальше — не подходит
    expect(ctx.evaluateAtom({ ...inRange, minAtr: distBelow + 5, maxAtr: distBelow + 10 }, at)).toBe(false);
    // и слишком строгий вес отсекает
    expect(ctx.evaluateAtom({ ...inRange, minWeight: 999 }, at)).toBe(false);
  });

  it("на ровном фоне без уровней не срабатывает", () => {
    const flat = bars(constantBackground(260));
    const ctx = new EvaluationContext(flat);
    expect(
      ctx.evaluateAtom({ kind: "liquidity", side: "below", minAtr: 0, maxAtr: 100, minWeight: 1 }, at),
    ).toBe(false);
  });
});
