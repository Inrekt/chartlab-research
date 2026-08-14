/**
 * Разовая проверка гипотезы владельца: «толпа лонгует, крупные шортят —
 * через какое-то время толпу сливают». Пре-регистрация (сетка, определения,
 * зафиксированные ДО этого прогона): docs/family-crowd-top-divergence-preregistration.md.
 *
 * Локальный скрипт, минующий журнал испытаний и ночной гаунтлет screen.ts —
 * см. раздел пре-регистрации «что НЕ прогоняется» про урезанный набор ворот
 * (нет нуль-модели t≥2.6 и BH-FDR, DSR без поправки Бонферрони на семейства
 * журнала). Запуск: npx tsx researcher/backtest-crowd-top-divergence.ts
 */
import type { Candle, ConditionAtom, StrategyConfig, TradeResult } from "../src/core/types/index.ts";
import { runBacktest } from "../src/core/backtest/engine.ts";
import { activeCosts, statsAfterCosts, tradeCostInR } from "../src/core/committee/costModel.ts";
import { moments, tradeSharpe } from "./stats.ts";
import {
  gateActivity,
  gateBreadth,
  gateCostStress,
  gateDsr,
  gatePlateau,
  gateTemporal,
  gateWilson,
  type SymbolNet,
} from "./gates.ts";
import { listUniverse, loadCandlesWindow, splitHoldout, OOT_CUTOFF_SEC, HISTORY_DIR } from "./corpus.ts";

const TF = "1h" as const;
const PERCENTILE = 90;
const WINDOW_DAYS = 30;
const STOP_ATR = 2;
const TAKE_R_GRID = [1, 2] as const;
const MAX_BARS_GRID = [4, 24, 72] as const;
// Метрики Binance начинаются 2021-12-01 — это и есть реальная граница «корпуса»
// для данного кандидата, а не начало ценовой истории (та у части монет раньше).
const METRICS_START_SEC = Math.floor(Date.parse("2021-12-01T00:00:00Z") / 1000);

interface Candidate {
  readonly label: string;
  readonly tradeDirection: "long" | "short";
  readonly atomDirection: "crowdLong" | "crowdShort";
  readonly takeR: number;
  readonly maxBars: number;
}

// crowdLong (толпа лонгует сильнее крупных) → гипотеза: цену тянет вниз →
// естественная сторона входа — шорт. crowdShort — зеркало, лонг.
const CANDIDATES: Candidate[] = (["crowdLong", "crowdShort"] as const).flatMap((atomDirection) =>
  TAKE_R_GRID.flatMap((takeR) =>
    MAX_BARS_GRID.map((maxBars) => ({
      label: `${atomDirection}_r${takeR}_h${maxBars}`,
      tradeDirection: atomDirection === "crowdLong" ? "short" : "long",
      atomDirection,
      takeR,
      maxBars,
    })),
  ),
);

function buildConfig(candidate: Candidate): StrategyConfig {
  const atom: ConditionAtom = {
    kind: "crowdTopDivergence",
    direction: candidate.atomDirection,
    percentile: PERCENTILE,
    windowDays: WINDOW_DAYS,
  };
  return {
    id: `crowd-top-divergence:${candidate.label}`,
    ownerId: "researcher",
    name: candidate.label,
    timeframe: TF,
    direction: candidate.tradeDirection,
    symbols: [],
    entry: { operator: "AND", conditions: [atom] },
    exit: {
      stopLoss: { type: "atr", value: STOP_ATR },
      takeProfit: { type: "rr", value: candidate.takeR },
      maxBarsInTrade: candidate.maxBars,
    },
  };
}

function netRMultiples(trades: readonly TradeResult[]): number[] {
  return trades.map((t) => t.rMultiple - tradeCostInR(t));
}

function symbolNets(bySymbol: ReadonlyMap<string, TradeResult[]>): SymbolNet[] {
  return [...bySymbol.entries()].map(([symbol, trades]) => {
    const net = netRMultiples(trades);
    const netExpectancy = net.length > 0 ? net.reduce((a, b) => a + b, 0) / net.length : 0;
    return { symbol, trades: trades.length, netExpectancy };
  });
}

console.log(`юниверс (${TF}): загружаю…`);
const universe = listUniverse(TF, HISTORY_DIR);
const split = splitHoldout(universe);
console.log(`  всего символов: ${universe.length} · поиск: ${split.search.length} · отложено: ${split.holdout.length}`);

// Свечи по символу грузятся один раз и переиспользуются для всех 12 кандидатов.
const candlesBySymbol = new Map<string, Candle[]>();
for (const symbol of universe) {
  const candles = loadCandlesWindow(symbol, TF, "in", HISTORY_DIR);
  if (candles && candles.length > 2) candlesBySymbol.set(symbol, candles);
}
console.log(`  со свечами (in-window): ${candlesBySymbol.size}`);

interface CandidateRun {
  readonly candidate: Candidate;
  readonly tradesBySymbol: Map<string, TradeResult[]>;
  readonly allTrades: TradeResult[];
}

const runs: CandidateRun[] = CANDIDATES.map((candidate) => {
  const config = buildConfig(candidate);
  const tradesBySymbol = new Map<string, TradeResult[]>();
  const allTrades: TradeResult[] = [];
  for (const [symbol, candles] of candlesBySymbol) {
    const trades = runBacktest(candles, config, symbol);
    if (trades.length > 0) {
      tradesBySymbol.set(symbol, trades);
      allTrades.push(...trades);
    }
  }
  console.log(`  ${candidate.label}: ${allTrades.length} сделок на ${tradesBySymbol.size} символах`);
  return { candidate, tradesBySymbol, allTrades };
});

