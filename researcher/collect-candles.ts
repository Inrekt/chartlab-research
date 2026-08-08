/**
 * Сборщик корпуса свечей.
 *
 * Появился из-за двух находок 2026-08-08, и обе меняют смысл всего поиска.
 *
 * 1. СБОРЩИКА НЕ БЫЛО ВООБЩЕ. Корпус в public/data/history не обновлялся с
 *    2026-07-25 (единый mtime у всех 340 файлов), а скрипта, который его
 *    создал, в репозитории нет. У 59 символов ровно 44000 баров (1h) и 11000
 *    (4h) — это не предел данных, а потолок скачивания, отсчитанный НАЗАД от
 *    даты сбора: 44000 часов от 2021-07-11 дают ровно 2026-07-25. Отсюда и
 *    «история с 2021», из-за которой in-окно составляет 4.06 года при пороге
 *    ворот в 4 года — запас три недели.
 *
 * 2. КОРПУС БЫЛ СПОТОВЫЙ. Проверено сверкой байт в байт на BTC/ETH/SOL/AAVE/
 *    WIF: свечи совпадают с api.binance.com/api/v3 (спот) и НЕ совпадают с
 *    fapi (бессрочные фьючерсы). При этом фандинг, открытый интерес,
 *    long-short и поток тейкеров — фьючерсные, документация всюду говорит
 *    «170 перпов», а владелец будет торговать перпы на проп-аккаунте.
 *    То есть цена бралась с одного рынка, а микроструктура — с другого, и
 *    сильнее всего это било по единственным семействам, которым разрешён
 *    бюджет: ликвидити-магнит и фандинг живут на плече, а плечо — на перпах.
 *
 * Поэтому источник по умолчанию — ФЬЮЧЕРСЫ. Побочный выигрыш: их история
 * глубже спотового корпуса (BTC с 2019-09 против 2021-07), то есть переход
 * не сокращает, а РАСШИРЯЕТ окно поиска.
 *
 * Запуск:
 *   npx tsx researcher/collect-candles.ts --out public/data/history-perp
 *   npx tsx researcher/collect-candles.ts --tf 1h --symbols BTCUSDT,ETHUSDT
 *   npx tsx researcher/collect-candles.ts --source spot     (старое поведение)
 *
 * Дозапись: если файл уже есть, качается только хвост после последнего бара.
 * Полный пересбор — флагом --full.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Candle } from "../src/core/types/index.ts";
import type { SignalTf } from "./grammar.ts";

type Source = "perp" | "spot";

const HOSTS: Record<Source, { klines: string; info: string }> = {
  perp: {
    klines: "https://fapi.binance.com/fapi/v1/klines",
    info: "https://fapi.binance.com/fapi/v1/exchangeInfo",
  },
  spot: {
    klines: "https://api.binance.com/api/v3/klines",
    info: "https://api.binance.com/api/v3/exchangeInfo",
  },
};

const TF_MS: Record<SignalTf, number> = { "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };
/** fapi отдаёт до 1500 баров за запрос, спот — до 1000. Берём общий минимум. */
const PAGE = 1000;
/** Пауза между запросами внутри одного символа. */
const GAP_MS = 120;
/**
 * Символов одновременно. Узкое место — задержка сети (запрос идёт ~1 с при
 * паузе 120 мс), а не лимит биржи: klines(limit=1000) стоит вес 10 при
 * бюджете 2400/мин, то есть 240 запросов в минуту. Последовательный сбор
 * даёт ~60/мин и растянулся бы на часы; шесть потоков укладываются в бюджет
 * с запасом и упираются уже в биржу, а не в ожидание.
 */
const CONCURRENCY = 6;
const MAX_RETRY = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string): Promise<unknown> {
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      if (attempt === MAX_RETRY) throw e;
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    // 429/418 — лимит запросов. Retry-After в секундах; ждём и пробуем снова.
    if (res.status === 429 || res.status === 418) {
      const wait = Math.min(Number(res.headers.get("retry-after") ?? 5) || 5, 120);
      await sleep(wait * 1000);
      continue;
    }
    if (!res.ok) {
      if (attempt === MAX_RETRY) throw new Error(`${res.status} ${url}`);
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    return res.json();
  }
  throw new Error(`не удалось получить ${url}`);
}

