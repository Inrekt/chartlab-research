import { describe, expect, test } from "vitest";
import type { TradeResult } from "../src/core/types/index.ts";
import {
  candidateId,
  enumerateAll,
  exitsFor,
  familySpaceSize,
  grammarSize,
  resolveUniverse,
  setupFamily,
  toStrategyConfig,
  type CandidateSpec,
  type SwingExit,
} from "./grammar.ts";
import { neighborSpecs } from "./screen.ts";
import { fnv1a } from "./hash.ts";
import { computeMembership, monthStartSec, prevMonthKey, type SymbolProfile } from "./universe.ts";
import {
  isNoDivision,
  memberUnits,
  netT,
  orderUnits,
  PoolTrades,
  yearOf,
  type PoolUnit,
} from "./unitScreen.ts";

const YEAR = 365 * 86_400;
const T0 = Date.UTC(2020, 0, 1) / 1000;

const profile = (
  symbol: string,
  notional: Record<string, number>,
  firstBarSec: number | null = T0,
  data: Record<string, string[]> = {},
): SymbolProfile => ({
  symbol,
  firstBarSec: firstBarSec ?? undefined,
  notional: new Map(Object.entries(notional)),
  dataMonths: (kind) => (data[kind] ? new Set(data[kind]) : null),
});

describe("P1: помесячное членство", () => {
  test("членство месяца M считается по нотионалу M−1, а не M", () => {
    // В M=2022-03 лидер по M−1 (февраль) — A, хотя по самому марту лидирует B.
    const a = profile("A", { "2022-02": 100, "2022-03": 1 });
    const b = profile("B", { "2022-02": 1, "2022-03": 100 });
    const m = computeMembership([a, b], { topN: 1, requiresData: [], minHistoryYears: 1 });
    expect(m.isMember("A", "2022-03")).toBe(true);
    expect(m.isMember("B", "2022-03")).toBe(false);
  });

  test("tier: первая половина ceil(n/2) — ликвидная, остальные — неликвидная, помесячно", () => {
    const ps = [
      profile("A", { "2022-01": 9, "2022-02": 1 }),
      profile("B", { "2022-01": 5, "2022-02": 1 }),
      profile("C", { "2022-01": 1, "2022-02": 1 }),
    ];
    const liquid = computeMembership(ps, { tier: "liquid", requiresData: [], minHistoryYears: 1 });
    const illiquid = computeMembership(ps, { tier: "illiquid", requiresData: [], minHistoryYears: 1 });
    expect(["A", "B", "C"].filter((s) => liquid.isMember(s, "2022-02"))).toEqual(["A", "B"]);
    expect(["A", "B", "C"].filter((s) => illiquid.isMember(s, "2022-02"))).toEqual(["C"]);
  });

  test("minHistoryYears: нужно ≥ N лет баров окна ДО начала месяца", () => {
    const young = profile("Y", { "2020-12": 1, "2021-01": 1, "2021-02": 1 }, Date.UTC(2020, 5, 1) / 1000);
    const m = computeMembership([young], { requiresData: [], minHistoryYears: 1 });
    expect(m.isMember("Y", "2021-01")).toBe(false); // ещё нет года истории
    expect(m.isMember("Y", "2021-07")).toBe(false);
    expect(monthStartSec("2021-07") - Date.UTC(2020, 5, 1) / 1000).toBeGreaterThanOrEqual(YEAR); // порог достигнут…
    const m2 = computeMembership([profile("Y", { "2021-06": 1, "2021-07": 1 }, Date.UTC(2020, 5, 1) / 1000)], { requiresData: [], minHistoryYears: 1 });
    expect(m2.isMember("Y", "2021-07")).toBe(true); // …и символ становится членом
    const old = profile("O", { "2021-12": 1, "2022-01": 1 }, T0);
    const mo = computeMembership([old], { requiresData: [], minHistoryYears: 1 });
    expect(mo.isMember("O", "2022-01")).toBe(true);
  });

  test("символ с нулевой историей окна никогда не член", () => {
    const ghost = profile("G", { "2021-01": 5, "2023-01": 5, "2023-02": 5 }, null);
    const m = computeMembership([ghost], { requiresData: [], minHistoryYears: 0 });
    expect(m.symbolsEver()).toEqual([]);
  });

  test("requiresData: нет ряда за месяц — не член месяца; свечные виды не проверяются", () => {
    const f = profile("F", { "2022-01": 1, "2022-02": 1 }, T0, { funding: ["2022-02"] });
    const need = computeMembership([f], { requiresData: ["funding"], minHistoryYears: 0 });
    expect(need.isMember("F", "2022-02")).toBe(true);
    expect(need.isMember("F", "2022-03")).toBe(false); // M−1 есть, фандинга в марте нет
    const candleOnly = computeMembership([f], { requiresData: ["trend", "location"], minHistoryYears: 0 });
    expect(candleOnly.isMember("F", "2022-02")).toBe(true);
    const unknown = computeMembership([f], { requiresData: ["nonsense"], minHistoryYears: 0 });
    expect(unknown.symbolsEver()).toEqual([]);
  });

  test("умолчание вселенной: срез сетапа, requiresContext, 1 год", () => {
    const u = resolveUniverse("trend_cross_50");
    expect(u).toMatchObject({ tier: undefined, minHistoryYears: 1 });
    expect(prevMonthKey("2022-01")).toBe("2021-12");
  });
});

