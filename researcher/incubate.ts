/**
 * Инкубатор — форвард-проверка выживших жерновов на живом рынке (без денег).
 *
 * Цикл одного запуска (launchd будет звать ежечасно, фаза R5):
 * 1. Посев: VALIDATED-кандидаты с матожиданием ≥ 0.20R входят в инкубатор,
 *    остальные отклоняются — инкубация слабого края лишь тратит календарь.
 * 2. Догонка: для каждого инкубируемого — свежие ЗАКРЫТЫЕ бары с Binance,
 *    прогон тем же движком, что и бэктест (паритет), новые сделки в
 *    append-only книгу. Mac спал — не страшно: правила заморожены до данных.
 * 3. Решение: SPRT по сделкам в порядке закрытия. Принял H1 + выдержан
 *    календарь (≥40 сделок И ≥120 дней на 1h/4h, ≥180 на 1d) → GRADUATED.
 *    Принял H0 → KILLED. Тянет дольше min(3·E[N], 150 сделок, 365 дней) →
 *    KILLED усечением: «не доказал за отведённое время» — тоже ответ.
 *
 * Запуск: npx tsx researcher/incubate.ts [--db path]
 */
import { pathToFileURL } from "node:url";
import type { TradeResult } from "../src/core/types/index.ts";
import { DB_PATH } from "./paths.ts";
import { runBacktest } from "../src/core/backtest/engine.ts";
import { tradeCostInR } from "../src/core/committee/costModel.ts";
import { toStrategyConfig, type SignalTf } from "./grammar.ts";
import { fetchBinanceKlines, TF_SECONDS } from "./binance.ts";
import { buildCard, DEFAULT_VAULT_CARDS_DIR, writeCard } from "./cards.ts";
import { IncubationBook, type PaperTradeRow } from "./incubationBook.ts";
import { TrialLedger } from "./ledger.ts";
import { expectedAcceptSampleSize, sprtDecide } from "./sprt.ts";
import type { Candle } from "../src/core/types/index.ts";

/** Входной порог инкубатора: край тоньше 0.20R не окупит даже календарь. */
export const ENTRY_GATE_EXPECTANCY = 0.2;
/** Прогрев индикаторов перед первым интересующим баром (SMA200 + перцентиль волы). */
export const WARMUP_BARS = 600;
export const MAX_TRADES_CAP = 150;
export const MAX_INCUBATION_DAYS = 365;
export const MIN_GRADUATION_TRADES = 40;
export const MIN_GRADUATION_DAYS: Record<SignalTf, number> = {
  "1h": 120,
  "4h": 120,
  "1d": 180,
};
/** Нижний предел σ: вырожденно узкое распределение R завысило бы шаг LLR. */
const SIGMA_FLOOR = 0.5;

export type CandleSource = (
  symbol: string,
  tf: SignalTf,
  startTimeSec: number,
) => Promise<Candle[]>;

export interface IncubationSummary {
  seeded: number;
  rejectedAtEntry: number;
  checked: number;
  newTrades: number;
  graduated: string[];
  killed: string[];
}

export function netR(row: PaperTradeRow): number {
  const pseudo = { entryPrice: row.entryPrice, stopPrice: row.stopPrice } as TradeResult;
  return row.rMultiple - tradeCostInR(pseudo);
}

/**
 * Догонка одного кандидата по всем его символам: свежие закрытые бары →
 * движок → новые сделки в книгу (дубли отсекает БД). Общая для инкубатора
 * и надзора за выпускниками — форвард-учёт не заканчивается выпуском.
 */
export async function catchUpTrades(
  book: IncubationBook,
  candidateId: string,
  spec: Parameters<typeof toStrategyConfig>[0],
  inc: { tf: SignalTf; symbols: string[]; frozenAt: number },
  source: CandleSource,
  nowSec: () => number,
  log: (m: string) => void,
): Promise<number> {
  const config = toStrategyConfig(spec);
  const tfSec = TF_SECONDS[inc.tf];
  let inserted = 0;
  for (const symbol of inc.symbols) {
    const cursor = book.cursor(candidateId, symbol) ?? inc.frozenAt;
    const startSec = cursor - WARMUP_BARS * tfSec;
    let candles: Candle[];
    try {
      candles = await source(symbol, inc.tf, startSec);
    } catch (error) {
      log(`  ${symbol}: источник свечей упал (${String(error)}) — догоним в следующий раз`);
      continue;
    }
    const closed = candles.filter((c) => c.time + tfSec <= nowSec());
    if (closed.length < 250) continue; // прогрева не хватает — сигналы не считаемы
    const trades = runBacktest(closed, config, symbol).filter((t) => t.entryTime > inc.frozenAt);
    inserted += book.recordTrades(candidateId, trades);
    book.setCursor(candidateId, symbol, closed[closed.length - 1].time);
  }
  return inserted;
}

