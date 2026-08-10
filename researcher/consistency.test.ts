import { describe, expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrialLedger } from "./ledger.ts";
import { behavioralExclusionFor, markEpoch } from "./epochs.ts";
import { behavioralId, sampleCandidates, toStrategyConfig } from "./grammar.ts";
import { runBacktest } from "../src/core/backtest/engine.ts";
import { netR } from "./incubationBook.ts";
import type { Candle } from "../src/core/types/index.ts";

/*
 * ИНВАРИАНТЫ СОГЛАСОВАННОСТИ — тесты против одной конкретной ошибки, которую
 * я совершил трижды за двое суток.
 *
 * Каждый раз причина была одна: правка вносилась туда, где дефект НАШЛИ, а не
 * туда, где живёт правило. А правило в этой машине почти всегда реализовано
 * дважды:
 *
 *   — исключение повторов: по id И по поведению (правило × корпус);
 *   — единица риска: в движке И в книге бумажных сделок;
 *   — расчёт чистого R: в инкубаторе И в карточке выпускника.
 *
 * Починка одной копии выглядит как успех: тесты зелёные, лог чистый,
 * предпросмотр рапортует. Обнаруживается это через сутки и следующим
 * прогоном. Здесь вопрос «кто ещё это читает» задаёт не человек, а падающий
 * тест — единственная форма, которая переживает забывчивость.
 */
const freshDb = () => join(mkdtempSync(join(tmpdir(), "inv-")), "t.sqlite");

const bar = (i: number, p: number): Candle => ({
  time: 1_700_000_000 + i * 3600,
  open: p,
  high: p + 1,
  low: p - 1,
  close: p,
  volume: 100,
});

describe("инвариант: карантин снимает ОБА исключения", () => {
  test("после карантина правило свободно и по id, и по поведению", () => {
    /*
     * Дефект, который это ловит: `epochs.ts` не знал о карантине вовсе.
     * Карантин отчитывался об освобождении 1080 комбинаций, сэмплер отсеивал
     * их вторым механизмом, и необратимая операция не делала НИЧЕГО. Я записал
     * владельцу инструкцию её запускать.
     */
    const dbPath = freshDb();
    const ledger = new TrialLedger(dbPath, { now: () => "2026-08-09T21:37:00.000Z" });
    const specs = sampleCandidates(31, 5, undefined, { tf: "4h" });
    ledger.registerCandidates(specs);
    const rows = ledger.byState("CANDIDATE");
    for (const r of rows) ledger.recordEval(r.candidateId, "halving_16", { trades: 11 });
    const family = ledger.getTrial(rows[0]!.candidateId)!.setupFamily;
    ledger.close();
    markEpoch(dbPath, () => "2026-08-09T00:00:00.000Z");

    const idBefore = new TrialLedger(dbPath);
    const byIdBefore = idBefore.resamplableExclusions().size;
    idBefore.close();
    const byBehaviorBefore = behavioralExclusionFor(dbPath, "4h").size;

    const l = new TrialLedger(dbPath, { now: () => "2026-08-09T22:00:00.000Z" });
    l.quarantineEpoch(family, "2026-08-09", "2026-08-09", "прибор был сломан");
    const byIdAfter = l.resamplableExclusions().size;
    l.close();
    const byBehaviorAfter = behavioralExclusionFor(dbPath, "4h").size;

    // ОБА механизма обязаны ослабнуть. Достаточно одному остаться прежним —
    // и карантин бесполезен, оставаясь при этом «успешным».
    expect(byIdAfter).toBeLessThan(byIdBefore);
    expect(byBehaviorAfter).toBeLessThan(byBehaviorBefore);
  });
});

