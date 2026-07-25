import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import type { Candle } from "../src/core/types/index.ts";
import type { CandidateSpec } from "./grammar.ts";
import { runIncubation } from "./incubate.ts";
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
const T0 = 1_700_000_000;
const BARS = 2000;
const MARKET = syntheticCandles(BARS, T0, HOUR);
const END = T0 + BARS * HOUR;

describe("incubation flow on a synthetic market", () => {
  let dbPath: string;

  const seedValidated = (netExpectancy: number, frozenIso: string) => {
    const tick = { value: 0 };
    const ledger = new TrialLedger(dbPath, {
      // updatedAt последнего перехода = момент заморозки — управляем им явно
      now: () => (tick.value++ < 3 ? "2023-11-01T00:00:00.000Z" : frozenIso),
    });
    ledger.registerCandidates([SPEC]);
    const id = ledger.allCandidateIds().values().next().value as string;
    ledger.transition(id, "SCREENED", "тест");
    ledger.recordEval(id, "incubation_seed", {
      netExpectancy,
      sigma: 1,
      symbols: "TESTUSDT",
      tf: "1h",
    });
    ledger.transition(id, "VALIDATED", "тест"); // updatedAt := frozenIso
    ledger.close();
    return id;
  };

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
