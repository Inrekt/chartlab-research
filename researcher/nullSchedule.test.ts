import { describe, expect, test } from "vitest";
import type { Candle, TradeResult } from "../src/core/types/index.ts";
import {
  dailyNetSeries,
  MIN_CLUSTER_DAYS,
  POOLED_T_MIN,
  sampleScheduledEntries,
  scheduleBucket,
  scheduledNullGate,
  scheduleProfile,
} from "./nullSchedule.ts";

/** Час = 3600; свечи по часу с плоской ценой — сделки закрываются тайм-аутом в 0R. */
const HOUR = 3600;
const flatCandles = (n: number, startSec = 1_700_000_000 - (1_700_000_000 % HOUR)): Candle[] =>
  Array.from({ length: n }, (_, i) => ({
    time: startSec + i * HOUR,
    open: 100, high: 100, low: 100, close: 100, volume: 1,
  }));

const trade = (entryTime: number, exitTime: number, r: number): TradeResult => ({
  symbol: "X", direction: "long", entryTime, entryPrice: 100, exitTime, exitPrice: 100,
  stopPrice: 99, targetPrice: 102, rMultiple: r, riskBudget: 1, won: r > 0, barsHeld: 1,
});

describe("scheduleProfile / sampleScheduledEntries", () => {
  test("профиль считает входы по бакетам день-недели × час", () => {
    const monday10 = Date.UTC(2026, 6, 27, 10) / 1000; // понедельник
    const p = scheduleProfile([monday10, monday10, monday10 + 7 * 24 * HOUR]);
    expect(p.get(scheduleBucket(monday10))).toBe(3); // та же клетка недели
    expect(p.size).toBe(1);
  });

  test("выбранные бары попадают в бакеты профиля (fill-бар i+1)", () => {
    const candles = flatCandles(24 * 7 * 8); // 8 недель почасовых
    // кандидат входит только в часы с бакетом среды-14:00
    const wednesday14 = Date.UTC(2026, 6, 29, 14) / 1000;
    const profile = scheduleProfile([wednesday14]);
    let s = 42;
    const rand = () => ((s = (s * 16807) % 2147483647) % 1000) / 1000;
    const picked = sampleScheduledEntries(candles, 5, profile, rand);
    expect(picked.length).toBeGreaterThan(0);
    for (const i of picked) {
      expect(scheduleBucket(candles[i + 1].time)).toBe(scheduleBucket(wednesday14));
    }
  });

  test("короткая история → пусто, без исключений", () => {
    expect(sampleScheduledEntries(flatCandles(50), 5, new Map([[0, 1]]), () => 0.5)).toEqual([]);
  });
});

describe("dailyNetSeries", () => {
  test("суммирует net R по UTC-суткам выхода", () => {
    const d0 = 1_700_006_400; // сутки A
    const series = dailyNetSeries([trade(d0, d0, 1), trade(d0, d0 + HOUR, 0.5), trade(d0, d0 + 86_400, -0.25)]);
    expect(series.size).toBe(2);
    const days = [...series.keys()].sort();
    // издержки вычитаются из каждой сделки — суммы строго меньше валовых
    expect(series.get(days[0])!).toBeLessThan(1.5);
    expect(series.get(days[1])!).toBeLessThan(0);
  });
});

