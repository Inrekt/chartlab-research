import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import type { Candle, TradeResult } from "../src/core/types/index.ts";
import { cardFileName } from "./cards.ts";
import type { CandidateSpec } from "./grammar.ts";
import {
  catchUpTrades,
  ENTRY_GATE_DELTA,
  MAX_INCUBATION_DAYS,
  MIN_GRADUATION_TRADES,
  runIncubation,
  corpusCandleSource,
  type CandleSource,
} from "./incubate.ts";
import { ExchangeBlockedError } from "./binance.ts";
import { dailySigma, toDailyObservations, withinDayIcc } from "./sprt.ts";
import { IncubationBook } from "./incubationBook.ts";
import { TrialLedger } from "./ledger.ts";
import {
  expectedAcceptSampleSize,
  llrIncrement,
  SPRT_A,
  SPRT_B,
  sprtDecide,
} from "./sprt.ts";

describe("sprt math", () => {
  test("Wald bounds match the verified constants", () => {
    expect(SPRT_A).toBeCloseTo(2.8904, 3);
    expect(SPRT_B).toBeCloseTo(-2.2513, 3);
  });

  test("expected accept sample size reproduces the δ=0.25 table row (≈76)", () => {
    expect(expectedAcceptSampleSize(0.25, 1)).toBeGreaterThan(74);
    expect(expectedAcceptSampleSize(0.25, 1)).toBeLessThan(78);
    expect(expectedAcceptSampleSize(0, 1)).toBe(Number.POSITIVE_INFINITY);
  });

  test("strong wins accept quickly, consistent losses reject faster", () => {
    // μ1=0.5, σ=1: выигрыш +1 даёт +0.375 к LLR, проигрыш −1 даёт −0.625.
    expect(llrIncrement(1, 0.5, 1)).toBeCloseTo(0.375, 10);
    const accept = sprtDecide(Array.from({ length: 20 }, () => 1), 0.5, 1);
    expect(accept.decision).toBe("accept");
    expect(accept.stoppedAt).toBe(8); // 8 × 0.375 = 3.0 ≥ 2.8904
    const reject = sprtDecide(Array.from({ length: 20 }, () => -1), 0.5, 1);
    expect(reject.decision).toBe("reject");
    expect(reject.stoppedAt).toBe(4); // 4 × −0.625 = −2.5 ≤ −2.2513
  });

  test("stops at FIRST crossing — later trades cannot un-decide", () => {
    const rs = [...Array.from({ length: 8 }, () => 1), -1, -1, -1, -1, -1, -1];
    const result = sprtDecide(rs, 0.5, 1);
    expect(result.decision).toBe("accept");
    expect(result.stoppedAt).toBe(8);
  });

  test("mixed evidence keeps waiting", () => {
    expect(sprtDecide([1, -1, 1, -1], 0.5, 1).decision).toBe("continue");
    expect(sprtDecide([], 0.5, 1).decision).toBe("continue");
  });
});

/**
 * Синтетический рынок: синус вокруг растущей базы — close регулярно
 * пересекает SMA50 снизу вверх, у trend_cross_50 есть сигналы.
 */
function syntheticCandles(count: number, t0: number, tfSec: number): Candle[] {
  const out: Candle[] = [];
  let prevClose = 100;
  for (let i = 0; i < count; i++) {
    const close = 100 + i * 0.01 + 8 * Math.sin(i / 20);
    out.push({
      time: t0 + i * tfSec,
      open: prevClose,
      high: Math.max(prevClose, close) + 1,
      low: Math.min(prevClose, close) - 1,
      close,
      volume: 1000,
    });
    prevClose = close;
  }
  return out;
}

const SPEC: CandidateSpec = {
  setup: "trend_cross_50",
  direction: "long",
  timeframe: "1h",
  filters: [],
  exit: { stopAtr: 2, takeR: 1, maxBars: 10 },
};

const HOUR = 3600;
const DAY = 86_400;
const T0 = 1_700_000_000;
const BARS = 2000;
const MARKET = syntheticCandles(BARS, T0, HOUR);
const END = T0 + BARS * HOUR;

