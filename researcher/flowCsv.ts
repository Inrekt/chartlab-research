import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { setFlowLoader, type FlowHistory } from "../src/core/flow/flowSeries.ts";

/**
 * Чтение честного потока тейкеров (бэкфилл flow-1h) с диска. ТОЛЬКО нода.
 *
 * Лежит в researcher/, как metricsCsv/fundingCsv, по той же причине: src/core
 * собирается в браузер, а браузерный код не должен уметь читать диск.
 *
 * Формат строки (backfill-flow.ts): `time,volume,takerBuyVolume`, где
 * takerBuyVolume — объём агрессивных ПОКУПОК (поле klines[9]). Доля продаж
 * sellFrac = 1 − takerBuyVolume/volume.
 */
function flowDir(): string {
  const base =
    process.env.COLLECT_DIR ?? join(process.env.HOME ?? "", ".chartlab", "data-repo", "market");
  return join(base, "flow-1h");
}

/** `.csv.gz` предпочтительнее голого `.csv` — той же конвенцией, что метрики. */
function readFlowText(symbol: string): string | null {
  const gz = join(flowDir(), `${symbol}.csv.gz`);
  if (existsSync(gz)) return gunzipSync(readFileSync(gz)).toString("utf8");
  const raw = join(flowDir(), `${symbol}.csv`);
  if (existsSync(raw)) return readFileSync(raw, "utf8");
  return null;
}

export function readFlowCsv(symbol: string): FlowHistory | null {
  const text = readFlowText(symbol);
  if (text === null) return null;

  const lines = text.split("\n");
  const hourStarts: number[] = [];
  const sellFrac: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cols = line.split(",");
    if (cols.length < 3) continue;
    const time = Date.parse(cols[0]);
    const volume = Number(cols[1]);
    const takerBuy = Number(cols[2]);
    // Дыра/битьё в любой из величин → строка пропускается, а не даёт мусорный
    // sellFrac: пропущенные данные не должны молча становиться сигналом.
    if (!Number.isFinite(time) || !Number.isFinite(volume) || !Number.isFinite(takerBuy)) continue;
    if (volume <= 0) continue; // деление на объём; ноль-объём = нет торговли
    hourStarts.push(time / 1000);
    // Инвариант архива (проверен: 0 нарушений на 7.9M строк): takerBuy ≤ volume,
    // значит sellFrac ∈ [0, 1]. Клип на всякий случай — защита от будущего битья.
    sellFrac.push(Math.min(1, Math.max(0, 1 - takerBuy / volume)));
  }

  if (hourStarts.length === 0) return null;
  return {
    hourStarts: Float64Array.from(hourStarts),
    sellFrac: Float64Array.from(sellFrac),
  };
}

/** Подключает чтение потока с диска. Зовётся из corpus.ts — см. useCsvMetrics. */
export function useCsvFlow(): void {
  setFlowLoader(readFlowCsv);
}
