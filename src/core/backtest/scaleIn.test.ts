import { describe, expect, it } from "vitest";
import type { Candle, StrategyConfig } from "../types";
import { simulateExits } from "./engine";
import { liquidityFeatures } from "../liquidations/clusterSeries";

const HOUR = 3600;
const SIGNAL = 150;

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

/**
 * Ровный фон (одинаковые бары не рождают пивотов) плюс ДВА скопления сверху и
 * одно снизу. Два уровня сверху — обязательное условие: только тогда у шорта
 * есть куда добирать дважды, а K=2 отличается от K=1.
 */
function twoLevelsAbove(moves: Record<number, [number, number]> = {}): Candle[] {
  const spec: Array<[number, number]> = Array.from({ length: 260 }, () => [99, 101]);
  // Порядок во времени важен: бар, пробивающий уровень, снимает его. Сначала
  // рождается дальний уровень, потом ближний — иначе более высокий шип снёс бы
  // нижнее скопление, и сверху остался бы один уровень вместо двух.
  spec[40] = [99, 110]; // дальнее скопление сверху
  spec[60] = [99, 106]; // ближнее скопление сверху
  spec[90] = [94, 101]; // магнит снизу — цель шорта
  for (const [i, bar] of Object.entries(moves)) spec[Number(i)] = bar;
  return bars(spec);
}

const shortCfg = (adds: number, maxBarsInTrade = 50): StrategyConfig => ({
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
    maxBarsInTrade,
    scaleInAdds: adds,
  },
});

const only = (candles: Candle[], adds: number, maxBars = 50) =>
  simulateExits(candles, shortCfg(adds, maxBars), "X", [SIGNAL])[0];

describe("добор на скоплениях ликвидности", () => {
  it("фикстура и правда даёт два разных уровня сверху", () => {
    const f = liquidityFeatures(twoLevelsAbove());
    expect(f.nearAbove[SIGNAL]).toBeCloseTo(106, 6);
    expect(f.farAbove[SIGNAL]).toBeCloseTo(110, 6);
    expect(f.nearAbove[SIGNAL]).toBeLessThan(f.farAbove[SIGNAL]);
  });

  it("при полном исполнении доборов убыток на стопе равен РОВНО 1R", () => {
    // Один бар выносит цену выше стопа: по дороге он проходит оба уровня
    // добора, значит позиция набрана целиком. Это и есть худший сценарий, ради
    // которого нормировался размер.
    const candles = twoLevelsAbove({ 152: [99, 115] });
    const trade = only(candles, 2);
    expect(trade).toBeDefined();
    expect(trade.rMultiple).toBeCloseTo(-1, 9);
  });

  it("потолок риска тот же, что и без добора — сравнение идёт при равной ставке", () => {
    const candles = twoLevelsAbove({ 152: [99, 115] });
    expect(only(candles, 0).rMultiple).toBeCloseTo(-1, 9);
    expect(only(candles, 1).rMultiple).toBeCloseTo(-1, 9);
    expect(only(candles, 2).rMultiple).toBeCloseTo(-1, 9);
  });

  it("исполнились не все доборы — убыток СТРОГО меньше 1R", () => {
    // Цена ушла к первому уровню и там застряла до таймаута: вторая доля не
    // набрана, значит и ставка меньше запланированной.
    const moves: Record<number, [number, number]> = { 152: [99, 107] };
    for (let i = 153; i <= 156; i++) moves[i] = [104, 107];
    const trade = only(twoLevelsAbove(moves), 2, 6);
    expect(trade.rMultiple).toBeLessThan(0);
    expect(trade.rMultiple).toBeGreaterThan(-1);
  });

  it("доборы не сработали — выигрыш МЕНЬШЕ, чем без добора (цена дисциплины)", () => {
    // Цена сразу пошла к цели. Первый вход у версии с добором меньше единицы,
    // поэтому та же самая победа приносит меньше. Это не баг, а честная
    // стоимость правила, и семейство обязано её показывать.
    const candles = twoLevelsAbove({ 152: [93, 101] });
    const withAdds = only(candles, 2);
    const baseline = only(candles, 0);
    expect(baseline.rMultiple).toBeGreaterThan(0);
    expect(withAdds.rMultiple).toBeGreaterThan(0);
    expect(withAdds.rMultiple).toBeLessThan(baseline.rMultiple);
  });

  it("добор сработал и цена дошла до цели — выигрыш БОЛЬШЕ, чем без добора", () => {
    const candles = twoLevelsAbove({ 152: [99, 107], 153: [93, 101] });
    const withAdds = only(candles, 1);
    const baseline = only(candles, 0);
    expect(withAdds.rMultiple).toBeGreaterThan(baseline.rMultiple);
    // средняя цена шорта поднялась: долив прошёл выше первого входа
    expect(withAdds.entryPrice).toBeGreaterThan(baseline.entryPrice);
  });

  it("бар задел и уровень добора, и цель — добор НЕ исполняется", () => {
    // Порядок тиков внутри бара неизвестен. «Сначала долив, потом цель» дало бы
    // прибыль из одного лишь предположения, поэтому такой бар считается
    // сделкой без долива.
    const both = twoLevelsAbove({ 152: [93, 107] });
    const targetOnly = twoLevelsAbove({ 152: [93, 101] });
    expect(only(both, 2).rMultiple).toBeCloseTo(only(targetOnly, 2).rMultiple, 9);
  });

  it("бар задел и уровень добора, и стоп — добор исполняется", () => {
    // Зеркальный случай: чтобы дойти до стопа, цена обязана была пройти уровень
    // добора. Здесь предположение работает против стратегии, и это правильно.
    const candles = twoLevelsAbove({ 152: [99, 115] });
    expect(only(candles, 2).rMultiple).toBeCloseTo(-1, 9);
  });

  it("уровень против сделки всего один — K=2 вырождается в K=1, а не ломается", () => {
    const spec: Array<[number, number]> = Array.from({ length: 260 }, () => [99, 101]);
    spec[40] = [99, 106]; // единственное скопление сверху
    spec[90] = [94, 101];
    spec[152] = [99, 107];
    spec[153] = [93, 101];
    const candles = bars(spec);
    const f = liquidityFeatures(candles);
    expect(f.nearAbove[SIGNAL]).toBeCloseTo(f.farAbove[SIGNAL], 6);
    expect(only(candles, 2).rMultiple).toBeCloseTo(only(candles, 1).rMultiple, 9);
  });

  it("без добора поведение движка не изменилось ни на бит", () => {
    // scaleInAdds отсутствует в конфиге вовсе — путь эпохи 2 обязан остаться
    // прежним, иначе журнал предыдущей ночи станет несравним.
    const candles = twoLevelsAbove({ 152: [99, 107], 153: [93, 101] });
    const legacy = simulateExits(
      candles,
      {
        ...shortCfg(0),
        exit: {
          stopLoss: { type: "liquidity", value: 0.5 },
          takeProfit: { type: "liquidity", value: 0.2 },
          maxBarsInTrade: 50,
        },
      },
      "X",
      [SIGNAL],
    )[0];
    const explicitZero = only(candles, 0);
    expect(legacy.rMultiple).toBeCloseTo(explicitZero.rMultiple, 12);
    expect(legacy.entryPrice).toBeCloseTo(explicitZero.entryPrice, 12);
    expect(legacy.exitPrice).toBeCloseTo(explicitZero.exitPrice, 12);
  });
});
