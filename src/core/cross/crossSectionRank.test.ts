import { describe, expect, it } from "vitest";
import type { Candle } from "../types";
import { crossSectionRanks, MIN_UNIVERSE } from "./crossSectionRank";

const HOUR = 3600;
const T0 = 1_700_000_000;

/** Свечи с заданными закрытиями, начиная с бара `startBar` по общей шкале времени. */
function series(closes: number[], startBar = 0): Candle[] {
  return closes.map((close, i) => ({
    time: T0 + (startBar + i) * HOUR,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
  }));
}

/**
 * Вселенная из именованных монет плюс `fillers` монет с неподвижной ценой.
 *
 * Наполнитель нужен, потому что место в списке считается только когда в
 * сравнении не меньше MIN_UNIVERSE монет. Тест на трёх монетах молча получал бы
 * пустой результат и «проходил» бы при любом коде.
 */
function universeOf(
  named: Array<[string, Candle[]]>,
  fillers: number,
  bars: number,
  startBar = 0,
): Map<string, Candle[]> {
  const universe = new Map<string, Candle[]>(named);
  for (let k = 0; k < fillers; k++) {
    universe.set(`FILL${k}`, series(Array.from({ length: bars }, () => 100), startBar));
  }
  return universe;
}

describe("место монеты в общем списке", () => {
  it("лучшая по доходности получает 100, худшая — меньше всех", () => {
    // A +10%, B +5%, C −5%, остальные без движения. Всего 20 монет.
    const universe = universeOf(
      [
        ["A", series([100, 110])],
        ["B", series([100, 105])],
        ["C", series([100, 95])],
      ],
      17,
      2,
    );
    const ranks = crossSectionRanks(universe, 1);
    expect(ranks.get("A")![1]).toBeCloseTo(100, 6); // 20 из 20
    expect(ranks.get("B")![1]).toBeCloseTo(95, 6); // 19 из 20
    expect(ranks.get("C")![1]).toBeCloseTo(5, 6); // 1 из 20
  });

  it("пока истории не хватает — места нет, а не ноль", () => {
    // Ноль означал бы «худшая монета рынка», а это неправда: её просто не с чем
    // сравнивать.
    const universe = universeOf([["A", series([100, 110, 120])]], 19, 3);
    const ranks = crossSectionRanks(universe, 2);
    expect(Number.isNaN(ranks.get("A")![0])).toBe(true);
    expect(Number.isNaN(ranks.get("A")![1])).toBe(true);
    expect(ranks.get("A")![2]).toBeCloseTo(100, 6);
  });

  it("монет в сравнении меньше порога — места нет ни у кого", () => {
    // Процентиль среди двух монет это не место в списке, а подбрасывание
    // монетки, и правило «верхние 10%» там вырождается в «одна из двух».
    const thin = universeOf([["A", series([100, 130])]], MIN_UNIVERSE - 2, 2);
    expect([...crossSectionRanks(thin, 1).get("A")!].every(Number.isNaN)).toBe(true);

    // Ровно на пороге место появляется.
    const enough = universeOf([["A", series([100, 130])]], MIN_UNIVERSE - 1, 2);
    expect(crossSectionRanks(enough, 1).get("A")![1]).toBeCloseTo(100, 6);
  });

  it("сравниваются бары одного ВРЕМЕНИ, а не одного номера", () => {
    // B листнулась на два бара позже. Её первый бар обязан сравниваться с
    // ЧЕТВЁРТЫМ баром A — это один день, а не один номер.
    const universe = universeOf(
      [
        ["A", series([100, 100, 100, 130])],
        ["B", series([100, 110], 2)],
      ],
      20,
      4,
    );
    const ranks = crossSectionRanks(universe, 1);

    // На баре времени T0+3ч: A выросла на 30%, B на 10%, наполнитель стоит.
    expect(ranks.get("A")![3]).toBeCloseTo(100, 6);
    expect(ranks.get("B")![1]).toBeCloseTo((21 / 22) * 100, 6);
    // и это РАЗНЫЕ номера баров у двух монет
    expect(ranks.get("B")!.length).toBe(2);
  });

  it("место считается по ПРОШЛОМУ, а не по будущему", () => {
    // Главный тест причинности. A обгоняет всех на баре 1 и проваливается на
    // баре 2. Место на баре 1 обязано отражать обгон, а не будущий провал.
    const universe = universeOf(
      [
        ["A", series([100, 150, 50])],
        ["B", series([100, 110, 130])],
      ],
      18,
      3,
    );
    const ranks = crossSectionRanks(universe, 1);
    expect(ranks.get("A")![1]).toBeCloseTo(100, 6);
    expect(ranks.get("B")![1]).toBeCloseTo(95, 6);
    // на следующем баре порядок меняется на противоположный
    expect(ranks.get("A")![2]).toBeCloseTo(5, 6);
    expect(ranks.get("B")![2]).toBeCloseTo(100, 6);
  });

  it("укороченная история даёт те же места на тех же барах", () => {
    // То же требование, что к расчёту ликвидности: результат на баре не должен
    // зависеть от того, сколько данных пришло ПОСЛЕ него.
    const full = universeOf(
      [
        ["A", series([100, 120, 90, 140, 200])],
        ["B", series([100, 110, 130, 120, 105])],
      ],
      18,
      5,
    );
    const cut = universeOf(
      [
        ["A", series([100, 120, 90])],
        ["B", series([100, 110, 130])],
      ],
      18,
      3,
    );
    const rFull = crossSectionRanks(full, 1);
    const rCut = crossSectionRanks(cut, 1);
    for (let i = 0; i < 3; i++) {
      expect(rCut.get("A")![i]).toEqual(rFull.get("A")![i]);
      expect(rCut.get("B")![i]).toEqual(rFull.get("B")![i]);
    }
  });
});
