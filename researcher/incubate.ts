/**
 * Инкубатор — форвард-проверка выживших жерновов на живом рынке (без денег).
 *
 * Цикл одного запуска (launchd будет звать ежечасно, фаза R5):
 * 1. Посев: VALIDATED-кандидаты с отношением сигнал/шум δ = μ₁/σ ≥ 0.18
 *    входят в инкубатор, остальные отклоняются — тест, который не может
 *    закончиться за отведённые сделки, лишь тратит календарь.
 * 2. Догонка: для каждого инкубируемого — свежие ЗАКРЫТЫЕ бары с Binance,
 *    прогон тем же движком, что и бэктест (паритет), новые сделки в
 *    append-only книгу. Mac спал — не страшно: правила заморожены до данных.
 * 3. Решение: SPRT по сделкам в порядке закрытия. Принял H1 + выдержан
 *    календарь (≥40 сделок И ≥120 дней на 1h/4h, ≥180 на 1d) → GRADUATED.
 *    Принял H0 → KILLED. Тянет дольше 3·E[N] сделок либо 365 дней →
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
import { ExchangeBlockedError, fetchBinanceKlines, TF_SECONDS } from "./binance.ts";
import { loadCandles } from "./corpus.ts";
import { buildCard, DEFAULT_VAULT_CARDS_DIR, writeCard } from "./cards.ts";
import { IncubationBook, type PaperTradeRow } from "./incubationBook.ts";
import { TrialLedger } from "./ledger.ts";
import {
  dailySigma,
  expectedAcceptSampleSize,
  sprtDecide,
  toDailyObservations,
  withinDayIcc,
} from "./sprt.ts";
import type { Candle } from "../src/core/types/index.ts";

/**
 * Входной порог инкубатора — в δ = μ₁/σ (сигнал/шум), не в абсолютных R:
 * кандидаты с одинаковым краем, но разным σ имеют кратно разные шансы дожить
 * до вердикта.
 *
 * Было 0.18 и выводилось из «E[N] ≤ ~150 СДЕЛОК при α=0.05, β=0.1». Величина,
 * ради которой порог подбирался, с тех пор сменилась: SPRT переведён на
 * ДНЕВНЫЕ наблюдения (сделки внутри дня скоррелированы, ρ 0.20/0.44, и
 * посделочный счёт давал ложное принятие 14.5% вместо 5.6%). Порог остался от
 * теста, которого больше нет.
 *
 * Цена этого была скрытой и высокой. При σ≈1.04 пол SIGMA_FLOOR не связывает
 * никогда, и условие схлопывалось в тождество «tradeSharpe ≥ 0.36» — при
 * лучшем за всю историю журнала 0.2539. То есть после починки ворот дефляции
 * кандидат проходил бы девять ворот и умирал следующей строкой, у закрытой
 * двери, и ни одна часть машины об этом не сообщала бы.
 *
 * 0.12 выбрано ПРАВИЛОМ, объявленным до подстановки чисел: наименьший порог
 * сетки, при котором ожидаемое время решения на медленном таймфрейме не
 * превышает ⅔ календарного потолка (221 день против 243). Ожидание — это
 * середина распределения, и кандидат, идущий медленнее ожидания, обязан всё
 * равно успеть получить вердикт: смерть «по календарю» не доказывает и не
 * опровергает ничего, то есть тратит год без знания.
 *
 * Пре-регистрация с замером и заранее записанным эффектом:
 * docs/incubator-entry-preregistration.md.
 */
export const ENTRY_GATE_DELTA = 0.12;
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
/**
 * ρ, когда дней с несколькими сделками ещё мало для честной оценки.
 *
 * Взят ВЕРХНИЙ из замеренных (0.44 на 4ч против 0.20 на 1ч), потому что
 * завышенная ρ даёт больший σ_день и более осторожный тест. Ноль здесь вернул
 * бы ровно ту ошибку, от которой защищает вся правка.
 *
 * Экспортируется: надзор обязан считать реквалификацию ТЕМ ЖЕ прибором, что и
 * инкубатор, иначе пороги молча разъезжаются — так уже случилось однажды.
 */
export const ICC_FALLBACK_RHO = 0.45;

export type CandleSource = (
  symbol: string,
  tf: SignalTf,
  startTimeSec: number,
) => Promise<Candle[]>;