describe("P2: символо-годы", () => {
  test("порядок — по fnv1a(соль:символ:год) и стабилен", () => {
    const units: PoolUnit[] = ["AAA", "BBB", "CCC"].flatMap((symbol) =>
      [2020, 2021, 2022].map((year) => ({ symbol, year })),
    );
    const ordered = orderUnits(units, 0xc0ffee);
    const hashes = ordered.map((u) => fnv1a(`${0xc0ffee}:${u.symbol}:${u.year}`));
    expect([...hashes].sort((a, b) => a - b)).toEqual(hashes);
    expect(orderUnits([...units].reverse(), 0xc0ffee)).toEqual(ordered);
  });

  test("memberUnits: только годы членства до границы окна", () => {
    const p = profile("A", { "2021-12": 1, "2022-01": 1, "2022-12": 1, "2023-01": 1 }, T0);
    const m = computeMembership([p], { requiresData: [], minHistoryYears: 1 });
    const units = memberUnits(m, ["A"], Date.UTC(2023, 0, 1) / 1000, 1);
    expect(units.map((u) => u.year).sort()).toEqual([2022]);
  });

  test("порог «без деления»: пространство < 2000 ИЛИ вселенная ≤ 48", () => {
    expect(isNoDivision(1999, 300)).toBe(true);
    expect(isNoDivision(2000, 300)).toBe(false);
    expect(isNoDivision(5000, 48)).toBe(true);
    expect(isNoDivision(5000, 49)).toBe(false);
    expect(familySpaceSize("trend_following")).toBeGreaterThan(0);
  });

  test("t_net: mean/sd·√n, выборочное sd", () => {
    expect(netT([1, 1, 1])).toBe(Infinity);
    expect(netT([-1, -1])).toBe(-Infinity);
    const rs = [1, -1, 2, 0];
    const mean = 0.5;
    const sd = Math.sqrt(((0.5) ** 2 + 1.5 ** 2 + 1.5 ** 2 + 0.5 ** 2) / 3);
    expect(netT(rs)).toBeCloseTo((mean * 2) / sd, 10);
  });

  const trade = (symbol: string, time: number): TradeResult =>
    ({ symbol, entryTime: time, rMultiple: 0.1 }) as TradeResult;
  const spec = { setup: "trend_cross_50", direction: "long", timeframe: "4h", filters: [], exit: exitsFor("trend_cross_50", "4h")[0] } as CandidateSpec;

  test("take: единицы по порядку до бюджета, стадия B продолжает тот же порядок; чужие месяцы не считаются", () => {
    const units: PoolUnit[] = [
      { symbol: "A", year: 2021 },
      { symbol: "B", year: 2021 },
      { symbol: "A", year: 2022 },
    ];
    const t2021 = Date.UTC(2021, 5, 1) / 1000;
    const t2022 = Date.UTC(2022, 5, 1) / 1000;
    const runs: string[] = [];
    const pool = new PoolTrades({
      runSymbol: (symbol) => {
        runs.push(symbol);
        // по 3 сделки в каждом из годов 2021/2022, одна из них вне членства
        const trades = [trade(symbol, t2021), trade(symbol, t2021 + 1), trade(symbol, t2021 + 2), trade(symbol, t2022)];
        return new Map([[candidateId(spec), trades]]);
      },
      isMember: (_s, t) => t !== t2021 + 2,
    });
    const a = pool.take([spec], units, 4, 1).get(candidateId(spec))!;
    expect(a.unitsUsed).toBe(2); // A-2021 (2) + B-2021 (2) = 4
    expect(a.trades).toHaveLength(4);
    expect(a.exhausted).toBe(false);
    const b = pool.take([spec], units, 100, 1).get(candidateId(spec))!;
    expect(b.exhausted).toBe(true);
    expect(b.trades).toHaveLength(5); // + A-2022 (1)
    expect(b.trades.slice(0, 4)).toEqual(a.trades); // префикс стадии A
    expect(runs.filter((s) => s === "A")).toHaveLength(1); // символ гонялся один раз
    expect(yearOf(t2021)).toBe(2021);
  });
});

