import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import type { TradeResult } from "../src/core/types/index.ts";
import { appendCardEvent, buildCard, cardFileName, quarterKellyPct, writeCard } from "./cards.ts";
import { cusumLower } from "./cusum.ts";
import { IncubationBook, type IncubationRow, type PaperTradeRow } from "./incubationBook.ts";
import { TrialLedger } from "./ledger.ts";
import { sampleCandidates } from "./grammar.ts";
import { runSupervision } from "./supervise.ts";

describe("cusum", () => {
  test("healthy stream (z≈0) never alarms", () => {
    const zs = Array.from({ length: 400 }, (_, i) => (i % 2 === 0 ? 0.4 : -0.4));
    expect(cusumLower(zs).alarmAt).toBe(0);
  });

  test("a 1σ degradation is caught in about 10 trades", () => {
    const degraded = Array.from({ length: 50 }, () => -1);
    const { alarmAt } = cusumLower(degraded);
    expect(alarmAt).toBeGreaterThanOrEqual(8);
    expect(alarmAt).toBeLessThanOrEqual(13);
  });

  test("recovery drains the sum back toward zero", () => {
    const zs = [...Array.from({ length: 6 }, () => -1), ...Array.from({ length: 20 }, () => 1)];
    expect(cusumLower(zs).s).toBe(0);
  });
});

const HOUR = 3600;
const T0 = 1_700_000_000;

const paperTrade = (entryTime: number, rMultiple: number): TradeResult => ({
  symbol: "TESTUSDT",
  direction: "long",
  entryTime,
  entryPrice: 100,
  exitTime: entryTime + 2 * HOUR,
  exitPrice: 100 + 2 * rMultiple,
  stopPrice: 98,
  targetPrice: 102,
  rMultiple,
  riskBudget: 2,
  won: rMultiple > 0,
  barsHeld: 2,
});

/** Сделка движка → строка книги: карточка читает именно её форму. */
const paperRow = (t: TradeResult): PaperTradeRow => ({
  symbol: t.symbol,
  direction: t.direction,
  entryTime: t.entryTime,
  entryPrice: t.entryPrice,
  stopPrice: t.stopPrice,
  // Знаменатель R хранится ОТДЕЛЬНО от стопа: стоп мутирует при переносе в
  // безубыток, и восстановленный из двух цен риск у таких сделок равен нулю.
  riskBudget: t.riskBudget,
  rMultiple: t.rMultiple,
  exitTime: t.exitTime,
});

describe("strategy card", () => {
  const spec = sampleCandidates(5, 1)[0];
  const inc: IncubationRow = {
    candidateId: "test-id",
    tf: "1h",
    symbols: ["BTCUSDT", "ETHUSDT"],
    mu1: 0.15,
    sigma: 1,
    expectedN: 80,
    frozenAt: T0,
    startedAt: new Date(T0 * 1000).toISOString(),
  };
  const trades = Array.from({ length: 45 }, (_, i) =>
    paperTrade(T0 + i * 24 * HOUR, i % 3 === 0 ? -1 : 1.4),
  ).map(paperRow);

  test("card carries rules in words, forward evidence, risk block and kill switch", () => {
    const card = buildCard({
      candidateId: "test-id",
      spec,
      incubation: inc,
      trades,
      graduationReason: "SPRT принял H1",
      clusterKey: "breakout:1h:long",
      graduatedAt: new Date((T0 + 150 * 86_400) * 1000).toISOString(),
    });
    expect(card).toContain("## Правила (повторяются руками)");
    expect(card).toContain("## Риск-блок (не обсуждается)");
    expect(card).toContain("## Стоп-кран");
    expect(card).toContain("BTCUSDT, ETHUSDT");
    expect(card).toContain("Сделок в инкубации: **45**");
    expect(card).not.toContain("undefined");
  });

  test("quarter-Kelly is capped at 1% and floors at 0.25%", () => {
    const monster = Array.from({ length: 100 }, (_, i) => (i % 4 === 0 ? -1 : 2));
    expect(quarterKellyPct(monster)).toBe(1);
    const loser = Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? -1 : 0.5));
    expect(quarterKellyPct(loser)).toBe(0.25);
  });

  test("file name survives the | and + of a candidate id", () => {
    const dir = mkdtempSync(join(tmpdir(), "cards-"));
    const path = writeCard(dir, "a|b+c|s2t2b20", "# test");
    expect(path).toBe(join(dir, cardFileName("a|b+c|s2t2b20")));
    expect(readFileSync(path, "utf-8")).toBe("# test");
  });
});

/**
 * Журнал карточки. До сих пор ни один тест не создавал каталог карточек, из-за
 * чего КАЖДЫЙ appendCardEvent уходил в пустой catch: покрытие было ложным.
 */
