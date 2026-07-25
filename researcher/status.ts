/**
 * Публичный статус исследователя — единственное, что уходит наружу.
 *
 * Журнал испытаний приватен, потому что `candidateId` кодирует ПОЛНУЮ формулу
 * стратегии (сетап, фильтры, стоп, тейк, тайм-аут). Этот файл — обезличенный
 * агрегат для монитора в приложении: числа воронки, диагностика процесса,
 * прогресс инкубации и лента настоящих причин отказа.
 *
 * ГЛАВНОЕ ПРАВИЛО: наружу не выходит ни один полный id — ни у живых, ни у
 * мёртвых. Всё проходит через publicRef(). Правило охраняется тестом-стражем
 * в status.test.ts, а не дисциплиной.
 */
import type { CandidateSpec } from "./grammar.ts";
import { setupFamily } from "./grammar.ts";
import type { TrialLedger } from "./ledger.ts";
import type { IncubationBook } from "./incubationBook.ts";
import type { ScreenSummary } from "./screen.ts";
import type { IncubationSummary } from "./incubate.ts";
import type { SupervisionSummary } from "./supervise.ts";

/** Сколько строк журнала показывает лента монитора. */
export const JOURNAL_FEED_SIZE = 40;
/** Сколько ночей помним в истории. */
export const HISTORY_KEEP = 30;

/** Ночь запускается в 21:37 UTC (02:37 Алматы) — то же, что в cron воркфлоу. */
const NIGHT_UTC_HOUR = 21;
const NIGHT_UTC_MINUTE = 37;

const FAMILY_RU: Record<string, string> = {
  trend_following: "тренд",
  breakout: "пробой",
  pullback: "откат",
  momentum: "импульс",
  divergence: "дивергенция",
  pattern: "паттерн",
  mean_reversion: "возврат к средней",
  seasonality: "сезонность",
};

/**
 * Обезличивание: полная формула → «семейство · ТФ · направление».
 *
 * `trend_cross_50|long|1h|trend_sma200|s2t2b20` → `пробой · 1h · long`
 *
 * Обратной операции не существует: семейство объединяет десятки формул, а
 * фильтры и параметры выхода не выводятся вовсе. Строка годится, чтобы
 * узнать почерк ночи, и не годится, чтобы повторить стратегию.
 */
export function publicRef(spec: CandidateSpec): string {
  const family = FAMILY_RU[setupFamily(spec.setup)] ?? "прочее";
  return `${family} · ${spec.timeframe} · ${spec.direction}`;
}

export interface StatusUniverse {
  tf: string;
  batch: number;
  symbols: { search: number; holdout: number };
  /** Ступени воронки в порядке прохождения; n — сколько ДОШЛО до ступени. */
  funnel: { stage: string; n: number }[];
  rejectedByGate: Record<string, number>;
  realityCheckP: number | null;
  pbo: number | null;
}

export interface StatusIncubating {
  ref: string;
  trades: number;
  needTrades: number;
  days: number;
  needDays: number;
  llr: number;
}

export interface StatusJournalRow {
  at: string;
  state: string;
  ref: string;
  reason: string;
}

export interface StatusHistoryRow {
  date: string;
  batch: number;
  validated: number;
  graduated: number;
}

export interface ResearcherStatus {
  version: 1;
  generatedAt: string;
  run: { durationMin: number | null; nextNightUtc: string; lastTickUtc: string };
  ledger: { trials: number; clusters: number; census: Record<string, number> };
  universes: StatusUniverse[];
  incubating: StatusIncubating[];
  graduates: { ref: string; since: string }[];
  recentJournal: StatusJournalRow[];
  history: StatusHistoryRow[];
}