/**
 * Запасной источник — КОРПУС, когда биржа недоступна напрямую.
 *
 * Нужен из-за среды: раннеры GitHub получают от REST Binance 451 (блокировка
 * по юрисдикции), и без запасного пути инкубация в облаке невозможна вовсе —
 * кандидат просидел бы 365 дней с нулём сделок и умер как «не доказавший
 * край». Корпус при этом лежит рядом: ночь наполняет его из файлового архива
 * биржи, который открыт.
 *
 * ⚠️ Отставание на сутки методологически БЕЗВРЕДНО, и это не поблажка себе.
 * Форвард-тест накапливает ЗАКРЫТЫЕ сделки; узнать о закрытой сделке на день
 * позже не даёт ни грамма информации о будущем и ничего не смещает — меняется
 * только момент, когда мы об этом узнаём. Заморозка правил по-прежнему
 * происходит в момент валидации, а не задним числом.
 *
 * Чего этот источник НЕ даёт: живых сигналов для реальной торговли. Они
 * понадобятся только после первого выпускника, и к тому времени нужен хост с
 * прямым доступом к бирже.
 */
export function corpusCandleSource(): CandleSource {
  return async (symbol, tf, startTimeSec) => {
    const all = loadCandles(symbol, tf);
    /*
     * КОРПУСА НЕТ — это отказ источника, и он обязан быть исключением.
     *
     * Раньше здесь возвращался пустой массив, неотличимый от нормального «за
     * этот час новых баров не появилось». Потребитель на такое молча делал
     * `continue`, счётчик отказов не рос, страж «упали ВСЕ символы» не
     * срабатывал — и кандидат копил календарь молчания, пока через 365 дней
     * не умирал «не доказавшим край». Отказ инфраструктуры записывался бы в
     * журнал как вывод о рынке.
     *
     * Путь не гипотетический: в облаке корпус живёт в кэше раннера, и на
     * промахе кэша каталога просто нет.
     */
    if (!all) {
      throw new Error(
        `корпус не содержит ${symbol} ${tf}: спросить не получилось, ` +
          "и это отказ источника, а не отсутствие сделок",
      );
    }
    return all.filter((c) => c.time >= startTimeSec);
  };
}

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
  let failed = 0;
  for (const symbol of inc.symbols) {
    const cursor = book.cursor(candidateId, symbol) ?? inc.frozenAt;
    const startSec = cursor - WARMUP_BARS * tfSec;
    let candles: Candle[];
    try {
      candles = await source(symbol, inc.tf, startSec);
    } catch (error) {
      // Постоянная недоступность (451/403 — блокировка по юрисдикции) НЕ
      // проглатывается: «догоним в следующий раз» здесь было бы ложью, и
      // повторялось бы каждый час, пока кандидат не умрёт по календарю.
      if (error instanceof ExchangeBlockedError) throw error;
      failed += 1;
      log(`  ${symbol}: источник свечей упал (${String(error)}) — догоним в следующий раз`);
      continue;
    }
    const closed = candles.filter((c) => c.time + tfSec <= nowSec());
    // Прогрева не хватает — сигналы не считаемы. Это НЕ отказ: у монеты,
    // листингованной недавно, честно мало баров, а пустой ответ означает
    // «новых баров с прошлого раза нет» — обычное состояние часового тика.
    // Настоящий отказ (корпуса нет вовсе) распознаёт САМ ИСТОЧНИК и бросает.
    if (closed.length < 250) continue;
    const trades = runBacktest(closed, config, symbol).filter((t) => t.entryTime > inc.frozenAt);
    inserted += book.recordTrades(candidateId, trades);
    book.setCursor(candidateId, symbol, closed[closed.length - 1].time);
  }

  // Упали ВСЕ символы — это не дыра в данных отдельной монеты, это мёртвый
  // источник, какой бы ни была причина. Молча вернуть ноль значит записать
  // «кандидат не наторговал» вместо «мы не смогли спросить», а через 365 дней
  // это станет вердиктом о крае.
  if (inc.symbols.length > 0 && failed === inc.symbols.length) {
    throw new Error(
      `Источник свечей недоступен по ВСЕМ ${failed} символам инкубации ${candidateId}. ` +
        "Это отказ источника, а не отсутствие сделок: продолжать значит копить " +
        "календарь молчания и списать его потом на отсутствие края.",
    );
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
    const seedSigma = Number(seed.metrics.sigma);
    /**
     * NaN-щит на ОБА числа посева. Любое сравнение с NaN ложно, поэтому
     * порог пропускал такого кандидата; дальше book.start() падал на
     * NOT NULL, INSERT OR IGNORE глотал ошибку, а переход в INCUBATING всё
     * равно происходил. Получался бессмертный призрак: на каждом часовом
     * тике `if (!inc) continue` срабатывал ДО проверок усечения, так что его
     * не мог убить даже календарь (найдено тестами спящих веток 31.07).
     */
    if (!Number.isFinite(netExpectancy) || !Number.isFinite(seedSigma)) {
      ledger.transition(
        trial.candidateId,
        "REJECTED",
        `входной порог инкубатора: посев испорчен (netExpectancy=${seed.metrics.netExpectancy}, sigma=${seed.metrics.sigma})`,
      );
      summary.rejectedAtEntry += 1;
      continue;
    }
    const sigma = Math.max(seedSigma, SIGMA_FLOOR);
    const mu1 = netExpectancy / 2; // скептичная половина Бентера
    /**
     * v3: порог входа в δ = μ₁/σ, а не в абсолютных R. Старая пара
     * (0.20R; cap 150) была внутренне противоречива: допускала кандидатов,
     * которым для решения нужно 475–1027 сделок, и обрывала тест на 150 —
     * 98–99.7% «усечений» при любой истине. δ ≥ 0.18 ⇔ E[N] ≤ ~150 при
     * α=0.05, β=0.1 — входной билет согласован с длиной теста.
     * Пре-регистрация: docs/gates-v3-preregistration.md.
     */
    const delta = mu1 / sigma;
    if (delta < ENTRY_GATE_DELTA) {
      ledger.transition(
        trial.candidateId,
        "REJECTED",
        `входной порог инкубатора: δ=${delta.toFixed(3)} < ${ENTRY_GATE_DELTA} (μ₁=${mu1.toFixed(3)}R, σ=${sigma.toFixed(2)})`,
      );
      summary.rejectedAtEntry += 1;
      continue;
    }
    const expectedN = expectedAcceptSampleSize(mu1, sigma);
    // Заморозка — время ПЕРЕХОДА в VALIDATED из журнала переходов, а не
    // updated_at: тот мутирует (например, setClusterKey) и сдвинул бы границу
    // «что считается форвардом».
    const validatedAt = ledger
      .transitionsFor(trial.candidateId)
      .filter((t) => t.toState === "VALIDATED")
      .at(-1)?.createdAt;
    const frozenAt = Math.floor(Date.parse(validatedAt ?? trial.updatedAt) / 1000);
    // Переход только если книга ДЕЙСТВИТЕЛЬНО завела строку: иначе кандидат
    // окажется в INCUBATING без записи, а такой на каждом тике отсеивается
    // строкой `if (!inc) continue` раньше любых проверок усечения.
    const started = book.start({
      candidateId: trial.candidateId,
      tf: String(seed.metrics.tf) as SignalTf,
      symbols: String(seed.metrics.symbols).split(","),
      mu1,
      sigma,
      expectedN,
      frozenAt,
    });
    if (!started) {
      log(`  ${trial.candidateId}: книга инкубации не приняла посев — остаётся VALIDATED, повторим`);
      continue;
    }
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

    // SPRT решает по ДНЕВНЫМ наблюдениям, а не по сделкам: сделки не
    // независимы (холд длиннее интервала входов, внутри дня их двигает общий
    // рыночный фактор). Замер на 600 симуляциях: наивный посделочный счёт при
    // измеренной ρ=0.44 даёт ложное принятие 14.5% вместо ≤5.6% — втрое мягче
    // вывески — и теряет 13 пунктов мощности.
    // Пре-регистрация: docs/sprt-daily-preregistration.md.
    const netByDay = rows.map((r) => ({ day: Math.floor(r.exitTime / 86_400), net: netR(r) }));
    const daily = toDailyObservations(netByDay);
    const icc = withinDayIcc(netByDay);
    // Данных на оценку ρ не хватило — берём КОНСЕРВАТИВНУЮ: завышенная ρ даёт
    // больший σ_день, то есть более осторожный тест. Считать ρ нулём здесь
    // значило бы вернуть ту самую ошибку, от которой правка и защищает.
    const rho = icc?.rho ?? ICC_FALLBACK_RHO;
    const meanPerDay = icc?.meanPerDay ?? (daily.length > 0 ? rows.length / daily.length : 1);
    const sigmaDay = dailySigma(inc.sigma, meanPerDay, rho);
    const sprt = sprtDecide(daily.map((d) => d.mean), inc.mu1, sigmaDay);
    const days = (nowSec() - inc.frozenAt) / 86_400;
    summary.checked += 1;
    ledger.recordEval(trial.candidateId, "incubation_check", {
      trades: rows.length,
      observationDays: daily.length,
      rho: Number(rho.toFixed(3)),
      rhoMeasured: icc !== null,
      meanPerDay: Number(meanPerDay.toFixed(2)),
      sigmaDay: Number(sigmaDay.toFixed(4)),
      llr: Number(sprt.llr.toFixed(3)),
      decision: sprt.decision,
      stoppedAt: sprt.stoppedAt,
      days: Number(days.toFixed(1)),
    });

    if (sprt.decision === "reject") {
      ledger.transition(
        trial.candidateId,
        "KILLED",
        `SPRT принял H0: llr=${sprt.llr.toFixed(2)} после ${sprt.stoppedAt} дней — край не подтвердился вживую`,
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
    // continue: усечение — «не смог решить» тоже решение. v3: потолок —
    // честные 3×E[N] (вход по δ гарантирует E[N] ≤ ~150, так что жёсткий
    // MAX_TRADES_CAP больше не обрубает тест на середине).
    const tradeCap = Math.ceil(3 * inc.expectedN);
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
