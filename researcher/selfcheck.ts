/**
 * Самокалибровка — машина проверяет собственные ворота шумом.
 *
 * Две проверки:
 * 1. SPRT-калибровка: тысячи симулированных «стратегий» с НУЛЕВЫМ краем
 *    кормят настоящий sprtDecide. Доля принятых обязана быть ≈ α (планка
 *    Вальда: α/(1−β) ≈ 5.6%). А стратегии с настоящим краем μ1 должны
 *    приниматься с мощностью ≈ 1−β = 90%. Если цифры уехали — сломан
 *    инкубатор, а не рынок.
 * 2. Нуль-гаунтлет: случайные входы с теми же выходами (та же машинерия,
 *    что нуль-модель) прогоняются через настоящие ворота жерновов. Полный
 *    проход нуля — событие уровня «ворота дырявые»: ожидание 0 из 20.
 *
 * Запуск: npx tsx researcher/selfcheck.ts [--runs 20] [--seed 7]
 */
import { pathToFileURL } from "node:url";
import { simulateExits } from "../src/core/backtest/engine.ts";
import { statsAfterCosts } from "../src/core/committee/costModel.ts";
import {
  gateActivity,
  gateBreadth,
  gateCostStress,
  gateDsr,
  gateTemporal,
  gateWilson,
} from "./gates.ts";
import { sampleCandidates, toStrategyConfig, type SignalTf } from "./grammar.ts";
import { halvingSubset, listUniverse, loadCandles, splitHoldout } from "./corpus.ts";
import { HALVING_SALT, netRMultiples, perSymbolNets, STAGE_A_SYMBOLS } from "./screen.ts";
import { MAX_TRADES_CAP } from "./incubate.ts";
import { sprtDecide } from "./sprt.ts";

/** Тот же детерминированный PRNG, что в грамматике (намеренная копия:
 * самопроверка не должна зависеть от внутренностей проверяемого). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Нормальные величины (Бокс–Мюллер) от seeded-PRNG. */
