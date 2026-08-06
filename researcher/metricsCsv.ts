import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

/** Разбирает metrics-1h CSV (шапка HEADER из backfill-metrics.ts). */
export function readMetricsCsv(symbol: string): MetricsHistory | null {
  const path = join(metricsDir(), `${symbol}.csv`);
  if (!existsSync(path)) return null;

  const lines = readFileSync(path, "utf8").split("\n");
  const hourStarts: number[] = [];
  const takerRatio: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cols = line.split(",");
    if (cols.length < 7) continue;
    const time = Date.parse(cols[0]);
    const ratio = Number(cols[6]); // takerBuySellVol — последняя колонка
    if (!Number.isFinite(time) || !Number.isFinite(ratio)) continue;
    hourStarts.push(time / 1000);
    takerRatio.push(ratio);
  }

  if (hourStarts.length === 0) return null;
  return { hourStarts: Float64Array.from(hourStarts), takerRatio: Float64Array.from(takerRatio) };
}

/** Подключает чтение метрик с диска. Зовётся из corpus.ts — см. useCsvFunding. */
export function useCsvMetrics(): void {
  setMetricsLoader(readMetricsCsv);
}
