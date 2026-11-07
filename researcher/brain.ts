/**
 * «Мозг»: генератор гипотез «механизм × доступные кубики × вселенная» с
 * автопроверкой адекватности и авто-пре-регистрацией.
 *
 * Узкое место исследователя — счётчик множественности, а не процессор. Поэтому
 * генератор разборчивый, а не плодовитый:
 * - предлагает только механизмы из каталога (mechanisms.ts) со статусом open;
 *   опровергнутое не предлагает вовсе (вернуть — только наводкой с новой
 *   гипотезой, см. hint.ts);
 * - предложенная гипотеза (proposed) планку НЕ поднимает;
 * - в прогон (queued) уходит только по правилу авто-одобрения — идея целиком
 *   из готовых кубиков ядра, все проверки пройдены, не воскрешение
 *   опровергнутого — и не больше лимита за ночь (умолчание 1). Поставленная
 *   гипотеза сразу входит в F (`TrialLedger.familiesTried`).
 * Ворота и пороги здесь не меняются и не читаются как цель: проверки — это
 * отсев «стоит ли тратить выстрел», вердикт выносят ворота на данных.
 *
 * Дубли по ДОХОДНОСТЯМ (ρ ≥ 0.7, clustering.ts) ловятся после прогона
 * кластеризатором; до прогона доходностей нет, поэтому здесь проверяется
 * статический кластер «семейство × ТФ» по журналу.
 *
 * Запуск: npx tsx researcher/brain.ts            — только показать
 *         npx tsx researcher/brain.ts --save     — записать предложения
 *         npx tsx researcher/brain.ts --queue [--limit 1] — и поставить по правилу
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { HISTORY_DIR, OOT_CUTOFF_ISO } from "./corpus.ts";
import { MEASURED_TRADE_SIGMA, requiredTradeSharpe, roundTripCost } from "./cost-floor.ts";
import { GATE_VERSION } from "./epochs.ts";
import { MIN_ACTIVE_SYMBOLS, MIN_TRADES_PER_ACTIVE } from "./gates.ts";
import type { SignalTf } from "./grammar.ts";
import type { HypothesisRow, NewHypothesis, TrialLedger } from "./ledger.ts";
import {
  CORE_CUBES,
  MECHANISMS,
  isDeadMechanism,
  type CubeId,
  type DataKind,
  type Mechanism,
} from "./mechanisms.ts";

/** Сколько гипотез за ночь может уйти в прогон (каждая — +1 к F). */
export const DEFAULT_NIGHTLY_LIMIT = 1;
/** Минимум ожидаемых сделок во всём окне поиска — иначе ворота нечего мерить. */
export const MIN_EXPECTED_TRADES = 200;
/** Длина окна поиска до экзамена (MIN_COVERED_YEARS = 4). */
export const IN_SAMPLE_YEARS = 4;
/** Целевой годовой Шарп для пола издержек — как в cost-floor.ts. */
export const TARGET_ANNUAL_SHARPE = 1.6;
/** Срез семейства мёртв, если испытаний не меньше и ни одно не выжило. */
export const DEAD_SLICE_MIN_TRIALS = 20;
/** Члены вселенной 4h по P1 (search-v4): 129 из 279 поисковых символов. */
export const DEFAULT_UNIVERSE_SIZE = 129;
/** Новая гипотеза для воскрешения опровергнутого — не отписка. */
export const MIN_NEW_HYPOTHESIS_CHARS = 40;

const SWING_TFS: ReadonlySet<SignalTf> = new Set(["4h", "1d"]);

export interface BrainContext {
  availableData: ReadonlySet<DataKind>;
  availableCubes: ReadonlySet<CubeId>;
  universeSize: number;
  /** Исход среза семейства в журнале; без журнала — проверка пропускается. */
  sliceOutcome?: (familyId: string, tf: SignalTf) => { trials: number; survivors: number };
}

export interface HypothesisDraft {
  mechanism: Mechanism;
  cubes: readonly CubeId[];
  timeframe: SignalTf;
  source: "generator" | "hint";
  hintText?: string;
  /** Обязательна для опровергнутого механизма: почему платят ИНАЧЕ. */
  newHypothesis?: string;
}

export interface Check {
  name: "who_pays" | "not_dead" | "data" | "cubes_ready" | "trades" | "dead_cluster" | "cost_floor";
  ok: boolean;
  /** Жёсткая проверка: провал — гипотеза не записывается вовсе. */
  hard: boolean;
  detail: string;
}