/**
 * Кандидат, доведённый до VALIDATED с управляемым моментом заморозки:
 * frozenAt берётся из времени ПЕРЕХОДА в VALIDATED, поэтому часы журнала
 * подменяются ровно на последнем вызове.
 */
function seedValidatedInto(
  dbPath: string,
  seedMetrics: Record<string, unknown>,
  frozenIso: string,
): string {
  const tick = { value: 0 };
  const ledger = new TrialLedger(dbPath, {
    // updatedAt последнего перехода = момент заморозки — управляем им явно
    now: () => (tick.value++ < 3 ? "2023-11-01T00:00:00.000Z" : frozenIso),
  });
  ledger.registerCandidates([SPEC]);
  const id = ledger.allCandidateIds().values().next().value as string;
  ledger.transition(id, "SCREENED", "тест");
  ledger.recordEval(id, "incubation_seed", seedMetrics);
  ledger.transition(id, "VALIDATED", "тест"); // updatedAt := frozenIso
  ledger.close();
  return id;
}

/**
 * Бумажная сделка с ценой входа 100 и стопом 98: риск = 2, круговая
 * стоимость 2·(0.0005+0.0005)·100 / 2 = ровно 0.1R. Значит netR = r − 0.1,
 * и нужный вход SPRT задаётся арифметикой, а не подгонкой рынка.
 */
const COST_R = 0.1;
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

describe("incubation flow on a synthetic market", () => {
  let dbPath: string;

  const seedValidated = (netExpectancy: number, frozenIso: string) =>
    seedValidatedInto(
      dbPath,
      { netExpectancy, sigma: 1, symbols: "TESTUSDT", tf: "1h" },
      frozenIso,
    );

  beforeEach(() => {
    dbPath = join(mkdtempSync(join(tmpdir(), "incubate-")), "trials.sqlite");
  });

  test("entry gate: expectancy below 0.20R is rejected, never incubated", async () => {
    const id = seedValidated(0.1, new Date((T0 + 1000 * HOUR) * 1000).toISOString());
    const summary = await runIncubation({
      dbPath,
      source: async () => MARKET,
      nowSec: () => END,
    });
    expect(summary.rejectedAtEntry).toBe(1);
    expect(summary.seeded).toBe(0);
    const ledger = new TrialLedger(dbPath);
    expect(ledger.getTrial(id)!.state).toBe("REJECTED");
    ledger.close();
  });

  test("изоляция кандидата: ExchangeBlockedError из тика ПРОБРАСЫВАЕТСЯ, не глотается", async () => {
    // Цикл инкубации теперь оборачивает КАЖДОГО кандидата в try/catch, чтобы
    // один сбойный не ронял инкубацию остальных. Но опасная половина этой
    // правки — случайно проглотить ГЛОБАЛЬНОЕ состояние: биржа закрыта для
    // ВСЕХ, и это не «ошибка кандидата», а причина остановить тик. Здесь
    // проверяется, что ExchangeBlockedError по-прежнему пробивается наружу, а
    // не тихо оседает в summary.errored — иначе блок юрисдикции выглядел бы как
    // единичный сбой, и кандидаты копили бы календарь молчания.
    seedValidated(0.5, new Date((T0 + 1000 * HOUR) * 1000).toISOString());
    const blocked: CandleSource = () => {
      throw new ExchangeBlockedError("451 — доступ закрыт по юрисдикции");
    };
    await expect(
      runIncubation({ dbPath, source: blocked, nowSec: () => END }),
    ).rejects.toThrow(/451|юрисдикц/);
  });

  test("freeze honesty: only bars after VALIDATED count as forward trades", async () => {
    const frozenAt = T0 + 1500 * HOUR; // сигналы есть и до, и после
    seedValidated(0.4, new Date(frozenAt * 1000).toISOString());
    const summary = await runIncubation({
      dbPath,
      source: async () => MARKET,
      nowSec: () => END,
    });
    expect(summary.seeded).toBe(1);
    expect(summary.newTrades).toBeGreaterThan(0);
    const book = new IncubationBook(dbPath);
    const id = new TrialLedger(dbPath).allCandidateIds().values().next().value as string;
    for (const trade of book.trades(id)) {
      expect(trade.entryTime).toBeGreaterThan(frozenAt);
    }
    book.close();
  });

  test("catch-up is idempotent: a second run records zero new trades", async () => {
    seedValidated(0.4, new Date((T0 + 1500 * HOUR) * 1000).toISOString());
    const opts = { dbPath, source: async () => MARKET, nowSec: () => END };
    const first = await runIncubation(opts);
    expect(first.newTrades).toBeGreaterThan(0);
    const second = await runIncubation(opts);
    expect(second.newTrades).toBe(0);
    expect(second.checked).toBeGreaterThanOrEqual(first.checked === 0 ? 0 : 1);
  });

  test("incubation_check eval lands in the ledger with an SPRT verdict", async () => {
    const id = seedValidated(0.4, new Date((T0 + 1500 * HOUR) * 1000).toISOString());
    await runIncubation({ dbPath, source: async () => MARKET, nowSec: () => END });
    const ledger = new TrialLedger(dbPath);
    const checks = ledger.evalsFor(id, "incubation_check");
    expect(checks.length).toBe(1);
    expect(["accept", "reject", "continue"]).toContain(checks[0].metrics.decision);
    ledger.close();
  });
});

