import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { setMetricsLoader, type MetricsHistory } from "../src/core/metrics/metricsSeries.ts";

/**
 * Чтение почасовых futures-метрик (бэкфилл metrics-1h) с диска. ТОЛЬКО нода.
 *
 * Лежит в researcher/, как и fundingCsv.ts, по той же причине: src/core
 * собирается в браузер, и браузерный код не должен уметь читать диск.
 */

function metricsDir(): string {
  const base =
    process.env.COLLECT_DIR ?? join(process.env.HOME ?? "", ".chartlab", "data-repo", "market");
  return join(base, "metrics-1h");
}

/**
 * Текст метрик символа. `.csv.gz` предпочтительнее голого `.csv`: в репозитории
 * хранится сжатая версия (274 МБ сырых против ~105 МБ), той же конвенцией, что
 * и корпус свечей (`*_1h.json.gz`). Голый `.csv` остаётся рабочим — им пишет
 * бэкфилл, и локально после прогона лежит именно он.
 */
function readMetricsText(symbol: string): string | null {
  const gz = join(metricsDir(), `${symbol}.csv.gz`);
  if (existsSync(gz)) return gunzipSync(readFileSync(gz)).toString("utf8");
  const raw = join(metricsDir(), `${symbol}.csv`);
  if (existsSync(raw)) return readFileSync(raw, "utf8");
  return null;
}

/**
 * Разбирает metrics-1h CSV (шапка HEADER из backfill-metrics.ts):
 * `time,oi,oiValue,topLsAccounts,topLsPositions,globalLsAccounts,takerBuySellVol`.
 * `topLsPositions` (индекс 4) и `globalLsAccounts` (индекс 5) не читались
 * нигде до расхождения толпы/крупных — см. family-crowd-top-divergence-preregistration.md.
 *
 * Строка попадает в ряд по ПРЕЖНЕМУ правилу — время и `takerBuySellVol`
 * числовые (это ворота, от которых уже зависит живой атом `takerFlow` в
 * журнале испытаний). Новые колонки НЕ ужесточают это правило: дырка именно
 * в top/crowd даёт NaN в СВОЁМ поле строки, а не выбрасывает всю строку —
 * иначе более редкая история top/crowd задним числом сузила бы ряд
 * takerRatio для уже прогонянных кандидатов.
 */
export function readMetricsCsv(symbol: string): MetricsHistory | null {
  const text = readMetricsText(symbol);
  if (text === null) return null;

  const lines = text.split("\n");
  const hourStarts: number[] = [];
  const takerRatio: number[] = [];
  const topLsPositions: number[] = [];
  const globalLsAccounts: number[] = [];
  const oi: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cols = line.split(",");
    if (cols.length < 7) continue;
    const time = Date.parse(cols[0]);
    const ratio = Number(cols[6]); // takerBuySellVol
    if (!Number.isFinite(time) || !Number.isFinite(ratio)) continue;
    hourStarts.push(time / 1000);
    takerRatio.push(ratio);
    const top = Number(cols[4]); // topLsPositions
    const crowd = Number(cols[5]); // globalLsAccounts
    const openInterest = Number(cols[1]); // oi
    topLsPositions.push(Number.isFinite(top) ? top : NaN);
    globalLsAccounts.push(Number.isFinite(crowd) ? crowd : NaN);
    oi.push(Number.isFinite(openInterest) ? openInterest : NaN);
  }

  if (hourStarts.length === 0) return null;
  return {
    hourStarts: Float64Array.from(hourStarts),
    takerRatio: Float64Array.from(takerRatio),
    topLsPositions: Float64Array.from(topLsPositions),
    globalLsAccounts: Float64Array.from(globalLsAccounts),
    oi: Float64Array.from(oi),
  };
}

/** Подключает чтение метрик с диска. Зовётся из corpus.ts — см. useCsvFunding. */
export function useCsvMetrics(): void {
  setMetricsLoader(readMetricsCsv);
}