export interface Adequacy {
  passed: boolean;
  autoApprovable: boolean;
  checks: Check[];
  expectedTrades: number;
  edgeBp: number;
  floorBp: number;
  /** Меньше — раньше: свинг первым, затем запас края над полом. */
  priority: number;
}

export interface Evaluated {
  draft: HypothesisDraft;
  familyId: string;
  adequacy: Adequacy;
}

export function familyIdOf(m: Mechanism, cubes: readonly CubeId[]): string {
  return `h_${m.id}_${[...cubes].sort().join("+")}`;
}

function effectiveUniverse(m: Mechanism, size: number): number {
  let n = m.universe.tier ? Math.floor(size / 2) : size;
  if (m.universe.topN !== undefined) n = Math.min(n, m.universe.topN);
  return n;
}

/** σ доходности сделки: замер движка на 1h/4h, на 1d — от 4h по √времени. */
export function tradeSigma(tf: SignalTf, holdHours: number): number {
  if (tf === "1d") return MEASURED_TRADE_SIGMA["4h"] * Math.sqrt(holdHours / 40);
  return MEASURED_TRADE_SIGMA[tf];
}

/** Минимальный валовой край на сделку (бп), который выдерживают издержки + значимость. */
export function costFloorBp(tf: SignalTf, holdHours: number, tradesPerYear: number): number {
  const sigma = tradeSigma(tf, holdHours);
  const sr = requiredTradeSharpe({
    cost: roundTripCost(),
    sigmaHourly: Number.NaN,
    holdHours,
    targetAnnualSharpe: TARGET_ANNUAL_SHARPE,
    tradesPerYear: Math.max(1, tradesPerYear),
    measuredTradeSigma: sigma,
  });
  return sr * sigma * 1e4;
}

export function evaluateDraft(draft: HypothesisDraft, ctx: BrainContext): Evaluated {
  const m = draft.mechanism;
  const tf = draft.timeframe;
  const familyId = familyIdOf(m, draft.cubes);
  const checks: Check[] = [];

  checks.push({
    name: "who_pays",
    ok: m.whoPays.trim().length >= 40,
    hard: true,
    detail: m.whoPays.trim().length >= 40 ? "плательщик описан" : "нет внятного «кто платит»",
  });

  const revived = isDeadMechanism(m);
  const newHyp = draft.newHypothesis?.trim() ?? "";
  let deadOk = true;
  let deadDetail = `статус ${m.status}`;
  if (m.status === "in_grammar" || m.status === "in_progress") {
    deadOk = false;
    deadDetail = `дубль: семейство ${m.status === "in_grammar" ? "уже в грамматике" : "строится в другой ветке"}`;
  } else if (revived && newHyp.length < MIN_NEW_HYPOTHESIS_CHARS) {
    deadOk = false;
    deadDetail = `опровергнут (${(m.refutedBy ?? []).map((r) => r.family).join("; ")}) — нужна новая гипотеза`;
  } else if (revived) {
    deadDetail = "опровергнут, но дана новая гипотеза — только с одобрения владельца";
  }
  checks.push({ name: "not_dead", ok: deadOk, hard: true, detail: deadDetail });

  const missingData = m.requiresData.filter((d) => !ctx.availableData.has(d));
  checks.push({
    name: "data",
    ok: missingData.length === 0,
    hard: true,
    detail: missingData.length === 0 ? "данные есть" : `нет данных: ${missingData.join(", ")}`,
  });

  const missingCubes = draft.cubes.filter((c) => !ctx.availableCubes.has(c));
  checks.push({
    name: "cubes_ready",
    ok: missingCubes.length === 0,
    hard: false,
    detail: missingCubes.length === 0 ? "кубики готовы" : `нужен код: ${missingCubes.join(", ")}`,
  });

  const uSize = effectiveUniverse(m, ctx.universeSize);
  const perSymbolYear = m.eventsPerSymbolYear[tf] ?? 0;
  const expectedTrades = Math.round(perSymbolYear * uSize * IN_SAMPLE_YEARS);
  const perSymbol = perSymbolYear * IN_SAMPLE_YEARS;
  const tradesOk =
    expectedTrades >= MIN_EXPECTED_TRADES &&
    perSymbol >= MIN_TRADES_PER_ACTIVE &&
    uSize >= MIN_ACTIVE_SYMBOLS;
  checks.push({
    name: "trades",
    ok: tradesOk,
    hard: true,
    detail: `≈${expectedTrades} сделок (${perSymbol.toFixed(0)} на символ, вселенная ${uSize})`,
  });

  const slice = ctx.sliceOutcome?.(familyId, tf);
  const deadCluster = !!slice && slice.trials >= DEAD_SLICE_MIN_TRIALS && slice.survivors === 0;
  checks.push({
    name: "dead_cluster",
    ok: !deadCluster,
    hard: true,
    detail: slice
      ? `в журнале ${slice.trials} испытаний, выжило ${slice.survivors}`
      : "журнал не подключён",
  });

  const hold = m.holdHours[tf] ?? 24;
  const edgeBp = m.plausibleEdgeBp[tf] ?? 0;
  const floorBp = costFloorBp(tf, hold, perSymbolYear * uSize);
  checks.push({
    name: "cost_floor",
    ok: edgeBp >= floorBp,
    hard: true,
    detail: `правдоподобный край ${edgeBp} бп против пола ${floorBp.toFixed(0)} бп`,
  });

  const passed = checks.every((c) => c.ok || !c.hard);
  const autoApprovable = passed && missingCubes.length === 0 && !revived;
  const margin = floorBp > 0 ? edgeBp / floorBp : 0;
  const priority = (SWING_TFS.has(tf) ? 0 : 10) - margin;
  return {
    draft,
    familyId,
    adequacy: { passed, autoApprovable, checks, expectedTrades, edgeBp, floorBp, priority },
  };
}