/**
 * Терминальные вердикты инкубатора. В проде за 28 370 испытаний ни один
 * кандидат не дошёл до VALIDATED, поэтому весь этот код НИ РАЗУ не исполнялся
 * — ни выпуск с карточкой, ни три ветки KILLED. Первый настоящий выпускник
 * стал бы первым исполнением, и любой отказ здесь всплыл бы на живой машине.
 *
 * Метод: инкубация запускается пустым источником свечей (посев + регистрация
 * в книге), затем книга наполняется сделками с ЗАДАННЫМ netR, и второй запуск
 * выносит вердикт. Так вход SPRT — арифметика, а не свойство синтетики.
 */
describe("incubation terminal verdicts (never executed in production)", () => {
  let dbPath: string;
  let cardsDir: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "incubate-verdict-"));
    dbPath = join(dir, "trials.sqlite");
    cardsDir = join(dir, "Карточки");
  });

  /** Посев + первый (пустой) прогон: кандидат оказывается в INCUBATING. */
  const startIncubation = async (netExpectancy: number, frozenAt: number) => {
    const id = seedValidatedInto(
      dbPath,
      { netExpectancy, sigma: 1, symbols: "TESTUSDT", tf: "1h" },
      new Date(frozenAt * 1000).toISOString(),
    );
    const summary = await runIncubation({
      dbPath,
      source: async () => [],
      nowSec: () => frozenAt + DAY,
    });
    expect(summary.seeded).toBe(1);
    return id;
  };

  /** Кладёт в книгу count сделок с нужным netR (r = netR + стоимость). */
  const fillBook = (id: string, count: number, netR: number, from: number, stepSec: number) => {
    const book = new IncubationBook(dbPath);
    const inserted = book.recordTrades(
      id,
      Array.from({ length: count }, (_, i) => paperTrade(from + i * stepSec, netR + COST_R)),
    );
    book.close();
    expect(inserted).toBe(count);
  };

  const lastReason = (id: string) => {
    const ledger = new TrialLedger(dbPath);
    const row = ledger.transitionsFor(id).at(-1)!;
    ledger.close();
    return row;
  };

  test("GRADUATED: card is really written to disk, with rules and a risk block", async () => {
    const frozenAt = T0;
    // netExpectancy 0.4 → μ1=0.2, σ=1 → δ=0.20 ≥ 0.18: входной билет v3
    const id = await startIncubation(0.4, frozenAt);
    // 45 сделок по +1.0R нетто: приращение LLR 0.18 → SPRT принимает на 17-й,
    // а 45 ≥ 40 сделок и 150 ≥ 120 дней закрывают календарный ценз 1h.
    fillBook(id, 45, 1, frozenAt + 2 * DAY, 3 * DAY);

    const logs: string[] = [];
    const summary = await runIncubation({
      dbPath,
      source: async () => [],
      nowSec: () => frozenAt + 150 * DAY,
      vaultCardsDir: cardsDir,
      log: (m) => logs.push(m),
    });

    expect(summary.graduated).toEqual([id]);
    expect(summary.killed).toEqual([]);
    const ledger = new TrialLedger(dbPath);
    expect(ledger.getTrial(id)!.state).toBe("GRADUATED");
    ledger.close();

    const path = join(cardsDir, cardFileName(id));
    expect(existsSync(path)).toBe(true);
    expect(logs.some((m) => m.includes("карточка выпускника") && m.includes(path))).toBe(true);

    const card = readFileSync(path, "utf-8");
    // правила стратегии — словами, а не ссылкой на спеку
    expect(card).toContain("## Правила (повторяются руками)");
    expect(card).toContain("Вход, когда цена закрытия пересекает SMA50 в сторону сделки");
    expect(card).toContain("**Стоп:** 2 × ATR(14) от цены входа");
    expect(card).toContain("**Тейк:** 1R");
    expect(card).toContain("**Инструменты:** TESTUSDT");
    // риск-блок
    expect(card).toContain("## Риск-блок (не обсуждается)");
    expect(card).toMatch(/\*\*Размер позиции: \d+\.\d\d% счёта\*\*/);
    expect(card).toContain("Просадка счёта −10%");
    expect(card).toContain("## Стоп-кран");
    // доказательства — из книги, а не из бэктеста
    expect(card).toContain(`Сделок в инкубации: **${MIN_GRADUATION_TRADES + 5}** за 150 дней`);
    expect(card).toContain(`candidate: "${id}"`);
    expect(card).not.toContain("undefined");
    expect(card).not.toContain("NaN");
  });

  test("KILLED: SPRT accepts H0 — the edge did not survive live", async () => {
    const frozenAt = T0;
    const id = await startIncubation(0.4, frozenAt);
    // netR = −1.0 → приращение −0.22; 11 сделок дают −2.42 ≤ −2.2513
    fillBook(id, 12, -1, frozenAt + 2 * DAY, DAY);

    const summary = await runIncubation({
      dbPath,
      source: async () => [],
      nowSec: () => frozenAt + 30 * DAY,
      vaultCardsDir: cardsDir,
    });

    expect(summary.killed).toEqual([id]);
    expect(summary.graduated).toEqual([]);
    const last = lastReason(id);
    expect(last.toState).toBe("KILLED");
    expect(last.reason).toContain("SPRT принял H0");
    // Единица наблюдения теперь ДЕНЬ, а не сделка. Здесь по одной сделке в
    // сутки, поэтому счёт совпадает — и это ровно то, чего мы хотим: при
    // отсутствии перекрытия дневная агрегация тождественна посделочной.
    expect(last.reason).toContain("после 11 дней");
    // карточки у убитого кандидата быть не должно
    expect(existsSync(join(cardsDir, cardFileName(id)))).toBe(false);
  });

  test("KILLED by trade truncation: 3×E[N] trades without an SPRT verdict", async () => {
    const frozenAt = T0;
    // netExpectancy 1.0 → μ1=0.5, δ=0.5 → E[N]≈19, потолок 3×E[N] = 58 сделок
    const id = await startIncubation(1.0, frozenAt);
    const cap = Math.ceil(3 * expectedAcceptSampleSize(0.5, 1));
    expect(cap).toBe(58);
    // netR ровно μ1/2 = 0.25 → приращение LLR нулевое: SPRT молчит вечно,
    // и единственный выход — усечение по числу сделок.
    fillBook(id, cap, 0.5 / 2, frozenAt + 2 * DAY, DAY / 2);

    const summary = await runIncubation({
      dbPath,
      source: async () => [],
      nowSec: () => frozenAt + 60 * DAY, // календарь ещё не исчерпан
    });

    expect(summary.killed).toEqual([id]);
    const last = lastReason(id);
    expect(last.toState).toBe("KILLED");
    expect(last.reason).toBe(`усечение: ${cap} сделок ≥ ${cap} (3×E[N]) без решения SPRT`);
  });

  test("KILLED by calendar truncation: more than MAX_INCUBATION_DAYS undecided", async () => {
    const frozenAt = T0;
    const id = await startIncubation(0.4, frozenAt); // потолок сделок = 357
    // Сделок мало и они нейтральны (netR = μ1/2 = 0.1): ни SPRT, ни потолок
    // сделок не срабатывают — остаётся только календарь.
    fillBook(id, 10, 0.2 / 2, frozenAt + 2 * DAY, 10 * DAY);

    const summary = await runIncubation({
      dbPath,
      source: async () => [],
      nowSec: () => frozenAt + (MAX_INCUBATION_DAYS + 1) * DAY,
    });

    expect(summary.killed).toEqual([id]);
    const last = lastReason(id);
    expect(last.toState).toBe("KILLED");
    expect(last.reason).toBe(
      `усечение: ${MAX_INCUBATION_DAYS + 1} дней > ${MAX_INCUBATION_DAYS} без решения SPRT`,
    );
  });

  test("entry gate is in δ, not in absolute R: fat σ rejects a 0.30R candidate", async () => {
    // Старый порог (0.20R) такого кандидата пустил бы: μ1 = 0.30R. Но δ = 0.1,
    // то есть решения ждать ~1200 сделок — билет не по карману теста.
    const id = seedValidatedInto(
      dbPath,
      { netExpectancy: 0.6, sigma: 3, symbols: "TESTUSDT", tf: "1h" },
      new Date(T0 * 1000).toISOString(),
    );
    const summary = await runIncubation({
      dbPath,
      source: async () => [],
      nowSec: () => T0 + DAY,
    });
    expect(summary.rejectedAtEntry).toBe(1);
    expect(summary.seeded).toBe(0);
    const last = lastReason(id);
    expect(last.toState).toBe("REJECTED");
    expect(last.reason).toBe(
      `входной порог инкубатора: δ=0.100 < ${ENTRY_GATE_DELTA} (μ₁=0.300R, σ=3.00)`,
    );
  });

  test("NaN shield: a broken seed is rejected instead of incubating forever", async () => {
    // netExpectancy отсутствует (старый/битый формат посева) → Number(undefined)
    // = NaN. Без щита кандидат уехал бы в инкубатор с μ1=NaN, где SPRT вечно
    // «continue», и умер бы только по календарю через год.
    const id = seedValidatedInto(
      dbPath,
      { sigma: 1, symbols: "TESTUSDT", tf: "1h" },
      new Date(T0 * 1000).toISOString(),
    );
    const summary = await runIncubation({
      dbPath,
      source: async () => [],
      nowSec: () => T0 + DAY,
    });
    expect(summary.rejectedAtEntry).toBe(1);
    expect(summary.seeded).toBe(0);
    expect(lastReason(id).reason).toBe(
      "входной порог инкубатора: посев испорчен (netExpectancy=undefined, sigma=1)",
    );
    const book = new IncubationBook(dbPath);
    expect(book.get(id)).toBeUndefined();
    book.close();
  });

  /**
   * СПОРНО — тест фиксирует текущее (ошибочное) поведение, продкод не тронут.
   *
   * У netExpectancy щит от NaN есть, у sigma — нет. Посев БЕЗ ключа sigma
   * (старый формат скрина — ровно тот случай, ради которого написан щит выше)
   * даёт σ=NaN, δ=NaN, и проверка `delta < ENTRY_GATE_DELTA` пропускает
   * кандидата: NaN не меньше ничего. Дальше book.start() молча возвращает
   * false — NaN связывается как NULL и ломает NOT NULL, а INSERT OR IGNORE
   * это проглатывает; возвращаемое значение никто не проверяет. Кандидат
   * уходит в INCUBATING без строки в книге, и цикл решения вечно спотыкается
   * о `if (!inc) continue`. Календарное усечение стоит ПОСЛЕ этой проверки,
   * поэтому даже через год кандидат не умирает — он бессмертен и невидим.
   */
  test("seed without sigma is rejected too — no immortal ghost in INCUBATING", async () => {
    // Раньше NaN-щит стоял только на netExpectancy: Number(undefined) → NaN,
    // сравнение с порогом ложно, кандидат проходил, book.start() падал на
    // NOT NULL (проглочено INSERT OR IGNORE), а переход в INCUBATING всё
    // равно происходил. На каждом тике `if (!inc) continue` срабатывал ДО
    // проверок усечения — призрака не мог убить даже календарь.
    const id = seedValidatedInto(
      dbPath,
      { netExpectancy: 0.4, symbols: "TESTUSDT", tf: "1h" }, // sigma отсутствует
      new Date(T0 * 1000).toISOString(),
    );
    const seeded = await runIncubation({
      dbPath,
      source: async () => [],
      nowSec: () => T0 + DAY,
    });
    expect(seeded.rejectedAtEntry).toBe(1);
    expect(seeded.seeded).toBe(0);
    expect(lastReason(id).reason).toContain("посев испорчен");

    const book = new IncubationBook(dbPath);
    expect(book.get(id)).toBeUndefined();
    book.close();

    const ledger = new TrialLedger(dbPath);
    expect(ledger.getTrial(id)!.state).toBe("REJECTED"); // а не вечный INCUBATING
    ledger.close();
  });
});

