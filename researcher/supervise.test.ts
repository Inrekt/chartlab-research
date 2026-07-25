import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import type { TradeResult } from "../src/core/types/index.ts";
import { buildCard, cardFileName, quarterKellyPct, writeCard } from "./cards.ts";
import { cusumLower } from "./cusum.ts";
import { IncubationBook, type IncubationRow } from "./incubationBook.ts";
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
  won: rMultiple > 0,
  barsHeld: 2,
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
  ).map((t) => ({
    symbol: t.symbol,
    direction: t.direction,
    entryTime: t.entryTime,
    entryPrice: t.entryPrice,
    stopPrice: t.stopPrice,
    rMultiple: t.rMultiple,
    exitTime: t.exitTime,
  }));

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
  };

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

    // в деградации продолжает лить (сделки ПОСЛЕ тревоги) — SPRT добивает
    const book2 = new IncubationBook(dbPath);
    book2.recordTrades(
      id,
      Array.from({ length: 15 }, (_, i) => paperTrade(gradAt + (65 + i) * 12 * HOUR, -1)),
    );
    book2.close();
    const second = await runSupervision({ ...opts, nowSec: () => gradAt + 60 * 86_400 });
    expect(second.retired).toEqual([id]);
    const ledger = new TrialLedger(dbPath);
    expect(ledger.getTrial(id)!.state).toBe("RETIRED");
    ledger.close();
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
  });
});
