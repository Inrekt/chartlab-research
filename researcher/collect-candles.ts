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
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync, gzipSync, inflateRawSync } from "node:zlib";
import type { Candle } from "../src/core/types/index.ts";
import type { SignalTf } from "./grammar.ts";

/**
 * Откуда берутся свечи.
 *
 * `mirror` — те же ФЬЮЧЕРСНЫЕ данные, но из файлового архива Binance, а не из
 * REST. Существует по единственной причине: раннеры GitHub получают от REST
 * `451 Unavailable For Legal Reasons` (замерено зондом probe.yml — и на
 * api.binance.com, и на fapi). Архив на data.binance.vision отвечает 200.
 * Без этого источника корпус в облаке собрать нельзя вообще.
 *
 * Плата за обход — хвост отстаёт примерно на сутки: дневной архив за день D
 * публикуется на следующий день. Для ночного скрина на пятилетней истории это
 * несущественно, для инкубатора — существенно, и потому инкубация остаётся
 * задачей машины, у которой REST открыт.
 */
type Source = "perp" | "spot" | "mirror";

const HOSTS: Record<Source, { klines: string; info: string }> = {
  perp: {
    klines: "https://fapi.binance.com/fapi/v1/klines",
    info: "https://fapi.binance.com/fapi/v1/exchangeInfo",
  },
  spot: {
    klines: "https://api.binance.com/api/v3/klines",
    info: "https://api.binance.com/api/v3/exchangeInfo",
  },
  mirror: {
    klines: "https://data.binance.vision/data/futures/um",
    info: "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision",
  },
};

/**
 * Какой РЫНОК описывают данные источника — не путать с тем, откуда они взяты.
 *
 * Поле `source` манифеста читает `binance.ts`, выбирая рынок живых баров.
 * Записать туда «mirror» значило бы, что рынок не распознан, и живые бары
 * молча поехали бы со спота, пока корпус фьючерсный. Ровно это расхождение
 * уже случалось — цена ошибки известна.
 */
