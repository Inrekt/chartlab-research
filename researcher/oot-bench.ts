/**
 * Стенд ворот out-of-time: код, который НИ РАЗУ не исполнялся.
 *
 * За 56 374 испытания в журнале нет ни одной записи `gate_oot` — до этих ворот
 * никто не дошёл, их убивала дефляция. Значит первый живой кандидат станет их
 * бета-тестером, и произойдёт это в худший возможный момент: после месяцев
 * ожидания, на единственном за всю историю проекте кандидате.
 *
 * Стенд отвечает на три вопроса, и все три сейчас без ответа:
 *   1. Исполняется ли этот путь вообще без исключений на реальном корпусе?
 *   2. Сколько кандидатов доживает до вердикта (а не отбраковывается за
 *      нехватку сделок или дней в годовом окне)?
 *   3. Наследуют ли эти ворота перекос нуль-модели? Они гоняют ТУ ЖЕ
 *      `scheduledNullGate`, у которой по журналу ноль отрицательных t из
 *      1512 — если дефект тот же, чинить надо один раз в одном месте.
 *
 * ⚠️ Расходует ли стенд «одноразовый патрон» OOT-окна? Нет, и это важно.
 * Патрон — про то, что РЕЗУЛЬТАТ окна нельзя использовать для отбора
 * кандидатов. Здесь измеряется поведение ПРИБОРА (доля исполнимости и
 * симметрия статистики), а какие спеки прошли — не записывается в журнал и
 * не влияет ни на один отбор.
 *
 * Запуск: npx tsx researcher/oot-bench.ts [--n 60] [--tf 4h] [--seed 3]
 */
import { pathToFileURL } from "node:url";
import type { TradeResult } from "../src/core/types/index.ts";
import { runBacktest } from "../src/core/backtest/engine.ts";
import { statsAfterCosts } from "../src/core/committee/costModel.ts";
import {
  halvingSubset,
  listUniverse,
  loadCandlesWindow,
  OOT_CUTOFF_SEC,
  splitHoldout,
} from "./corpus.ts";
import { sampleCandidates, toStrategyConfig, type SignalTf } from "./grammar.ts";
import { OOT_T_MIN, POOLED_T_MIN, scheduledNullGate } from "./nullSchedule.ts";
import { HALVING_SALT, STAGE_A_SYMBOLS } from "./screen.ts";

export interface OotBenchRow {
  /** Кандидатов прогнано. */
  attempted: number;
  /** Дошло до вердикта (хватило дней разностного ряда). */
  judged: number;
  /** Прошло ворота целиком (нуль-модель И положительное матожидание). */
  passed: number;
  /** Доля отрицательных t среди судимых — калибровочная проверка. */
  negativeTShare: number;
  medianT: number;
  minT: number;
  /** Медианное число сделок в годовом окне. */
  medianOotTrades: number;
  /** Сколько отбраковано за нехватку дней, а не по существу. */
  tooFewDays: number;
}

export function runOotBench(opts: {
  n: number;
  tf: SignalTf;
  seed: number;
  symbols?: number;
  /**
   * Окно. `oot` — годовой отложенный период, `in` — период поиска.
   *
   * Прогон в `in` — КОНТРОЛЬНЫЙ ОПЫТ, и он решает спор о нуль-модели. По
   * журналу среди 1512 отвергнутых нет ни одного отрицательного t, и это
   * похоже на сломанный базлайн. Но до нуль-модели доходят только кандидаты,
   * уже отобранные за прибыльность в этом же окне, — и тогда положительный t
   * объясняется ОТБОРОМ, а не дефектом. Различить можно единственным
   * способом: прогнать НЕОТОБРАННЫХ кандидатов в том же окне.
   */
  window?: "in" | "oot";
}): OotBenchRow {
  const window = opts.window ?? "oot";
  const cutoff = window === "oot" ? OOT_CUTOFF_SEC : 0;
  const minT = window === "oot" ? OOT_T_MIN : POOLED_T_MIN;
  const { search } = splitHoldout(listUniverse(opts.tf));
  const symbols = halvingSubset(search, opts.symbols ?? STAGE_A_SYMBOLS, HALVING_SALT);
  const specs = sampleCandidates(opts.seed, opts.n, undefined, { tf: opts.tf });

  const ts: number[] = [];
  const tradeCounts: number[] = [];
  let judged = 0;
  let passed = 0;
  let tooFewDays = 0;

  for (const spec of specs) {
    const config = toStrategyConfig(spec);
    const bySymbol = new Map<string, TradeResult[]>();
    for (const symbol of symbols) {
      const candles = loadCandlesWindow(symbol, opts.tf, window);
      if (!candles || candles.length < 300) continue;
      // Тот же фильтр, что в боевом скрине: бары прогрева ДО границы окна в
      // корпусе есть, но сделки из них кандидату не принадлежат.
      const trades = runBacktest(candles, config, symbol).filter(
        (t) => t.entryTime >= cutoff,
      );
      if (trades.length > 0) bySymbol.set(symbol, trades);
    }
    const all = [...bySymbol.values()].flat();
    tradeCounts.push(all.length);
    if (all.length === 0) continue;

    const result = scheduledNullGate(
      bySymbol,
      config,
      (symbol) => loadCandlesWindow(symbol, opts.tf, window),
      opts.seed ^ 0x007007,
      { minT, minEntryTime: cutoff },
    );
    if (result.reason?.includes("дней")) {
      tooFewDays += 1;
      continue;
    }
    judged += 1;
    ts.push(result.t);
    if (result.pass && statsAfterCosts(all).expectancy > 0) passed += 1;
  }

  ts.sort((a, b) => a - b);
  tradeCounts.sort((a, b) => a - b);
  return {
    attempted: specs.length,
    judged,
    passed,
    negativeTShare: ts.length > 0 ? ts.filter((t) => t < 0).length / ts.length : NaN,
    medianT: ts[Math.floor(ts.length / 2)] ?? NaN,
    minT: ts[0] ?? NaN,
    medianOotTrades: tradeCounts[Math.floor(tradeCounts.length / 2)] ?? NaN,
    tooFewDays,
  };
}

function arg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

async function main(): Promise<void> {
  const window = arg("window", "oot") as "in" | "oot";
  const row = runOotBench({
    n: Number(arg("n", "60")),
    tf: arg("tf", "4h") as SignalTf,
    seed: Number(arg("seed", "3")),
    window,
  });
  console.error(`окно: ${window === "oot" ? "отложенный год" : "период поиска"}`);

  console.error(`прогнано кандидатов: ${row.attempted}`);
  console.error(`медиана сделок в годовом окне: ${row.medianOotTrades}`);
  console.error(`отбраковано за нехватку дней: ${row.tooFewDays}`);
  console.error(`дошло до вердикта: ${row.judged}`);
  console.error(`прошло ворота: ${row.passed}`);
  console.error(
    `\n── калибровка: t обязан быть симметричен под нулём ──\n` +
      `доля t < 0: ${(row.negativeTShare * 100).toFixed(1)}%  (честный тест дал бы ≈50%)\n` +
      `min ${row.minT.toFixed(2)}, медиана ${row.medianT.toFixed(2)}`,
  );
  if (row.judged > 20 && row.negativeTShare < 0.15) {
    console.error(
      "\n🚨 Ворота OOT наследуют перекос нуль-модели: та же машинерия, тот же\n" +
        "односторонний сдвиг. Чинить надо один раз в одном месте.",
    );
  }
  console.log(JSON.stringify(row, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