/** Следующее срабатывание ночного крона после `now`. */
export function nextNightUtc(now: Date): string {
  const next = new Date(now);
  next.setUTCHours(NIGHT_UTC_HOUR, NIGHT_UTC_MINUTE, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

function funnelOf(screen: ScreenSummary): StatusUniverse["funnel"] {
  const stage = (key: string) => screen.stages[key];
  return [
    { stage: "batch", n: stage("halving_16")?.evaluated ?? 0 },
    { stage: "halving_16", n: stage("halving_16")?.passed ?? 0 },
    { stage: "halving_128", n: stage("halving_128")?.passed ?? 0 },
    { stage: "gauntlet", n: stage("gauntlet")?.passed ?? 0 },
  ];
}

export interface BuildStatusInput {
  screens: readonly ScreenSummary[];
  incubation: IncubationSummary;
  supervision: SupervisionSummary;
  ledger: TrialLedger;
  book: IncubationBook;
  states: readonly string[];
  /**
   * Предыдущий status.json, если есть. Часовая догонка приходит БЕЗ screens —
   * тогда воронка последней ночи и её длительность переносятся отсюда,
   * иначе тик стирал бы главную часть монитора до следующей ночи.
   */
  previous?: ResearcherStatus | null;
  durationMin?: number | null;
  now?: Date;
}

export function buildStatus(input: BuildStatusInput): ResearcherStatus {
  const now = input.now ?? new Date();
  const { ledger, book } = input;

  const census: Record<string, number> = {};
  for (const state of input.states) {
    const n = ledger.byState(state as never).length;
    if (n > 0) census[state] = n;
  }

  const incubating: StatusIncubating[] = [];
  for (const trial of ledger.byState("INCUBATING")) {
    const inc = book.get(trial.candidateId);
    const check = ledger.evalsFor(trial.candidateId, "incubation_check").at(-1);
    incubating.push({
      ref: publicRef(trial.spec),
      trades: Number(check?.metrics.trades ?? 0),
      needTrades: 40,
      days: Number(check?.metrics.days ?? 0),
      needDays: inc?.tf === "1d" ? 180 : 120,
      llr: Number(check?.metrics.llr ?? 0),
    });
  }

  const graduates = ledger.byState("GRADUATED").map((trial) => ({
    ref: publicRef(trial.spec),
    since:
      ledger
        .transitionsFor(trial.candidateId)
        .filter((t) => t.toState === "GRADUATED")
        .at(-1)?.createdAt ?? trial.updatedAt,
  }));

  // Лента: candidateId из журнала НЕ попадает наружу — только publicRef.
  const recentJournal: StatusJournalRow[] = ledger
    .recentTransitions(JOURNAL_FEED_SIZE)
    .map((row) => {
      const trial = ledger.getTrial(row.candidateId);
      return {
        at: row.createdAt,
        state: row.toState,
        ref: trial ? publicRef(trial.spec) : "неизвестно",
        reason: row.reason,
      };
    });

  const isNight = input.screens.length > 0;
  const previousHistory = input.previous?.history ?? [];
  const batch = input.screens.reduce((sum, s) => sum + (s.stages.halving_16?.evaluated ?? 0), 0);
  const validated = input.screens.reduce((sum, s) => sum + s.validated.length, 0);
  const today = now.toISOString().slice(0, 10);
  // Тик истории не пишет — иначе каждый час подменял бы строку ночи нулями.
  const history: StatusHistoryRow[] = isNight
    ? [
        { date: today, batch, validated, graduated: input.incubation.graduated.length },
        ...previousHistory.filter((row) => row.date !== today),
      ].slice(0, HISTORY_KEEP)
    : [...previousHistory];

  return {
    version: 1,
    generatedAt: now.toISOString(),
    run: {
      durationMin: isNight ? (input.durationMin ?? null) : (input.previous?.run.durationMin ?? null),
      nextNightUtc: nextNightUtc(now),
      lastTickUtc: now.toISOString(),
    },
    ledger: { ...ledger.counts(), census },
    universes: isNight
      ? input.screens.map((screen) => ({
          tf: screen.tf,
          batch: screen.stages.halving_16?.evaluated ?? 0,
          symbols: screen.universe,
          funnel: funnelOf(screen),
          rejectedByGate: screen.rejectedByGate,
          realityCheckP: screen.diagnostics?.realityCheck.pValue ?? null,
          pbo: screen.diagnostics?.pbo?.pbo ?? null,
        }))
      : (input.previous?.universes ?? []),
    incubating,
    graduates,
    recentJournal,
    history,
  };
}
