import { describe, expect, test } from "vitest";
import { statsAfterCosts } from "../src/core/committee/costModel.ts";
import { recallBench, syntheticTrades } from "./recall.ts";
import { netRMultiples } from "./screen.ts";
import { tradeSharpe } from "./stats.ts";

describe("синтетика стенда мощности", () => {
  test("заложенный край РЕАЛЬНО оказывается в net-доходности", () => {
    // Единственное свойство, от которого зависят все выводы стенда. Если
    // синтетика молча даёт не тот δ, стенд продолжит печатать проценты —
    // просто они будут отвечать на другой вопрос. Эта проверка и есть
    // разница между прибором и генератором чисел.
    for (const delta of [0.1, 0.25, 0.5]) {
      const trades = syntheticTrades({
        delta,
        sigma: 1,
        trades: 20_000,
        symbols: 16,
        years: 5,
        seed: 11,
        symbolSpread: 0,
      });
      expect(tradeSharpe(netRMultiples(trades))).toBeCloseTo(delta, 1);
    }
  });

  test("издержки не съедают заявленный край: δ задан ПОСЛЕ них", () => {
    // Брутто обязано быть выше нетто ровно на издержки. Если бы δ задавался
    // по брутто, стенд систематически завышал бы мощность — то есть врал
    // именно в ту сторону, куда хочется.
    const trades = syntheticTrades({
      delta: 0.3,
      sigma: 1,
      trades: 20_000,
      symbols: 8,
      years: 5,
      seed: 3,
      symbolSpread: 0,
    });
    const gross = tradeSharpe(trades.map((t) => t.rMultiple));
    const net = tradeSharpe(netRMultiples(trades));
    expect(net).toBeCloseTo(0.3, 1);
    expect(gross).toBeGreaterThan(net);
    expect(statsAfterCosts([...trades]).expectancy).toBeGreaterThan(0);
  });

  test("выборка покрывает все годы — иначе ворота времени падали бы всегда", () => {
    const trades = syntheticTrades({
      delta: 0.25,
      sigma: 1,
      trades: 1000,
      symbols: 16,
      years: 5,
      seed: 5,
    });
    const years = new Set(trades.map((t) => new Date(t.entryTime * 1000).getUTCFullYear()));
    expect(years.size).toBeGreaterThanOrEqual(5);
  });

  test("мощность растёт с крем и падает с планкой — прибор реагирует в нужную сторону", () => {
    const run = (delta: number, varSR: number) =>
      recallBench({
        deltas: [delta],
        runs: 20,
        trades: 1000,
        symbols: 16,
        years: 5,
        sigma: 1,
        nEffective: 8445,
        varSR,
        seed: 7,
      })[0].fullPass;

    // Тот же край, более низкая планка — мощность обязана вырасти.
    expect(run(0.35, 0.0016)).toBeGreaterThan(run(0.35, 0.0158));
    // Та же планка, более сильный край — тоже.
    expect(run(0.6, 0.0158)).toBeGreaterThan(run(0.25, 0.0158));
  });

  test("узкое место называется честно, а не первым по списку", () => {
    const [row] = recallBench({
      deltas: [0.25],
      runs: 20,
      trades: 1000,
      symbols: 16,
      years: 5,
      sigma: 1,
      nEffective: 8445,
      varSR: 0.0158,
      seed: 7,
    });
    // При медианной планке журнала настоящий край с δ=0.25 (годовой Шарп ≈4)
    // не проходит ВООБЩЕ — и виноваты именно ворота дефляции.
    expect(row.bottleneck).toBe("dsr");
    expect(row.fullPass).toBe(0);
  });
});