describe("incubation book invariants", () => {
  test("paper trades are append-only and deduplicated at the DB level", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "book-")), "trials.sqlite");
    const book = new IncubationBook(dbPath);
    const trade = {
      symbol: "TESTUSDT",
      direction: "long" as const,
      entryTime: 111,
      entryPrice: 100,
      exitTime: 222,
      exitPrice: 102,
      stopPrice: 98,
      targetPrice: 104,
      rMultiple: 1,
      riskBudget: 2,
      won: true,
      barsHeld: 4,
    };
    expect(book.recordTrades("cand", [trade])).toBe(1);
    expect(book.recordTrades("cand", [trade])).toBe(0);
    const raw = (book as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    expect(() => raw.exec("UPDATE paper_trades SET r_multiple = 99")).toThrow(/append-only/);
    expect(() => raw.exec("DELETE FROM paper_trades")).toThrow(/append-only/);
    book.close();
  });
});

describe("отказ источника не выглядит как отсутствие края", () => {
  test("блокировка по юрисдикции роняет догонку, а не откладывает её", async () => {
    // 451 Unavailable For Legal Reasons: Binance закрывает доступ раннерам
    // GitHub (проверено зондом — 451 и на споте, и на перпах). Это НЕ сетевой
    // сбой: «догоним в следующий раз» повторялось бы каждый час, пока
    // кандидат не умрёт по календарю через 365 дней, и в журнал это записалось
    // бы как «не доказал край» — вывод о рынке вместо мёртвой инфраструктуры.
    const book = new IncubationBook(":memory:");
    const blocked: CandleSource = () => {
      throw new ExchangeBlockedError("451 — доступ закрыт по юрисдикции");
    };
    await expect(
      catchUpTrades(
        book,
        "cand-1",
        SPEC,
        { tf: "1h", symbols: ["BTCUSDT", "ETHUSDT"], frozenAt: 1_700_000_000 },
        blocked,
        () => 1_800_000_000,
        () => {},
      ),
    ).rejects.toThrow(/юрисдикц/);
    book.close();
  });

  test("падение ВСЕХ символов — тоже отказ источника, какой бы ни была причина", async () => {
    // Предохранитель шире, чем один код ответа: причину следующего отказа мы
    // предсказать не можем, а признак «не ответил никто» универсален.
    const book = new IncubationBook(":memory:");
    const dead: CandleSource = () => {
      throw new Error("ECONNRESET");
    };
    await expect(
      catchUpTrades(
        book,
        "cand-2",
        SPEC,
        { tf: "1h", symbols: ["A", "B", "C"], frozenAt: 1_700_000_000 },
        dead,
        () => 1_800_000_000,
        () => {},
      ),
    ).rejects.toThrow(/недоступен по ВСЕМ 3 символам/);
    book.close();
  });

  test("отказ ЧАСТИ символов по-прежнему прощается", async () => {
    // Дыра у одной монеты — нормальная жизнь, ронять из-за неё нельзя.
    const book = new IncubationBook(":memory:");
    const flaky: CandleSource = (symbol) => {
      if (symbol === "BAD") throw new Error("404");
      return Promise.resolve([]);
    };
    await expect(
      catchUpTrades(
        book,
        "cand-3",
        SPEC,
        { tf: "1h", symbols: ["BAD", "GOOD"], frozenAt: 1_700_000_000 },
        flaky,
        () => 1_800_000_000,
        () => {},
      ),
    ).resolves.toBe(0);
    book.close();
  });
});

