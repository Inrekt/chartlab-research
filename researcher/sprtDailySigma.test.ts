import { describe, expect, test } from "vitest";
import { dailySigma, dailySigmas, sprtDecide, type DailyObservation } from "./sprt.ts";

/*
 * Йенсен-поправка σ_день: σ считается ПО КАЖДОМУ дню (его число сделок), а не
 * одним σ из среднего m̄.
 *
 * Дефект, который это чинит: `f(m) = ρ + (1−ρ)/m` ВЫПУКЛА по m, поэтому
 * среднее `f(count)` строго больше `f(m̄)`; одно m̄ занижало σ_день на 5.1–5.8%
 * НА РЕАЛИСТИЧНОМ потоке, и смещение было В ПОЛЬЗУ стратегии — LLR выше, границы
 * Вальда эффективно сжаты, ложное принятие выше номинала в воротах, решающих
 * ВЫПУСК. День с одной сделкой несёт σ целиком; усреднять его счёт с
 * десятисделочным до подстановки в σ нельзя.
 */
const hetero = (): DailyObservation[] =>
  // 30 дней, чётные по 1 сделке, нечётные по 10; все дневные средние = +0.3
  // (в сторону принятия). Именно разнородность счётов активирует Йенсен.
  Array.from({ length: 30 }, (_, i) => ({ day: i, mean: 0.3, count: i % 2 === 0 ? 1 : 10 }));

describe("σ_день по каждому дню строже, чем одно σ из m̄", () => {
  test("на разнородных счётах per-day σ даёт LLR НИЖЕ (строже) одного m̄", () => {
    const daily = hetero();
    const means = daily.map((d) => d.mean);
    const mbar = daily.reduce((a, d) => a + d.count, 0) / daily.length;
    const rho = 0.4;
    const sigma = 1;

    const singleLlr = sprtDecide(means, 0.5, dailySigma(sigma, mbar, rho)).llr;
    const perDayLlr = sprtDecide(means, 0.5, dailySigmas(daily, sigma, rho)).llr;

    // Оба должны ещё «continue» (не упереться в границу), иначе сравнение llr
    // некорректно — проверяем это явно.
    expect(sprtDecide(means, 0.5, dailySigmas(daily, sigma, rho)).decision).toBe("continue");
    // Честный per-day СТРОЖЕ: тот же дрейф даёт меньше свидетельств принятия.
    expect(perDayLlr).toBeLessThan(singleLlr);
  });

  test("на ОДНОРОДНЫХ счётах разницы нет — поправка не трогает то, что верно", () => {
    // Если все дни по m сделок, m̄ = m и per-day = одно σ. Поправка не должна
    // ничего менять там, где усреднять было нечего.
    const daily: DailyObservation[] = Array.from({ length: 20 }, (_, i) => ({
      day: i,
      mean: 0.2,
      count: 3,
    }));
    const means = daily.map((d) => d.mean);
    const single = sprtDecide(means, 0.5, dailySigma(1, 3, 0.4)).llr;
    const perDay = sprtDecide(means, 0.5, dailySigmas(daily, 1, 0.4)).llr;
    expect(perDay).toBeCloseTo(single, 10);
  });

  test("массив σ и одно σ совпадают, когда массив константен — обратная совместимость", () => {
    // sprtDecide(σ:number) и sprtDecide(σ:[одинаковые]) обязаны дать одно и то же.
    const xs = [0.4, -0.2, 0.5, 0.1, 0.3];
    const byNum = sprtDecide(xs, 0.5, 0.9);
    const byArr = sprtDecide(xs, 0.5, xs.map(() => 0.9));
    expect(byArr.llr).toBeCloseTo(byNum.llr, 12);
    expect(byArr.decision).toBe(byNum.decision);
  });
});
