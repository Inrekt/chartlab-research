/**
 * Замер движка: N кандидатов × 1 символ (BTCUSDT), полная история.
 * Запуск: npx tsx researcher/bench-engine.ts [--tf 1h] [--n 50] [--seed 7]
 * Печатает мс/кандидата — число, по которому принимается кэш-оптимизация.
 */
import { loadCandles } from "./corpus.ts";
import { sampleCandidates, toStrategyConfig } from "./grammar.ts";
import { runBacktest } from "../src/core/backtest/engine.ts";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const tf = arg("tf", "1h") as "1h" | "4h" | "1d";
const n = Number(arg("n", "50"));
const seed = Number(arg("seed", "7"));

const candles = loadCandles("BTCUSDT", tf);
if (!candles) throw new Error("нет BTCUSDT в корпусе");
const specs = sampleCandidates(seed, n, undefined, { tf });
const configs = specs.map(toStrategyConfig);

// прогрев JIT одним кандидатом вне замера
runBacktest(candles, configs[0], "BTCUSDT");

const t0 = performance.now();
let trades = 0;
for (const config of configs) trades += runBacktest(candles, config, "BTCUSDT").length;
const ms = performance.now() - t0;

console.log(
  JSON.stringify({
    tf,
    candidates: configs.length,
    bars: candles.length,
    trades,
    totalMs: Math.round(ms),
    msPerCandidate: Number((ms / configs.length).toFixed(1)),
  }),
);