/**
 * Спотовое имя → имя перпа. Монеты с крошечной ценой торгуются на фьючерсах
 * пачками по 1000 штук (SHIBUSDT на споте = 1000SHIBUSDT на перпах), иначе
 * шаг цены не выразить. Без этой таблицы пять ликвидных мем-коинов молча
 * выпали бы из вселенной как «нет фьючерса», хотя фьючерс есть.
 *
 * ВНИМАНИЕ на будущее: цена перпа здесь в 1000 раз больше спотовой. Для
 * бэктеста это безразлично (все правила и стопы относительные, в ATR и R),
 * но абсолютные пороги цены по таким символам сравнивать нельзя.
 */
const PERP_ALIASES: Record<string, string> = {
  SHIBUSDT: "1000SHIBUSDT",
  PEPEUSDT: "1000PEPEUSDT",
  BONKUSDT: "1000BONKUSDT",
  FLOKIUSDT: "1000FLOKIUSDT",
  LUNCUSDT: "1000LUNCUSDT",
};

/** Живые USDT-символы биржи. Для перпов — только PERPETUAL в статусе TRADING. */
async function fetchUniverse(source: Source): Promise<string[]> {
  const info = (await getJson(HOSTS[source].info)) as {
    symbols: { symbol: string; status: string; contractType?: string; quoteAsset: string }[];
  };
  return info.symbols
    .filter((s) => s.status === "TRADING" && s.quoteAsset === "USDT")
    .filter((s) => (source === "perp" ? s.contractType === "PERPETUAL" : true))
    .map((s) => s.symbol)
    .sort();
}

/**
 * Свечи символа начиная с `fromMs`. Потолка по числу баров НЕТ — качаем,
 * пока биржа отдаёт: именно потолок обрезал историю до 2021 года.
 * Возвращаются только ЗАКРЫТЫЕ бары: незакрытая свеча — ещё не факт, и в
 * бэктесте её не существует (паритет с движком).
 */
async function fetchKlines(
  source: Source,
  symbol: string,
  tf: SignalTf,
  fromMs: number,
): Promise<Candle[]> {
  const out: Candle[] = [];
  let start = fromMs;
  const now = Date.now();
  for (;;) {
    const url = `${HOSTS[source].klines}?symbol=${symbol}&interval=${tf}&startTime=${start}&limit=${PAGE}`;
    const rows = (await getJson(url)) as [number, string, string, string, string, string, number][];
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) {
      if (r[6] >= now) continue; // closeTime в будущем — бар не закрыт
      out.push({
        time: r[0] / 1000,
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        volume: Number(r[5]),
      });
    }
    if (rows.length < PAGE) break;
    start = rows[rows.length - 1][0] + 1;
    await sleep(GAP_MS);
  }
  return out;
}

function readCorpus(path: string): Candle[] {
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(gunzipSync(readFileSync(path)).toString("utf-8")) as Candle[];
  } catch {
    return [];
  }
}

/** Склейка без дублей и без дыр в порядке: старое + только более новые бары. */
function mergeCandles(existing: Candle[], fresh: Candle[]): Candle[] {
  if (existing.length === 0) return fresh;
  const lastTime = existing[existing.length - 1].time;
  const tail = fresh.filter((c) => c.time > lastTime);
  return tail.length === 0 ? existing : [...existing, ...tail];
}

export interface SymbolCoverage {
  symbol: string;
  tf: SignalTf;
  bars: number;
  firstIso: string;
  lastIso: string;
}

/** Манифест версии корпуса — без него нельзя сказать, чем измеряли. */
export interface CorpusManifest {
  source: Source;
  generatedAt: string;
  tfs: SignalTf[];
  symbols: number;
  coverage: SymbolCoverage[];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const source = (arg("source") ?? "perp") as Source;
  const tfs = (arg("tf") ?? "1h,4h").split(",").map((t) => t.trim()) as SignalTf[];
  const outDir = arg("out") ?? join("public", "data", `history-${source}`);
  const full = argv.includes("--full");
  const only = arg("symbols")?.split(",").map((s) => s.trim());
  const limit = Number(arg("limit") ?? 0);

  mkdirSync(outDir, { recursive: true });