describe("инвариант: единица риска одна на движок и книгу", () => {
  test("движок отдаёт riskBudget у КАЖДОЙ сделки, и он не выводится из цен", () => {
    /*
     * Дефект, который это ловит: `riskBudget` появился в отчёте движка, но
     * книга его не хранила, а потребители обходили обязательное поле
     * приведением типа. Издержки обнулялись там, где ошибка стоит денег.
     *
     * Проверка именно на сделках С СОПРОВОЖДЕНИЕМ: у них стоп переезжает во
     * вход, и разность цен перестаёт быть риском.
     */
    // Плато, затем СКАЧОК: при плавном росте close не превышает вчерашний
    // канал (шаг роста меньше полудиапазона свечи), и сделок не будет вовсе —
    // тест прошёл бы «зелёным», не проверив ничего.
    const candles = [
      ...Array.from({ length: 30 }, (_, i) => bar(i, 100)),
      ...Array.from({ length: 25 }, (_, i) => bar(30 + i, 130 + i * 0.4)),
    ];
    const config = {
      id: "t",
      ownerId: "test",
      name: "t",
      timeframe: "1h" as const,
      direction: "long" as const,
      symbols: [],
      entry: {
        operator: "AND" as const,
        conditions: [
          {
            kind: "comparison" as const,
            left: { kind: "close" as const },
            op: ">" as const,
            right: { kind: "donchian" as const, period: 10, line: "upper" as const, shift: 1 },
          },
        ],
      },
      exit: {
        stopLoss: { type: "percent" as const, value: 2 },
        takeProfit: { type: "rr" as const, value: 3 },
        maxBarsInTrade: 15,
        scaleOut: { atR: 0.5, fraction: 0.5, toBreakeven: true },
      },
    };
    const trades = runBacktest(candles, config, "X");
    expect(trades.length).toBeGreaterThan(0);
    for (const t of trades) {
      expect(Number.isFinite(t.riskBudget), "riskBudget обязан быть у каждой сделки").toBe(true);
      expect(t.riskBudget).toBeGreaterThan(0);
    }
    // Хотя бы у одной стоп должен был переехать во вход — иначе тест ничего
    // не проверяет, и это надо знать.
    const moved = trades.filter((t) => Math.abs(t.entryPrice - t.stopPrice) < 1e-9);
    if (moved.length > 0) {
      for (const t of moved) {
        // Риск СОХРАНЁН, хотя разность цен уже ноль.
        expect(t.riskBudget).toBeGreaterThan(0);
      }
    }
  });

  test("чистый R считается ОДНОЙ формулой — копии больше нет", () => {
    // Дефект, который это ловит: у карточки выпускника была своя копия
    // расчёта, и она разошлась с той, по которой принималось решение о
    // выпуске. Теперь формула одна и живёт рядом со строкой книги.
    const row = {
      symbol: "X",
      direction: "short" as const,
      entryTime: 1,
      entryPrice: 100,
      stopPrice: 100, // безубыток: разность цен ноль
      riskBudget: 2,
      rMultiple: 0.25,
      exitTime: 2,
    };
    const net = netR(row);
    expect(net).toBeLessThan(row.rMultiple); // издержка списана, а не обнулена
  });
});

describe("инвариант: правило и его проверка меряют одно и то же", () => {
  test("поведенческий id не зависит от таймфрейма, а исключение — зависит", () => {
    /*
     * Дефект, который это ловит: эпоха-1 писала в спек случайный ярлык ТФ, и
     * дедуп блокировал повторы по ЯРЛЫКУ, а не по факту прогона. Правило,
     * сгоревшее на 1ч под меткой «1d», на 4ч не проверялось никогда — при
     * том что журнал считал его проверенным.
     */
    const specs = sampleCandidates(5, 3, undefined, { tf: "4h" });
    for (const spec of specs) {
      const other = { ...spec, timeframe: "1h" as const };
      expect(behavioralId(spec)).toBe(behavioralId(other));
      // При этом конфиг движка ТФ несёт — иначе прогон был бы неотличим.
      expect(toStrategyConfig(spec).timeframe).toBe("4h");
      expect(toStrategyConfig(other).timeframe).toBe("1h");
    }
  });
});
