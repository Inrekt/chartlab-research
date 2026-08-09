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
}

/** Требуемый Шарп на сделку (валовой) при данном горизонте. */
export function requiredTradeSharpe(i: FloorInput): number {
  return (
    i.cost / (i.sigmaHourly * Math.sqrt(i.holdHours)) +
    i.targetAnnualSharpe / Math.sqrt(i.tradesPerYear)
  );
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
  console.error(
    "\nДля сравнения: ворота дефляции при нынешнем varSR требуют ~0.5 Шарпа на\n" +
      "сделку. Значит связывающее ограничение — ВОРОТА, а не издержки.",
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