  let symbols = only ?? (await fetchUniverse(source));
  if (limit > 0) symbols = symbols.slice(0, limit);
  console.error(
    `Источник: ${source} (${HOSTS[source].klines}). Символов: ${symbols.length}. ТФ: ${tfs.join(",")}. Каталог: ${outDir}.` +
      (full ? " Режим: ПОЛНЫЙ пересбор." : " Режим: дозапись хвоста."),
  );

  const coverage: SymbolCoverage[] = [];
  let done = 0;

  /** Один символ целиком (все ТФ) — единица работы для пула. */
  const collectSymbol = async (symbol: string): Promise<void> => {
    for (const tf of tfs) {
      const path = join(outDir, `${symbol}_${tf}.json.gz`);
      const existing = full ? [] : readCorpus(path);
      // Дозапись начинается со СЛЕДУЮЩЕГО бара после последнего известного.
      const fromMs =
        existing.length > 0 ? existing[existing.length - 1].time * 1000 + TF_MS[tf] : 0;
      // Файл называем спотовым именем (им пользуются фандинг, метрики и весь
      // остальной код), а запрашиваем — фьючерсным.
      const remote = source === "perp" ? (PERP_ALIASES[symbol] ?? symbol) : symbol;
      try {
        const fresh = await fetchKlines(source, remote, tf, fromMs);
        const merged = mergeCandles(existing, fresh);
        if (merged.length > 0 && merged.length !== existing.length) {
          writeFileSync(path, gzipSync(JSON.stringify(merged)));
        }
        if (merged.length > 0) {
          coverage.push({
            symbol,
            tf,
            bars: merged.length,
            firstIso: new Date(merged[0].time * 1000).toISOString(),
            lastIso: new Date(merged[merged.length - 1].time * 1000).toISOString(),
          });
        }
      } catch (e) {
        console.error(`  ! ${symbol} ${tf}: ${(e as Error).message}`);
      }
      await sleep(GAP_MS);
    }
    done += 1;
    if (done % 10 === 0) console.error(`  …${done}/${symbols.length} символов`);
  };

  // Пул воркеров: каждый берёт следующий символ из общей очереди. Порядок
  // результатов не важен — манифест всё равно сортируется при чтении.
  const queue = [...symbols];
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (;;) {
        const symbol = queue.shift();
        if (symbol === undefined) return;
        await collectSymbol(symbol);
      }
    }),
  );

  // Манифест описывает КАТАЛОГ, а не прогон: сканируем всё, что лежит рядом.
  // Иначе запуск с --symbols по пяти монетам затирал бы описание корпуса из
  // 157 символов пятью строками — и потребитель манифеста (в том числе выбор
  // рынка живых свечей в binance.ts) читал бы неправду.
  const full$ = scanCorpus(outDir);
  const manifest: CorpusManifest = {
    source,
    generatedAt: new Date().toISOString(),
    tfs: [...new Set(full$.map((c) => c.tf))],
    symbols: new Set(full$.map((c) => c.symbol)).size,
    coverage: full$,
  };
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 1));

  const oneH = full$.filter((c) => c.tf === "1h");
  const earliest = oneH.reduce((a, c) => (c.firstIso < a ? c.firstIso : a), "9999");
  console.log(
    JSON.stringify({
      source,
      corpusSymbols: manifest.symbols,
      corpusFiles: full$.length,
      touchedThisRun: coverage.length,
      earliest1h: earliest,
      maxBars1h: oneH.reduce((a, c) => Math.max(a, c.bars), 0),
      totalBars1h: oneH.reduce((a, c) => a + c.bars, 0),
      outDir,
    }),
  );
}

/** Покрытие по ВСЕМ файлам каталога — источник правды для манифеста. */
export function scanCorpus(dir: string): SymbolCoverage[] {
  if (!existsSync(dir)) return [];
  const out: SymbolCoverage[] = [];
  for (const file of readdirSync(dir)) {
    const m = file.match(/^(.+)_(1h|4h|1d)\.json\.gz$/);
    if (!m) continue;
    const candles = readCorpus(join(dir, file));
    if (candles.length === 0) continue;
    out.push({
      symbol: m[1],
      tf: m[2] as SignalTf,
      bars: candles.length,
      firstIso: new Date(candles[0].time * 1000).toISOString(),
      lastIso: new Date(candles[candles.length - 1].time * 1000).toISOString(),
    });
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.tf.localeCompare(b.tf));
}

await main();