describe("запасной источник — корпус", () => {
  test("НЕТ КОРПУСА — это отказ, а не пустота", async () => {
    // Раньше тут утверждалось обратное: на неизвестном символе источник
    // возвращал []. Это и была дыра. Пустой массив неотличим от нормального
    // «за этот час новых баров не появилось», потребитель молча пропускал
    // символ, счётчик отказов не рос, страж «упали ВСЕ символы» не срабатывал —
    // и кандидат копил календарь молчания, пока через 365 дней не умирал «не
    // доказавшим край». Отказ инфраструктуры записался бы в журнал как вывод
    // о рынке.
    //
    // Путь не гипотетический: в облаке корпус живёт в кэше раннера, и на
    // промахе кэша каталога нет вовсе.
    //
    // Один недостающий символ по-прежнему прощается — но НА УРОВНЕ ДОГОНКИ,
    // где он считается отказом и терпится, пока отказали не все.
    const source = corpusCandleSource();
    await expect(source("НЕТ-ТАКОГО", "1h", 0)).rejects.toThrow(/корпус не содержит/);
  });

  test("отставание источника на сутки не даёт заглянуть в будущее", async () => {
    // Ключ к тому, почему сутки отставания безвредны: источник обязан отдавать
    // только бары ПОСЛЕ запрошенного момента, а догонка сверху отсекает
    // незакрытые. Информации о будущем в этом нет ни при каком лаге.
    const source = corpusCandleSource();
    const bars = await source("BTCUSDT", "1h", 4_000_000_000);
    expect(bars.every((c) => c.time >= 4_000_000_000)).toBe(true);
  });
});