const totalTrades = runs.reduce((sum, r) => sum + r.allTrades.length, 0);
if (totalTrades === 0) {
  console.log("\nНоль сделок на всей сетке — атом ни разу не сработал. Останавливаюсь честно, без ворот.");
  process.exit(0);
}

// Батч-Шарп для DSR — по ВСЕМ 12 кандидатам сетки, включая проигравших:
// дисперсия только по выжившим занижает планку E[max] (см. gates.ts).
const batchSharpes = runs.map((r) => tradeSharpe(netRMultiples(r.allTrades)));
const batchSharpeVariance = moments(batchSharpes).stdDev ** 2;
const N_EFFECTIVE = CANDIDATES.length; // честно: реально испытанных вариантов сетки

// Лучший по чистому матожиданию — тот единственный, для которого печатается
// полный вердикт ворот. Остальные 11 уже отработали свою роль — задали
// дисперсию батча для DSR и решётку соседей для плато.
function netExpectancyOf(run: CandidateRun): number {
  const net = netRMultiples(run.allTrades);
  return net.length > 0 ? net.reduce((a, b) => a + b, 0) / net.length : -Infinity;
}
const best = [...runs].sort((a, b) => netExpectancyOf(b) - netExpectancyOf(a))[0];

console.log("\nВся сетка (netExpectancy после издержек, R на сделку):");
for (const r of [...runs].sort((a, b) => netExpectancyOf(b) - netExpectancyOf(a))) {
  console.log(`  ${r.candidate.label.padEnd(18)} ${netExpectancyOf(r).toFixed(4)}R  (${r.allTrades.length} сделок)`);
}

console.log(`\nЛучший по сетке: ${best.candidate.label} (netExpectancy=${netExpectancyOf(best).toFixed(4)}R)`);

const searchSet = new Set(split.search);
const holdoutSet = new Set(split.holdout);
const searchTrades = best.allTrades.filter((t) => searchSet.has(t.symbol));
const holdoutTrades = best.allTrades.filter((t) => holdoutSet.has(t.symbol));
const searchBySymbol = new Map([...best.tradesBySymbol].filter(([s]) => searchSet.has(s)));
const holdoutNetExpectancy =
  netRMultiples(holdoutTrades).reduce((a, b) => a + b, 0) / Math.max(1, holdoutTrades.length);

const neighborNets = runs
  .filter((r) => r !== best)
  .map((r) => netExpectancyOf(r))
  .filter((n) => Number.isFinite(n));

const netStats = statsAfterCosts([...searchTrades], activeCosts());
const wins = searchTrades.filter((t) => t.rMultiple - tradeCostInR(t) > 0);
const losses = searchTrades.filter((t) => t.rMultiple - tradeCostInR(t) <= 0);
const avgWin = wins.length > 0 ? wins.reduce((a, t) => a + (t.rMultiple - tradeCostInR(t)), 0) / wins.length : 0;
const avgLoss =
  losses.length > 0
    ? Math.abs(losses.reduce((a, t) => a + (t.rMultiple - tradeCostInR(t)), 0) / losses.length)
    : 0;
const payoffRatio = avgLoss > 0 ? avgWin / avgLoss : 0;

const gates = {
  activity: gateActivity(symbolNets(searchBySymbol)),
  breadth: gateBreadth(symbolNets(searchBySymbol), {
    netExpectancy: holdoutNetExpectancy,
    trades: holdoutTrades.length,
  }),
  costStress: gateCostStress(searchTrades),
  plateau: gatePlateau(netExpectancyOf(best), neighborNets),
  temporal: gateTemporal(searchTrades, { fromSec: METRICS_START_SEC, toSec: OOT_CUTOFF_SEC }),
  dsr: gateDsr(netRMultiples(searchTrades), N_EFFECTIVE, batchSharpeVariance),
  wilson: gateWilson(netStats, payoffRatio),
};

console.log(`\n=== Вердикт: ${best.candidate.label} ===`);
console.log(
  `Сделок в поиске: ${searchTrades.length} (${searchBySymbol.size} символов) · в отложенном наборе: ${holdoutTrades.length}`,
);
for (const [name, result] of Object.entries(gates)) {
  console.log(`  ${result.pass ? "✅" : "❌"} ${name}: ${result.pass ? "проходит" : result.reason}`);
  console.log(`     ${JSON.stringify(result.metrics)}`);
}

const allPassed = Object.values(gates).every((g) => g.pass);
console.log(
  `\n${allPassed ? "✅ ВСЕ прогнанные ворота пройдены" : "❌ Отклонено хотя бы одними воротами"} ` +
    "(нуль-модель и BH-FDR не прогонялись — см. пре-регистрацию).",
);

// Вне времени: тот же кандидат на данных ПОСЛЕ OOT_CUTOFF_SEC, увиденных
// один раз. Не формальное ворото (одного разового прогона мало для его
// собственных порогов), но та же дисциплина «есть ли что показать вне окна».
const ootBySymbol = new Map<string, TradeResult[]>();
const config = buildConfig(best.candidate);
for (const symbol of universe) {
  const candles = loadCandlesWindow(symbol, TF, "oot", HISTORY_DIR);
  if (!candles || candles.length < 2) continue;
  const trades = runBacktest(candles, config, symbol);
  if (trades.length > 0) ootBySymbol.set(symbol, trades);
}
const ootTrades = [...ootBySymbol.values()].flat();
const ootNet = netRMultiples(ootTrades);
const ootMean = ootNet.length > 0 ? ootNet.reduce((a, b) => a + b, 0) / ootNet.length : Number.NaN;
console.log(
  `\nВне времени (после ${new Date(OOT_CUTOFF_SEC * 1000).toISOString().slice(0, 10)}): ` +
    `${ootTrades.length} сделок, netExpectancy=${ootMean.toFixed(4)}R`,
);
