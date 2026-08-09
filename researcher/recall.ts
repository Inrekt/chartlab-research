/**
 * Стенд мощности: сколько НАСТОЯЩИХ краёв наши ворота пропускают.
 *
 * Все девять ворот отвечают на один вопрос — «не показалось ли?». Ни одни не
 * отвечают на обратный: «а сколько живых находок мы выбрасываем?». Без этого
 * числа нельзя отличить «поле выжжено» от «прибор глухой», и обе гипотезы
 * одинаково хорошо объясняют результат 56 374 испытания → 0 находок.
 *
 * Здесь синтезируются сделки с ЗАРАНЕЕ ЗАЛОЖЕННЫМ краем δ (Шарп на сделку по
 * NET-доходности) и прогоняются через НАСТОЯЩИЕ ворота. Доля выживших — это
 * мощность батареи при данном δ.
 *
 * Почему сделки синтетические, а не из движка. Вопрос стенда — свойство
 * ВОРОТ, а не бэктестера: «при истинном крае δ и реалистичном числе сделок
 * какая доля проходит». Прогон через движок подмешал бы сюда поведение
 * исполнения и лишил бы возможности задать δ точно. Обратная сторона честная
 * и названа прямо в отчёте: ворота нуль-модели, плато и out-of-time здесь НЕ
 * проверяются — им нужны свечи и соседи по параметрам.
 *
 * Почему δ = 0.20–0.25, а не 0.10R. Входной порог инкубатора δ ≥ 0.18
 * (incubate.ts). Стенд на крае 0.10R ≈ δ 0.067 мерил бы то, что машина по
 * своим же правилам не принимает, и не мог бы показать ничего, кроме нуля.
 *
 * Запуск: npx tsx researcher/recall.ts [--runs 200] [--deltas 0.2,0.25]
 *         [--neff 8445] [--varsr 0.0158] [--trades 1000] [--seed 7]
 */
import { pathToFileURL } from "node:url";
import type { TradeResult } from "../src/core/types/index.ts";
import { statsAfterCosts } from "../src/core/committee/costModel.ts";
import {
  gateActivity,
  gateBreadth,
  gateCostStress,
  gateDsr,
  gateTemporal,
  gateWilson,
  type GateResult,
} from "./gates.ts";
import { netRMultiples, perSymbolNets } from "./screen.ts";

/** Тот же PRNG, что в грамматике и самопроверке — детерминизм стенда. */
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