function gaussianSource(seed: number): () => number {
  const rand = mulberry32(seed);
  return () => {
    const u = 1 - rand(); // (0,1], ln(0) исключён
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

export interface SprtCalibration {
  simulations: number;
  /** Доля нулевых стратегий, ошибочно принятых SPRT (должна быть ≈ α). */
  falseAcceptRate: number;
  /** Доля настоящих (μ=μ1) стратегий, принятых SPRT (мощность, ≈ 1−β). */
  powerRate: number;
  /** Доля прогонов, упершихся в усечение без решения. */
  truncatedNullRate: number;
}

/**
 * Эмпирические ошибки SPRT при рабочих параметрах. Потоки симуляции длиной
 * MAX_TRADES_CAP — это верхняя граница ДЛИНЫ СИМУЛЯЦИИ, а не боевое усечение:
 * в проде потолок динамический, 3·E[N] (см. incubate.ts).
 * Каждая симуляция — поток нормальных R с μ=0 (ноль) либо μ=μ1 (край).
 */
export function calibrateSprt(
  simulations: number,
  mu1: number,
  sigma: number,
  seed: number,
): SprtCalibration {
  let falseAccepts = 0;
  let truncatedNull = 0;
  let powerAccepts = 0;
  for (let i = 0; i < simulations; i++) {
    const gaussNull = gaussianSource(seed * 2 + i);
    const nullRs = Array.from({ length: MAX_TRADES_CAP }, () => gaussNull() * sigma);
    const nullVerdict = sprtDecide(nullRs, mu1, sigma);
    if (nullVerdict.decision === "accept") falseAccepts += 1;
    if (nullVerdict.decision === "continue") truncatedNull += 1;

    const gaussEdge = gaussianSource(seed * 2 + i + 1_000_003);
    const edgeRs = Array.from({ length: MAX_TRADES_CAP }, () => mu1 + gaussEdge() * sigma);
    if (sprtDecide(edgeRs, mu1, sigma).decision === "accept") powerAccepts += 1;
  }
  return {
    simulations,
    falseAcceptRate: falseAccepts / simulations,
    powerRate: powerAccepts / simulations,
    truncatedNullRate: truncatedNull / simulations,
  };
}

export interface NullGauntletReport {
  runs: number;
  perGate: Record<string, number>;
  /** Сколько нулей прошли ВСЕ ворота — ожидание 0. */
  fullPasses: number;
}

const NULL_ENTRIES_PER_SYMBOL = 30;
const NULL_GAUNTLET_CLUSTERS = 1000;

/**
 * Случайные входы + настоящие выходы кандидатов из грамматики — через
 * настоящие ворота. Использует реальный корпус (стадия-16 + 8 отложенных).
 */
export function runNullGauntlet(runs: number, seed: number, tf: SignalTf): NullGauntletReport {
  const universe = listUniverse(tf);
  const { search, holdout } = splitHoldout(universe);
  const searchSymbols = halvingSubset(search, STAGE_A_SYMBOLS, HALVING_SALT);
  const holdoutSymbols = halvingSubset(holdout, 8, HALVING_SALT);
  const candleCache = new Map<string, ReturnType<typeof loadCandles>>();
  const candlesFor = (symbol: string) => {
    if (!candleCache.has(symbol)) candleCache.set(symbol, loadCandles(symbol, tf));
    return candleCache.get(symbol)!;
  };

  const perGate: Record<string, number> = {};
  let fullPasses = 0;
  // ТФ пинится к корпусу гаунтлета — метка спеки честная, как в эпохе-2.
  const specs = sampleCandidates(seed, runs, undefined, { tf });

  for (let r = 0; r < specs.length; r++) {
    const config = toStrategyConfig(specs[r]);
    const rand = mulberry32(seed + r * 7919);
    const collect = (symbols: readonly string[]) =>
      symbols.flatMap((symbol) => {
        const candles = candlesFor(symbol);
        if (!candles || candles.length < 500) return [];
        const span = candles.length - 202;
        const picked = new Set<number>();
        while (picked.size < NULL_ENTRIES_PER_SYMBOL) picked.add(200 + Math.floor(rand() * span));
        return simulateExits(candles, config, symbol, [...picked].sort((a, b) => a - b));
      });

    const trades = collect(searchSymbols);
    const holdoutTrades = collect(holdoutSymbols);
    const gates = [
      ["activity", () => gateActivity(perSymbolNets(trades))],
      [
        "breadth",
        () =>
          gateBreadth(perSymbolNets(trades), {
            netExpectancy: statsAfterCosts(holdoutTrades).expectancy,
            trades: holdoutTrades.length,
          }),
      ],
      ["cost_stress", () => gateCostStress(trades)],
      ["temporal", () => gateTemporal(trades)],
      ["dsr", () => gateDsr(netRMultiples(trades), NULL_GAUNTLET_CLUSTERS, 0.01)],
      ["wilson", () => gateWilson(statsAfterCosts(trades), statsAfterCosts(trades).avgRR)],
    ] as const;

    let alive = true;
    for (const [name, gate] of gates) {
      if (!alive) break;
      if (gate().pass) perGate[name] = (perGate[name] ?? 0) + 1;
      else alive = false;
    }
    if (alive) fullPasses += 1;
  }
  return { runs: specs.length, perGate, fullPasses };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
function main(): void {
  const argv = process.argv.slice(2);
  const flag = (name: string, fallback: number) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? Number(argv[i + 1]) : fallback;
  };
  const runs = flag("runs", 20);
  const seed = flag("seed", 7);

  const fat = calibrateSprt(2000, 0.25, 1, seed);
  const thin = calibrateSprt(2000, 0.15, 1, seed);
  console.error(
    `SPRT (жирный край μ1=0.25): ложных принятий ${(fat.falseAcceptRate * 100).toFixed(1)}% ` +
      `(планка Вальда ≤ 5.6%), мощность ${(fat.powerRate * 100).toFixed(0)}% (цель ≈ 90%)`,
  );
  console.error(
    `SPRT (тонкий край μ1=0.15): мощность ${(thin.powerRate * 100).toFixed(0)}% — ` +
      `тонкие края гибнут усечением ЧАЩЕ, чем выпускаются (консерватизм по дизайну), ` +
      `усечений нуля ${(thin.truncatedNullRate * 100).toFixed(0)}%`,
  );
  const sprt = { fat, thin };
  const gauntlet = runNullGauntlet(runs, seed, "1h");
  console.error(
    `Нуль-гаунтлет: полных проходов ${gauntlet.fullPasses}/${gauntlet.runs} (ожидание 0)`,
  );
  console.log(JSON.stringify({ sprt, gauntlet }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
