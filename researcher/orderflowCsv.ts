import { join } from "node:path";
import { setOrderflowLoader, type OrderflowHistory } from "../src/core/orderflow/orderflowSeries.ts";
import { flowPaths, readFlow } from "./orderflow.ts";

/**
 * Чтение 15m-ордерфлоу (researcher/collect-orderflow.ts) с диска. ТОЛЬКО нода.
 * Каталог — COLLECT_DIR/orderflow-15m, как у сборщика. Строки: шапка
 * FLOW_HEADER (`time,trades,buyQty,sellQty,buyUsd,sellUsd,...`), дубли по
 * времени уже схлопнуты `readFlow`. Строка с нечисловыми buyUsd/sellUsd
 * пропускается — бар становится дырой, а не нулём.
 */
function collectDir(): string {
  return process.env.COLLECT_DIR ?? join(process.env.HOME ?? "", ".chartlab", "data-repo", "market");
}

export function parseOrderflowRows(rows: readonly string[]): OrderflowHistory | null {
  const starts: number[] = [];
  const buy: number[] = [];
  const sell: number[] = [];
  for (const row of rows) {
    const f = row.split(",");
    const t = Date.parse(f[0]);
    const b = Number(f[4]);
    const s = Number(f[5]);
    if (!Number.isFinite(t) || !Number.isFinite(b) || !Number.isFinite(s) || f[4] === "" || f[5] === "") continue;
    starts.push(t / 1000);
    buy.push(b);
    sell.push(s);
  }
  if (starts.length === 0) return null;
  return { barStarts: Float64Array.from(starts), buyUsd: Float64Array.from(buy), sellUsd: Float64Array.from(sell) };
}

export function readOrderflowCsv(symbol: string): OrderflowHistory | null {
  return parseOrderflowRows(readFlow(flowPaths(collectDir(), symbol).m15));
}

/** Подключает чтение ордерфлоу с диска. Зовётся из corpus.ts — см. useCsvMetrics. */
export function useCsvOrderflow(): void {
  setOrderflowLoader(readOrderflowCsv);
}
