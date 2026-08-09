/**
 * Стоимостной пол: какой край физически необходим, чтобы издержки не съели его.
 *
 * Вопрос, на который отвечает модуль: ворота требуют от кандидата Шарп на
 * сделку ~0.5 — но какой минимум требует САМА АРИФМЕТИКА издержек, независимо
 * от любых ворот? Если пол выше требования ворот, чинить надо горизонт
 * торговли; если ниже — чинить надо ворота. Без этого числа спор о приоритетах
 * не имеет фактического основания.
 *
 * Формула (издержки платятся за сделку, доходность растёт с горизонтом):
 *
 *     требуемый край / σ_сделки = c / (σ_час · √h) + SR_цель / √N
 *
 * где c — круговые издержки, h — часов удержания, N — сделок в год.
 * Первое слагаемое — стоимостной дрейф, второе — цена статистической
 * значимости. Издержки входят как c/h: единственный способ убрать их давление,
 * не снижая сами издержки, — держать позицию дольше.
 *
 * ⚠️ Обе входные величины ОБЯЗАНЫ быть замерены, а не взяты из литературы.
 * Внешний разбор считал σ_час = 40 бп (это про BTC) и h = 1 час (это вообще не
 * про нас) и получил пол 0.59 — вчетверо выше фактического. Наша вселенная —
 * 162 перпа, включая альты, и держим мы медианно 15 часов.
 *
 * Запуск: npx tsx researcher/cost-floor.ts [--symbols 40] [--bars 4000]
 */
import { pathToFileURL } from "node:url";
import { DEFAULT_COSTS } from "../src/core/committee/costModel.ts";
import { listUniverse, loadCandles, splitHoldout } from "./corpus.ts";

/** Круговые издержки в долях цены: вход и выход, комиссия и проскальзывание. */
export function roundTripCost(): number {
  return 2 * (DEFAULT_COSTS.feeRate + DEFAULT_COSTS.slippageRate);
}

/**
 * Медианная часовая волатильность вселенной.
 *
 * Медиана, а не среднее: распределение по символам скошено вправо мем-коинами,
 * и среднее описывало бы инструмент, которого в корпусе нет.
 */
export function medianHourlySigma(symbols: readonly string[], bars: number): number {
  const sds: number[] = [];
  for (const symbol of symbols) {
    const candles = loadCandles(symbol, "1h");
    if (!candles || candles.length < 500) continue;
    const from = Math.max(1, candles.length - bars);
    const rs: number[] = [];
    for (let i = from; i < candles.length; i++) {
      rs.push(Math.log(candles[i].close / candles[i - 1].close));
    }
    if (rs.length < 100) continue;
    const m = rs.reduce((a, b) => a + b, 0) / rs.length;
    sds.push(Math.sqrt(rs.reduce((a, b) => a + (b - m) ** 2, 0) / rs.length));
  }
  sds.sort((a, b) => a - b);
  return sds.length === 0 ? NaN : sds[Math.floor(sds.length / 2)];
}

export interface FloorInput {
  cost: number;
  sigmaHourly: number;
  holdHours: number;
  targetAnnualSharpe: number;
  tradesPerYear: number;
  /**
   * Замеренная σ доходности СДЕЛКИ в долях цены. Задана — используется она,
   * а модель `σ_час·√h` игнорируется.
   */
  measuredTradeSigma?: number;
}

/**
 * Замеренная σ сделки по данным движка, в долях цены.
 *
 * Модель `σ_час·√h` предполагает случайное блуждание, а сделка обрывается
 * стопом или тейком — распределение усечено с обеих сторон, и совпадать эти
 * величины не обязаны. Замер: 41 131 и 13 004 сделки, 30 спек × 6 символов.
 *
 * Расхождение с моделью оказалось МАЛЫМ (461 против 407 бп на 1h), то есть
 * поправка меняет пол на ~4% и вывод «связывают ворота, а не издержки» не
 * трогает. Записано ровно потому, что внешняя проверка утверждала расхождение
 * в 2.5–5 раз: величину, на которой держится вывод, полагается мерить, а не
 * обсуждать.
 */
export const MEASURED_TRADE_SIGMA: Record<string, number> = { "1h": 0.0461, "4h": 0.0832 };

/** Требуемый Шарп на сделку (валовой) при данном горизонте. */
export function requiredTradeSharpe(i: FloorInput): number {
  const sigmaTrade = i.measuredTradeSigma ?? i.sigmaHourly * Math.sqrt(i.holdHours);
  return i.cost / sigmaTrade + i.targetAnnualSharpe / Math.sqrt(i.tradesPerYear);
}

function arg(name: string, fallback: number): number {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? Number(process.argv[idx + 1]) : fallback;
}

async function main(): Promise<void> {
  const { search } = splitHoldout(listUniverse("1h"));
  const cost = roundTripCost();
  const sigmaHourly = medianHourlySigma(search.slice(0, arg("symbols", 40)), arg("bars", 4000));

  console.error(`круговые издержки: ${(cost * 1e4).toFixed(1)} бп`);
  console.error(`часовая σ вселенной (медиана): ${(sigmaHourly * 1e4).toFixed(0)} бп\n`);

  const base = { cost, sigmaHourly, targetAnnualSharpe: 1.6, tradesPerYear: 300 };
  const rows = [
    { h: 1, note: "посылка внешнего разбора" },
    { h: 15, note: "наш 1ч: медиана удержания" },
    { h: 40, note: "наш 1ч p90 / наш 4ч медиана" },
    { h: 72, note: "рекомендация внешнего разбора" },
    { h: 160, note: "наш 4ч p90" },
  ];
  console.error("h, ч   требуемый Шарп/сделку   комментарий");
  for (const { h, note } of rows) {
    const need = requiredTradeSharpe({ ...base, holdHours: h });
    console.error(`${String(h).padStart(4)}   ${need.toFixed(3)}                  ${note}`);
  }
  console.error("\n── на ЗАМЕРЕННОЙ σ сделки (движок), а не на модели σ_час·√h ──");
  for (const tf of ["1h", "4h"] as const) {
    const modelH = tf === "1h" ? 15 : 40;
    const modelled = requiredTradeSharpe({ ...base, holdHours: modelH });
    const measured = requiredTradeSharpe({
      ...base,
      holdHours: modelH,
      measuredTradeSigma: MEASURED_TRADE_SIGMA[tf],
    });
    console.error(
      `${tf}: модель ${modelled.toFixed(3)} → замер ${measured.toFixed(3)} ` +
        `(σ сделки ${(MEASURED_TRADE_SIGMA[tf] * 1e4).toFixed(0)} бп)`,
    );
  }

  console.error(
    "\nДля сравнения: ворота дефляции при нынешнем varSR требуют ~0.54 Шарпа на\n" +
      "сделку, а вход в инкубатор — 0.36 (тождество, см. thresholds.test.ts).\n" +
      "Оба ограничения ВЫШЕ стоимостного пола втрое и более. Значит связывают\n" +
      "ворота, а не арифметика издержек.",
  );
  console.log(
    JSON.stringify(
      {
        cost,
        sigmaHourly,
        floors: rows.map(({ h }) => ({ h, need: requiredTradeSharpe({ ...base, holdHours: h }) })),
      },
      null,
      2,
    ),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
