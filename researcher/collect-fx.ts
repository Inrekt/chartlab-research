/**
 * Сборщик часовых свечей FX / золота / индексов (источник — Yahoo).
 *
 * ЗАЧЕМ. Крипто-свип умер не от концентрации, а от переобучения: 9 кандидатов
 * gate_breadth торговали 63 символа широко, и holdoutNet отрицательный у 8 из
 * 9. Настоящее направление следующего свипа — СЕССИОННОЕ (лондонский/
 * нью-йоркский открытия как уровень с причиной вместо N-барного экстремума),
 * а сессии есть только там, где рынок закрывается: FX, золото, индексы.
 * Эти же рынки заранее объявлены осью внешней репликации в плане свипа.
 * Данные нужны ДО пре-регистрации, потому что без них семейство нечем
 * проверить, а подгонять порог под уже увиденное — p-hacking.
 *
 * ЧЕГО ЭТОТ ФАЙЛ НЕ ДЕЛАЕТ. Он не меняет вселенную поиска. Состав вселенной
 * объявляется в `researcher/universe-perp.json`, а корпус машины читается из
 * HISTORY_DIR (по умолчанию `history-perp`). Каталог `history-fx` для ночного
 * перебора инертен: ни один прогон в него не заглядывает, пока владелец не
 * решит иначе. Смена вселенной = смена эпохи измерений, это его решение.
 *
 * ГРАНИЦЫ ДАННЫХ, которые обязан знать любой, кто на них считает:
 *  1. Часовая история Yahoo обрезана примерно 730 днями — это ПОТОЛОК
 *     ИСТОЧНИКА, а не глубина рынка. Ворота «годы» на таком корпусе не
 *     выполнимы; семейство здесь может быть только репликацией, не первичным
 *     поиском.
 *  2. У спотового FX объёма НЕТ (Yahoo отдаёт нули). Любой атом с объёмом на
 *     `*=X` мерит константу. Настоящий объём есть у фьючерсов (GC=F, NQ=F).
 *  3. Бары выровнены по бирже, а выходные — дыры. Сессионная логика обязана
 *     читать время бара, а не его индекс.
 *
 * Запуск:
 *   npx tsx researcher/collect-fx.ts
 *   npx tsx researcher/collect-fx.ts --symbols EURUSD,XAUUSD_F --tf 1h
 *   npx tsx researcher/collect-fx.ts --out public/data/history-fx --full
 *
 * Дозапись: существующие бары читаются, новые доливаются по времени открытия;
 * пересечение решается в пользу СВЕЖЕЙ загрузки (Yahoo уточняет последний
 * незакрытый бар).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Candle } from "../src/core/types/index.ts";

/** Имя в корпусе → тикер Yahoo. Имя намеренно без `=X`/`=F` в начале файла. */
export const FX_UNIVERSE: Record<string, string> = {
  EURUSD: "EURUSD=X",
  GBPUSD: "GBPUSD=X",
  USDJPY: "JPY=X",
  AUDUSD: "AUDUSD=X",
  USDCAD: "USDCAD=X",
  USDCHF: "USDCHF=X",
  NZDUSD: "NZDUSD=X",
  EURJPY: "EURJPY=X",
  GBPJPY: "GBPJPY=X",
  EURGBP: "EURGBP=X",
  XAUUSD_F: "GC=F",
  XAGUSD_F: "SI=F",
  NASDAQ_F: "NQ=F",
  SP500_F: "ES=F",
};

export type FxTf = "1h" | "1d";

/** Диапазон запроса на каждый ТФ: 1h упирается в потолок источника (730д). */
const RANGE: Record<FxTf, string> = { "1h": "730d", "1d": "20y" };

interface YahooChart {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
          volume?: Array<number | null>;
        }>;
      };
    }> | null;
    error?: unknown;
  };
}

/**
 * Разбор ответа Yahoo в свечи.
 *
 * Пустые бары (null в любом из OHLC) ОТБРАСЫВАЮТСЯ, а не заполняются
 * предыдущим значением: выдуманная свеча на неторговом часе — это выдуманная
 * возможность входа, самый дешёвый способ получить край из воздуха.
 */
