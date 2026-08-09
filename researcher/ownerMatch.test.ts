import { describe, expect, test } from "vitest";
import { CONFIRM_AT, REFUTE_AT, TOLERANCE_BARS, matchOwnerTrades } from "./ownerMatch.ts";
import type { OwnerTradeRow } from "./ledger.ts";

/*
 * Тест на ДИСЦИПЛИНУ теста, а не на его результат.
 *
 * Главная опасность этой проверки не в арифметике, а в том, что у неё легко
 * получается только один исход. Мой первоначальный метод именно этим и был
 * порочен: плохо совпало — «правило не то, ищем дальше», хорошо совпало и ноль
 * на воротах — «формализация опять не та». Поэтому здесь пинуются оба порога и
 * ОТДЕЛЬНО — что пробел в данных не выдаётся за опровержение.
 */
const trade = (id: number, over: Partial<OwnerTradeRow> = {}): OwnerTradeRow => ({
  id,
  symbol: "НЕТ_ТАКОГО_СИМВОЛА",
  direction: "short",
  entryIso: "2026-03-14T12:00:00.000Z",
  entryPrice: 100,
  stopPrice: null,
  targetPrice: null,
  exitIso: null,
  exitPrice: null,
  note: null,
  setupLabel: null,
  context: null,
  source: "test",
  ...over,
});

describe("фальсификация по сделкам владельца", () => {
  test("пороги — те, что заморожены в пре-регистрации", () => {
    // Числа не выбираются исполнителем и не подстраиваются под результат:
    // они записаны ДО получения данных вместе с трактовкой обоих исходов.
    expect(CONFIRM_AT).toBe(6);
    expect(REFUTE_AT).toBe(2);
    expect(TOLERANCE_BARS).toBe(2);
  });

  test("символа нет в корпусе ⇒ «нет данных», а НЕ «формализация не та»", () => {
    // Самая опасная подмена: пробел в данных выглядит как ноль попаданий и
    // читается как опровержение. Непокрытые сделки обязаны выпадать из
    // знаменателя, а не пополнять счёт промахов.
    const report = matchOwnerTrades([trade(1), trade(2), trade(3)], "4h");
    expect(report.covered).toBe(0);
    expect(report.matched).toBe(0);
    expect(report.verdict).toBe("нет данных");
    expect(report.rows.every((r) => !r.covered)).toBe(true);
  });

  test("пустой список сделок не даёт вердикта", () => {
    expect(matchOwnerTrades([], "4h").verdict).toBe("нет данных");
  });

  test("каждая сделка попадает в отчёт поимённо", () => {
    // Отчёт обязан быть построчным: агрегат «совпало 4 из 10» скрывает, какие
    // именно сделки не совпали, а следующий шаг зависит именно от них.
    const report = matchOwnerTrades([trade(7, { symbol: "AAA" }), trade(9, { symbol: "BBB" })], "1h");
    expect(report.rows.map((r) => r.tradeId)).toEqual([7, 9]);
    expect(report.rows.map((r) => r.symbol)).toEqual(["AAA", "BBB"]);
  });
});
