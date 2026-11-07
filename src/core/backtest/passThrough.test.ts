import { describe, expect, it } from "vitest";
import type { Candle, StrategyConfig } from "../types";
import { PASS_THROUGH_RATE, simulateExits } from "./engine";
import { atr as atrIndicator } from "../indicators";

/*
 * P4/P7 движка: тейк только на сквозном проходе, трейлинг-стоп, причина выхода
 * и исполнения по ногам. Пре-регистрация: researcher/docs/search-v4-preregistration.md.
 */

const HOUR = 3600;
type Spec = Array<[number, number, number, number]>;

function bars(spec: Spec): Candle[] {
  return spec.map(([open, high, low, close], i) => ({
    time: 1_700_000_000 + i * HOUR,
    open,
    high,
    low,
    close,
    volume: 100,
  }));
}
const flat = (n: number): Spec => Array.from({ length: n }, () => [100, 101, 99, 100] as [number, number, number, number]);

const cfg = (direction: "long" | "short", over: Partial<StrategyConfig["exit"]> = {}): StrategyConfig => ({
  id: "t",
  ownerId: "test",
  name: "t",
  timeframe: "1h",
  direction,
  symbols: [],
  entry: { operator: "AND", conditions: [] },
  exit: {
    stopLoss: { type: "percent", value: 5 },
    takeProfit: { type: "rr", value: 3 },
    maxBarsInTrade: 6,
    ...over,
  },
});

const SIGNAL = 5;
const run = (spec: Spec, config: StrategyConfig, signal = SIGNAL) =>
  simulateExits(bars(spec), config, "X", [signal])[0];

describe("тейк: сквозной проход", () => {
  it("константа — 1 б.п.", () => {
    expect(PASS_THROUGH_RATE).toBe(0.0001);
  });

  it("лонг: касание цели (115) без прохода НЕ исполняет — сделка идёт до времени", () => {
    const spec = flat(14);
    spec[7] = [100, 115, 99, 100];
    const t = run(spec, cfg("long"))!;
    expect(t.exitReason).toBe("time");
    expect(t.rMultiple).toBeCloseTo(0, 6);
  });

  it("лонг: проход на 1 б.п. исполняет по цене тейка, мейкер", () => {
    const spec = flat(14);
    spec[7] = [100, 115.02, 99, 100];
    const t = run(spec, cfg("long"))!;
    expect(t.exitReason).toBe("target");
    expect(t.exitPrice).toBe(115);
    expect(t.rMultiple).toBeCloseTo(3, 9);
    expect(t.fills!.at(-1)!.liquidity).toBe("maker");
    expect(t.fills![0].liquidity).toBe("taker");
  });

  it("шорт зеркален: касание 85 не исполняет, проход ниже — исполняет", () => {
    const touch = flat(14);
    touch[7] = [100, 101, 85, 100];
    expect(run(touch, cfg("short"))!.exitReason).toBe("time");
    const pass = flat(14);
    pass[7] = [100, 101, 84.98, 100];
    const t = run(pass, cfg("short"))!;
    expect(t.exitReason).toBe("target");
    expect(t.rMultiple).toBeCloseTo(3, 9);
  });

  it("на баре стопа и прохода цели стоп по-прежнему первый", () => {
    const spec = flat(14);
    spec[7] = [100, 116, 94, 100];
    const t = run(spec, cfg("long"))!;
    expect(t.exitReason).toBe("stop");
    expect(t.fills!.at(-1)!.liquidity).toBe("taker");
  });

  it("частичный тейк: касание не фиксирует, проход фиксирует мейкером", () => {
    const so = { atR: 0.5, fraction: 0.5, toBreakeven: true } as const;
    const touch = flat(14);
    touch[7] = [100, 102.5, 99, 100];
    expect(run(touch, cfg("long", { scaleOut: so }))!.fills!.filter((f) => f.side === "exit")).toHaveLength(1);
    const pass = flat(14);
    pass[7] = [100, 102.6, 99, 100];
    const exits = run(pass, cfg("long", { scaleOut: so }))!.fills!.filter((f) => f.side === "exit");
    expect(exits).toHaveLength(2);
    expect(exits[0]).toMatchObject({ liquidity: "maker", price: 102.5, qty: 0.5 });
  });
});

