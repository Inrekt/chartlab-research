/**
 * Надзор за выпускниками — вечная часть машины.
 *
 * Edge умирает (медианная жизнь опубликованного края — 1–2 года), поэтому
 * выпуск — не конец проверки, а смена её режима:
 *
 * 1. Форвард-учёт сделок продолжается той же догонкой, что в инкубаторе.
 * 2. Каждая сделка выпускника стандартизуется против эталона, ЗАМОРОЖЕННОГО
 *    в момент выпуска (сделки инкубации), и кормит односторонний CUSUM.
 *    Тревога → DECAYING: торговлю по карточке остановить.
 * 3. В DECAYING судьбу решает SPRT по сделкам ПОСЛЕ тревоги: заново доказал
 *    край → единственная за жизнь реквалификация; отверг — RETIRED; молчит
 *    90 дней — RETIRED («не восстановился за квартал»).
 *
 * Запуск: npx tsx researcher/supervise.ts [--db path]
 */
import { pathToFileURL } from "node:url";
import { appendCardEvent, DEFAULT_VAULT_CARDS_DIR } from "./cards.ts";
import { DB_PATH } from "./paths.ts";
import { cusumLower } from "./cusum.ts";
import { catchUpTrades, ICC_FALLBACK_RHO, netR, type CandleSource } from "./incubate.ts";
import { fetchBinanceKlines } from "./binance.ts";
import { IncubationBook } from "./incubationBook.ts";
import { moments } from "./stats.ts";
import { dailySigmas, sprtDecide, toDailyObservations, withinDayIcc } from "./sprt.ts";
import { TrialLedger, type TrialRow } from "./ledger.ts";

/** DECAYING без реабилитации дольше этого срока — пенсия. */
export const MAX_DECAY_DAYS = 90;
/** Меньше эталонных сделок — σ_ref не измерить, надзор невозможен честно. */
const MIN_REFERENCE_TRADES = 10;
const SIGMA_FLOOR = 0.5;

export interface SupervisionSummary {
  supervised: number;
  newTrades: number;
  decayed: string[];
  requalified: string[];
  retired: string[];
}

function transitionSec(
  ledger: TrialLedger,
  id: string,
  toState: string,
  which: "first" | "last",
): number | undefined {
  const rows = ledger.transitionsFor(id).filter((t) => t.toState === toState);
  const row = which === "first" ? rows[0] : rows.at(-1);
  return row ? Math.floor(Date.parse(row.createdAt) / 1000) : undefined;
}