export function parseYahooChart(raw: unknown): Candle[] {
  const chart = raw as YahooChart;
  const result = chart?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo вернул ошибку: ${JSON.stringify(chart?.chart?.error ?? raw)}`);
  const times = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0];
  if (!q) return [];
  const out: Candle[] = [];
  for (let i = 0; i < times.length; i += 1) {
    const open = q.open?.[i];
    const high = q.high?.[i];
    const low = q.low?.[i];
    const close = q.close?.[i];
    if (open == null || high == null || low == null || close == null) continue;
    if (!Number.isFinite(open + high + low + close)) continue;
    out.push({ time: times[i], open, high, low, close, volume: q.volume?.[i] ?? 0 });
  }
  return out;
}

/**
 * Слияние старых и новых баров по времени открытия.
 *
 * При совпадении времени побеждает НОВАЯ загрузка: последний бар предыдущего
 * сбора мог быть незакрытым, и его старые high/low занижены.
 */
export function mergeCandles(existing: Candle[], fresh: Candle[]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const c of existing) byTime.set(c.time, c);
  for (const c of fresh) byTime.set(c.time, c);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** Доля пропущенных часов внутри рабочей недели — грубая мера дырявости. */
export function gapRatio(candles: Candle[], stepSec: number): number {
  if (candles.length < 2) return 0;
  let expected = 0;
  let present = 0;
  for (let i = 1; i < candles.length; i += 1) {
    const delta = candles[i].time - candles[i - 1].time;
    // Выходные (>= 24ч) не считаем дырой: рынок закрыт, это свойство рынка.
    if (delta >= 24 * 3600) continue;
    expected += delta / stepSec;
    present += 1;
  }
  return expected === 0 ? 0 : 1 - present / expected;
}

function readCorpus(path: string): Candle[] {
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(gunzipSync(readFileSync(path)).toString()) as Candle[];
  } catch {
    return [];
  }
}

async function fetchYahoo(ticker: string, tf: FxTf): Promise<Candle[]> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?interval=${tf}&range=${RANGE[tf]}`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (chartlab-research)" } });
  if (!res.ok) throw new Error(`${ticker} ${tf}: HTTP ${res.status}`);
  return parseYahooChart(await res.json());
}

interface Coverage {
  symbol: string;
  tf: FxTf;
  bars: number;
  firstIso: string;
  lastIso: string;
  gapRatio: number;
  zeroVolume: boolean;
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const outDir = argValue("--out") ?? "public/data/history-fx";
  const tfs = (argValue("--tf") ?? "1h,1d").split(",") as FxTf[];
  const only = argValue("--symbols")?.split(",");
  const full = process.argv.includes("--full");
  mkdirSync(outDir, { recursive: true });

  const names = Object.keys(FX_UNIVERSE).filter((n) => !only || only.includes(n));
  const coverage: Coverage[] = [];

  for (const name of names) {
    for (const tf of tfs) {
      const path = join(outDir, `${name}_${tf}.json.gz`);
      let fresh: Candle[];
      try {
        fresh = await fetchYahoo(FX_UNIVERSE[name], tf);
      } catch (err) {
        console.error(`✗ ${name} ${tf}: ${(err as Error).message}`);
        continue;
      }
      const merged = full ? fresh : mergeCandles(readCorpus(path), fresh);
      if (merged.length === 0) {
        console.error(`✗ ${name} ${tf}: пусто, файл не тронут`);
        continue;
      }
      writeFileSync(path, gzipSync(JSON.stringify(merged)));
      coverage.push({
        symbol: name,
        tf,
        bars: merged.length,
        firstIso: new Date(merged[0].time * 1000).toISOString(),
        lastIso: new Date(merged[merged.length - 1].time * 1000).toISOString(),
        gapRatio: Number(gapRatio(merged, tf === "1h" ? 3600 : 86400).toFixed(3)),
        zeroVolume: merged.every((c) => c.volume === 0),
      });
      console.log(`✓ ${name} ${tf}: ${merged.length} баров`);
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  const manifest = {
    source: "yahoo",
    collectedAt: new Date().toISOString(),
    note: "ИНЕРТЕН для ночного перебора: вселенная объявляется в universe-perp.json, корпус читается из HISTORY_DIR.",
    limits: {
      hourlyHistoryDays: 730,
      spotFxHasNoVolume: true,
    },
    symbols: new Set(coverage.map((c) => c.symbol)).size,
    coverage,
  };
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 1));
  console.log(
    JSON.stringify({
      outDir,
      symbols: manifest.symbols,
      files: readdirSync(outDir).filter((f) => f.endsWith(".json.gz")).length,
      bars1h: coverage.filter((c) => c.tf === "1h").reduce((a, c) => a + c.bars, 0),
    }),
  );
}

// Защита от запуска при ИМПОРТЕ (тот же приём, что в collect-candles.ts):
// без неё импорт ради parseYahooChart тянул бы сеть и запись на диск.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