export async function runIncubation(opts: {
  dbPath: string;
  source?: CandleSource;
  /** Unix-секунды «сейчас» — инъекция для тестов и детерминизма. */
  nowSec?: () => number;
  log?: (m: string) => void;
  /** Куда писать карточки выпускников; не задан — карточки не пишутся (тесты). */
  vaultCardsDir?: string;
}): Promise<IncubationSummary> {
  const log = opts.log ?? (() => {});
  const source = opts.source ?? fetchBinanceKlines;
  const nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000));
  // Единые часы: заморозка, курсоры и решения живут в одном календаре.
  const clock = { now: () => new Date(nowSec() * 1000).toISOString() };
  const ledger = new TrialLedger(opts.dbPath, clock);
  const book = new IncubationBook(opts.dbPath, clock);
  const summary: IncubationSummary = {
    seeded: 0,
    rejectedAtEntry: 0,
    checked: 0,
    newTrades: 0,
    graduated: [],
    killed: [],
  };

  // ── 1. Посев ──────────────────────────────────────────────────────────────
  for (const trial of ledger.byState("VALIDATED")) {
    const seed = ledger.evalsFor(trial.candidateId, "incubation_seed").at(-1);
    if (!seed) {
      log(`  ${trial.candidateId}: нет incubation_seed — пропуск (старый формат скрина)`);
      continue;
    }
    const netExpectancy = Number(seed.metrics.netExpectancy);
    if (netExpectancy < ENTRY_GATE_EXPECTANCY) {
      ledger.transition(
        trial.candidateId,
        "REJECTED",
        `входной порог инкубатора: ${netExpectancy.toFixed(3)}R < ${ENTRY_GATE_EXPECTANCY}R`,
      );
      summary.rejectedAtEntry += 1;
      continue;
    }
    const sigma = Math.max(Number(seed.metrics.sigma), SIGMA_FLOOR);
    const mu1 = netExpectancy / 2; // скептичная половина Бентера
    const expectedN = expectedAcceptSampleSize(mu1, sigma);
    // Заморозка — время ПЕРЕХОДА в VALIDATED из журнала переходов, а не
    // updated_at: тот мутирует (например, setClusterKey) и сдвинул бы границу
    // «что считается форвардом».
    const validatedAt = ledger
      .transitionsFor(trial.candidateId)
      .filter((t) => t.toState === "VALIDATED")
      .at(-1)?.createdAt;
    const frozenAt = Math.floor(Date.parse(validatedAt ?? trial.updatedAt) / 1000);
    book.start({
      candidateId: trial.candidateId,
      tf: String(seed.metrics.tf) as SignalTf,
      symbols: String(seed.metrics.symbols).split(","),
      mu1,
      sigma,
      expectedN,
      frozenAt,
    });
    ledger.transition(
      trial.candidateId,
      "INCUBATING",
      `в инкубатор: μ1=${mu1.toFixed(3)}R, σ=${sigma.toFixed(2)}, E[N]≈${Math.round(expectedN)} сделок`,
    );
    summary.seeded += 1;
  }

  // ── 2–3. Догонка и решение ────────────────────────────────────────────────
  for (const trial of ledger.byState("INCUBATING")) {
    const inc = book.get(trial.candidateId);
    if (!inc) continue;
    summary.newTrades += await catchUpTrades(
      book,
      trial.candidateId,
      trial.spec,
      inc,
      source,
      nowSec,
      log,
    );

    const rows = book.trades(trial.candidateId);
    const sprt = sprtDecide(rows.map(netR), inc.mu1, inc.sigma);
    const days = (nowSec() - inc.frozenAt) / 86_400;
    summary.checked += 1;
    ledger.recordEval(trial.candidateId, "incubation_check", {
      trades: rows.length,
      llr: Number(sprt.llr.toFixed(3)),
      decision: sprt.decision,
      stoppedAt: sprt.stoppedAt,
      days: Number(days.toFixed(1)),
    });

    if (sprt.decision === "reject") {
      ledger.transition(
        trial.candidateId,
        "KILLED",
        `SPRT принял H0: llr=${sprt.llr.toFixed(2)} после ${sprt.stoppedAt} сделок — край не подтвердился вживую`,
      );
      summary.killed.push(trial.candidateId);
      continue;
    }
    if (sprt.decision === "accept") {
      const daysNeeded = MIN_GRADUATION_DAYS[inc.tf];
      if (rows.length >= MIN_GRADUATION_TRADES && days >= daysNeeded) {
        const reason = `SPRT принял H1 (llr=${sprt.llr.toFixed(2)}, ${rows.length} сделок, ${Math.round(days)} дней)`;
        ledger.transition(trial.candidateId, "GRADUATED", reason);
        summary.graduated.push(trial.candidateId);
        if (opts.vaultCardsDir) {
          const path = writeCard(
            opts.vaultCardsDir,
            trial.candidateId,
            buildCard({
              candidateId: trial.candidateId,
              spec: trial.spec,
              incubation: inc,
              trades: rows,
              graduationReason: reason,
              clusterKey: trial.clusterKey,
              graduatedAt: new Date(nowSec() * 1000).toISOString(),
            }),
          );
          log(`  🎓 карточка выпускника: ${path}`);
        }
      } else {
        log(
          `  ${trial.candidateId}: SPRT «за», но календарь не выдержан ` +
            `(${rows.length}/${MIN_GRADUATION_TRADES} сделок, ${Math.round(days)}/${daysNeeded} дней) — ждём`,
        );
      }
      continue;
    }
    // continue: усечение — «не смог решить» тоже решение.
    const tradeCap = Math.min(3 * inc.expectedN, MAX_TRADES_CAP);
    if (rows.length >= tradeCap) {
      ledger.transition(
        trial.candidateId,
        "KILLED",
        `усечение: ${rows.length} сделок ≥ ${Math.round(tradeCap)} (3×E[N]) без решения SPRT`,
      );
      summary.killed.push(trial.candidateId);
    } else if (days > MAX_INCUBATION_DAYS) {
      ledger.transition(
        trial.candidateId,
        "KILLED",
        `усечение: ${Math.round(days)} дней > ${MAX_INCUBATION_DAYS} без решения SPRT`,
      );
      summary.killed.push(trial.candidateId);
    }
  }

  ledger.close();
  book.close();
  return summary;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dbFlag = argv.indexOf("--db");
  const summary = await runIncubation({
    dbPath: (dbFlag >= 0 ? argv[dbFlag + 1] : undefined) ?? DB_PATH,
    vaultCardsDir: DEFAULT_VAULT_CARDS_DIR,
    log: (m) => console.error(m),
  });
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
