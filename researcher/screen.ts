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
import {
  averageCostInR,
  DEFAULT_COSTS,
  setActiveCosts,
  statsAfterCosts,
  tradeCostInR,
} from "../src/core/committee/costModel.ts";
import { buildSlippageTable } from "./liquidityCosts.ts";
import {
  candidateId,
  EXITS,
  isLiquidityExit,
  LIQUIDITY_EXITS,
  setupFamily,
  setupNeighbors,
  setupTier,
  sampleCandidates,
  type SampleDiagnostics,
  toStrategyConfig,
  type CandidateSpec,
  type SignalTf,
} from "./grammar.ts";
import {
  liquidityTiers,
  type LiquidityTier,
  clearCandleCache,
  corpusVersion,
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
  fullYearsIn,
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
import { behavioralExclusionFor, currentGitSha, GATE_VERSION, markEpoch } from "./epochs.ts";
import { classifyDeath, depthScore } from "./gatePolicy.ts";

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
  /**
   * Как набралась партия. Уходит в статус, а не только в лог: с тех пор как
   * малая партия РАЗРЕШЕНА, единственное, что отличает «пространство честно
   * исследовано» от «сэмплер сломался», — эти числа. Невидимая партия из трёх
   * кандидатов месяцами выглядела бы как нормальная работа.
   */
  sampling: {
    requested: number;
    picked: number;
    space: number;
    wastedAttempts: number;
    attemptsExhausted: boolean;
    /** Партия набрана меньше чем на половину запроса — повод для тревоги. */
    starved: boolean;
  };
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

/**
 * Экономика испытания для журнала (пункт 3 фазы 1, ранжирование критика №4).
 *
 * breakevenCostR — издержки в R, при которых ожидание обнуляется (= валовое
 * ожидание): по нему near-miss анализ отличает «сигнала нет» от «сигнал есть,
 * экономики нет» — вторые зоны живые, чинятся горизонтом, а не порогами.
 * tradesPerDay — оборот; высокооборотные семейства умирают об издержки
 * раньше, чем сигнал успевает заплатить (урок пост-мортема Fayez 2026:
 * IC +0.024 при чистом Шарпе −2.91).
 */
export function tradeEconomics(trades: readonly TradeResult[]): {
  grossExpectancy: number;
  costR: number;
  breakevenCostR: number;
  tradesPerDay: number;
} {
  if (trades.length === 0) {
    return { grossExpectancy: 0, costR: 0, breakevenCostR: 0, tradesPerDay: 0 };
  }
  const gross = trades.reduce((sum, t) => sum + t.rMultiple, 0) / trades.length;
  const costR = averageCostInR([...trades]);
  let first = Infinity;
  let last = -Infinity;
  for (const t of trades) {
    if (t.entryTime < first) first = t.entryTime;
    if (t.entryTime > last) last = t.entryTime;
  }
  const spanDays = Math.max(1, (last - first) / 86400);
  return {
    grossExpectancy: gross,
    costR,
    breakevenCostR: gross,
    tradesPerDay: trades.length / spanDays,
  };
}

export function netRMultiples(trades: readonly TradeResult[]): number[] {
  return trades.map((t) => t.rMultiple - tradeCostInR(t));
}

/**
 * Соседи по сетке ПАРАМЕТРОВ: ±1 шаг по каждому измерению. Для обычных
 * семейств измерения живут в выходе (стоп/тейк/потолок баров), у
 * ликвидити-магнита — ещё и в сетапе (порог растянутости, вес скопления,
 * окно поиска). Без вторых у кандидата этого семейства было бы меньше трёх
 * соседей, и ворота плато отсекли бы всё семейство, ничего не проверив.
 */
export function neighborSpecs(spec: CandidateSpec): CandidateSpec[] {
  const out: CandidateSpec[] = [];

  // Соседи по параметрам сетапа (непусто только у семейств с параметрами).
  for (const setup of setupNeighbors(spec.setup)) {
    out.push({ ...spec, setup });
  }

  if (isLiquidityExit(spec.exit)) {
    const exit = spec.exit;
    const dims = [
      { grid: [...new Set(LIQUIDITY_EXITS.map((e) => e.stopBufferAtr))].sort((a, b) => a - b), own: exit.stopBufferAtr, key: "stopBufferAtr" as const },
      // Соседи по числу доборов: у варианта K=1 соседями оказываются K=0 и
      // K=2, то есть плато само проверяет, что добор — не одиночный всплеск.
      { grid: [...new Set(LIQUIDITY_EXITS.map((e) => e.adds))].sort((a, b) => a - b), own: exit.adds, key: "adds" as const },
    ];
    for (const { grid, own, key } of dims) {
      const idx = grid.indexOf(own);
      for (const delta of [-1, 1]) {
        const j = idx + delta;
        if (j < 0 || j >= grid.length) continue;
        out.push({ ...spec, exit: { ...exit, [key]: grid[j] } });
      }
    }
    return out;
  }

  const rr = spec.exit;
  const steps = {
    stopAtr: [...new Set(EXITS.map((e) => e.stopAtr))].sort((a, b) => a - b),
    takeR: [...new Set(EXITS.map((e) => e.takeR))].sort((a, b) => a - b),
    maxBars: [...new Set(EXITS.map((e) => e.maxBars))].sort((a, b) => a - b),
  };
  for (const dim of ["stopAtr", "takeR", "maxBars"] as const) {
    const grid = steps[dim];
    const idx = grid.indexOf(rr[dim]);
    for (const delta of [-1, 1]) {
      const neighborIdx = idx + delta;
      if (neighborIdx < 0 || neighborIdx >= grid.length) continue;
      out.push({ ...spec, exit: { ...rr, [dim]: grid[neighborIdx] } });
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
  /**
   * Вскрытие (пункт 4 фазы 1): каждая смерть получает depth-score (доля
   * ОБУЧАЕМЫХ ворот, пройденных до гибели) и класс причины. Пишется здесь,
   * одним местом, — какие бы ворота ни убили; extra уточняет класс у
   * халвингов (сигнала нет / экономика съела / сделок мало).
   */
  const reject = (
    id: string,
    gate: string,
    reason: string,
    extra?: Parameters<typeof classifyDeath>[1],
  ) => {
    rejectedByGate[gate] = (rejectedByGate[gate] ?? 0) + 1;
    ledger.recordEval(id, "post_mortem", {
      gate,
      cause: classifyDeath(gate, extra),
      depth: depthScore(gate),
      gateVersion: GATE_VERSION,
    });
    ledger.transition(id, "REJECTED", reason);
  };

  const universe = listUniverse(opts.tf);
  const { search, holdout } = splitHoldout(universe);
  /**
   * Срез по ликвидности (пункт 3 фазы 1): семейства с universeTier живут на
   * своей половине вселенной — разворот на неликвидной, моментум на ликвидной.
   * Половины считаются по нотионалу in-окна ОДИН раз на вселенную; halvingSubset
   * поверх отфильтрованного пула сохраняет свойство «стадия-16 — префикс
   * стадии-128» внутри каждого среза.
   */
  const tiers = liquidityTiers(opts.tf, universe);

  /**
   * Издержки по ЛИКВИДНОСТИ символа в момент сделки — на весь прогон.
   *
   * Ставится один раз здесь, а не протаскивается параметром: издержки
   * считаются в двенадцати местах воронки, и забытое место означало бы, что
   * половина отбора идёт по одной модели, а половина по другой. Такое
   * рассогласование не роняет тесты и ничего не пишет в лог.
   *
   * Модель применяется только ВВЕРХ (пол на текущих 5 б.п.), поэтому правка
   * строго ужесточает. Пре-регистрация: docs/liquidity-costs-preregistration.md.
   */
  const slippage = buildSlippageTable(opts.tf, universe, (symbol) =>
    loadCandlesWindow(symbol, opts.tf, "in"),
  );

  /**
   * Границы окна поиска — для ворот времени. Считаются по КОРПУСУ, а не по
   * сделкам кандидата: полнота года это свойство данных. Кандидат, торговавший
   * только в январе полного года, этот год всё равно имел.
   */
  const corpusSpan = (() => {
    let fromSec = Infinity;
    let toSec = -Infinity;
    for (const symbol of universe) {
      const candles = loadCandlesWindow(symbol, opts.tf, "in");
      if (!candles || candles.length === 0) continue;
      fromSec = Math.min(fromSec, candles[0].time);
      toSec = Math.max(toSec, candles[candles.length - 1].time);
    }
    return Number.isFinite(fromSec) && toSec > fromSec ? { fromSec, toSec } : undefined;
  })();
  if (corpusSpan) {
    const full = fullYearsIn(corpusSpan.fromSec, corpusSpan.toSec);
    log(
      `окно поиска: ${new Date(corpusSpan.fromSec * 1000).toISOString().slice(0, 10)} … ` +
        `${new Date(corpusSpan.toSec * 1000).toISOString().slice(0, 10)}, полных лет ${full.size}`,
    );
  }
  const restoreCosts = setActiveCosts({
    feeRate: DEFAULT_COSTS.feeRate,
    slippageRate: DEFAULT_COSTS.slippageRate,
    slippageFor: slippage.slippageFor,
  });
  log(`издержки: по ликвидности, покрыто символов ${slippage.symbols} из ${universe.length}`);
  const poolOf = (list: readonly string[], tier: LiquidityTier | undefined): string[] =>
    tier ? list.filter((symbol) => tiers.get(symbol) === tier) : [...list];
  /**
   * Стадийные списки на срез. Префиксное свойство «стадия-16 ⊂ стадия-128 ⊂
   * весь пул» обязано выполняться ВНУТРИ каждого среза — halvingSubset поверх
   * отфильтрованного пула это даёт (сортировка по хэшу устойчива к фильтру).
   */
  const stageListsFor = (tier: LiquidityTier | undefined) => {
    const pool = poolOf(search, tier);
    return {
      pool,
      a: halvingSubset(pool, STAGE_A_SYMBOLS, HALVING_SALT),
      b: halvingSubset(pool, STAGE_B_SYMBOLS, HALVING_SALT),
      holdout: poolOf(holdout, tier),
      oot: poolOf([...search, ...holdout], tier),
    };
  };
  const tierLists = {
    all: stageListsFor(undefined),
    liquid: stageListsFor("liquid"),
    illiquid: stageListsFor("illiquid"),
  } as const;
  type TierLists = (typeof tierLists)["all"];
  const runStageTiered = (
    list: readonly CandidateSpec[],
    pick: (lists: TierLists) => readonly string[],
    window: CorpusWindow = "in",
    stageLog?: (m: string) => void,
  ): Map<string, TradeResult[]> => {
    const groups = new Map<keyof typeof tierLists, CandidateSpec[]>();
    for (const spec of list) {
      const key = (setupTier(spec.setup) ?? "all") as keyof typeof tierLists;
      const group = groups.get(key);
      if (group) group.push(spec);
      else groups.set(key, [spec]);
    }
    const out = new Map<string, TradeResult[]>();
    for (const [key, group] of groups) {
      const symbols = pick(tierLists[key]);
      for (const [id, trades] of runStage(group, symbols, opts.tf, stageLog, window)) {
        out.set(id, trades);
      }
    }
    return out;
  };
  const stageASymbols = tierLists.all.a;

  // Эпоха-2: кандидат несёт РЕАЛЬНЫЙ ТФ ночи, а повторы блокируются по
  // поведению (правило × корпус), а не по ярлыку — см. epochs.ts.
  markEpoch(opts.dbPath);
  const excludeBehavioral = behavioralExclusionFor(opts.dbPath, opts.tf);
  const sampling = {} as SampleDiagnostics;
  // resamplable, а НЕ all: испытания отравленной эпохи (авария источника
  // данных) измерением не были, и закрывать ими комбинации навсегда значит
  // терять гипотезы из-за поломки инфраструктуры, а не из-за рынка. На
  // счётчик множественности карантин намеренно не влияет — см. ledger.migrate.
  const specs = sampleCandidates(opts.seed, opts.n, ledger.resamplableExclusions(), {
    tf: opts.tf,
    excludeBehavioral,
    diagnostics: sampling,
  });
  // Происхождение записывается ОДИН раз, при регистрации, и больше не
  // меняется: задним числом уже не восстановить, каким кодом и на каком
  // корпусе считалось. Без этих полей нельзя ни повторить результат
  // конкретной ночи, ни отделить испытания разных эпох в счётчике проб —
  // а спотовый и фьючерсный корпус это РАЗНЫЕ рынки.
  const { inserted } = ledger.registerCandidates(specs, {
    gitSha: currentGitSha(),
    batchSeed: opts.seed,
    gateVersion: GATE_VERSION,
    corpusVersion: corpusVersion(),
  });
  const batchId = `${opts.tf}:${opts.seed}`;
  log(`Партия: ${specs.length} кандидатов (${inserted} новых). Вселенная ${opts.tf}: ` +
    `${search.length} поисковых + ${holdout.length} отложенных символов.`);

  // Недобор партии обязан быть СОБЫТИЕМ, а не строчкой в логе. Пространство
  // финансируемых семейств конечно (fundableSpaceSize) и однажды кончится;
  // когда это случится, ночь молча выродится в холостой прогон, и месяцы
  // «работы» не проверят ни одной гипотезы. Ровно это и произошло: партия
  // из 4 кандидатов выглядела в отчёте как обычная маленькая партия.
  if (specs.length < opts.n) {
    log(
      `НЕДОБОР ПАРТИИ: запрошено ${opts.n}, набрано ${specs.length}. ` +
        `Пространство финансируемых семейств на ${opts.tf}: ${sampling.space} комбинаций, ` +
        `холостых бросков ${sampling.wastedAttempts}` +
        (sampling.attemptsExhausted ? ", лимит бросков ИСЧЕРПАН" : "") +
        ".",
    );
  }
  /*
   * Страж останавливает ночь, только когда проверять НЕЧЕГО ВООБЩЕ.
   *
   * Раньше порогом была половина запрошенной партии, и это спутало два разных
   * состояния. «Набрано 0 из 2000» — авария: сэмплер не нашёл того, что есть.
   * «Набрано 54 из 2000» при исчерпанном лимите бросков — не авария, а
   * ЧЕСТНО ИССЛЕДОВАННОЕ пространство, в которое только что добавили семейство
   * ровно на 54 комбинации. Отказ их прогнать — та же подмена аварии выводом,
   * против которой страж и ставился, только с обратным знаком: единственная
   * гипотеза владельца не проверялась бы, потому что мы попросили 2000.
   *
   * Маленькая партия статистически БЕЗОПАСНА: множественность ниже, планка
   * дефляции ниже, а от вырожденной дисперсии партии защищает varFloor в
   * gates.ts. Опасна не малая партия, а незамеченная малая партия — поэтому
   * размер уходит в статус и в тревогу, а не только в лог.
   */
  if (specs.length === 0) {
    throw new Error(
      [
        `Пространство гипотез исчерпано: не набрано НИ ОДНОГО кандидата из ${opts.n} запрошенных.`,
        `Всё пространство финансируемых семейств на ТФ ${opts.tf} — ${sampling.space} комбинаций,`,
        `и свободных в нём не осталось (${sampling.wastedAttempts} бросков подряд впустую).`,
        "",
        "Прогон ОСТАНОВЛЕН намеренно: проверять нечего, и холостая ночь",
        "выглядела бы в отчёте как обычная работа.",
        "Дальше — не ослаблять ворота, а дать новому семейству пре-регистрацию",
        "с полем «кто платит»: только это законно расширяет пространство.",
      ].join("\n"),
    );
  }

  // ── Стадия 16 символов ────────────────────────────────────────────────────
  log(`Стадия 1/3: ${specs.length} кандидатов × ${stageASymbols.length} символов…`);
  const tradesA = runStageTiered(specs, (l) => l.a);
  const stageASharpes: number[] = [];
  const stageATradeCounts: number[] = [];
  const stageAFamilies: string[] = [];
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
      stageATradeCounts.push(netRs.length);
      // Семейство идёт рядом с Шарпом, потому что дисперсия для планки
      // дефляции считается ВНУТРИ семейства: формула просит разброс ВЕЗЕНИЯ
      // однотипных попыток, а разброс между механизмами — настоящее различие,
      // а не шум отбора. Индексы этих трёх массивов не совпадают с `specs`:
      // сюда попадают только кандидаты, чей Шарп вообще измерим.
      stageAFamilies.push(setupFamily(spec.setup));
    }
    ledger.recordEval(id, "halving_16", {
      trades: trades.length,
      netExpectancy: net,
      ...tradeEconomics(trades),
      runTf: opts.tf,
      seed: opts.seed,
      batchId,
      gateVersion: GATE_VERSION,
    });
    if (trades.length < STAGE_A_MIN_TRADES) {
      reject(id, "halving_16", `халвинг-16: лишь ${trades.length} сделок`, { trades: trades.length, minTrades: STAGE_A_MIN_TRADES });
    } else if (net <= 0) {
      reject(id, "halving_16", `халвинг-16: матожидание ${net.toFixed(3)}R ≤ 0 после издержек`, { grossExpectancy: tradeEconomics(trades).grossExpectancy, netExpectancy: net });
    } else {
      survivorsA.push(spec);
    }
  }
  // Дисперсия Шарпа ПО ВСЕЙ партии, включая проигравших, — вход планки E[max].
  const batchSharpeVariance = moments(stageASharpes).stdDev ** 2;
  /**
   * ЗАМЕР, на вердикт не влияет. Наблюдаемый разброс Шарпов = разброс
   * ИСТИННЫЙ + шум оценивания, причём Var[ŝ] ≈ (1+ŝ²/2)/T. Кандидаты
   * стадии-16 имеют 8–40 сделок, поэтому второе слагаемое велико, и планка
   * дефляции сейчас зависит от того, сколько сделок случайно набрали
   * ПРОИГРАВШИЕ, — артефакт конвейера, а не свойство пространства стратегий.
   * Пишем обе величины в журнал: переход на очищенную оценку — отдельная
   * пре-регистрация, и делать её надо по наблюдениям боевых ночей.
   */
  /**
   * ОЦЕНКА ДИСПЕРСИИ, по которой считается планка дефляции. Наблюдаемый Шарп
   * = истинный + ошибка оценивания с дисперсией ≈ (1+ŝ²/2)/T. У кандидата с
   * 8 сделками эта ошибка колоссальна, и три таких записи задирают планку
   * всей ночи (ночь 03.08: sr0=4.11 при Шарпах кандидатов 0.08-0.15 —
   * ворота перестали проверять и стали отказом по построению).
   *
   * Поэтому дисперсия считается по кандидатам, которых вообще ИЗМЕРИМО
   * оценивать (≥40 сделок), и из неё вычитается средняя дисперсия
   * оценивания по ним же. Формула DSR и порог 0.95 не меняются — меняется
   * оценщик одного входа, в сторону состоятельности.
   * Пре-регистрация с замерами: docs/dsr-variance-preregistration.md.
   */
  const MIN_TRADES_FOR_VARIANCE = 40;
  const thickIdx = stageATradeCounts
    .map((t, i) => (t >= MIN_TRADES_FOR_VARIANCE ? i : -1))
    .filter((i) => i >= 0);
  const estimationVar = (indices: readonly number[]): number =>
    indices.length > 0
      ? indices.reduce(
          (sum, i) =>
            sum + (1 + (stageASharpes[i] * stageASharpes[i]) / 2) / Math.max(stageATradeCounts[i], 2),
          0,
        ) / indices.length
      : 0;
  const thickVariance =
    thickIdx.length >= 5 ? moments(thickIdx.map((i) => stageASharpes[i])).stdDev ** 2 : batchSharpeVariance;
  const deflationVariance = Math.max(
    0,
    thickVariance - estimationVar(thickIdx.length >= 5 ? thickIdx : stageASharpes.map((_, i) => i)),
  );

  /*
   * GATE_VERSION=6: дисперсия для планки дефляции считается ВНУТРИ СЕМЕЙСТВА.
   *
   * Формула Бейли–Лопеса де Прадо просит дисперсию оценок Шарпа внутри
   * семейства множественных проверок — разброс ВЕЗЕНИЯ однотипных попыток.
   * Ей же скармливался разброс по ночной партии, где рядом стоят разные
   * механизмы; различие между механизмами — настоящее, а не шум отбора, и его
   * подстановка завышала оценку случайного максимума. Планка ∝ √varSR, и это
   * единственный рычаг: замер мощности показал 0% прохождения при любом
   * реалистичном крае, то есть ворота отвергли бы и Medallion.
   *
   * Замер отношения (521 запись gate_dsr, 7 ночей, крупнейшее семейство):
   * дисперсия внутри семейства к дисперсии по смеси ≈ 0.42. Поэтому эффект
   * ожидается около ÷2 по планке, а не разы. Ожидание записано ДО правки:
   * мощность 40±15% при δ=0.25 и 15±10% при δ=0.20
   * (docs/dsr-power-preregistration.md).
   *
   * ПРЕДОХРАНИТЕЛЬ. У семейства должно быть достаточно измеримых кандидатов,
   * иначе дисперсия выродится, planка рухнет и ворота станут свободным
   * проходом — ровно та поломка, которую они обязаны ловить. При нехватке
   * берётся общепартийная величина, то есть СТАРОЕ, более строгое поведение.
   */
  const MIN_FAMILY_FOR_VARIANCE = 5;
  const familyDeflationVariance = new Map<string, number>();
  for (const family of new Set(stageAFamilies)) {
    const idx = stageAFamilies
      .map((f, i) => (f === family ? i : -1))
      .filter((i) => i >= 0 && stageATradeCounts[i] >= MIN_TRADES_FOR_VARIANCE);
    if (idx.length < MIN_FAMILY_FOR_VARIANCE) continue;
    const raw = moments(idx.map((i) => stageASharpes[i])).stdDev ** 2;
    familyDeflationVariance.set(family, Math.max(0, raw - estimationVar(idx)));
  }
  /** Дисперсия для планки: своя у семейства, общепартийная — при нехватке. */
  const deflationVarianceFor = (family: string): number =>
    familyDeflationVariance.get(family) ?? deflationVariance;
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
  log(`Стадия 2/3: ${survivorsA.length} кандидатов × до ${STAGE_B_SYMBOLS} символов…`);
  const extraB = runStageTiered(survivorsA, (l) => l.b.slice(l.a.length), "in", log);
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
      ...tradeEconomics(trades),
      runTf: opts.tf,
      gateVersion: GATE_VERSION,
    });
    if (trades.length < STAGE_B_MIN_TRADES) {
      reject(id, "halving_128", `халвинг-128: лишь ${trades.length} сделок`, { trades: trades.length, minTrades: STAGE_B_MIN_TRADES });
    } else if (net <= 0) {
      reject(id, "halving_128", `халвинг-128: матожидание ≤ 0 после издержек`, { grossExpectancy: tradeEconomics(trades).grossExpectancy, netExpectancy: net });
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
  const extraFull = runStageTiered(survivorsB, (l) => l.pool.slice(l.b.length));
  const holdoutTrades = runStageTiered(survivorsB, (l) => l.holdout);

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
    const neighborTrades = runStageTiered(neighbors, (l) => l.a);
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
        // Диагностика калибровки — на вердикт не влияет. До неё `t` жил
        // только в ТЕКСТЕ причины отказа, то есть у прошедших терялся вовсе,
        // и проверить симметрию теста было не по чему. Именно так дефект
        // «ни одного отрицательного t из 1512» прожил незамеченным.
        candidateTrades: result.diagnostics.candidateTrades,
        nullTradesPerRun: result.diagnostics.nullTradesPerRun,
        daysCandidateOnly: result.diagnostics.daysCandidateOnly,
        daysNullOnly: result.diagnostics.daysNullOnly,
        daysBoth: result.diagnostics.daysBoth,
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
  const { clusters: nEffectiveGlobal } = ledger.counts();
  const familiesTried = ledger.familiesTried();
  const validated: ScreenSummary["validated"] = [];
  for (const f of finalists) {
    if (!applyGate("gate_temporal", f, gateTemporal(f.trades, corpusSpan))) continue;
    const netRs = netRMultiples(f.trades);
    /*
     * GATE_VERSION=6: N и дисперсия берутся ПО РОДОСЛОВНОЙ кандидата.
     *
     * Кандидат семейства свипа рождён перебором пространства свипа, а не
     * перебором моментума; платить планкой за чужой слепой перебор он не
     * обязан. Глобальное N при этом продолжает писаться в журнал рядом —
     * чтобы переход между эпохами ворот был обратим и сравним.
     */
    const family = setupFamily(f.spec.setup);
    const nEffective = Math.max(1, ledger.clustersForFamily(family));
    const familyVar = deflationVarianceFor(family);
    // Вердикт — по очищенной оценке; наивная пишется рядом для сравнимости
    // ночей и обратимости перехода.
    const dsrGate = gateDsr(netRs, nEffective, familyVar, batchSharpeVariance);
    ledger.recordEval(f.id, "dsr_accounting", {
      family,
      nEffectiveFamily: nEffective,
      nEffectiveGlobal,
      deflationVarianceFamily: familyVar,
      deflationVarianceBatch: deflationVariance,
      // Множественность МЕЖДУ семействами этим счётчиком не покрыта. Число
      // пишется, чтобы поправка на неё была видимой и решалась своей
      // пре-регистрацией, а не потерялась молча.
      familiesTried,
      gateVersion: GATE_VERSION,
    });
    if (!applyGate("gate_dsr", f, dsrGate)) continue;
    const netStats = statsAfterCosts(f.trades);
    // Реализованное соотношение выигрыш/проигрыш, а не номинальный takeR:
    // у уровневых выходов риск переменный, и takeR там не существует.
    const wilsonGate = gateWilson(netStats, netStats.avgRR);
    if (!applyGate("gate_wilson", f, wilsonGate)) continue;

    // G10, последнее и единственное честное «а работает ли оно ЗАВТРА»:
    // окно out-of-time, которого не видела ни одна стадия поиска. Патрон
    // одноразовый — сюда доходят единицы кандидатов за ночь, поэтому прогон
    // по всей вселенной здесь дёшев. Тест тот же (разностный, с сохранением
    // расписания), порог ниже: на годе данных наблюдений в пять раз меньше,
    // и t≥2.6 убивал бы 3/4 настоящих краёв (calibrate.ts --mode oot).
    const ootRaw = runStageTiered([f.spec], (l) => l.oot, "oot").get(f.id) ?? [];
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

    /**
     * Ширина посева выводится из ЧАСТОТЫ кандидата, а не задана числом.
     *
     * Замер, из-за которого это появилось: у семейства свипа боковика 0.41
     * сделки на символ в год. При посеве на 8 символах сорок форвард-сделок
     * набирались бы 4419 дней, при 30 — 1179, при потолке инкубации в 365.
     * То есть выпуск был бы невозможен АРИФМЕТИЧЕСКИ, и кандидат умер бы «не
     * доказавшим край», хотя проверить его не дали.
     *
     * Быстрым семействам широкий посев не нужен и вреден (лишние запросы к
     * бирже каждый час), поэтому берётся минимум символов, при котором тест
     * успевает закончиться в календарь: sqrt-запаса нет, считается напрямую.
     */
    const spanDays = Math.max(1, (Math.max(...f.trades.map((t) => t.entryTime)) -
      Math.min(...f.trades.map((t) => t.entryTime))) / 86_400);
    const symbolsTraded = bySymbolCount.size || 1;
    const perSymbolYear = (f.trades.length / symbolsTraded) * (365 / spanDays);
    // Нужно MIN_GRADUATION_TRADES за календарный пол, с запасом ×1.5 на то,
    // что форвард всегда медленнее бэктеста (режим мог смениться).
    const needPerYear = (40 * 1.5 * 365) / 120;
    const needSymbols = perSymbolYear > 0 ? Math.ceil(needPerYear / perSymbolYear) : 8;
    const seedWidth = Math.min(Math.max(8, needSymbols), bySymbolCount.size);
    const topSymbols = [...bySymbolCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, seedWidth)
      .map(([s]) => s);
    const netMoments = moments(netRs);
    ledger.recordEval(f.id, "incubation_seed", {
      netExpectancy: Number(netMoments.mean.toFixed(4)),
      sigma: Number(netMoments.stdDev.toFixed(4)),
      symbols: topSymbols.join(","),
      tf: opts.tf,
      // В журнал — чтобы решение о ширине посева было проверяемым, а не
      // спрятанным в коде: медленное семейство обязано получать широкий посев.
      seedWidth,
      tradesPerSymbolYear: Number(perSymbolYear.toFixed(3)),
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
    sampling: {
      requested: opts.n,
      picked: specs.length,
      space: sampling.space,
      wastedAttempts: sampling.wastedAttempts,
      attemptsExhausted: sampling.attemptsExhausted,
      starved: specs.length < opts.n / 2,
    },
  };
  ledger.close();
  // Модель издержек — состояние прогона, а не процесса: не вернуть её значит
  // оставить следующему вызывающему (тесту, утилите) таблицу чужой вселенной.
  restoreCosts();
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