describe("причина выхода и исполнения", () => {
  it("стоп / время несут exitReason и тейкерский финальный выход", () => {
    const stop = flat(14);
    stop[7] = [100, 101, 94, 95];
    const s = run(stop, cfg("long"))!;
    expect(s.exitReason).toBe("stop");
    expect(s.fills).toHaveLength(2);
    expect(s.fills![1]).toMatchObject({ side: "exit", liquidity: "taker", qty: 1 });
    expect(run(flat(14), cfg("long"))!.exitReason).toBe("time");
  });
});

describe("трейлинг-стоп", () => {
  // 30 одинаковых баров ⇒ ATR(14) = 2; стоп 2 ATR = 4 ⇒ вход 100, стартовый стоп 96.
  const trailCfg = cfg("long", {
    stopLoss: { type: "atr", value: 2 },
    takeProfit: { type: "none", value: 0 },
    trailingStop: { atr: 1 },
    maxBarsInTrade: 50,
  });
  const TS = 20;

  it("тянется по закрытию в сторону сделки, действует со следующего бара, назад не отпускается", () => {
    const spec = flat(30);
    spec[21] = [100, 106, 100, 105]; // новое лучшее закрытие; low 100 ниже будущего стопа, но он ещё не действует
    spec[22] = [105, 105.5, 104, 104.5]; // закрытие хуже лучшего — стоп не отпускается
    spec[23] = [104, 104, 100, 101]; // пробивает подтянутый стоп
    const candles = bars(spec);
    const t = simulateExits(candles, trailCfg, "X", [TS])[0];
    const atr22 = atrIndicator(candles).find((p) => p.time === candles[22].time)!.value;
    // Лучшее закрытие остаётся 105 (бар 22 закрылся хуже), но ATR бара 22 меньше — стоп тянется ещё выше.
    const expectedStop = 105 - 1 * atr22;
    expect(t.exitReason).toBe("stop");
    expect(t.barsHeld).toBe(3); // бары 21, 22, 23: на 21-м выхода нет
    expect(t.exitPrice).toBeCloseTo(expectedStop, 9);
    expect(t.exitPrice).toBeGreaterThan(96);
    expect(t.fills!.at(-1)!.liquidity).toBe("taker");
  });

  it("гэп через подтянутый стоп исполняется по открытию", () => {
    const spec = flat(30);
    spec[21] = [100, 106, 100, 105];
    spec[22] = [95, 96, 94, 95];
    const t = simulateExits(bars(spec), trailCfg, "X", [TS])[0];
    expect(t.exitPrice).toBe(95);
  });

  it("цели нет: «none» не открывает и не закрывает по цели, сделка доживает до времени", () => {
    const spec = flat(30);
    spec[22] = [100, 500, 99, 100]; // любой максимум — цели всё равно нет
    const t = simulateExits(bars(spec), { ...trailCfg, exit: { ...trailCfg.exit, trailingStop: undefined, maxBarsInTrade: 5 } }, "X", [TS])[0];
    expect(t.exitReason).toBe("time");
  });

  it("шорт зеркален", () => {
    const spec = flat(30);
    spec[21] = [100, 100, 94, 95];
    spec[22] = [95, 96, 94.5, 95.5];
    spec[23] = [96, 100, 95.5, 99];
    const candles = bars(spec);
    const t = simulateExits(candles, { ...trailCfg, direction: "short" }, "X", [TS])[0];
    const atr22 = atrIndicator(candles).find((p) => p.time === candles[22].time)!.value;
    expect(t.exitReason).toBe("stop");
    expect(t.exitPrice).toBeCloseTo(95 + atr22, 9);
  });
});