describe("SPRT решает по дням, а не по сделкам", () => {
  test("без перекрытия дневная агрегация ТОЖДЕСТВЕННА посделочной", () => {
    // Ключевое свойство: правка не меняет поведение там, где предпосылка
    // независимости и так выполнялась. Иначе это была бы не починка, а
    // подкрутка под желаемый результат.
    const netRs = Array.from({ length: 12 }, (_, i) => ({ day: i, net: -1 }));
    const daily = toDailyObservations(netRs);
    expect(daily).toHaveLength(12);
    expect(daily.every((d) => d.count === 1 && d.mean === -1)).toBe(true);
    // σ_день при одной сделке в дне равен σ при ЛЮБОЙ ρ.
    expect(dailySigma(1.0, 1, 0.45)).toBeCloseTo(1.0, 10);
    expect(dailySigma(1.0, 1, 0)).toBeCloseTo(1.0, 10);
  });

  test("σ дня растёт с корреляцией: при ρ=1 день — одна ставка", () => {
    // Границы формулы σ_день = σ·√((1+(m−1)ρ)/m). При ρ=0 три сделки в дне
    // дают σ/√3 (полная независимость), при ρ=1 — сам σ.
    expect(dailySigma(1.0, 3, 0)).toBeCloseTo(1 / Math.sqrt(3), 6);
    expect(dailySigma(1.0, 3, 1)).toBeCloseTo(1.0, 6);
    expect(dailySigma(1.0, 3, 0.44)).toBeGreaterThan(dailySigma(1.0, 3, 0.2));
  });

  test("ρ оценивается по данным и не уходит в минус на шуме", () => {
    // Отрицательная ICC на малой выборке — шум, а не отрицательная
    // корреляция. Пропустить её значило бы получить σ_день МЕНЬШЕ честного,
    // то есть тест мягче заявленного — ровно та ошибка, которую чиним.
    const noisy = Array.from({ length: 60 }, (_, i) => ({
      day: Math.floor(i / 2),
      net: i % 2 === 0 ? 1 : -1,
    }));
    const icc = withinDayIcc(noisy);
    expect(icc).not.toBeNull();
    expect(icc!.rho).toBeGreaterThanOrEqual(0);
    expect(icc!.meanPerDay).toBeCloseTo(2, 6);
  });

  test("мало данных → ρ не выдумывается, а сообщается как неизвестная", () => {
    // Вызывающий обязан подставить консервативную оценку сам. Вернуть здесь
    // ноль значило бы тихо соврать в мягкую сторону.
    expect(withinDayIcc([{ day: 1, net: 0.5 }])).toBeNull();
  });

  test("общий дневной фактор распознаётся как высокая ρ", () => {
    // Три сделки в дне, целиком определяемые дневным сдвигом → ρ близка к 1.
    const rows: { day: number; net: number }[] = [];
    for (let d = 0; d < 40; d++) {
      const shift = d % 2 === 0 ? 1 : -1;
      for (let k = 0; k < 3; k++) rows.push({ day: d, net: shift });
    }
    const icc = withinDayIcc(rows)!;
    expect(icc.rho).toBeGreaterThan(0.9);
    expect(icc.meanPerDay).toBeCloseTo(3, 6);
  });
});

