import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listUniverse, loadCandles, splitHoldout } from "./corpus.ts";
import type { CandidateSpec } from "./grammar.ts";
import { corpusCandleSource, runIncubation } from "./incubate.ts";
import { IncubationBook } from "./incubationBook.ts";
import { TrialLedger } from "./ledger.ts";

/**
 * Сквозной дымовой прогон инкубатора на РЕАЛЬНОМ корпусе.
 *
 * Половина машины, которая ни разу не отработала: за всю историю журнала
 * `incubations = 0` и `paper_trades = 0`. Юнит-тесты рядом покрывают вердикты
 * SPRT и терминальные состояния, но на СИНТЕТИЧЕСКОМ рынке и с подставным
 * источником свечей. Связка «журнал → книга → движок → SPRT → журнал» на
 * настоящих данных не запускалась никогда, и первый живой кандидат стал бы её
 * бета-тестером после месяцев ожидания.
 *
 * Дымовой прогон отвечает на один вопрос: доходит ли кандидат от VALIDATED до
 * записанных форвард-сделок, не спотыкаясь ни на одном стыке. Он НЕ проверяет
 * качество вердикта — для этого есть калибровочные тесты.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "smoke-inc-"));
  dirs.push(dir);
  return join(dir, "trials.sqlite");
}

/**
 * Спека для дымового прогона берётся ЯВНО, а не из `sampleCandidates`.
 *
 * Сэмплер выдаёт только финансируемые семейства (фандинг, скопления
 * ликвидности) — они по построению редко торгуют, а фандинговым нужен ещё и
 * COLLECT_DIR. Прогон на такой спеке давал ноль сделок, и тест проверял бы не
 * связку, а наличие внешних данных. Здесь нужен предсказуемо активный сетап:
 * задача — пройти по всем стыкам, а не измерить край.
 */
const ACTIVE_SPEC: CandidateSpec = {
  setup: "trend_cross_50",
  direction: "long",
  timeframe: "1h",
  filters: [],
  exit: { stopAtr: 2, takeR: 1, maxBars: 10 },
};

describe("сквозной прогон инкубатора на реальном корпусе", () => {
  test("кандидат доходит от VALIDATED до записанных форвард-сделок", async () => {
    const universe = listUniverse("1h");
    if (universe.length === 0) return; // корпуса нет — проверять нечего

    // Символы с самой длинной историей: инкубации нужны бары ПОСЛЕ заморозки,
    // а прогрев съедает первые 600.
    const { search } = splitHoldout(universe);
    const symbols = search
      .map((s) => ({ s, n: loadCandles(s, "1h")?.length ?? 0 }))
      .filter((x) => x.n > 5000)
      .sort((a, b) => b.n - a.n)
      .slice(0, 3)
      .map((x) => x.s);
    if (symbols.length === 0) return;

    const candles = loadCandles(symbols[0], "1h")!;
    // Заморозка — за 2000 баров до конца: столько форвард-окна получит
    // кандидат. «Сейчас» — последний бар корпуса.
    const frozenAt = candles[candles.length - 2000].time;
    const nowSec = candles[candles.length - 1].time + 3600;

    const dbPath = tempDb();
    // Часы журнала задаются ЯВНО, и это не техническая деталь теста, а
    // свойство машины: момент заморозки = момент перехода в VALIDATED. С
    // реальными часами заморозка встала бы в «сегодня», корпус кончается
    // раньше, и ВСЕ сделки оказались бы до неё — инкубатор честно вернул бы
    // ноль. Ровно так это и выглядело бы в проде на отставшем корпусе.
    const ledger = new TrialLedger(dbPath, {
      now: () => new Date(frozenAt * 1000).toISOString(),
    });
    ledger.registerCandidates([ACTIVE_SPEC]);
    const id = ledger.byState("CANDIDATE")[0]!.candidateId;
    ledger.transition(id, "SCREENED", "дымовой прогон");
    ledger.transition(id, "VALIDATED", "дымовой прогон");
    // δ = (netExpectancy/2)/σ = 0.25 — выше входного порога 0.18, иначе
    // кандидат будет отвергнут на входе и цепочка не проверится.
    ledger.recordEval(id, "incubation_seed", {
      netExpectancy: 0.5,
      sigma: 1.0,
      symbols: symbols.join(","),
      tf: "1h",
    });
    ledger.close();

    const summary = await runIncubation({
      dbPath,
      source: corpusCandleSource(),
      nowSec: () => nowSec,
    });

    // Посев состоялся, вход не отверг.
    expect(summary.seeded).toBe(1);
    expect(summary.rejectedAtEntry).toBe(0);

    // Главное: форвард-сделки РЕАЛЬНО записаны в книгу. Ноль здесь означал бы,
    // что цепочка формально прошла, но ничего не измерила — ровно та тихая
    // поломка, которая через 365 дней стала бы вердиктом «край не доказан».
    const book = new IncubationBook(dbPath);
    const trades = book.trades(id);
    book.close();
    expect(summary.newTrades).toBeGreaterThan(0);
    expect(trades.length).toBe(summary.newTrades);

    // Все форвард-сделки строго ПОСЛЕ заморозки: иначе инкубатор считал бы
    // за доказательство то, на чём кандидат отбирался.
    expect(trades.every((t) => t.entryTime > frozenAt)).toBe(true);

    // Вердикт SPRT записан в журнал — значит решающий слой тоже отработал.
    const after = new TrialLedger(dbPath);
    const check = after.evalsFor(id, "incubation_check").at(-1);
    after.close();
    expect(check).toBeDefined();
    expect(Number.isFinite(Number(check!.metrics.llr))).toBe(true);
  }, 300_000);

  test("повторный прогон не удваивает сделки — догонка идемпотентна", async () => {
    const universe = listUniverse("1h");
    if (universe.length === 0) return;
    const { search } = splitHoldout(universe);
    const symbol = search.find((s) => (loadCandles(s, "1h")?.length ?? 0) > 5000);
    if (!symbol) return;

    const candles = loadCandles(symbol, "1h")!;
    const nowSec = candles[candles.length - 1].time + 3600;
    const frozenAt = candles[candles.length - 2000].time;
    const dbPath = tempDb();
    const ledger = new TrialLedger(dbPath, {
      now: () => new Date(frozenAt * 1000).toISOString(),
    });
    ledger.registerCandidates([ACTIVE_SPEC]);
    const id = ledger.byState("CANDIDATE")[0]!.candidateId;
    ledger.transition(id, "SCREENED", "дымовой прогон");
    ledger.transition(id, "VALIDATED", "дымовой прогон");
    ledger.recordEval(id, "incubation_seed", {
      netExpectancy: 0.5,
      sigma: 1.0,
      symbols: symbol,
      tf: "1h",
    });
    ledger.close();

    const opts = { dbPath, source: corpusCandleSource(), nowSec: () => nowSec };
    const first = await runIncubation(opts);
    const second = await runIncubation(opts);

    // Курсор двинулся, дубли отсекает БД: второй проход обязан дать НОЛЬ
    // новых сделок. Иначе каждый час удваивал бы выборку, и SPRT принимал бы
    // решение по несуществующим доказательствам.
    expect(first.newTrades).toBeGreaterThanOrEqual(0);
    expect(second.newTrades).toBe(0);
  }, 300_000);
});
