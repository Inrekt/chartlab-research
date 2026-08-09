import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import type { Candle } from "../src/core/types/index.ts";
import {
  clearCandleCache,
  loadCandlesWindow,
  OOT_CUTOFF_SEC,
  OOT_WARMUP_BARS,
} from "./corpus.ts";
import {
  OOT_T_MIN,
  POOLED_T_MIN,
  sampleScheduledEntries,
  scheduledNullGate,
  scheduleProfile,
} from "./nullSchedule.ts";

const HOUR = 3600;
const BEFORE = 1500;
const AFTER = 500;

/** Корпус из одного символа: 1500 часовых баров до границы OOT и 500 после. */
function fakeCorpus(): string {
  const dir = mkdtempSync(join(tmpdir(), "oot-"));
  const start = OOT_CUTOFF_SEC - BEFORE * HOUR;
  const candles: Candle[] = Array.from({ length: BEFORE + AFTER }, (_, i) => ({
    time: start + i * HOUR,
    open: 100, high: 101, low: 99, close: 100, volume: 1,
  }));
  writeFileSync(join(dir, "TESTUSDT_1h.json.gz"), gzipSync(JSON.stringify(candles)));
  return dir;
}

describe("окна корпуса", () => {
  test("in — строго до границы; oot — граница плюс прогрев перед ней", () => {
    clearCandleCache();
    const dir = fakeCorpus();
    const inSample = loadCandlesWindow("TESTUSDT", "1h", "in", dir)!;
    const oot = loadCandlesWindow("TESTUSDT", "1h", "oot", dir)!;

    expect(inSample).toHaveLength(BEFORE);
    expect(inSample.at(-1)!.time).toBeLessThan(OOT_CUTOFF_SEC);

    // прогрев лежит ДО границы: индикаторам нужна предыстория, иначе первые
    // ~300 баров окна не дают сигналов вообще
    expect(oot[0].time).toBe(OOT_CUTOFF_SEC - OOT_WARMUP_BARS * HOUR);
    expect(oot).toHaveLength(OOT_WARMUP_BARS + AFTER);
    expect(oot.at(-1)!.time).toBeGreaterThanOrEqual(OOT_CUTOFF_SEC);
  });

  test("поиск НЕ видит ни одного бара из будущего", () => {
    clearCandleCache();
    const dir = fakeCorpus();
    const inSample = loadCandlesWindow("TESTUSDT", "1h", "in", dir)!;
    expect(inSample.every((c) => c.time < OOT_CUTOFF_SEC)).toBe(true);
  });

  test("срез окна СТАБИЛЕН по идентичности — иначе кэш индикаторов мёртв", () => {
    clearCandleCache();
    const dir = fakeCorpus();
    // кэш серий движка привязан к идентичности массива (WeakMap): свежий
    // slice на каждый вызов означал бы пересчёт SMA200 на каждого кандидата
    expect(loadCandlesWindow("TESTUSDT", "1h", "in", dir)).toBe(
      loadCandlesWindow("TESTUSDT", "1h", "in", dir),
    );
    expect(loadCandlesWindow("TESTUSDT", "1h", "oot", dir)).toBe(
      loadCandlesWindow("TESTUSDT", "1h", "oot", dir),
    );
    // и это ДВА РАЗНЫХ массива, а не один и тот же
    expect(loadCandlesWindow("TESTUSDT", "1h", "in", dir)).not.toBe(
      loadCandlesWindow("TESTUSDT", "1h", "oot", dir),
    );
  });

  test("clearCandleCache чистит и полные свечи, и срезы окон", () => {
    clearCandleCache();
    const dir = fakeCorpus();
    const first = loadCandlesWindow("TESTUSDT", "1h", "oot", dir);
    clearCandleCache();
    expect(loadCandlesWindow("TESTUSDT", "1h", "oot", dir)).not.toBe(first);
  });

  test("отсутствующий символ — null в любом окне", () => {
    clearCandleCache();
    const dir = fakeCorpus();
    expect(loadCandlesWindow("NOPEUSDT", "1h", "in", dir)).toBeNull();
    expect(loadCandlesWindow("NOPEUSDT", "1h", "oot", dir)).toBeNull();
  });
});

describe("базлайн не заходит в прогрев", () => {
  test("minFillTimeSec отсекает бары, недоступные кандидату", () => {
    clearCandleCache();
    const dir = fakeCorpus();
    const oot = loadCandlesWindow("TESTUSDT", "1h", "oot", dir)!;
    const profile = scheduleProfile(
      oot.filter((c) => c.time >= OOT_CUTOFF_SEC).map((c) => c.time),
    );
    let s = 7;
    const rand = () => ((s = (s * 16807) % 2147483647) % 1000) / 1000;

    const picked = sampleScheduledEntries(oot, 40, profile, rand, OOT_CUTOFF_SEC);
    expect(picked.length).toBeGreaterThan(0);
    // fill-бар (i+1) обязан лежать в окне, а не в прогреве
    for (const i of picked) expect(oot[i + 1].time).toBeGreaterThanOrEqual(OOT_CUTOFF_SEC);

    // без фильтра базлайн торговал бы и в прогреве — то есть в периоде,
    // которого у кандидата не было
    const unfiltered = sampleScheduledEntries(oot, 40, profile, rand);
    expect(unfiltered.some((i) => oot[i + 1].time < OOT_CUTOFF_SEC)).toBe(true);
  });
});

describe("порог теста параметризован", () => {
  test("один и тот же кандидат может пройти OOT-порог и не пройти in-sample", () => {
    // плоские свечи: базлайн даёт 0R, поэтому t кандидата определяется
    // подмешанным краем; конкретное значение не важно — важно, что порог
    // применяется тот, который передан
    const candles: Candle[] = Array.from({ length: 24 * 200 }, (_, i) => ({
      time: 1_700_000_000 - (1_700_000_000 % HOUR) + i * HOUR,
      open: 100, high: 100, low: 100, close: 100, volume: 1,
    }));
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
    const trades = new Map([
      ["X", Array.from({ length: 150 }, (_, d) => {
        const t0 = candles[24 * d + 12].time;
        return {
          symbol: "X", direction: "long" as const, entryTime: t0, entryPrice: 100,
          exitTime: t0 + HOUR, exitPrice: 100, stopPrice: 99, targetPrice: 102,
          rMultiple: 0.12, riskBudget: 1, won: true, barsHeld: 1,
        };
      })],
    ]);

    const strict = scheduledNullGate(trades, config, () => candles, 5, { minT: 99 });
    expect(strict.pass).toBe(false); // недостижимый порог
    const lenient = scheduledNullGate(trades, config, () => candles, 5, {
      minT: strict.t - 0.01,
    });
    expect(lenient.pass).toBe(true); // тот же t, порог ниже
    expect(lenient.t).toBeCloseTo(strict.t, 10); // статистика не изменилась
  });

  test("пороги пре-регистрированы: OOT мягче in-sample по мощности, не по прихоти", () => {
    expect(POOLED_T_MIN).toBe(2.6);
    expect(OOT_T_MIN).toBe(1.3);
    expect(OOT_T_MIN).toBeLessThan(POOLED_T_MIN);
  });
});
