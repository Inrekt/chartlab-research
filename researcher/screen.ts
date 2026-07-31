/**
 * Ночной скрин — жернова исследователя.
 *
 * Конвейер за ночь: выборка свежих кандидатов из закрытой грамматики →
 * успешное деление пополам (16 → 128 символов — бюджет уходит выжившим) →
 * полный гаунтлет ворот в порядке «дешёвое → дорогое»: активность, ширина с
 * отложенными символами, стресс издержек ×2, плато Пардо, разностная
 * нуль-модель с сохранением расписания (t≥2.6 по дневному портфелю),
 * BH-FDR по всей партии, временна́я устойчивость, DSR≥0.95, Уилсон и
 * последним — out-of-time окно (t≥1.3), которого не видела ни одна стадия.
 *
 * ВЕСЬ ПОИСК идёт по корпусу ДО границы OOT (corpus.OOT_CUTOFF_ISO); окно
 * после границы кандидат видит ровно один раз, в последних воротах.
 *
 * Каждый шаг пишется в append-only журнал: recordEval — числа, transition —
 * вердикт с человекочитаемой причиной. Проход по корпусу — символ-мажорный:
 * в памяти живёт ОДИН символ свечей, не весь корпус.
 *
 * Запуск: npx tsx researcher/screen.ts --tf 1h --n 100 --seed 7
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { DB_PATH } from "./paths.ts";
import type { TradeResult } from "../src/core/types/index.ts";
import { runBacktest } from "../src/core/backtest/engine.ts";
import { statsAfterCosts, tradeCostInR } from "../src/core/committee/costModel.ts";
import {
  candidateId,
  EXITS,
  sampleCandidates,
  toStrategyConfig,
  type CandidateSpec,
  type SignalTf,
} from "./grammar.ts";
import {
  clearCandleCache,
  halvingSubset,
  listUniverse,
  loadCandlesWindow,
  OOT_CUTOFF_ISO,
  OOT_CUTOFF_SEC,
  splitHoldout,
  type CorpusWindow,
} from "./corpus.ts";
import { OOT_T_MIN, scheduledNullGate } from "./nullSchedule.ts";
import {
  gateActivity,
  gateBreadth,
  gateCostStress,
  gateDsr,
  gatePlateau,
  gateTemporal,
  gateWilson,
  type GateResult,
  type SymbolNet,
} from "./gates.ts";
import { benjaminiHochberg, moments, tradeSharpe } from "./stats.ts";
import {
  buildDailyMatrix,
  cscvPbo,
  whiteRealityCheck,
  type PboResult,
  type RealityCheckResult,
} from "./batchDiagnostics.ts";
import { CorrelationClusterer, weeklyFingerprint } from "./clustering.ts";
import { TrialLedger } from "./ledger.ts";
import { behavioralExclusionFor, GATE_VERSION, markEpoch } from "./epochs.ts";

export const STAGE_A_SYMBOLS = 16;
export const STAGE_B_SYMBOLS = 128;
const STAGE_A_MIN_TRADES = 8;
const STAGE_B_MIN_TRADES = 40;
const STAGE_B_MIN_POSITIVE_SHARE = 0.45;
export const FDR_Q = 0.1;
/** Фиксированная соль деления пополам: стадия-16 — префикс стадии-128,
 * и обе стабильны от ночи к ночи (сравнимость журнала). */
export const HALVING_SALT = 0xc0ffee;

export interface ScreenOptions {
  tf: SignalTf;
  n: number;
  seed: number;
  dbPath: string;
  log?: (message: string) => void;
}

export interface ScreenSummary {
  tf: SignalTf;
  seed: number;
  registered: number;
  universe: { search: number; holdout: number };
  stages: Record<string, { evaluated: number; passed: number }>;
  rejectedByGate: Record<string, number>;
  validated: { id: string; metrics: Record<string, unknown> }[];
  ledgerCounts: { trials: number; clusters: number };
  /** Диагностика процесса отбора; null — партия слишком мала/коротка. */
  diagnostics: { realityCheck: RealityCheckResult; pbo: PboResult | null } | null;
}

