/**
 * Источник живых свечей для инкубатора — публичный REST Binance (без ключа).
 * Отдаёт ТОЛЬКО закрытые бары: незакрытая свеча — это ещё не факт, решать по
 * ней нельзя (и в бэктесте её тоже не существует — паритет).
 *
 * РЫНОК берётся из манифеста корпуса (см. klinesUrlFromCorpus ниже), а не
 * задан константой. Источник живых баров ОБЯЗАН совпадать с источником
 * корпуса: иначе кандидат проверяется на одном рынке, а инкубируется на
 * другом, и разойдутся они молча.
 *
 * До 2026-08-08 здесь и в корпусе стоял СПОТ (api.binance.com/api/v3) —
 * найдено сверкой байт в байт, см. collect-candles.ts. Это была ошибка:
 * фандинг, открытый интерес, long-short и поток тейкеров фьючерсные;
 * механизм края владельца (ликвидации, охота за стопами) живёт на плече, а
 * плечо есть только на перпах; и торговать владелец будет перпы.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Candle } from "../src/core/types/index.ts";
import type { SignalTf } from "./grammar.ts";

export const TF_SECONDS: Record<SignalTf, number> = {
  "1h": 3600,
  "4h": 14_400,
  "1d": 86_400,
};

const SPOT_KLINES = "https://api.binance.com/api/v3/klines";
const PERP_KLINES = "https://fapi.binance.com/fapi/v1/klines";

/**
 * Рынок берётся из МАНИФЕСТА КОРПУСА, а не из константы, — чтобы источник
 * живых баров нельзя было забыть переключить вместе с корпусом. Манифеста
 * нет (старый спотовый корпус) → спот; `source: "perp"` → перпы.
 *
 * Развязка ровно та, из-за которой ошибка и прожила так долго: две настройки
 * в разных файлах, обязанные совпадать, рано или поздно разъезжаются молча.
 */
function klinesUrlFromCorpus(): string {
  const manifest = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "public",
    "data",
    "history",
    "manifest.json",
  );
  if (!existsSync(manifest)) return SPOT_KLINES;
  try {
    const { source } = JSON.parse(readFileSync(manifest, "utf-8")) as { source?: string };
    return source === "perp" ? PERP_KLINES : SPOT_KLINES;
  } catch {
    return SPOT_KLINES;
  }
}

const BASE_URL = klinesUrlFromCorpus();
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
