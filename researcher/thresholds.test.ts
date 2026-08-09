import { describe, expect, test } from "vitest";
import { expectedMaxSharpe, deflatedSharpe } from "./stats.ts";
import { DSR_MIN } from "./gates.ts";
import { ENTRY_GATE_DELTA } from "./incubate.ts";

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

/** Требуемый Шарп/сделку, чтобы DSR ≥ 0.95 при данных N и varSR. */
function screenDemands(nEffective: number, varSR: number, trades = 1000): number {
  const sr0 = expectedMaxSharpe(nEffective, varSR);
  let lo = 0;
  let hi = 3;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (deflatedSharpe(mid, sr0, trades, 0, 3) >= DSR_MIN) hi = mid;
    else lo = mid;
  }
  return hi;
}

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
  test("вход в инкубатор тождественно равен tradeSharpe ≥ 0.36", () => {
    expect(INCUBATOR_DEMANDS).toBeCloseTo(0.36, 10);
  });

  test("зафиксировано: сегодня инкубатор недостижим даже для лучшего кандидата истории", () => {
    // Лучший tradeSharpe за 56 374 испытания. Число фактическое, из журнала.
    const BEST_EVER = 0.2539;
    expect(BEST_EVER).toBeLessThan(INCUBATOR_DEMANDS);
  });

  test("починка varSR в одиночку НЕ открывает инкубатор — связывающим станет он", () => {
    // Медиана журнала и её версия «по одному семейству» (÷4). Тест фиксирует
    // вывод, от которого зависит решение владельца: после починки дефляции
    // узким местом становится вход в инкубатор, а не ворота.
    const now = screenDemands(8445, 0.0158);
    const fixed = screenDemands(8445, 0.0158 / 4);
    expect(now).toBeGreaterThan(INCUBATOR_DEMANDS);
    expect(fixed).toBeLessThan(INCUBATOR_DEMANDS);
  });

  test("страж: пороги обязаны меняться вместе", () => {
    // Если однажды ворота дефляции ослабят ниже входа в инкубатор и забудут
    // про второй порог, ночь начнёт производить кандидатов, которые умирают
    // строкой позже. Тест падает — и заставляет назвать оба числа сразу.
    const afterFix = screenDemands(8445, 0.0158 / 4);
    const gap = INCUBATOR_DEMANDS / afterFix;
    expect(gap).toBeLessThan(1.5);
  });
});