/** Символ-мажорный прогон партии кандидатов по списку символов. */
function runStage(
  specs: readonly CandidateSpec[],
  symbols: readonly string[],
  tf: SignalTf,
  log?: (m: string) => void,
  /** Окно корпуса. Весь поиск живёт в "in"; "oot" — только финальные ворота. */
  window: CorpusWindow = "in",
): Map<string, TradeResult[]> {
  const configs = specs.map((spec) => ({ id: candidateId(spec), config: toStrategyConfig(spec) }));
  const acc = new Map<string, TradeResult[]>(configs.map((c) => [c.id, []]));
  let done = 0;
  for (const symbol of symbols) {
    const candles = loadCandlesWindow(symbol, tf, window);
    done += 1;
    if (!candles) continue;
    for (const { id, config } of configs) {
      acc.get(id)!.push(...runBacktest(candles, config, symbol));
    }
    if (log && done % 25 === 0) log(`  …${done}/${symbols.length} символов`);
  }
  return acc;
}

export function perSymbolNets(trades: readonly TradeResult[]): SymbolNet[] {
  const bySymbol = new Map<string, TradeResult[]>();
  for (const t of trades) {
    const list = bySymbol.get(t.symbol) ?? [];
    list.push(t);
    bySymbol.set(t.symbol, list);
  }
  return [...bySymbol.entries()].map(([symbol, list]) => ({
    symbol,
    trades: list.length,
    netExpectancy: statsAfterCosts(list).expectancy,
  }));
}

export function netRMultiples(trades: readonly TradeResult[]): number[] {
  return trades.map((t) => t.rMultiple - tradeCostInR(t));
}

/** Соседи по сетке выходов: ±1 шаг по каждому из трёх измерений (≤6 штук). */
export function neighborSpecs(spec: CandidateSpec): CandidateSpec[] {
  const steps = {
    stopAtr: [...new Set(EXITS.map((e) => e.stopAtr))].sort((a, b) => a - b),
    takeR: [...new Set(EXITS.map((e) => e.takeR))].sort((a, b) => a - b),
    maxBars: [...new Set(EXITS.map((e) => e.maxBars))].sort((a, b) => a - b),
  };
  const out: CandidateSpec[] = [];
  for (const dim of ["stopAtr", "takeR", "maxBars"] as const) {
    const grid = steps[dim];
    const idx = grid.indexOf(spec.exit[dim]);
    for (const delta of [-1, 1]) {
      const neighborIdx = idx + delta;
      if (neighborIdx < 0 || neighborIdx >= grid.length) continue;
      out.push({ ...spec, exit: { ...spec.exit, [dim]: grid[neighborIdx] } });
    }
  }
  return out;
}

