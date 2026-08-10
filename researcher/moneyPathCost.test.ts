import { describe, expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IncubationBook, netR } from "./incubationBook.ts";
import type { TradeResult } from "../src/core/types/index.ts";

/*
 * Издержки на ДЕНЕЖНОМ пути: решение о выпуске, надзор, карточка.
 *
 * История дефекта, ради которой файл существует. Перенос стопа в безубыток
 * делает финальный стоп равным средней цене входа, а издержки восстанавливались
 * из этих двух цен — получался ноль. На скрине это починили полем `riskBudget`,
 * но книга бумажных сделок его не хранила, и оба потребителя строили
 * псевдо-сделку через приведение типа, обходя обязательное поле. То есть на
 * пути, где ошибка стоит ДЕНЕГ, дыра оставалась открытой ещё сутки.
 *
 * Проверка адверсарная: сделка сконструирована ровно так, как её пишет движок
 * после срабатывания безубытка.
 */
const freshDb = () => join(mkdtempSync(join(tmpdir(), "mp-")), "t.sqlite");

/** Сделка ПОСЛЕ переноса стопа в безубыток: стоп равен средней цене входа. */
const breakevenTrade = (): TradeResult => ({
  symbol: "SOLUSDT",
  direction: "short",
  entryTime: 1_700_000_000,
  entryPrice: 100,
  exitTime: 1_700_003_600,
  exitPrice: 100,
  stopPrice: 100, // ← стоп переехал во вход
  targetPrice: 90,
  rMultiple: 0.25,
  riskBudget: 2, // ← настоящая единица риска, известная движку
  won: true,
  barsHeld: 3,
});

describe("издержки доходят до денежного пути", () => {
  test("книга ХРАНИТ единицу риска отдельно от стопа", () => {
    // Стоп мутирует, риск — нет. Пока книга их не различала, восстановить
    // издержку было невозможно в принципе.
    const book = new IncubationBook(freshDb());
    book.start({
      candidateId: "c1",
      tf: "4h",
      symbols: ["SOLUSDT"],
      mu1: 0.1,
      sigma: 1,
      expectedN: 100,
      frozenAt: 1_699_000_000,
    } as never);
    book.recordTrades("c1", [breakevenTrade()]);
    const row = book.trades("c1")[0]!;
    expect(row.stopPrice).toBe(100);
    expect(row.riskBudget).toBe(2);
    book.close();
  });

  test("сделка с безубытком НЕ бесплатна", () => {
    // Главный тест файла. Если издержка обнулилась, значит риск снова
    // выводится из двух цен, и треть сделок семейств с сопровождением опять
    // торгует даром — в решении о ВЫПУСКЕ и в карточке.
    const book = new IncubationBook(freshDb());
    book.start({
      candidateId: "c2",
      tf: "4h",
      symbols: ["SOLUSDT"],
      mu1: 0.1,
      sigma: 1,
      expectedN: 100,
      frozenAt: 1_699_000_000,
    } as never);
    book.recordTrades("c2", [breakevenTrade()]);
    const row = book.trades("c2")[0]!;
    const net = netR(row);
    expect(net).toBeLessThan(row.rMultiple); // издержка списана
    expect(row.rMultiple - net).toBeGreaterThan(0);
    book.close();
  });

  test("старые записи без колонки считаются по прежней формуле, а не по нулю", () => {
    // Записи, сделанные до появления колонки, действительно не знают своей
    // единицы риска. Подставлять им что-либо задним числом — подделка;
    // запасной путь по двум ценам это ровно то, чем они мерились всегда.
    const legacy = {
      symbol: "X",
      direction: "long" as const,
      entryTime: 1,
      entryPrice: 100,
      stopPrice: 98,
      riskBudget: null,
      rMultiple: 1,
      exitTime: 2,
    };
    expect(netR(legacy)).toBeLessThan(1);
    expect(Number.isFinite(netR(legacy))).toBe(true);
  });
});