const MARKET_OF: Record<Source, "perp" | "spot"> = {
  perp: "perp",
  spot: "spot",
  mirror: "perp",
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

/** Сырые байты с ретраями — для архивов. 404 значит «файла нет», а не сбой. */
async function getBuffer(url: string): Promise<Buffer | null> {
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    } catch (e) {
      if (attempt === MAX_RETRY) throw e;
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    // Ожидаемая пустота: дневного файла за сегодня ещё нет, месячного за
    // текущий месяц не будет до его конца. Это не ошибка.
    if (res.status === 404) return null;
    if (!res.ok) {
      if (attempt === MAX_RETRY) throw new Error(`${res.status} ${url}`);
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    return Buffer.from(await res.arrayBuffer());
  }
  throw new Error(`не удалось получить ${url}`);
}

async function getText(url: string): Promise<string> {
  const buf = await getBuffer(url);
  if (buf === null) throw new Error(`404 ${url}`);
  return buf.toString("utf8");
}

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

/**
 * Список вселенной, зафиксированный в git.
 *
 * Нужен ровно для холодного старта: в архиве 832 символа (всё, что когда-либо
 * торговалось), в живом корпусе — 162. Без явного списка первая же ночь на
 * пустом кэше ушла бы в закачку впятеро большего объёма и не уложилась в
 * лимит джоба. Файл — метаданные, а не данные: несколько килобайт имён.
 */
export function committedUniverse(): string[] {
  try {
    const path = join(dirname(fileURLToPath(import.meta.url)), "universe-perp.json");
    return JSON.parse(readFileSync(path, "utf8")) as string[];
  } catch {
    return [];
  }
}

// ── Архив Binance: разбор ZIP без зависимостей ──────────────────────────────
//
// Архивы содержат ровно один CSV. Библиотеки zip в проекте нет и заводить её
// ради одного формата не стоит: центральный каталог читается тридцатью
// строками, а `inflateRawSync` уже есть в стандартной библиотеке.

/** Единственный файл из zip-архива Binance, распакованный в текст. */
export function unzipSingleEntry(zip: Buffer): string {
  // Идём от КОНЦА через End of Central Directory, а не от начала через
  // локальный заголовок: при выставленном бите 3 размеры в локальном
  // заголовке нулевые и лежат в дескрипторе ПОСЛЕ данных. Центральный каталог
  // хранит их всегда — это единственный надёжный путь.
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0 && i > zip.length - 65_557; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip: не найден End of Central Directory");

  const cdOffset = zip.readUInt32LE(eocd + 16);
  if (zip.readUInt32LE(cdOffset) !== 0x02014b50) throw new Error("zip: битый центральный каталог");

  const method = zip.readUInt16LE(cdOffset + 10);
  const compSize = zip.readUInt32LE(cdOffset + 20);
  const localOffset = zip.readUInt32LE(cdOffset + 42);

  if (zip.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("zip: битый локальный заголовок");
  const nameLen = zip.readUInt16LE(localOffset + 26);
  const extraLen = zip.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + nameLen + extraLen;
  const data = zip.subarray(dataStart, dataStart + compSize);

  if (method === 0) return data.toString("utf8");
  if (method === 8) return inflateRawSync(data).toString("utf8");
  throw new Error(`zip: неподдерживаемый метод сжатия ${method}`);
}

/**
 * CSV архива → свечи.
 *
 * ⚠️ Две ловушки формата, обе тихие. Первая: у части файлов есть строка
 * заголовка, у части нет. Вторая опаснее — Binance перевёл часть архивов на
 * МИКРОсекунды, и наивный разбор дал бы бары в 54-м тысячелетии, которые
 * молча выпали бы из любого окна. Различаем по величине числа.
 */
/** Пустое поле — НЕ ноль: `Number("")` вернул бы 0 и притворился ценой. */
const num = (v: string | undefined): number =>
  v === undefined || v.trim() === "" ? NaN : Number(v);

export function parseKlineCsv(csv: string): Candle[] {
  const out: Candle[] = [];
  for (const line of csv.split("\n")) {
    if (line.length === 0) continue;
    const c = line.split(",");
    const raw = Number(c[0]);
    if (!Number.isFinite(raw)) continue; // строка заголовка
    // 1e14 мс ≈ 5138 год; всё, что больше, — микросекунды.
    const timeMs = raw > 1e14 ? Math.floor(raw / 1000) : raw;
    const candle: Candle = {
      time: Math.floor(timeMs / 1000),
      open: num(c[1]),
      high: num(c[2]),
      low: num(c[3]),
      close: num(c[4]),
      volume: num(c[5]),
    };
    // Цена обязана быть ПОЛОЖИТЕЛЬНОЙ, а не просто конечной. Пустое поле
    // `Number("")` даёт 0, и такой бар тихо прошёл бы проверку на конечность,
    // а дальше обнулил бы доходности и сломал любое деление на цену. Ноль
    // хуже NaN именно тем, что выглядит числом.
    if (candle.open > 0 && candle.high > 0 && candle.low > 0 && candle.close > 0) {
      out.push(candle);
    }
  }
  return out;
}

/** Ключи архива по префиксу (S3-листинг, постранично). */
async function listMirrorKeys(prefix: string, delimiter = ""): Promise<string[]> {
  const out: string[] = [];
  let token = "";
  for (let page = 0; page < 50; page++) {
    const url =
      `${HOSTS.mirror.info}?list-type=2&prefix=${encodeURIComponent(prefix)}` +
      (delimiter ? `&delimiter=${encodeURIComponent(delimiter)}` : "") +
      (token ? `&continuation-token=${encodeURIComponent(token)}` : "");
    const xml = await getText(url);
    const tag = delimiter ? "Prefix" : "Key";
    for (const m of xml.matchAll(new RegExp(`<${tag}>([^<]+)</${tag}>`, "g"))) {
      if (m[1] !== prefix) out.push(m[1]);
    }
    const next = /<NextContinuationToken>([^<]+)</.exec(xml);
    if (!next) break;
    token = next[1];
  }
  return out;
}

/** Живые USDT-символы биржи. Для перпов — только PERPETUAL в статусе TRADING. */
async function fetchUniverse(source: Source): Promise<string[]> {
  if (source === "mirror") {
    // exchangeInfo закрыт для раннера (451), поэтому вселенная берётся из
    // ЛИСТИНГА архива. Отличие смысловое и его надо знать: здесь символы,
    // у которых КОГДА-ЛИБО были данные, включая делистнутые. Для корпуса это
    // скорее плюс — ошибка выжившего лечится именно так.
    const prefixes = await listMirrorKeys("data/futures/um/monthly/klines/", "/");
    return prefixes
      .map((p) => p.split("/").filter(Boolean).pop() ?? "")
      .filter((sym) => sym.endsWith("USDT"))
      .sort();
  }
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
async function fetchMirrorKlines(
  symbol: string,
  tf: SignalTf,
  fromMs: number,
): Promise<Candle[]> {
  const base = `${HOSTS.mirror.klines}`;
  const out: Candle[] = [];

  // Месячные архивы закрывают историю, дневные — хвост текущего месяца.
  // Список берём из архива, а не строим по календарю: у каждого символа своя
  // дата листинга, и угадывание дало бы сотни лишних 404.
  const monthly = await listMirrorKeys(`data/futures/um/monthly/klines/${symbol}/${tf}/`);
  const daily = await listMirrorKeys(`data/futures/um/daily/klines/${symbol}/${tf}/`);
  const keys = [...monthly, ...daily].filter((k) => k.endsWith(".zip")).sort();

  // Месячный архив перекрывает дневные того же месяца — дубли снимет
  // mergeCandles, но качать их незачем.
  const coveredMonths = new Set(
    monthly.map((k) => /-(\d{4}-\d{2})\.zip$/.exec(k)?.[1]).filter(Boolean) as string[],
  );

  for (const key of keys) {
    const isDaily = key.includes("/daily/");
    if (isDaily) {
      const month = /-(\d{4}-\d{2})-\d{2}\.zip$/.exec(key)?.[1];
      if (month && coveredMonths.has(month)) continue;
    }
    // Дозапись: пропускаем архивы, целиком лежащие до известного хвоста.
    const stamp = /-(\d{4}-\d{2}(?:-\d{2})?)\.zip$/.exec(key)?.[1];
    if (fromMs > 0 && stamp) {
      const end = isDaily
        ? Date.parse(`${stamp}T23:59:59Z`)
        : Date.parse(`${stamp}-01T00:00:00Z`) + 32 * 86_400_000;
      if (Number.isFinite(end) && end < fromMs) continue;
    }
    const zip = await getBuffer(`${base}/${key.replace("data/futures/um/", "")}`);
    if (zip === null) continue;
    for (const candle of parseKlineCsv(unzipSingleEntry(zip))) {
      if (candle.time * 1000 >= fromMs) out.push(candle);
    }
  }
  out.sort((a, b) => a.time - b.time);
  // Архив местами расходится с REST: сверка BTCUSDT 1h дала 8 отличий на
  // 57 880 общих баров, из них 6 только по объёму. Но два бара пришли с
  // НУЛЕВЫМ объёмом и другой ценой — это дефект архива, а не округление.
  // Ноль объёма ломает всё, что делит на объём или считает по нему перцентиль,
  // поэтому такие бары считаются и о них сообщается, а не проглатываются.
  const zeroVol = out.filter((c) => c.volume === 0).length;
  if (zeroVol > 0) {
    console.error(`  ! ${symbol} ${tf}: баров с нулевым объёмом в архиве: ${zeroVol}`);
  }
  return out;
}

async function fetchKlines(
  source: Source,
  symbol: string,
  tf: SignalTf,
  fromMs: number,
): Promise<Candle[]> {
  if (source === "mirror") return fetchMirrorKlines(symbol, tf, fromMs);
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
  /** РЫНОК данных: `perp` | `spot`. Читается при выборе живых баров. */
  source: "perp" | "spot";
  /** ТРАНСПОРТ: чем скачано. Отличается от рынка только у архива. */
  via?: Source;
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

  /**
   * Дозапись НЕ расширяет вселенную сама.
   *
   * Листинг архива отдаёт все символы, у которых КОГДА-ЛИБО были данные, —
   * это сотни против 162 живых перпов у REST. Для разовой первичной сборки
   * это плюс (лечится ошибка выжившего), для ночной дозаписи — ловушка:
   * каждая ночь тратила бы часы на закачку истории символов, которых в
   * корпусе нет, и упиралась бы в лимит джоба.
   *
   * Поэтому по умолчанию дозапись трогает только то, что в корпусе уже есть.
   * Расширение вселенной — осознанное действие: `--full` или `--symbols`.
   */
  if (!full && !only) {
    // Пустой корпус — это ХОЛОДНЫЙ СТАРТ (в облаке: промах кэша). Брать в
    // этот момент весь листинг архива нельзя: 832 символа против 162 живых,
    // и первая же ночь ушла бы в многочасовую закачку и лимит джоба. Список
    // вселенной поэтому лежит в git — это метаданные на несколько килобайт,
    // а не данные, и он делает холодный старт ограниченным и одинаковым
    // локально и в облаке.
    const known = new Set(scanCorpus(outDir).map((c) => c.symbol));
    const wanted = known.size > 0 ? known : new Set(committedUniverse());
    if (wanted.size > 0) {
      const before = symbols.length;
      symbols = symbols.filter((s) => wanted.has(s));
      if (symbols.length < before) {
        console.error(
          `Дозапись: ${symbols.length} символов из ${before} доступных в источнике ` +
            `(${known.size > 0 ? "по корпусу" : "по списку вселенной из git"}). ` +
            "Расширение вселенной — только с --full или --symbols.",
        );
      }
    }
  }

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
    // РЫНОК, а не транспорт: `binance.ts` читает это поле, выбирая источник
    // живых баров. «mirror» здесь означал бы «рынок не распознан», и живые
    // бары уехали бы на спот при фьючерсном корпусе.
    source: MARKET_OF[source],
    via: source,
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

// Защита от запуска при ИМПОРТЕ. Без неё любой `import` из этого модуля —
// в тесте или ради scanCorpus — запускал бы полный сбор корпуса: сеть,
// минуты и запись на диск в стороннем каталоге.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
