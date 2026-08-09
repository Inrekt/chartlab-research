/**
 * Фальсификация: срабатывает ли ЗАМОРОЖЕННОЕ правило на сделках владельца.
 *
 * Это НЕ подбор. Ни одна ось правила здесь не варьируется, ничего не
 * выбирается по результату: правило v1 заморожено задолго до появления этих
 * данных, и вопрос ровно один — попадает оно в его входы или нет.
 *
 * Почему именно так, а не подбором лучшего варианта: критерий «насколько
 * вариант воспроизводит входы» это полнота без точности, и правило,
 * срабатывающее на каждом баре, выигрывает его тривиально. Плюс перебор
 * невидим бюджету проб (кластеризация схлопывает варианты по корреляции
 * доходностей), а доходность протекает в отбор через то, какие сделки
 * владелец вспомнил. Разбор: docs/owner-trades-falsification-preregistration.md.
 *
 * Пороги и трактовка обоих исходов зафиксированы в пре-регистрации ДО
 * получения данных. Этот модуль их не выбирает, а исполняет.
 */
import { pathToFileURL } from "node:url";
import { runBacktest } from "../src/core/backtest/engine.ts";
import { loadCandles } from "./corpus.ts";
import { enumerateAll, setupFamily, toStrategyConfig, type SignalTf } from "./grammar.ts";
import { TrialLedger, type OwnerTradeRow } from "./ledger.ts";
import { DB_PATH } from "./paths.ts";

/** Допуск по времени, зафиксированный в пре-регистрации. */
export const TOLERANCE_BARS = 2;
/** Пороги исходов, зафиксированные в пре-регистрации. */
export const CONFIRM_AT = 6;
export const REFUTE_AT = 2;

export interface MatchRow {
  tradeId: number;
  symbol: string;
  direction: "long" | "short";
  entryIso: string;
  /** Правило сработало в допуске и в ТУ ЖЕ сторону. */
  matched: boolean;
  /** Ближайший по времени сигнал правила, в барах. null — сигналов не было. */
  nearestBars: number | null;
  /** Корпус не покрывает символ или дату — сделка ИСКЛЮЧАЕТСЯ из знаменателя. */
  covered: boolean;
}

export interface MatchReport {
  tf: SignalTf;
  rows: MatchRow[];
  covered: number;
  matched: number;
  verdict: "формализация верна" | "формализация НЕ ТА" | "неопределённо" | "нет данных";
}

/**
 * Сигнальные бары замороженного правила на одном символе.
 *
 * Берутся ВСЕ сетапы семейства нужного направления: правило заморожено как
 * семейство из трёх длин окна, и выбирать из них одну означало бы начать
 * подбор — ровно то, чего этот тест избегает.
 */
function signalTimes(symbol: string, tf: SignalTf, direction: "long" | "short"): number[] {
  const candles = loadCandles(symbol, tf);
  if (!candles || candles.length < 600) return [];
  const specs = [...enumerateAll()].filter(
    (s) =>
      setupFamily(s.setup) === "range_sweep" && s.timeframe === tf && s.direction === direction,
  );
  const times = new Set<number>();
  for (const spec of specs) {
    for (const t of runBacktest(candles, toStrategyConfig(spec), symbol)) times.add(t.entryTime);
  }
  return [...times].sort((a, b) => a - b);
}

const BAR_SECONDS: Record<SignalTf, number> = { "1h": 3600, "4h": 14400, "1d": 86400 };

export function matchOwnerTrades(trades: readonly OwnerTradeRow[], tf: SignalTf): MatchReport {
  const bar = BAR_SECONDS[tf];
  const cache = new Map<string, number[]>();
  const rows: MatchRow[] = [];

  for (const t of trades) {
    const key = `${t.symbol}|${t.direction}`;
    if (!cache.has(key)) cache.set(key, signalTimes(t.symbol, tf, t.direction));
    const sigs = cache.get(key)!;
    const candles = loadCandles(t.symbol, tf);
    const entrySec = Math.floor(Date.parse(t.entryIso) / 1000);

    // Покрытие проверяется по корпусу, а не по наличию сигналов: отсутствие
    // сигналов — это РЕЗУЛЬТАТ, а отсутствие данных — отсутствие теста, и
    // смешивать их значит записать пробел в данных как опровержение.
    const covered =
      !!candles &&
      candles.length > 0 &&
      entrySec >= candles[0].time &&
      entrySec <= candles[candles.length - 1].time;

    let nearestBars: number | null = null;
    for (const s of sigs) {
      const d = Math.abs(s - entrySec) / bar;
      if (nearestBars === null || d < nearestBars) nearestBars = d;
    }
    rows.push({
      tradeId: t.id,
      symbol: t.symbol,
      direction: t.direction,
      entryIso: t.entryIso,
      covered,
      nearestBars: nearestBars === null ? null : Number(nearestBars.toFixed(2)),
      matched: covered && nearestBars !== null && nearestBars <= TOLERANCE_BARS,
    });
  }

  const covered = rows.filter((r) => r.covered).length;
  const matched = rows.filter((r) => r.matched).length;
  const verdict: MatchReport["verdict"] =
    covered === 0
      ? "нет данных"
      : matched >= CONFIRM_AT
        ? "формализация верна"
        : matched <= REFUTE_AT
          ? "формализация НЕ ТА"
          : "неопределённо";
  return { tf, rows, covered, matched, verdict };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const ledger = new TrialLedger(DB_PATH);
  const trades = ledger.ownerTrades();
  ledger.close();
  if (trades.length === 0) {
    console.error("сделок владельца в журнале нет — записывать через researcher/ownerTrades.ts");
    process.exit(2);
  }
  const reports = (["1h", "4h"] as SignalTf[]).map((tf) => matchOwnerTrades(trades, tf));
  for (const r of reports) {
    console.error(`\n=== ${r.tf}: совпало ${r.matched} из ${r.covered} покрытых — ${r.verdict}`);
    for (const row of r.rows) {
      const near = row.nearestBars === null ? "сигналов нет" : `${row.nearestBars} бара`;
      console.error(
        `  ${row.symbol} ${row.direction} ${row.entryIso.slice(0, 16)}: ` +
          (row.covered ? `${row.matched ? "ПОПАЛ" : "мимо"} (ближайший ${near})` : "корпус не покрывает"),
      );
    }
  }
  console.error(
    "\nТрактовка исходов зафиксирована ДО данных: " +
      "docs/owner-trades-falsification-preregistration.md",
  );
  console.log(JSON.stringify(reports, null, 2));
}