export async function runSupervision(opts: {
  dbPath: string;
  source?: CandleSource;
  nowSec?: () => number;
  log?: (m: string) => void;
  vaultCardsDir?: string;
}): Promise<SupervisionSummary> {
  const log = opts.log ?? (() => {});
  const source = opts.source ?? fetchBinanceKlines;
  const nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000));
  // Единые часы: таймштампы журнала обязаны идти от того же nowSec, что и
  // решения, — иначе фильтры «после тревоги» сравнивают разные календари.
  const clock = { now: () => new Date(nowSec() * 1000).toISOString() };
  const ledger = new TrialLedger(opts.dbPath, clock);
  const book = new IncubationBook(opts.dbPath, clock);
  const summary: SupervisionSummary = {
    supervised: 0,
    newTrades: 0,
    decayed: [],
    requalified: [],
    retired: [],
  };
  const cardEvent = (id: string, line: string) => {
    if (opts.vaultCardsDir) {
      appendCardEvent(opts.vaultCardsDir, id, `${new Date(nowSec() * 1000).toISOString().slice(0, 10)} — ${line}`);
    }
  };

  const wards: TrialRow[] = [...ledger.byState("GRADUATED"), ...ledger.byState("DECAYING")];
  for (const trial of wards) {
    const id = trial.candidateId;
    const inc = book.get(id);
    if (!inc) continue;
    summary.supervised += 1;
    summary.newTrades += await catchUpTrades(book, id, trial.spec, inc, source, nowSec, log);

    const rows = book.trades(id);
    // Окно надзора — от ПОСЛЕДНЕГО выпуска (реквалификация начинает новый
    // счёт), а эталон — здоровые сделки до ПЕРВОГО: иначе после
    // реквалификации в эталон попали бы сделки периода деградации и CUSUM
    // сравнивал бы с больным образцом.
    const gradAt = transitionSec(ledger, id, "GRADUATED", "last");
    const firstGradAt = transitionSec(ledger, id, "GRADUATED", "first");
    if (!gradAt || !firstGradAt) continue;
    const reference = rows.filter((r) => r.exitTime <= firstGradAt).map(netR);
    if (reference.length < MIN_REFERENCE_TRADES) {
      log(`  ${id}: эталон из ${reference.length} сделок — надзор отложен`);
      continue;
    }
    const ref = moments(reference);
    const sigmaRef = Math.max(ref.stdDev, SIGMA_FLOOR);

    if (trial.state === "GRADUATED") {
      const post = rows.filter((r) => r.exitTime > gradAt);
      const zs = post.map((r) => (netR(r) - ref.mean) / sigmaRef);
      const cusum = cusumLower(zs);
      ledger.recordEval(id, "supervision_check", {
        postTrades: post.length,
        cusumS: Number(cusum.s.toFixed(2)),
        cusumMax: Number(cusum.max.toFixed(2)),
        alarmAt: cusum.alarmAt,
      });
      if (cusum.alarmAt > 0) {
        const reason = `CUSUM-тревога на сделке ${cusum.alarmAt} из ${post.length} (S=${cusum.max.toFixed(1)} > 5) — деградация против эталона выпуска`;
        ledger.transition(id, "DECAYING", reason);
        cardEvent(id, `⚠️ DECAYING: ${reason}. Торговлю по карточке остановить.`);
        summary.decayed.push(id);
      }
      continue;
    }

    // DECAYING: судьбу решает SPRT по сделкам после тревоги.
    const decayAt = transitionSec(ledger, id, "DECAYING", "last");
    if (!decayAt) continue;
    /*
     * ДНЕВНЫЕ наблюдения, как и в инкубаторе. Здесь стоял посделочный счёт —
     * путь, пропущенный при переводе SPRT на дневные (GATE_VERSION=6).
     *
     * Цена расхождения замерена в той же пре-регистрации: посделочный счёт при
     * измеренной ρ=0.44 даёт ложное принятие 14.5% вместо заявленных ≤5.6%,
     * втрое мягче вывески. И это единственное место во всей машине с ПРЯМЫМ
     * денежным последствием: принятие здесь пишет в карточку «торговлю можно
     * возобновить» по стратегии, которую CUSUM уже объявил деградировавшей, а
     * владелец торгует по карточке руками.
     */
    const postRows = rows.filter((r) => r.exitTime > decayAt);
    const netByDay = postRows.map((r) => ({ day: Math.floor(r.exitTime / 86_400), net: netR(r) }));
    const postDailyObs = toDailyObservations(netByDay);
    const postDecay = postDailyObs.map((d) => d.mean);
    const icc = withinDayIcc(netByDay);
    // Не хватило данных на оценку ρ — берём КОНСЕРВАТИВНУЮ: завышенная ρ даёт
    // больший σ_день, то есть более осторожный тест. Ноль здесь вернул бы ту
    // самую ошибку, от которой правка защищает.
    const rho = icc?.rho ?? ICC_FALLBACK_RHO;
    // σ ПО КАЖДОМУ дню (его число сделок), а не одно из m̄: усреднение занижает
    // σ_день на ~5.6% в пользу стратегии (Йенсен). Реквалификация возобновляет
    // ручную торговлю — здесь мягкость особенно дорога.
    const sprt = sprtDecide(postDecay, inc.mu1, dailySigmas(postDailyObs, inc.sigma, rho));
    const decayDays = (nowSec() - decayAt) / 86_400;
    ledger.recordEval(id, "requalification_check", {
      // postDecay — ДНЕВНЫЕ наблюдения (по одному на день после toDailyObservations),
      // а не сделки: SPRT переведён на дневную сетку из-за корреляции внутри дня.
      // Раньше поле звалось postDecayTrades и карточка печатала «N сделок» — это
      // вводило владельца в заблуждение (он видел бы «40 сделок», а это 40 дней).
      postDecayDays: postDecay.length,
      llr: Number(sprt.llr.toFixed(3)),
      decision: sprt.decision,
      decayDays: Number(decayDays.toFixed(1)),
    });

    if (sprt.decision === "accept") {
      try {
        ledger.transition(
          id,
          "GRADUATED",
          `реквалификация: SPRT заново доказал край (llr=${sprt.llr.toFixed(2)}, ${postDecay.length} дней)`,
        );
        cardEvent(id, `✅ реквалификация: SPRT заново доказал край — торговлю можно возобновить`);
        summary.requalified.push(id);
      } catch (error) {
        // Пенсией наказываем ТОЛЬКО за вторую реквалификацию; любая другая
        // ошибка перехода — это баг, который обязан всплыть, а не похоронить
        // живую стратегию втихую.
        if (!String(error).includes("уже использована")) throw error;
        ledger.transition(id, "RETIRED", "вторая деградация после единственной реквалификации");
        cardEvent(id, `🪦 RETIRED: вторая деградация — карточка закрыта навсегда`);
        summary.retired.push(id);
      }
    } else if (sprt.decision === "reject") {
      ledger.transition(
        id,
        "RETIRED",
        `SPRT в деградации принял H0 (llr=${sprt.llr.toFixed(2)}) — край умер`,
      );
      cardEvent(id, `🪦 RETIRED: край не восстановился (SPRT) — карточка закрыта навсегда`);
      summary.retired.push(id);
    } else if (decayDays > MAX_DECAY_DAYS) {
      ledger.transition(
        id,
        "RETIRED",
        `${Math.round(decayDays)} дней в деградации без восстановления (> ${MAX_DECAY_DAYS})`,
      );
      cardEvent(id, `🪦 RETIRED: не восстановился за ${MAX_DECAY_DAYS} дней — карточка закрыта`);
      summary.retired.push(id);
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
  const summary = await runSupervision({
    dbPath: (dbFlag >= 0 ? argv[dbFlag + 1] : undefined) ?? DB_PATH,
    vaultCardsDir: DEFAULT_VAULT_CARDS_DIR,
    log: (m) => console.error(m),
  });
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
