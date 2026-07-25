/**
 * Источник живых свечей для инкубатора — публичный REST Binance (без ключа).
 * Отдаёт ТОЛЬКО закрытые бары: незакрытая свеча — это ещё не факт, решать по
 * ней нельзя (и в бэктесте её тоже не существует — паритет).
 */
import type { Candle } from "../src/core/types/index.ts";
import type { SignalTf } from "./grammar.ts";

export const TF_SECONDS: Record<SignalTf, number> = {
  "1h": 3600,
  "4h": 14_400,
  "1d": 86_400,
};

const BASE_URL = "https://api.binance.com/api/v3/klines";
const PAGE_LIMIT = 1000;
const MAX_PAGES = 20;
const RETRY_AFTER_CAP_SEC = 60;

/** 429/418 — лимит запросов: ждём Retry-After (с потолком) и пробуем ещё раз;
 * повторный отказ отдаём наверх — догонка переживёт пропуск часа. */
async function fetchWithRetry(url: string): Promise<Response> {
  const res = await fetch(url);
  if (res.status !== 429 && res.status !== 418) return res;
  const wait = Math.min(Number(res.headers.get("retry-after") ?? 5) || 5, RETRY_AFTER_CAP_SEC);
  await new Promise((resolve) => setTimeout(resolve, wait * 1000));
  return fetch(url);
}

export async function fetchBinanceKlines(
  symbol: string,
  tf: SignalTf,
  startTimeSec: number,
): Promise<Candle[]> {
  const out: Candle[] = [];
  let startMs = startTimeSec * 1000;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${BASE_URL}?symbol=${symbol}&interval=${tf}&startTime=${startMs}&limit=${PAGE_LIMIT}`;
    const res = await fetchWithRetry(url);
    if (!res.ok) throw new Error(`Binance ${res.status} для ${symbol} ${tf}`);
    const rows = (await res.json()) as [number, string, string, string, string, string, number][];
    if (rows.length === 0) break;
    for (const r of rows) {
      // r[6] — closeTime (мс): бар закрыт, только если его конец уже в прошлом.
      if (r[6] >= Date.now()) continue;
      out.push({
        time: r[0] / 1000,
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        volume: Number(r[5]),
      });
    }
    if (rows.length < PAGE_LIMIT) break;
    startMs = rows[rows.length - 1][0] + 1;
  }
  return out;
}