describe("scheduledNullGate", () => {
  test("мало дней → отказ с причиной, не проход", () => {
    const trades = new Map([["X", [trade(1_700_000_000, 1_700_000_000, 2)]]]);
    const res = scheduledNullGate(
      trades,
      { id: "t", ownerId: "test", name: "t", direction: "long", timeframe: "1h", symbols: [],
        entry: { operator: "AND", conditions: [] },
        exit: { stopLoss: { type: "percent", value: 1 }, takeProfit: { type: "rr", value: 2 }, maxBarsInTrade: 5 } },
      () => flatCandles(300),
      7,
    );
    expect(res.pass).toBe(false);
    expect(res.days).toBeLessThan(MIN_CLUSTER_DAYS);
    expect(res.reason).toContain("дней");
  });

  test("кандидат без края над собственным расписанием не проходит; сдвинутый на +R — проходит", () => {
    // плоские свечи: ЛЮБЫЕ входы дают 0R (тайм-аут по той же цене), издержки
    // симметричны → базлайн ≈ кандидат. Дни размазаны на полгода.
    const candles = flatCandles(24 * 200);
    const config = { id: "t", ownerId: "test", name: "t", direction: "long" as const, timeframe: "1h" as const, symbols: [],
      entry: { operator: "AND" as const, conditions: [] },
      exit: { stopLoss: { type: "percent" as const, value: 1 }, takeProfit: { type: "rr" as const, value: 2 }, maxBarsInTrade: 3 } };
    const mkTrades = (bonus: number): Map<string, TradeResult[]> => {
      const list: TradeResult[] = [];
      for (let d = 0; d < 150; d++) {
        const t0 = candles[24 * d + 12].time;
        list.push(trade(t0, t0 + HOUR, bonus));
      }
      return new Map([["X", list]]);
    };
    const flat = scheduledNullGate(mkTrades(0), config, () => candles, 7);
    expect(flat.pass).toBe(false); // нет края — нет прохода
    const edged = scheduledNullGate(mkTrades(0.5), config, () => candles, 7);
    expect(edged.t).toBeGreaterThan(POOLED_T_MIN);
    expect(edged.pass).toBe(true);
  });

  test("детерминирован по сиду", () => {
    const candles = flatCandles(24 * 100);
    const config = { id: "t", ownerId: "test", name: "t", direction: "long" as const, timeframe: "1h" as const, symbols: [],
      entry: { operator: "AND" as const, conditions: [] },
      exit: { stopLoss: { type: "percent" as const, value: 1 }, takeProfit: { type: "rr" as const, value: 2 }, maxBarsInTrade: 3 } };
    const trades = new Map([["X", Array.from({ length: 80 }, (_, i) => trade(candles[24 * i + 6].time, candles[24 * i + 7].time, 0.3))]]);
    const a = scheduledNullGate(trades, config, () => candles, 99);
    const b = scheduledNullGate(trades, config, () => candles, 99);
    expect(a).toEqual(b);
  });
});

describe("диагностика калибровки нуль-модели", () => {
  test("числа заполняются и позволяют увидеть недобор сделок у базлайна", () => {
    // Существует потому, что по журналу нашлось невозможное: среди 1512
    // ОТВЕРГНУТЫХ кандидатов нет ни одного отрицательного t, хотя разностный
    // тест обязан быть симметричным. Разделить причины без этих чисел нельзя,
    // а раньше они не сохранялись нигде — `t` жил только в тексте причины
    // отказа и у прошедших терялся вовсе.
    const candles = flatCandles(24 * 200);
    const config = {
      id: "t", ownerId: "test", name: "t", direction: "long" as const,
      timeframe: "1h" as const, symbols: [],
      entry: { operator: "AND" as const, conditions: [] },
      exit: {
        stopLoss: { type: "percent" as const, value: 1 },
        takeProfit: { type: "rr" as const, value: 2 },
        maxBarsInTrade: 3,
      },
    };
    const list: TradeResult[] = [];
    for (let d = 0; d < 150; d++) {
      const at = candles[0].time + d * 86_400 + 3600;
      list.push(trade(at, at + 3 * 3600, 0));
    }
    const res = scheduledNullGate(new Map([["X", list]]), config, () => candles, 11);

    expect(res.diagnostics.candidateTrades).toBe(150);
    // Базлайну выдаётся столько же ВХОДОВ — реализованных сделок у него не
    // может быть больше, а меньше вполне: случайные входы чаще попадают в уже
    // открытую позицию, и незакрытые на конце окна выбрасываются.
    expect(res.diagnostics.nullTradesPerRun).toBeGreaterThan(0);
    expect(res.diagnostics.nullTradesPerRun).toBeLessThanOrEqual(150);
    // Разбиение дней сходится с их общим числом — иначе третий подозреваемый
    // (объединение дней) считается неверно.
    const d = res.diagnostics;
    expect(d.daysBoth + d.daysCandidateOnly + d.daysNullOnly).toBe(res.days);
  });
});