function gaussianSource(seed: number): () => number {
  const rand = mulberry32(seed);
  return () => {
    const u = 1 - rand();
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

export interface SyntheticOpts {
  /** Истинный Шарп на сделку ПОСЛЕ издержек. */
  delta: number;
  /** Разброс R-мультипликаторов. 1.0 — типичная стратегия со стопом в 1R. */
  sigma: number;
  trades: number;
  symbols: number;
  /** Сколько календарных лет покрывает выборка (ворота времени требуют ≥4). */
  years: number;
  seed: number;
  /**
   * Разброс краёв МЕЖДУ символами. Ноль означал бы, что край одинаков на всех
   * инструментах — так не бывает, и ворота ширины при этом проходились бы
   * бесплатно. 0.5·δ — умеренная неоднородность.
   */
  symbolSpread?: number;
}

const ENTRY_PRICE = 100;
/** Стоп в 2% от цены ⇒ издержки ≈ 0.1R при плоской ставке 5 б.п. */
const STOP_PRICE = 98;

/**
 * Синтетическая выборка сделок с известным истинным краем.
 *
 * δ задаётся по NET-доходности, поэтому в брутто закладывается δ·σ ПЛЮС
 * издержки: иначе стенд мерил бы край, который ворота никогда не увидят.
 */
export function syntheticTrades(opts: SyntheticOpts): TradeResult[] {
  const { delta, sigma, trades, symbols, years, seed } = opts;
  const spread = opts.symbolSpread ?? 0.5 * Math.abs(delta);
  const gauss = gaussianSource(seed);
  const costR = (2 * (0.0005 + 0.0005) * ENTRY_PRICE) / Math.abs(ENTRY_PRICE - STOP_PRICE);

  // Край у каждого символа свой: общий δ плюс собственное отклонение.
  const perSymbolDelta = Array.from({ length: symbols }, () => delta + gauss() * spread);

  const start = Date.UTC(2026, 0, 1) - years * 365 * 86_400_000;
  const span = years * 365 * 86_400_000;
  const out: TradeResult[] = [];
  for (let i = 0; i < trades; i++) {
    const s = i % symbols;
    const gross = perSymbolDelta[s] * sigma + costR + gauss() * sigma;
    // Время равномерно по всему окну: ворота времени обязаны видеть все годы.
    const entryTime = Math.floor((start + (i / trades) * span) / 1000);
    out.push({
      symbol: `SYM${s}`,
      direction: "long",
      entryTime,
      entryPrice: ENTRY_PRICE,
      exitTime: entryTime + 3600 * 8,
      exitPrice: ENTRY_PRICE * (1 + (gross * (ENTRY_PRICE - STOP_PRICE)) / ENTRY_PRICE / 100),
      stopPrice: STOP_PRICE,
      targetPrice: ENTRY_PRICE * 1.04,
      rMultiple: gross,
      won: gross > 0,
      barsHeld: 8,
    });
  }
  return out;
}

export interface RecallRow {
  delta: number;
  runs: number;
  /** Доля дошедших ДО этих ворот и прошедших их. */
  survived: Record<string, number>;
  /**
   * Доля прошедших эти ворота среди ВСЕХ прогонов, независимо от цепочки.
   *
   * Отличается от `survived` тем, что не зависит от порядка ворот. В ночном
   * гаунтлете есть короткое замыкание: упавший на первых воротах до
   * остальных не доходит, и по одному лишь `survived` нельзя отличить
   * «ворота мягкие» от «до них никто не добрался». Именно так gate_wilson и
   * gate_oot за 56 374 испытания не исполнились НИ РАЗУ.
   */
  marginal: Record<string, number>;
  /**
   * Сколько кандидатов убиты ТОЛЬКО этими воротами (все остальные пройдены).
   *
   * Ворота с нулём одиночных убийств не добавляют ничего: всё, что они ловят,
   * уже поймано соседями. Это и есть цена девяти условий, перемноженных в
   * одно, — избыточность видна только так.
   */
  uniqueKills: Record<string, number>;
  /** Доля прошедших ВСЮ цепочку. */
  fullPass: number;
  /** Ворота, на которых чаще всего умирает настоящий край. */
  bottleneck: string;
}

export interface RecallOpts {
  deltas: readonly number[];
  runs: number;
  trades: number;
  symbols: number;
  years: number;
  sigma: number;
  nEffective: number;
  varSR: number;
  /** Число испытанных семейств — поправка Бонферрони на межсемейную множественность. */
  families?: number;
  seed: number;
}

/** Порядок как в ночном гаунтлете: дешёвые ворота первыми. */
const CHAIN = [
  "activity",
  "breadth",
  "cost_stress",
  "temporal",
  "dsr",
  "wilson",
] as const;

export function recallBench(opts: RecallOpts): RecallRow[] {
  const rows: RecallRow[] = [];
  for (const delta of opts.deltas) {
    const reached: Record<string, number> = {};
    const passed: Record<string, number> = {};
    const marginalPass: Record<string, number> = {};
    const uniqueKills: Record<string, number> = {};
    let fullPass = 0;

    for (let r = 0; r < opts.runs; r++) {
      const seed = opts.seed + r * 7919 + Math.round(delta * 1e6);
      const trades = syntheticTrades({
        delta,
        sigma: opts.sigma,
        trades: opts.trades,
        symbols: opts.symbols,
        years: opts.years,
        seed,
      });
      // Отложенный набор — независимая выборка того же процесса, как в ночи.
      const holdout = syntheticTrades({
        delta,
        sigma: opts.sigma,
        trades: Math.max(40, Math.round(opts.trades / 8)),
        symbols: Math.max(2, Math.round(opts.symbols / 4)),
        years: opts.years,
        seed: seed ^ 0x5eed,
      });

      const nets = perSymbolNets(trades);
      const stats = statsAfterCosts([...trades]);
      const holdoutStats = statsAfterCosts([...holdout]);
      const gates: Record<string, () => GateResult> = {
        activity: () => gateActivity(nets),
        breadth: () =>
          gateBreadth(nets, {
            netExpectancy: holdoutStats.expectancy,
            trades: holdout.length,
          }),
        cost_stress: () => gateCostStress(trades),
        temporal: () => gateTemporal(trades),
        dsr: () => gateDsr(netRMultiples(trades), opts.nEffective, opts.varSR, undefined, opts.families),
        wilson: () => gateWilson(stats, stats.avgRR),
      };

      // Все ворота считаются ВСЕГДА, даже после первого провала. В ночном
      // гаунтлете есть короткое замыкание — оно экономит вычисления, но
      // скрывает избыточность: невозможно понять, ловят ли поздние ворота
      // хоть что-то своё. Здесь ворота дёшевы (сделки синтетические), и
      // платить нечем.
      const verdicts = Object.fromEntries(
        CHAIN.map((name) => [name, gates[name]().pass]),
      ) as Record<string, boolean>;
      for (const name of CHAIN) if (verdicts[name]) marginalPass[name] = (marginalPass[name] ?? 0) + 1;

      const failures = CHAIN.filter((n) => !verdicts[n]);
      if (failures.length === 1) uniqueKills[failures[0]] = (uniqueKills[failures[0]] ?? 0) + 1;

      let alive = true;
      for (const name of CHAIN) {
        if (!alive) break;
        reached[name] = (reached[name] ?? 0) + 1;
        if (verdicts[name]) passed[name] = (passed[name] ?? 0) + 1;
        else alive = false;
      }
      if (alive) fullPass += 1;
    }

    // Доля выживших СРЕДИ ДОШЕДШИХ: иначе ворота в конце цепочки выглядели бы
    // безобидными просто потому, что до них мало кто добирается.
    const survived: Record<string, number> = {};
    for (const name of CHAIN) {
      survived[name] = reached[name] ? (passed[name] ?? 0) / reached[name] : NaN;
    }
    const marginal = Object.fromEntries(
      CHAIN.map((n) => [n, (marginalPass[n] ?? 0) / opts.runs]),
    ) as Record<string, number>;
    const kills = Object.fromEntries(CHAIN.map((n) => [n, uniqueKills[n] ?? 0])) as Record<
      string,
      number
    >;
    // Узкое место — по МАРГИНАЛЬНОЙ доле: по цепочке первые ворота всегда
    // выглядят главными просто потому, что стоят первыми.
    const bottleneck = [...CHAIN].sort((a, b) => marginal[a] - marginal[b])[0] ?? "—";

    rows.push({
      delta,
      runs: opts.runs,
      survived,
      marginal,
      uniqueKills: kills,
      fullPass: fullPass / opts.runs,
      bottleneck,
    });
  }
  return rows;
}

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

async function main(): Promise<void> {
  const opts: RecallOpts = {
    deltas: arg("deltas", "0.10,0.18,0.20,0.25,0.35").split(",").map(Number),
    runs: Number(arg("runs", "200")),
    trades: Number(arg("trades", "1000")),
    symbols: Number(arg("symbols", "16")),
    years: Number(arg("years", "5")),
    sigma: Number(arg("sigma", "1")),
    // Медиана журнала, а НЕ среднее: varSR скошен вправо (p50 0.0158 против
    // среднего 0.185), и среднее описывало бы ночь, которой не было.
    nEffective: Number(arg("neff", "8445")),
    varSR: Number(arg("varsr", "0.0158")),
    families: Number(arg("families", "1")),
    seed: Number(arg("seed", "7")),
  };

  const rows = recallBench(opts);
  console.error(
    `стенд мощности: ${opts.runs} прогонов × ${opts.trades} сделок, ` +
      `N_eff=${opts.nEffective}, varSR=${opts.varSR}\n`,
  );
  console.error(
    ["δ", ...CHAIN, "ВСЕ", "узкое место"].map((s) => String(s).padEnd(12)).join(""),
  );
  for (const row of rows) {
    console.error(
      [
        row.delta.toFixed(2),
        ...CHAIN.map((n) =>
          Number.isNaN(row.survived[n]) ? "—" : `${(row.survived[n] * 100).toFixed(0)}%`,
        ),
        `${(row.fullPass * 100).toFixed(1)}%`,
        row.bottleneck,
      ]
        .map((s) => String(s).padEnd(12))
        .join(""),
    );
  }
  console.error("\n── маргинально: доля прошедших НЕЗАВИСИМО от цепочки ──");
  console.error(["δ", ...CHAIN].map((s) => String(s).padEnd(12)).join(""));
  for (const row of rows) {
    console.error(
      [row.delta.toFixed(2), ...CHAIN.map((n) => `${(row.marginal[n] * 100).toFixed(0)}%`)]
        .map((s) => String(s).padEnd(12))
        .join(""),
    );
  }

  console.error("\n── одиночные убийства: сколько раз ворота были ЕДИНСТВЕННОЙ причиной ──");
  console.error(["δ", ...CHAIN].map((s) => String(s).padEnd(12)).join(""));
  for (const row of rows) {
    console.error(
      [row.delta.toFixed(2), ...CHAIN.map((n) => String(row.uniqueKills[n]))]
        .map((s) => String(s).padEnd(12))
        .join(""),
    );
  }
  console.error(
    "\n⚠️ Читать строго так: ноль одиночных убийств означает, что эти ворота не\n" +
      "стоят НИЧЕГО в мощности — они не выбрасывают настоящие края. Это НЕ\n" +
      "означает, что их можно убрать: их работа — резать ЛОЖНЫХ кандидатов, а\n" +
      "здесь прогоняются только настоящие. Полезность ворот измеряет нуль-\n" +
      "гаунтлет (selfcheck.ts), этот стенд измеряет их цену.",
  );

  console.error(
    "\nНЕ проверено здесь: нуль-модель, плато, out-of-time — им нужны свечи и\n" +
      "соседи по параметрам. Мощность батареи ЦЕЛИКОМ не выше показанной.",
  );
  console.log(JSON.stringify({ opts, rows }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