describe("card event log", () => {
  const ID = "cand|x+y|s2t2b20";

  test("appendCardEvent really appends to an existing card file", () => {
    const dir = mkdtempSync(join(tmpdir(), "card-events-"));
    writeCard(dir, ID, "# карточка\n\n## Журнал событий\n\n- 2026-01-01 — выпуск (GRADUATED)\n");
    appendCardEvent(dir, ID, "2026-02-01 — ⚠️ DECAYING: тревога CUSUM");
    appendCardEvent(dir, ID, "2026-03-01 — 🪦 RETIRED: край умер");
    const lines = readFileSync(join(dir, cardFileName(ID)), "utf-8").trimEnd().split("\n");
    // append-only по духу: старые строки на месте, новые в хвосте и по порядку
    expect(lines).toContain("- 2026-01-01 — выпуск (GRADUATED)");
    expect(lines.at(-2)).toBe("- 2026-02-01 — ⚠️ DECAYING: тревога CUSUM");
    expect(lines.at(-1)).toBe("- 2026-03-01 — 🪦 RETIRED: край умер");
  });

  test("missing cards directory is swallowed — supervision never dies over a file", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "card-events-")), "нет-такого-каталога");
    expect(() => appendCardEvent(dir, ID, "2026-02-01 — событие")).not.toThrow();
    expect(existsSync(dir)).toBe(false);
  });

  test("directory without a card: the event creates an orphan file (current behaviour)", () => {
    const dir = mkdtempSync(join(tmpdir(), "card-events-"));
    appendCardEvent(dir, ID, "2026-02-01 — событие без карточки");
    // СПОРНО: комментарий в cards.ts обещает «карточки нет — событие живёт в
    // журнале БД», но флаг 'a' создаёт файл, и catch ловит только отсутствие
    // каталога. На диске появляется .md без правил и риск-блока. Продкод не
    // трогаем — тест фиксирует то, как код ведёт себя сейчас.
    expect(readFileSync(join(dir, cardFileName(ID)), "utf-8")).toBe(
      "- 2026-02-01 — событие без карточки\n",
    );
  });
});