export function runScreen(opts: ScreenOptions): ScreenSummary {
  const log = opts.log ?? (() => {});
  mkdirSync(dirname(opts.dbPath), { recursive: true });
  // Кэш свечей копится за прогон одной вселенной; между вселенными чистим,
  // чтобы 1h и 4h не жили в памяти одновременно.
  clearCandleCache();
  const ledger = new TrialLedger(opts.dbPath);
  const rejectedByGate: Record<string, number> = {};
  const reject = (id: string, gate: string, reason: string) => {
    rejectedByGate[gate] = (rejectedByGate[gate] ?? 0) + 1;
    ledger.transition(id, "REJECTED", reason);
  };

  const universe = listUniverse(opts.tf);
  const { search, holdout } = splitHoldout(universe);
  const stageASymbols = halvingSubset(search, STAGE_A_SYMBOLS, HALVING_SALT);
  const stageBSymbols = halvingSubset(search, STAGE_B_SYMBOLS, HALVING_SALT);
  /** Для окна out-of-time вселенная полная: отложенные символы там уже не
   * «отложены» — время само делает срез честным, символы прятать не от кого. */
  const ootSymbols = [...search, ...holdout];

  // Эпоха-2: кандидат несёт РЕАЛЬНЫЙ ТФ ночи, а повторы блокируются по
  // поведению (правило × корпус), а не по ярлыку — см. epochs.ts.
  markEpoch(opts.dbPath);
  const excludeBehavioral = behavioralExclusionFor(opts.dbPath, opts.tf);
  const specs = sampleCandidates(opts.seed, opts.n, ledger.allCandidateIds(), {
    tf: opts.tf,
    excludeBehavioral,
  });
  const { inserted } = ledger.registerCandidates(specs);
  const batchId = `${opts.tf}:${opts.seed}`;
  log(`Партия: ${specs.length} кандидатов (${inserted} новых). Вселенная ${opts.tf}: ` +
    `${search.length} поисковых + ${holdout.length} отложенных символов.`);

  // ── Стадия 16 символов ────────────────────────────────────────────────────
  log(`Стадия 1/3: ${specs.length} кандидатов × ${stageASymbols.length} символов…`);
  const tradesA = runStage(specs, stageASymbols, opts.tf);
  const stageASharpes: number[] = [];
  const survivorsA: CandidateSpec[] = [];
  for (const spec of specs) {
    const id = candidateId(spec);
    const trades = tradesA.get(id)!;
    const net = statsAfterCosts(trades).expectancy;
    const netRs = netRMultiples(trades);
    // Только кандидаты, прошедшие порог активности: Шарп на 5–7 сделках —
    // шумовая бомба (SD ≈ 0.45), эпоха-1 такими задирала дисперсию партии и
    // через неё планку E[max] ВСЕМ финалистам (√varSR 0.079 вместо ~0.03).
    if (trades.length >= STAGE_A_MIN_TRADES && netRs.length >= 5) {
      stageASharpes.push(tradeSharpe(netRs));
    }
    ledger.recordEval(id, "halving_16", {
      trades: trades.length,
      netExpectancy: net,
      runTf: opts.tf,
      seed: opts.seed,
      batchId,
      gateVersion: GATE_VERSION,
    });
    if (trades.length < STAGE_A_MIN_TRADES) {
      reject(id, "halving_16", `халвинг-16: лишь ${trades.length} сделок`);
    } else if (net <= 0) {
      reject(id, "halving_16", `халвинг-16: матожидание ${net.toFixed(3)}R ≤ 0 после издержек`);
    } else {
      survivorsA.push(spec);
    }
  }
  // Дисперсия Шарпа ПО ВСЕЙ партии, включая проигравших, — вход планки E[max].
  const batchSharpeVariance = moments(stageASharpes).stdDev ** 2;
  log(`  прошло ${survivorsA.length}/${specs.length}.`);

  // Диагностика ПРОЦЕССА на всей партии (с проигравшими): RC Уайта — «нашла
  // ли ночь хоть что-то с учётом перебора», PBO — «не выбирает ли отбор шум».
  const matrix = buildDailyMatrix(tradesA);
  const diagnostics = matrix
    ? { realityCheck: whiteRealityCheck(matrix, 500, opts.seed), pbo: cscvPbo(matrix) }
    : null;
  if (diagnostics) {
    log(
      `  RC Уайта p=${diagnostics.realityCheck.pValue.toFixed(3)}, ` +
        `PBO=${diagnostics.pbo ? diagnostics.pbo.pbo.toFixed(2) : "н/д"}.`,
    );
  }

  // Настоящие кластеры: недельный отпечаток доходностей каждого кандидата
  // сравнивается с представителями всех прошлых ночей (стадия-16 — одни и те
  // же символы, отпечатки сравнимы). N_eff дефляции берётся отсюда.
  if (matrix) {
    const clusterer = new CorrelationClusterer(opts.dbPath);
    let assigned = 0;
    for (let i = 0; i < matrix.candidates.length; i++) {
      const id = matrix.candidates[i];
      if ((tradesA.get(id)?.length ?? 0) < 10) continue; // шумовой отпечаток
      try {
        ledger.setClusterKey(
          id,
          clusterer.clusterFor(weeklyFingerprint(matrix.returns[i], matrix.startDay), opts.tf),
        );
        assigned += 1;
      } catch {
        // ключ уже уточнён (повторный прогон после сбоя) — пропускаем
      }
    }
    clusterer.close();
    log(`  кластеры: назначено ${assigned}, всего в журнале ${ledger.counts().clusters}.`);
  }

  // ── Стадия 128 символов (дозапуск только новых символов) ──────────────────
  log(`Стадия 2/3: ${survivorsA.length} кандидатов × ${stageBSymbols.length} символов…`);
  const extraB = runStage(survivorsA, stageBSymbols.slice(STAGE_A_SYMBOLS), opts.tf, log);
  const survivorsB: CandidateSpec[] = [];
  const tradesB = new Map<string, TradeResult[]>();
  for (const spec of survivorsA) {
    const id = candidateId(spec);
    const trades = [...tradesA.get(id)!, ...extraB.get(id)!];
    tradesB.set(id, trades);
    const nets = perSymbolNets(trades);
    const traded = nets.filter((s) => s.trades > 0);
    const positiveShare =
      traded.length > 0 ? traded.filter((s) => s.netExpectancy > 0).length / traded.length : 0;
    const net = statsAfterCosts(trades).expectancy;
    ledger.recordEval(id, "halving_128", {
      trades: trades.length,
      netExpectancy: net,
      positiveShare,
      runTf: opts.tf,
      gateVersion: GATE_VERSION,
    });
    if (trades.length < STAGE_B_MIN_TRADES) {
      reject(id, "halving_128", `халвинг-128: лишь ${trades.length} сделок`);
    } else if (net <= 0) {
      reject(id, "halving_128", `халвинг-128: матожидание ≤ 0 после издержек`);
    } else if (positiveShare < STAGE_B_MIN_POSITIVE_SHARE) {
      reject(id, "halving_128", `халвинг-128: прибыльна лишь на ${(positiveShare * 100).toFixed(0)}% символов`);
    } else {
      ledger.transition(id, "SCREENED", "прошёл деление пополам 16→128");
      survivorsB.push(spec);
    }
  }
  log(`  прошло ${survivorsB.length}/${survivorsA.length}.`);

  // ── Полный гаунтлет ───────────────────────────────────────────────────────
  log(`Стадия 3/3 (гаунтлет): ${survivorsB.length} кандидатов…`);
  const extraFull = runStage(survivorsB, search.slice(STAGE_B_SYMBOLS), opts.tf);
  const holdoutTrades = runStage(survivorsB, holdout, opts.tf);

  interface Finalist {
    spec: CandidateSpec;
    id: string;
    trades: TradeResult[];
    nullGate?: GateResult;
    pNull?: number;
  }
  let finalists: Finalist[] = survivorsB.map((spec) => {
    const id = candidateId(spec);
    return { spec, id, trades: [...tradesB.get(id)!, ...(extraFull.get(id) ?? [])] };
  });

  const applyGate = (name: string, f: Finalist, gate: GateResult): boolean => {
    ledger.recordEval(f.id, name, { ...gate.metrics, pass: gate.pass });
    if (!gate.pass) reject(f.id, name, gate.reason!);
    return gate.pass;
  };

  // G1–G3: активность, ширина+отложенные, стресс издержек — чистые и дешёвые.
  finalists = finalists.filter((f) => {
    const nets = perSymbolNets(f.trades);
    const ho = holdoutTrades.get(f.id) ?? [];
    return (
      applyGate("gate_activity", f, gateActivity(nets)) &&
      applyGate("gate_breadth", f, gateBreadth(nets, {
        netExpectancy: statsAfterCosts(ho).expectancy,
        trades: ho.length,
      })) &&
      applyGate("gate_cost_stress", f, gateCostStress(f.trades))
    );
  });
  log(`  после активности/ширины/стресса: ${finalists.length}.`);

  // G4: плато — соседи по сетке выходов на символах стадии-16.
  finalists = finalists.filter((f) => {
    const neighbors = neighborSpecs(f.spec);
    const neighborTrades = runStage(neighbors, stageASymbols, opts.tf);
    const nets = neighbors.map((n) => statsAfterCosts(neighborTrades.get(candidateId(n))!).expectancy);
    const own = statsAfterCosts(tradesA.get(f.id)!).expectancy;
    return applyGate("gate_plateau", f, gatePlateau(own, nets));
  });
  log(`  после плато: ${finalists.length}.`);

  // G5 (v3): разностная нуль-модель с сохранением расписания — по ВСЕМ
  // символам кандидата, статистика по дневному портфелю. Пороги
  // пре-регистрированы: docs/gates-v3-preregistration.md.
  for (const f of finalists) {
    const bySymbol = new Map<string, TradeResult[]>();
    for (const t of f.trades) {
      (bySymbol.get(t.symbol) ?? bySymbol.set(t.symbol, []).get(t.symbol)!).push(t);
    }
    const result = scheduledNullGate(
      bySymbol,
      toStrategyConfig(f.spec),
      (symbol) => loadCandlesWindow(symbol, opts.tf, "in"),
      opts.seed ^ 0x5eed,
    );
    f.nullGate = {
      pass: result.pass,
      reason: result.reason,
      metrics: {
        t: result.t,
        days: result.days,
        meanDiff: result.meanDiff,
        gateVersion: GATE_VERSION,
      },
    };
    f.pNull = result.pValue;
  }

  // G6: BH-FDR по всей партии, дошедшей до нуль-модели.
  const keepMask = benjaminiHochberg(finalists.map((f) => f.pNull!), FDR_Q);
  finalists = finalists.filter((f, i) => {
    if (!applyGate("gate_null", f, f.nullGate!)) return false;
    if (!keepMask[i]) {
      ledger.recordEval(f.id, "gate_fdr", { p: f.pNull!, q: FDR_Q, pass: false });
      reject(f.id, "gate_fdr", `BH-FDR: p=${f.pNull!.toFixed(4)} не проходит q=0.10 по партии`);
      return false;
    }
    ledger.recordEval(f.id, "gate_fdr", { p: f.pNull!, q: FDR_Q, pass: true });
    return true;
  });
  log(`  после нуль-модели и FDR: ${finalists.length}.`);

  // G7–G9: время, DSR с планкой из журнала, Уилсон. N — кластеры по
  // корреляции доходностей за всю жизнь журнала (см. gateDsr).
  const { clusters: nEffective } = ledger.counts();
  const validated: ScreenSummary["validated"] = [];
  for (const f of finalists) {
    if (!applyGate("gate_temporal", f, gateTemporal(f.trades))) continue;
    const netRs = netRMultiples(f.trades);
    const dsrGate = gateDsr(netRs, nEffective, batchSharpeVariance);
    if (!applyGate("gate_dsr", f, dsrGate)) continue;
    const wilsonGate = gateWilson(statsAfterCosts(f.trades), f.spec.exit.takeR);
    if (!applyGate("gate_wilson", f, wilsonGate)) continue;

    // G10, последнее и единственное честное «а работает ли оно ЗАВТРА»:
    // окно out-of-time, которого не видела ни одна стадия поиска. Патрон
    // одноразовый — сюда доходят единицы кандидатов за ночь, поэтому прогон
    // по всей вселенной здесь дёшев. Тест тот же (разностный, с сохранением
    // расписания), порог ниже: на годе данных наблюдений в пять раз меньше,
    // и t≥2.6 убивал бы 3/4 настоящих краёв (calibrate.ts --mode oot).
    const ootRaw = runStage([f.spec], ootSymbols, opts.tf, undefined, "oot").get(f.id) ?? [];
    const ootTrades = ootRaw.filter((t) => t.entryTime >= OOT_CUTOFF_SEC);
    const ootBySymbol = new Map<string, TradeResult[]>();
    for (const t of ootTrades) {
      (ootBySymbol.get(t.symbol) ?? ootBySymbol.set(t.symbol, []).get(t.symbol)!).push(t);
    }
    const ootNull = scheduledNullGate(
      ootBySymbol,
      toStrategyConfig(f.spec),
      (symbol) => loadCandlesWindow(symbol, opts.tf, "oot"),
      opts.seed ^ 0x007007,
      { minT: OOT_T_MIN, minEntryTime: OOT_CUTOFF_SEC },
    );
    const ootNet = statsAfterCosts(ootTrades).expectancy;
    const ootGate: GateResult = {
      pass: ootNull.pass && ootNet > 0,
      reason: !ootNull.pass
        ? `out-of-time (с ${OOT_CUTOFF_ISO.slice(0, 10)}): ${ootNull.reason ?? "не подтвердился"}`
        : ootNet > 0
          ? undefined
          : `out-of-time: матожидание ${ootNet.toFixed(3)}R ≤ 0 после издержек`,
      metrics: {
        t: Number(ootNull.t.toFixed(3)),
        days: ootNull.days,
        trades: ootTrades.length,
        netExpectancy: Number(ootNet.toFixed(4)),
        cutoff: OOT_CUTOFF_ISO,
        gateVersion: GATE_VERSION,
      },
    };
    if (!applyGate("gate_oot", f, ootGate)) continue;

    // Посев для инкубатора (фаза R3): топ-символы по числу сделок + параметры
    // SPRT из бэктеста. Пишется ДО перехода — заморозка правил и данных вместе.
    const bySymbolCount = new Map<string, number>();
    for (const t of f.trades) bySymbolCount.set(t.symbol, (bySymbolCount.get(t.symbol) ?? 0) + 1);
    const topSymbols = [...bySymbolCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([s]) => s);
    const netMoments = moments(netRs);
    ledger.recordEval(f.id, "incubation_seed", {
      netExpectancy: Number(netMoments.mean.toFixed(4)),
      sigma: Number(netMoments.stdDev.toFixed(4)),
      symbols: topSymbols.join(","),
      tf: opts.tf,
    });
    ledger.transition(f.id, "VALIDATED", "прошёл все ворота ночного гаунтлета");
    validated.push({ id: f.id, metrics: { ...dsrGate.metrics, ...wilsonGate.metrics } });
  }

  const summary: ScreenSummary = {
    tf: opts.tf,
    seed: opts.seed,
    registered: inserted,
    universe: { search: search.length, holdout: holdout.length },
    stages: {
      halving_16: { evaluated: specs.length, passed: survivorsA.length },
      halving_128: { evaluated: survivorsA.length, passed: survivorsB.length },
      gauntlet: { evaluated: survivorsB.length, passed: validated.length },
    },
    rejectedByGate,
    validated,
    ledgerCounts: ledger.counts(),
    diagnostics,
  };
  ledger.close();
  return summary;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
function main(): void {
  const args = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) args.set(argv[i].slice(2), argv[i + 1] ?? "true");
  }
  const summary = runScreen({
    tf: (args.get("tf") ?? "1h") as SignalTf,
    n: Number(args.get("n") ?? 100),
    seed: Number(args.get("seed") ?? 1),
    dbPath: args.get("db") ?? DB_PATH,
    log: (m) => console.error(m),
  });
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