describe("средняя сделок на день — по ВСЕМ дням, не только многосделочным", () => {
  test("одиночные дни входят в среднюю", () => {
    // Параметр в чужой семантике — тот же класс, что вырожденный стоп и
    // обнулённые издержки. Оценка ρ честно требует дней с двумя и более
    // сделками, но СРЕДНЯЯ уходит в σ_день, а дневные наблюдения строятся по
    // всем дням, включая одиночные.
    //
    // Цена замерена: при потоке 2.5 сделки в день средняя выходила 3.18 вместо
    // 2.54, σ_день занижалась на 10.7%, а шаг LLR (∝ 1/σ²) завышался на 22.6% —
    // тест был мягче заявленного, В ПОЛЬЗУ стратегии, и ложное принятие
    // подходило к 6% против объявленных 3.5%.
    const rows: { day: number; net: number }[] = [];
    // 30 дней по одной сделке и 30 дней по три: честная средняя ровно 2.0,
    // а по многосделочным — 3.0.
    for (let d = 0; d < 30; d++) rows.push({ day: d, net: 0.1 });
    for (let d = 30; d < 60; d++) for (let i = 0; i < 3; i++) rows.push({ day: d, net: -0.05 * i });
    const icc = withinDayIcc(rows)!;
    expect(icc).not.toBeNull();
    expect(icc.meanPerDay).toBeCloseTo(2.0, 6);
  });

  test("ρ по-прежнему считается только по многосделочным дням", () => {
    // Одиночный день не несёт информации о внутридневной корреляции: внутри
    // него сравнивать нечего. Смешать это с исправлением средней значило бы
    // сломать саму оценку ρ.
    const rows: { day: number; net: number }[] = [];
    for (let d = 0; d < 25; d++) for (let i = 0; i < 2; i++) rows.push({ day: d, net: d * 0.01 });
    const icc = withinDayIcc(rows)!;
    // Внутри дня разброса нет вовсе, между днями есть → ρ близка к единице.
    expect(icc.rho).toBeGreaterThan(0.9);
  });
});
