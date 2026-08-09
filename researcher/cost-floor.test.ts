import { describe, expect, test } from "vitest";
import { requiredTradeSharpe, roundTripCost } from "./cost-floor.ts";

const base = {
  cost: 0.002, // 20 бп круговых — фактическая ставка движка
  sigmaHourly: 0.0099, // 99 бп — замер по 37 символам вселенной
  targetAnnualSharpe: 1.6,
  tradesPerYear: 300,
};

describe("стоимостной пол", () => {
  test("издержки движка — те самые 20 бп, на которых считается пол", () => {
    // Если ставка в движке изменится, а пол останется посчитан на старой,
    // весь вывод «связывает не издержки, а ворота» станет неверным молча.
    expect(roundTripCost()).toBeCloseTo(0.002, 6);
  });

  test("пол падает с ростом горизонта — иначе формула собрана неверно", () => {
    const at = (h: number) => requiredTradeSharpe({ ...base, holdHours: h });
    expect(at(1)).toBeGreaterThan(at(15));
    expect(at(15)).toBeGreaterThan(at(72));
    expect(at(72)).toBeGreaterThan(at(160));
  });

  test("на НАШЕЙ волатильности и НАШЕМ горизонте пол втрое ниже требования ворот", () => {
    // Это и есть вывод, ради которого модуль написан: связывающее ограничение —
    // ворота (требуют ~0.5 Шарпа на сделку), а не арифметика издержек.
    const ours = requiredTradeSharpe({ ...base, holdHours: 15 });
    expect(ours).toBeLessThan(0.2);
    expect(ours * 3).toBeLessThan(0.5);
  });

  test("подмена σ на «литературные» 40 бп завышает пол вчетверо", () => {
    // Ровно эта подмена и дала внешнему разбору вывод «искали там, где
    // издержки требуют неправдоподобной точности». Тест фиксирует, что
    // расхождение объясняется входными данными, а не спором о методе.
    const ours = requiredTradeSharpe({ ...base, holdHours: 15 });
    const theirs = requiredTradeSharpe({ ...base, sigmaHourly: 0.004, holdHours: 1 });
    expect(theirs / ours).toBeGreaterThan(3.5);
  });

  test("удлинение горизонта с наших 15ч до рекомендованных 72ч даёт мало", () => {
    // Проверяемое следствие: раз мы стартуем не с h=1, обещанный «главный ход»
    // экономит около двадцати процентов, а не «больше одного Шарпа».
    const now = requiredTradeSharpe({ ...base, holdHours: 15 });
    const longer = requiredTradeSharpe({ ...base, holdHours: 72 });
    expect(1 - longer / now).toBeLessThan(0.25);
  });
});
