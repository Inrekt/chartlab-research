import { describe, expect, test } from "vitest";
import { expectedMaxSharpe, deflatedSharpe } from "./stats.ts";
import { DSR_MIN, dsrMinForFamilies } from "./gates.ts";
import { ENTRY_GATE_DELTA, MAX_INCUBATION_DAYS } from "./incubate.ts";
import { dailySigma, expectedAcceptSampleSize } from "./sprt.ts";

/**
 * Инвариант между двумя порогами, живущими в разных файлах.
 *
 * Скрин отбирает кандидата воротами дефляции, инкубатор принимает его входным
 * порогом δ. Пороги независимы, нигде не сравниваются и потому разъехались:
 * вход в инкубатор оказался СТРОЖЕ финальных ворот скрина, и разрыв невидим —
 * он не записан ни в одной пре-регистрации, потому что существует только как
 * следствие арифметики.
 *
 * Цена расхождения максимальная: кандидат, ради которого работала вся ночь,
 * проходит все девять ворот и умирает следующей строкой. За всю историю до
 * этого не дошёл никто, поэтому расхождение никак себя не проявило.
 */

/** Требуемый Шарп/сделку, чтобы DSR прошёл при данных N, varSR и пороге. */
function screenDemands(
  nEffective: number,
  varSR: number,
  trades = 1000,
  dsrMin: number = DSR_MIN,
): number {
  const sr0 = expectedMaxSharpe(nEffective, varSR);
  let lo = 0;
  let hi = 3;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (deflatedSharpe(mid, sr0, trades, 0, 3) >= dsrMin) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** Сколько семейств в журнале сегодня. Растёт — планка растёт всем. */
const FAMILIES_TODAY = 14;

/**
 * Входной порог инкубатора в тех же единицах.
 *
 * `sigma = max(seedSigma, 0.5)`, `mu1 = netExpectancy/2`, отказ при
 * `mu1/sigma < ENTRY_GATE_DELTA`. Замеренная σ R-мультипликаторов — 1.04 (1h)
 * и 1.19 (4h), то есть пол 0.5 не связывает никогда, и условие тождественно
 * равно `tradeSharpe ≥ 2·ENTRY_GATE_DELTA`.
 */
const INCUBATOR_DEMANDS = 2 * ENTRY_GATE_DELTA;

describe("пороги скрина и инкубатора", () => {
  test("вход в инкубатор тождественно равен tradeSharpe ≥ 2·δ", () => {
    // Было 0.36 при δ=0.18 — недостижимо: лучший tradeSharpe за 56 428
    // испытаний равен 0.2539. Стало 0.24 при δ=0.12, то есть лучший кандидат
    // истории теперь прошёл бы. Пре-регистрация:
    // docs/incubator-entry-preregistration.md.
    expect(INCUBATOR_DEMANDS).toBeCloseTo(0.24, 10);
  });

  test("лучший кандидат истории больше НЕ отсекается у двери", () => {
    // Лучший tradeSharpe за историю журнала. Число фактическое.
    const BEST_EVER = 0.2539;
    expect(BEST_EVER).toBeGreaterThan(INCUBATOR_DEMANDS);
  });

  test("после GATE_VERSION=7 связывающими стали ВОРОТА, а не дверь инкубатора", () => {
    // Смысл инварианта: узкое место должно быть у ворот, которые проверяют
    // край, а не у двери, которая про край ничего не знает. Иначе ночь
    // производит кандидатов, умирающих строкой позже.
    // Родословная семейства (10–800 кластеров) вместо всего журнала и varSR
    // по семейству (замеренное отношение 0.42).
    const smallFamily = screenDemands(10, 0.0158 * 0.42);
    const bigFamily = screenDemands(802, 0.0158 * 0.42);
    expect(smallFamily).toBeLessThan(INCUBATOR_DEMANDS);
    expect(bigFamily).toBeGreaterThan(INCUBATOR_DEMANDS);
  });

  test("страж: пороги обязаны меняться вместе", () => {
    // Если однажды ворота ослабят и забудут про второй порог, ночь начнёт
    // производить кандидатов, которые умирают строкой позже. Тест падает — и
    // заставляет назвать оба числа сразу.
    const afterFix = screenDemands(500, 0.0158 * 0.42);
    expect(INCUBATOR_DEMANDS / afterFix).toBeLessThan(1.5);
  });
});

/** Замеренные величины проекта: σ R-мультипликаторов и ρ внутри дня. */
const MEASURED = [
  { tf: "1h", sigma: 1.04, rho: 0.2, perDay: 1.8 },
  { tf: "4h", sigma: 1.19, rho: 0.44, perDay: 1.3 },
] as const;

const daysToDecision = (delta: number, c: (typeof MEASURED)[number]): number => {
  const mu1 = delta * Math.max(c.sigma, 0.5);
  const sd = dailySigma(c.sigma, c.perDay, c.rho);
  return expectedAcceptSampleSize(mu1 * c.perDay, sd * Math.sqrt(c.perDay));
};

describe("входной порог против календаря", () => {
  test("решение успевает на ОБОИХ таймфреймах", () => {
    // Правило выбора порога, объявленное в пре-регистрации ДО подстановки
    // чисел: ожидаемое время решения ≤ ⅔ потолка инкубации. Ожидание — это
    // середина распределения, и медленный кандидат обязан всё равно успеть:
    // смерть «по календарю» не доказывает и не опровергает ничего, то есть
    // тратит год без знания.
    const budget = (2 / 3) * MAX_INCUBATION_DAYS;
    for (const c of MEASURED) {
      const days = daysToDecision(ENTRY_GATE_DELTA, c);
      expect(days, `${c.tf}: ${Math.round(days)} дней при бюджете ${Math.round(budget)}`)
        .toBeLessThanOrEqual(budget);
    }
  });

  test("ниже опускать нельзя: при δ=0.08 вердикта не будет вовсе", () => {
    // Симметричная защита. Снизить порог «чтобы больше проходило» — самый
    // простой способ незаметно превратить инкубацию в формальность.
    expect(daysToDecision(0.08, MEASURED[1])).toBeGreaterThan(MAX_INCUBATION_DAYS);
    expect(ENTRY_GATE_DELTA).toBeGreaterThan(0.08);
  });
});


describe("поправка на число семейств", () => {
  test("одно семейство — поправки нет", () => {
    expect(dsrMinForFamilies(1)).toBeCloseTo(DSR_MIN, 10);
  });

  test("порог растёт с числом семейств по Бонферрони", () => {
    // 1 − (1 − 0.95)/F. Смысл: α делится между экспериментами, а каждое
    // семейство — отдельный эксперимент.
    expect(dsrMinForFamilies(14)).toBeCloseTo(1 - 0.05 / 14, 10);
    expect(dsrMinForFamilies(50)).toBeGreaterThan(dsrMinForFamilies(14));
    expect(dsrMinForFamilies(14)).toBeGreaterThan(dsrMinForFamilies(5));
  });

  test("мусорный вход не роняет ворота в свободный проход", () => {
    // Ноль или дробь означали бы деление на бессмыслицу; порог обязан
    // деградировать в БОЛЕЕ строгую сторону, а не в более мягкую.
    expect(dsrMinForFamilies(0)).toBeCloseTo(DSR_MIN, 10);
    expect(dsrMinForFamilies(-3)).toBeCloseTo(DSR_MIN, 10);
    expect(dsrMinForFamilies(2.7)).toBeCloseTo(dsrMinForFamilies(2), 10);
  });

  test("новое семейство поднимает планку СЕБЕ, а не только другим", () => {
    // Это и есть весь смысл правки: до неё запрет «не плодить семейства»
    // держался только на честном слове исполнителя.
    const varSR = 0.0158 * 0.42;
    const before = screenDemands(10, varSR, 1000, dsrMinForFamilies(FAMILIES_TODAY));
    const after = screenDemands(10, varSR, 1000, dsrMinForFamilies(FAMILIES_TODAY + 1));
    expect(after).toBeGreaterThan(before);
  });

  test("СТРАЖ: ворота ещё не строже двери инкубатора", () => {
    // При росте числа семейств требование ворот однажды перегонит вход в
    // инкубатор (0.24), и вернётся ситуация «кандидат проходит ворота и
    // умирает следующей строкой». Тест обязан упасть ДО того, как это
    // случится в бою, и заставить назвать оба числа сразу.
    const varSR = 0.0158 * 0.42;
    const demands = screenDemands(10, varSR, 1000, dsrMinForFamilies(FAMILIES_TODAY));
    expect(
      demands,
      `ворота требуют ${demands.toFixed(3)} при входе в инкубатор ${INCUBATOR_DEMANDS}`,
    ).toBeLessThan(INCUBATOR_DEMANDS);
  });
});
