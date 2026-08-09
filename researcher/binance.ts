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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Candle } from "../src/core/types/index.ts";
import { HISTORY_DIR } from "./corpus.ts";
import type { SignalTf } from "./grammar.ts";

/**
 * Постоянная недоступность биржи, а не временный сбой.
 *
 * Отдельный тип нужен ровно затем, чтобы догонка инкубатора могла отличить
 * «сеть моргнула, догоним через час» от «отсюда биржа недоступна никогда».
 * Первое проглатывать правильно, второе — смертельно: кандидат тихо
 * просиживает календарный лимит и умирает как не доказавший край.
 */
export class ExchangeBlockedError extends Error {
  readonly permanent = true;
}

export const TF_SECONDS: Record<SignalTf, number> = {
  "1h": 3600,
  "4h": 14_400,
  "1d": 86_400,
};

const SPOT_KLINES = "https://api.binance.com/api/v3/klines";
const PERP_KLINES = "https://fapi.binance.com/fapi/v1/klines";

/**
 * Рынок берётся из МАНИФЕСТА КОРПУСА, а не из константы, — чтобы источник
 * живых баров нельзя было забыть переключить вместе с корпусом.
 *
 * ⚠️ Каталог корпуса берётся из `HISTORY_DIR` (переопределяется переменной
 * `RESEARCHER_HISTORY_DIR`), а НЕ прибит к `public/data/history`. Прибитый
 * путь свёл на нет всю защиту: после переезда корпуса в кэш раннера манифест
 * по старому адресу перестал существовать, функция молча возвращала СПОТ — и
 * скрин считал по перпам, пока инкубатор догонял спотом. Ровно то расхождение,
 * которое эта функция и должна была предотвращать.
 *
 * Отсутствие манифеста по-прежнему означает спот — это НЕ дефолт «на всякий
 * случай», а известный факт: старый корпус в `public/data/history` собран без
 * манифеста и доказанно спотовый (сверка байт в байт, см. collect-candles.ts).
 * Ронять прогон на нём было бы ложной тревогой. Но молчать тоже нельзя, и за
 * видимость отвечает предполётная проверка: она печатает выбранный рынок
 * рядом с версией корпуса на каждом прогоне.
 */
export function klinesUrlFromCorpus(historyDir = HISTORY_DIR): string {
  const manifest = join(historyDir, "manifest.json");
  if (!existsSync(manifest)) return SPOT_KLINES;
  try {
    const { source } = JSON.parse(readFileSync(manifest, "utf-8")) as { source?: string };
    return source === "perp" ? PERP_KLINES : SPOT_KLINES;
  } catch {
    return SPOT_KLINES;
  }
}

/** Корпус лежит, а манифеста нет — рынок взят по умолчанию, а не установлен. */
export function marketIsAssumed(historyDir = HISTORY_DIR): boolean {
  if (existsSync(join(historyDir, "manifest.json"))) return false;
  try {
    return readdirSync(historyDir).some((f) => f.endsWith(".json.gz"));
  } catch {
    return false;
  }
}

/**
 * Ленивая и кэшированная: `HISTORY_DIR` фиксируется при загрузке модуля, а
 * вычислять URL на этапе импорта значит падать в тестах, которые корпуса не
 * видят и трогать сеть не собираются.
 */
let cachedBaseUrl: string | null = null;
function baseUrl(): string {
  if (cachedBaseUrl === null) cachedBaseUrl = klinesUrlFromCorpus();
  return cachedBaseUrl;
}
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
    const url = `${baseUrl()}?symbol=${symbol}&interval=${tf}&startTime=${startMs}&limit=${PAGE_LIMIT}`;
    const res = await fetchWithRetry(url);
    if (res.status === 451 || res.status === 403) {
      throw new ExchangeBlockedError(
        [
          `Биржа отвечает ${res.status} — доступ закрыт по юрисдикции, а не сбой сети.`,
          `Проверено зондом (.github/workflows/probe.yml): раннеры GitHub получают 451`,
          `и на api.binance.com, и на fapi.binance.com. Открыто только bulk-зеркало`,
          `data.binance.vision.`,
          "",
          "Это НЕ временная неудача, и ретраи её не лечат. Инкубатор в такой среде",
          "не наберёт ни одной форвард-сделки, а кандидат умрёт «по календарю» через",
          "365 дней — с виду честная смерть, на деле мёртвая инфраструктура.",
          "",
          "Чинить: перенести прогон туда, откуда биржа доступна (свой сервер), либо",
          "перевести источник живых баров на bulk-зеркало ценой суточного лага.",
        ].join("\n"),
      );
    }
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