describe("supervision lifecycle", () => {
  let dbPath: string;
  let cardsDir: string;
  const spec = sampleCandidates(5, 1)[0];
  let id: string;

  /** Проводит кандидата до GRADUATED с контролируемым временем выпуска. */
  const setupGraduate = (gradAtSec: number, incubationTrades: TradeResult[]) => {
    let calls = 0;
    // Порядок вызовов now(): регистрация, затем 4 перехода — последний = выпуск.
    const times = [T0, T0 + 1000, T0 + 2000, T0 + 3000, gradAtSec];
    const ledger = new TrialLedger(dbPath, {
      now: () => new Date((times[Math.min(calls++, times.length - 1)] ?? gradAtSec) * 1000).toISOString(),
    });
    ledger.registerCandidates([spec]);
    id = [...ledger.allCandidateIds()][0];
    ledger.transition(id, "SCREENED", "тест");
    ledger.transition(id, "VALIDATED", "тест");
    ledger.transition(id, "INCUBATING", "тест");
    ledger.transition(id, "GRADUATED", "SPRT принял H1 (тест)");
    ledger.close();
    const book = new IncubationBook(dbPath);
    book.start({
      candidateId: id,
      tf: "1h",
      symbols: ["TESTUSDT"],
      mu1: 0.15,
      sigma: 1,
      expectedN: 80,
      frozenAt: T0,
    });
    book.recordTrades(id, incubationTrades);
    book.close();
    // Карточка выпускника обязана лежать на диске: без неё каждый
    // appendCardEvent надзора молча проваливается в catch, и «покрытие»
    // событий карточки оказывается покрытием пустоты.
    writeCard(
      cardsDir,
      id,
      buildCard({
        candidateId: id,
        spec,
        incubation: {
          candidateId: id,
          tf: "1h",
          symbols: ["TESTUSDT"],
          mu1: 0.15,
          sigma: 1,
          expectedN: 80,
          frozenAt: T0,
          startedAt: new Date(T0 * 1000).toISOString(),
        },
        trades: incubationTrades.map(paperRow),
        graduationReason: "SPRT принял H1 (тест)",
        clusterKey: "test-cluster",
        graduatedAt: new Date(gradAtSec * 1000).toISOString(),
      }),
    );
  };

  const cardText = () => readFileSync(join(cardsDir, cardFileName(id)), "utf-8");

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "supervise-"));
    dbPath = join(dir, "trials.sqlite");
    cardsDir = join(dir, "cards");
  });

  const incubationSet = (gradAt: number) =>
    Array.from({ length: 30 }, (_, i) => paperTrade(T0 + i * 12 * HOUR, i % 3 === 0 ? -1 : 1.2)).filter(
      (t) => t.exitTime <= gradAt,
    );

  test("healthy graduate stays graduated", async () => {
    const gradAt = T0 + 40 * 86_400;
    setupGraduate(gradAt, incubationSet(gradAt));
    const book = new IncubationBook(dbPath);
    // после выпуска — тот же характер потока
    book.recordTrades(
      id,
      Array.from({ length: 25 }, (_, i) => paperTrade(gradAt + (i + 1) * 12 * HOUR, i % 3 === 0 ? -1 : 1.2)),
    );
    book.close();
    const summary = await runSupervision({
      dbPath,
      source: async () => [],
      nowSec: () => gradAt + 30 * 86_400,
      vaultCardsDir: cardsDir,
    });
    expect(summary.supervised).toBe(1);
    expect(summary.decayed).toEqual([]);
    const ledger = new TrialLedger(dbPath);
    expect(ledger.getTrial(id)!.state).toBe("GRADUATED");
    ledger.close();
    // здоровье — это отсутствие записей: журнал карточки не трогали
    expect(cardText()).not.toContain("⚠️");
    expect(cardText()).not.toContain("🪦");
  });

  test("degraded graduate → DECAYING, then dead stream → RETIRED", async () => {
    const gradAt = T0 + 40 * 86_400;
    setupGraduate(gradAt, incubationSet(gradAt));
    const book = new IncubationBook(dbPath);
    // после выпуска — сплошные стопы: деградация ~1.5σ против эталона
    book.recordTrades(
      id,
      Array.from({ length: 20 }, (_, i) => paperTrade(gradAt + (i + 1) * 12 * HOUR, -1)),
    );
    book.close();

    const opts = {
      dbPath,
      source: async () => [],
      nowSec: () => gradAt + 30 * 86_400,
      vaultCardsDir: cardsDir,
    };
    const first = await runSupervision(opts);
    expect(first.decayed).toEqual([id]);

    // В деградации продолжает лить — SPRT добивает.
    //
    // Сделки разнесены по ОДНОЙ на день и их сорок, а не пятнадцать по две:
    // реквалификация переведена на ДНЕВНЫЕ наблюдения, как и инкубатор
    // (раньше здесь оставался посделочный счёт — путь, пропущенный при
    // переводе, и он давал ложное принятие 14.5% вместо ≤5.6%). Дневной тест
    // требует больше свидетельств на тот же вердикт, и это его цена: пятнадцать
    // сделок за восемь дней теперь честно недостаточны, чтобы кого-то
    // похоронить.
    const book2 = new IncubationBook(dbPath);
    book2.recordTrades(
      id,
      Array.from({ length: 40 }, (_, i) => paperTrade(gradAt + (33 + i) * 24 * HOUR, -1)),
    );
    book2.close();
    const second = await runSupervision({ ...opts, nowSec: () => gradAt + 80 * 86_400 });
    expect(second.retired).toEqual([id]);
    const ledger = new TrialLedger(dbPath);
    expect(ledger.getTrial(id)!.state).toBe("RETIRED");
    ledger.close();
    // оба вердикта дописаны в журнал СУЩЕСТВУЮЩЕЙ карточки, с датой прогона
    const card = cardText();
    expect(card).toContain("⚠️ DECAYING: CUSUM-тревога");
    expect(card).toContain("Торговлю по карточке остановить.");
    expect(card).toContain("🪦 RETIRED: край не восстановился (SPRT)");
    expect(card).toContain(
      `- ${new Date((gradAt + 80 * 86_400) * 1000).toISOString().slice(0, 10)} — 🪦`,
    );
  });

  test("recovered decayer gets its single requalification", async () => {
    const gradAt = T0 + 40 * 86_400;
    setupGraduate(gradAt, incubationSet(gradAt));
    const book = new IncubationBook(dbPath);
    book.recordTrades(
      id,
      Array.from({ length: 15 }, (_, i) => paperTrade(gradAt + (i + 1) * 12 * HOUR, -1)),
    );
    book.close();
    const opts = { dbPath, source: async () => [], vaultCardsDir: cardsDir };
    const first = await runSupervision({ ...opts, nowSec: () => gradAt + 20 * 86_400 });
    expect(first.decayed).toEqual([id]);

    // после тревоги (decayAt = gradAt+20д) поток снова сильный — SPRT доказывает
    const book2 = new IncubationBook(dbPath);
    book2.recordTrades(
      id,
      Array.from({ length: 30 }, (_, i) => paperTrade(gradAt + (45 + i) * 12 * HOUR, 1.5)),
    );
    book2.close();
    const second = await runSupervision({ ...opts, nowSec: () => gradAt + 50 * 86_400 });
    expect(second.requalified).toEqual([id]);
    const ledger = new TrialLedger(dbPath);
    expect(ledger.getTrial(id)!.state).toBe("GRADUATED");
    ledger.close();
    expect(cardText()).toContain("✅ реквалификация: SPRT заново доказал край");
  });

  /**
   * Ветка, которой в проде не было ни разу: вторая реквалификация. SPRT снова
   * «за», но лимит «одна за жизнь» исчерпан — ledger.transition бросает, а
   * supervise ловит исключение ПО ПОДСТРОКЕ русского текста «уже использована»
   * и превращает отказ в пенсию. Никакой типизированной связи между файлами
   * нет, поэтому здесь она проверяется сквозным прогоном.
   */
  test("second requalification is refused and turns into RETIRED", async () => {
    const gradAt = T0 + 40 * 86_400;
    setupGraduate(gradAt, incubationSet(gradAt));
    const opts = { dbPath, source: async () => [], vaultCardsDir: cardsDir };
    const add = (from12h: number, count: number, rMultiple: number) => {
      const book = new IncubationBook(dbPath);
      book.recordTrades(
        id,
        Array.from({ length: count }, (_, i) => paperTrade(T0 + (from12h + i) * 12 * HOUR, rMultiple)),
      );
      book.close();
    };

    // 1. первая деградация (gradAt = T0+80·12ч, сплошные стопы после выпуска)
    add(81, 15, -1);
    const first = await runSupervision({ ...opts, nowSec: () => gradAt + 20 * 86_400 });
    expect(first.decayed).toEqual([id]);

    // 2. единственная за жизнь реквалификация
    add(125, 30, 1.5);
    const second = await runSupervision({ ...opts, nowSec: () => gradAt + 50 * 86_400 });
    expect(second.requalified).toEqual([id]);

    // 3. вторая деградация — CUSUM считает от НОВОГО выпуска, эталон прежний
    add(182, 15, -1);
    const third = await runSupervision({ ...opts, nowSec: () => gradAt + 65 * 86_400 });
    expect(third.decayed).toEqual([id]);

    // 4. SPRT снова принял H1, но билет уже потрачен → пенсия, а не выпуск
    add(214, 30, 1.5);
    const fourth = await runSupervision({ ...opts, nowSec: () => gradAt + 90 * 86_400 });
    expect(fourth.requalified).toEqual([]);
    expect(fourth.retired).toEqual([id]);

    const ledger = new TrialLedger(dbPath);
    expect(ledger.getTrial(id)!.state).toBe("RETIRED");
    const history = ledger.transitionsFor(id);
    expect(
      history.filter((t) => t.fromState === "DECAYING" && t.toState === "GRADUATED").length,
    ).toBe(1);
    expect(history.at(-1)).toMatchObject({
      fromState: "DECAYING",
      toState: "RETIRED",
      reason: "вторая деградация после единственной реквалификации",
    });
    // решение принято по SPRT-«за», а не по молчанию: журнал это фиксирует
    expect(ledger.evalsFor(id, "requalification_check").at(-1)!.metrics.decision).toBe("accept");
    ledger.close();

    const card = cardText();
    expect(card).toContain("✅ реквалификация");
    expect(card).toContain("🪦 RETIRED: вторая деградация — карточка закрыта навсегда");
  });
});

/**
 * Пин на текстовый контракт между ledger.ts и supervise.ts: пенсия за вторую
 * реквалификацию наступает только потому, что supervise ищет в сообщении об
 * ошибке подстроку «уже использована». Переименование текста в ledger.ts не
 * ломает ни типы, ни компиляцию — оно превращает штатный переход в пенсию в
 * НЕПЕРЕХВАЧЕННОЕ исключение посреди ночного прогона (см. supervise.ts:150).
 */
describe("ledger ↔ supervise text contract", () => {
  test("the second DECAYING→GRADUATED throws with the substring supervise catches", () => {
    const ledger = new TrialLedger(":memory:");
    const spec = sampleCandidates(5, 1)[0];
    ledger.registerCandidates([spec]);
    const candidate = [...ledger.allCandidateIds()][0];
    for (const to of ["SCREENED", "VALIDATED", "INCUBATING", "GRADUATED", "DECAYING", "GRADUATED", "DECAYING"] as const) {
      ledger.transition(candidate, to, "тест");
    }
    let message = "";
    try {
      ledger.transition(candidate, "GRADUATED", "вторая реквалификация");
    } catch (error) {
      message = String(error);
    }
    expect(message.includes("уже использована")).toBe(true);
    ledger.close();
  });
});