export interface GenerationReport {
  accepted: Evaluated[];
  rejected: Evaluated[];
  skipped: { mechanism: string; reason: string }[];
}

/**
 * Собрать гипотезы из каталога. Опровергнутые, закрытые и уже живущие
 * механизмы пропускаются ДО проверок: генератор их не предлагает.
 */
export function generate(ctx: BrainContext, mechanisms: readonly Mechanism[] = MECHANISMS): GenerationReport {
  const report: GenerationReport = { accepted: [], rejected: [], skipped: [] };
  for (const m of mechanisms) {
    if (m.status !== "open") {
      report.skipped.push({ mechanism: m.id, reason: m.status });
      continue;
    }
    for (const cubes of m.cubeSets) {
      for (const tf of m.tfs) {
        const ev = evaluateDraft({ mechanism: m, cubes, timeframe: tf, source: "generator" }, ctx);
        (ev.adequacy.passed ? report.accepted : report.rejected).push(ev);
      }
    }
  }
  report.accepted.sort((a, b) => a.adequacy.priority - b.adequacy.priority);
  return report;
}

/** Пре-регистрация: фиксируется при записи, дальше неизменна (триггер). */
export function buildPreregistration(ev: Evaluated, createdAt: string): Record<string, unknown> {
  const m = ev.draft.mechanism;
  const tf = ev.draft.timeframe;
  return {
    familyId: ev.familyId,
    mechanism: m.id,
    whoPays: m.whoPays,
    newHypothesis: ev.draft.newHypothesis ?? null,
    trigger: m.trigger,
    cubes: [...ev.draft.cubes],
    timeframe: tf,
    directions: [...m.directions],
    directionRule: m.directionRule,
    naturalExit: m.naturalExit,
    exitType: m.exitType,
    holdHours: m.holdHours[tf] ?? null,
    universe: m.universe,
    requiresData: [...m.requiresData],
    expectedTrades: ev.adequacy.expectedTrades,
    plausibleEdgeBp: ev.adequacy.edgeBp,
    costFloorBp: Math.round(ev.adequacy.floorBp),
    gateVersion: GATE_VERSION,
    examCutoff: OOT_CUTOFF_ISO,
    killRule:
      "Ворота текущей версии не пройдены — механизм на этих кубиках опровергнут. " +
      "Повтор только с новой гипотезой о плательщике, пороги не подбираются.",
    source: ev.draft.source,
    hintText: ev.draft.hintText ?? null,
    createdAt,
  };
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function toNewHypothesis(ev: Evaluated, createdAt: string): NewHypothesis {
  const preregJson = JSON.stringify(buildPreregistration(ev, createdAt));
  const idSeed = [ev.familyId, ev.draft.timeframe, ev.draft.source, ev.draft.hintText ?? "", ev.draft.newHypothesis ?? ""].join("|");
  return {
    id: `H-${sha(idSeed).slice(0, 12)}`,
    familyId: ev.familyId,
    mechanismId: ev.draft.mechanism.id,
    timeframe: ev.draft.timeframe,
    direction: ev.draft.mechanism.directions.join("+"),
    cubes: [...ev.draft.cubes],
    source: ev.draft.source,
    hintText: ev.draft.hintText ?? null,
    preregJson,
    preregHash: sha(preregJson),
    adequacy: ev.adequacy,
  };
}

/** Записать прошедшие проверки гипотезы как предложения. Возвращает число новых. */
export function saveProposals(ledger: TrialLedger, accepted: readonly Evaluated[], createdAt: string): number {
  let added = 0;
  for (const ev of accepted) {
    if (!ev.adequacy.passed) continue;
    if (ledger.proposeHypothesis(toNewHypothesis(ev, createdAt))) added += 1;
  }
  return added;
}

/**
 * Поставить в прогон по правилу авто-одобрения, не больше лимита за ночь.
 * Всё остальное остаётся предложением — владелец решает сам.
 */
export function promote(
  ledger: TrialLedger,
  opts: { night: string; limit?: number },
): HypothesisRow[] {
  const limit = opts.limit ?? DEFAULT_NIGHTLY_LIMIT;
  const eligible = ledger
    .hypotheses("proposed")
    .filter((h) => (h.adequacy as Adequacy).autoApprovable === true)
    .sort((a, b) => (a.adequacy as Adequacy).priority - (b.adequacy as Adequacy).priority);
  const queued: HypothesisRow[] = [];
  for (const h of eligible) {
    if (ledger.queuedOnNight(opts.night) >= limit) break;
    if (ledger.queueHypothesis(h.id, opts.night, limit)) queued.push(h);
  }
  return queued;
}

const MARKET_DIRS: Partial<Record<DataKind, string>> = {
  funding: "funding",
  metrics: "metrics-1h",
  flow: "flow-1h",
  orderflow15m: "orderflow-15m",
  announcements: "events",
  hlWhales: "hl-whales",
};

/** Какие данные реально лежат на диске. Календаря разлоков нет нигде. */
export function probeData(marketDir: string): Set<DataKind> {
  const out = new Set<DataKind>();
  if (existsSync(HISTORY_DIR)) out.add("candles");
  for (const [kind, dir] of Object.entries(MARKET_DIRS) as [DataKind, string][]) {
    if (existsSync(join(marketDir, dir))) out.add(kind);
  }
  return out;
}

export function defaultContext(ledger?: TrialLedger): BrainContext {
  const marketDir =
    process.env.COLLECT_DIR ?? join(process.env.HOME ?? "", ".chartlab", "data-repo", "market");
  return {
    availableData: probeData(marketDir),
    availableCubes: new Set(CORE_CUBES),
    universeSize: DEFAULT_UNIVERSE_SIZE,
    sliceOutcome: ledger ? (f, tf) => ledger.familySliceOutcome(f, tf) : undefined,
  };
}

export function formatEvaluated(ev: Evaluated): string {
  const a = ev.adequacy;
  const mark = a.autoApprovable ? "✅ авто" : a.passed ? "🟡 предложить" : "❌";
  const failed = a.checks.filter((c) => !c.ok && c.name !== "cost_floor").map((c) => c.detail);
  return (
    `${mark} ${ev.draft.mechanism.title} · ${ev.draft.cubes.join("+")} · ${ev.draft.timeframe} — ` +
    `${a.checks.find((c) => c.name === "cost_floor")?.detail}` +
    (failed.length ? ` | ${failed.join("; ")}` : "")
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const queue = args.includes("--queue");
  const save = queue || args.includes("--save");
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : DEFAULT_NIGHTLY_LIMIT;
  if (!Number.isInteger(limit) || limit < 0) throw new Error(`--limit: нужно целое ≥ 0, дано ${args[limitIdx + 1]}`);

  const { TrialLedger } = await import("./ledger.ts");
  const { DB_PATH } = await import("./paths.ts");
  const ledger = save || existsSync(DB_PATH) ? new TrialLedger(DB_PATH) : undefined;
  try {
    const report = generate(defaultContext(ledger));
    console.log(`Механизмы пропущены: ${report.skipped.map((s) => `${s.mechanism} (${s.reason})`).join(", ")}`);
    console.log("\nПрошли проверки:");
    for (const ev of report.accepted) console.log("  " + formatEvaluated(ev));
    console.log("\nОтсеяны:");
    for (const ev of report.rejected) console.log("  " + formatEvaluated(ev));
    if (!ledger || !save) {
      console.log("\n(показ без записи; --save — записать, --queue — поставить по правилу)");
      return;
    }
    const now = new Date().toISOString();
    console.log(`\nЗаписано новых предложений: ${saveProposals(ledger, report.accepted, now)}`);
    if (queue) {
      const queued = promote(ledger, { night: now.slice(0, 10), limit });
      console.log(`Поставлено в прогон (лимит ${limit}): ${queued.map((h) => `${h.id} ${h.familyId} ${h.timeframe}`).join(", ") || "нет"}`);
      console.log(`F (семейств в счётчике): ${ledger.familiesTried()}`);
    }
  } finally {
    ledger?.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