describe("P7: свинговые выходы", () => {
  test("4h/1d: три выхода на сетап по умолчанию rr 2/3/5, стоп 2; 1h — старые 27", () => {
    const swing = exitsFor("trend_cross_50", "4h") as readonly SwingExit[];
    expect(swing.map((e) => [e.type, e.value, e.stopAtr])).toEqual([
      ["rr", 2, 2],
      ["rr", 3, 2],
      ["rr", 5, 2],
    ]);
    expect(exitsFor("trend_cross_50", "1d")).toHaveLength(3);
    expect(exitsFor("trend_cross_50", "1h")).toHaveLength(27);
    expect(exitsFor("trend_cross_50")).toHaveLength(27);
  });

  test("grammarSize совпадает с перечислением; в нём нет свинга на 1h", () => {
    let n = 0;
    for (const s of enumerateAll()) {
      n += 1;
      if (s.timeframe === "1h") expect((s.exit as { kind?: string }).kind).not.toBe("swing");
    }
    expect(n).toBe(grammarSize());
  });

  test("тег id отличен от старых кодировок", () => {
    const base = { setup: "trend_cross_50", direction: "long", timeframe: "4h", filters: [] } as const;
    const id = candidateId({ ...base, exit: { kind: "swing", type: "rr", value: 5, stopAtr: 2 } });
    expect(id).toContain("sw:rr:5:s2");
    expect(id).not.toMatch(/\|s\d/);
  });

  const mk = (type: SwingExit["type"], value: number, stopAtr = 2): CandidateSpec => ({
    setup: "trend_cross_50",
    direction: "long",
    timeframe: "4h",
    filters: [],
    exit: { kind: "swing", type, value, stopAtr },
  });

  test("toStrategyConfig: rr, trail и time", () => {
    expect(toStrategyConfig(mk("rr", 3)).exit).toMatchObject({
      stopLoss: { type: "atr", value: 2 },
      takeProfit: { type: "rr", value: 3 },
      maxBarsInTrade: 60,
    });
    const trail = toStrategyConfig(mk("trail", 4)).exit;
    expect(trail).toMatchObject({ takeProfit: { type: "none", value: 0 }, trailingStop: { atr: 4 }, maxBarsInTrade: 60 });
    const time = toStrategyConfig(mk("time", 40)).exit;
    expect(time).toMatchObject({ takeProfit: { type: "none", value: 0 }, maxBarsInTrade: 40 });
    expect(time.trailingStop).toBeUndefined();
  });

  test("соседи: ±1 шаг параметра и стоп 1.5/2.5", () => {
    const ns = neighborSpecs(mk("rr", 3)).map((n) => n.exit as SwingExit);
    expect(ns.map((e) => [e.value, e.stopAtr])).toEqual([[2, 2], [5, 2], [3, 1.5], [3, 2.5]]);
    const edge = neighborSpecs(mk("trail", 2)).map((n) => n.exit as SwingExit);
    expect(edge.map((e) => [e.value, e.stopAtr])).toEqual([[3, 2], [2, 1.5], [2, 2.5]]);
  });

  test("семейства с собственным пулом выходов (фандинг) не меняются", () => {
    const fam = [...enumerateAll()].find((s) => setupFamily(s.setup) === "funding_pressure")!;
    expect((fam.exit as { kind?: string }).kind).not.toBe("swing");
    expect(familySpaceSize("funding_pressure")).toBeLessThan(2000);
  });
});
