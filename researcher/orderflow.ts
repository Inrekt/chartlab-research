/**
 * Свёртка сырых aggTrades Binance USDⓈ-M в бары ордерфлоу (15m и 1h).
 *
 * ЭТО ДАННЫЕ, НЕ НАУКА. Файл только превращает поток сделок в серии; кубики и
 * семейства поверх них появятся через пре-регистрацию. Поэтому здесь нет
 * ни порогов «сигнала», ни выбора по результатам.
 *
 * Колонки бара (Σ по сделкам бара; «сделка» = строка aggTrades, то есть один
 * агрессивный ордер на одной цене):
 *   trades        — число строк aggTrades
 *   buyQty/sellQty — объём тейкер-покупок/продаж, базовая монета
 *                    (is_buyer_maker=false → тейкер купил)
 *   buyUsd/sellUsd — то же в $ (price·qty), сопоставимо между эпохами
 *   largeBuyUsd/largeSellUsd — $ в «крупных» принтах (≥ largeThrUsd)
 *   largeThrUsd   — порог крупного принта: квантиль LARGE_PRINT_QUANTILE
 *                   размера принтов символа за ПРОШЛЫЕ ≤30 дней, дни бара
 *                   в него НЕ входят (никакого look-ahead). Пусто, пока в
 *                   истории < MIN_HIST_DAYS дней — крупных принтов тогда нет.
 *   absorb        — (delta/vol)·(1 − |close−open|/(high−low)) по ценам сделок:
 *                   >0 — агрессивные покупки, но цена не продвинулась (их
 *                   поглощают пассивные продавцы), <0 — зеркально.
 *   poc           — цена с максимальным объёмом внутри бара; корзина цены —
 *                   POC_BIN_BPS б.п. от первой цены дня, ничья → нижняя цена.
 * Дельта = buyQty−sellQty, CVD = накопленная сумма дельт — выводятся читателем
 * (`withCvd`), а не хранятся: так дозапись по дням не требует состояния CVD.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

export const LARGE_PRINT_QUANTILE = 0.995;
export const HIST_WINDOW_DAYS = 30;
export const MIN_HIST_DAYS = 5;
export const POC_BIN_BPS = 2;

/** Лог-гистограмма размера принта: 25 корзин на декаду, от $0.01 до $1e8. */
export const HIST_BINS = 250;
const histBin = (usd: number): number =>
  Math.min(HIST_BINS - 1, Math.max(0, Math.floor((Math.log10(usd) + 2) * 25)));

/** Квантиль по лог-гистограмме: верхняя граница корзины, где накоплено ≥ q. */
export function histQuantile(hist: readonly number[], q: number): number {
  const total = hist.reduce((a, b) => a + b, 0);
  if (total === 0) return NaN;
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc >= q * total) return 10 ** ((i + 1) / 25 - 2);
  }
  return 10 ** (HIST_BINS / 25 - 2);
}

export interface FlowState {
  symbol: string;
  /** Последний полностью свёрнутый день YYYY-MM-DD (дни идут строго по возрастанию). */
  lastDay: string | null;
  /** Старше этого дня файлов нет и не будет (опрошены и дали 404) — повторно не запрашиваем. */
  scannedThrough?: string;
  /** Гистограммы последних дней: день → счётчики по корзинам. */
  hists: Record<string, number[]>;
}

export function emptyState(symbol: string): FlowState {
  return { symbol, lastDay: null, hists: {} };
}

/** Порог крупного принта для дня `day` — только по дням СТРОГО раньше него. */
export function largeThreshold(state: FlowState, day: string): number | null {
  const days = Object.keys(state.hists)
    .filter((d) => d < day)
    .sort()
    .slice(-HIST_WINDOW_DAYS);
  if (days.length < MIN_HIST_DAYS) return null;
  const merged = new Array<number>(HIST_BINS).fill(0);
  for (const d of days) state.hists[d].forEach((c, i) => (merged[i] += c));
  const thr = histQuantile(merged, LARGE_PRINT_QUANTILE);
  return Number.isFinite(thr) ? thr : null;
}

/** Новое состояние после дня: добавляет гистограмму, подрезает окно. */
export function advanceState(state: FlowState, day: string, hist: number[]): FlowState {
  const hists = { ...state.hists, [day]: hist };
  const keep = Object.keys(hists).sort().slice(-HIST_WINDOW_DAYS);
  return {
    symbol: state.symbol,
    lastDay: day,
    scannedThrough: state.scannedThrough,
    hists: Object.fromEntries(keep.map((d) => [d, hists[d]])),
  };
}

class BarAcc {
  n = 0;
  buyQty = 0;
  sellQty = 0;
  buyUsd = 0;
  sellUsd = 0;
  largeBuyUsd = 0;
  largeSellUsd = 0;
  open = NaN;
  close = NaN;
  high = -Infinity;
  low = Infinity;
  bins = new Map<number, number>();
}

const num = (v: number, digits = 12): string => String(Number(v.toPrecision(digits)));

export const FLOW_HEADER =
  "time,trades,buyQty,sellQty,buyUsd,sellUsd,largeBuyUsd,largeSellUsd,largeThrUsd,absorb,poc";

function barRow(startMs: number, a: BarAcc, thr: number | null, binSize: number): string {
  const vol = a.buyQty + a.sellQty;
  const range = a.high - a.low;
  const body = range > 0 ? Math.abs(a.close - a.open) / range : 0;
  const absorb = vol > 0 ? ((a.buyQty - a.sellQty) / vol) * (1 - Math.min(1, body)) : 0;
  let pocBin = NaN;
  let pocVol = -1;
  for (const [bin, v] of a.bins) {
    if (v > pocVol || (v === pocVol && bin < pocBin)) {
      pocVol = v;
      pocBin = bin;
    }
  }
  const poc = (pocBin + 0.5) * binSize;
  return [
    new Date(startMs).toISOString(),
    a.n,
    num(a.buyQty),
    num(a.sellQty),
    num(a.buyUsd),
    num(a.sellUsd),
    num(a.largeBuyUsd),
    num(a.largeSellUsd),
    thr === null ? "" : num(thr, 6),
    num(absorb, 8),
    num(poc, 9),
  ].join(",");
}

export interface DayFold {
  rows15m: string[];
  rows1h: string[];
  hist: number[];
  trades: number;
  /** Сделки с временем вне суток файла — отброшены, чтобы не плодить дубли баров. */
  dropped: number;
}

const MS15 = 900_000;
const MS1H = 3_600_000;
const MS_DAY = 86_400_000;

/**
 * Свернуть строки одного дневного файла aggTrades. `lines` — построчный
 * поток CSV (с заголовком или без). Память — O(баров дня), не O(сделок).
 */
export async function foldDay(
  day: string,
  lines: AsyncIterable<string> | Iterable<string>,
  thrUsd: number | null,
): Promise<DayFold> {
  const dayStart = Date.parse(`${day}T00:00:00Z`);
  const dayEnd = dayStart + MS_DAY;
  const bars15 = new Map<number, BarAcc>();
  const bars1h = new Map<number, BarAcc>();
  const hist = new Array<number>(HIST_BINS).fill(0);
  let binSize = NaN;
  let trades = 0;
  let dropped = 0;

  const add = (map: Map<number, BarAcc>, key: number, p: number, q: number, usd: number, isSell: boolean, large: boolean, bin: number) => {
    let a = map.get(key);
    if (!a) {
      a = new BarAcc();
      map.set(key, a);
    }
    a.n += 1;
    if (isSell) {
      a.sellQty += q;
      a.sellUsd += usd;
      if (large) a.largeSellUsd += usd;
    } else {
      a.buyQty += q;
      a.buyUsd += usd;
      if (large) a.largeBuyUsd += usd;
    }
    if (a.n === 1) a.open = p;
    a.close = p;
    if (p > a.high) a.high = p;
    if (p < a.low) a.low = p;
    a.bins.set(bin, (a.bins.get(bin) ?? 0) + q);
  };

  for await (const line of lines) {
    // agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker
    const c1 = line.indexOf(",");
    if (c1 < 0) continue;
    const c2 = line.indexOf(",", c1 + 1);
    const c3 = line.indexOf(",", c2 + 1);
    const c4 = line.indexOf(",", c3 + 1);
    const c5 = line.indexOf(",", c4 + 1);
    const c6 = line.indexOf(",", c5 + 1);
    if (c6 < 0) continue;
    const price = Number(line.slice(c1 + 1, c2));
    const qty = Number(line.slice(c2 + 1, c3));
    let t = Number(line.slice(c5 + 1, c6));
    if (!(price > 0) || !(qty > 0) || !Number.isFinite(t)) continue; // заголовок/мусор
    if (t > 1e14) t = Math.floor(t / 1000); // микросекунды → мс
    if (t < dayStart || t >= dayEnd) {
      dropped += 1;
      continue;
    }
    const isSell = line.charCodeAt(c6 + 1) === 116 || line.charCodeAt(c6 + 1) === 84; // "t"/"T"
    if (Number.isNaN(binSize)) binSize = price * (POC_BIN_BPS / 10_000);
    const usd = price * qty;
    const large = thrUsd !== null && usd >= thrUsd;
    const bin = Math.floor(price / binSize);
    trades += 1;
    hist[histBin(usd)] += 1;
    add(bars15, Math.floor(t / MS15) * MS15, price, qty, usd, isSell, large, bin);
    add(bars1h, Math.floor(t / MS1H) * MS1H, price, qty, usd, isSell, large, bin);
  }

  const emit = (map: Map<number, BarAcc>) =>
    [...map.entries()].sort((x, y) => x[0] - y[0]).map(([k, a]) => barRow(k, a, thrUsd, binSize));
  return { rows15m: emit(bars15), rows1h: emit(bars1h), hist, trades, dropped };
}

// ── Хранение: gzip-«члены» дописываются по дню, читатель дедуплицирует ─────

/** Дописать день: заголовок — только в новый файл. Конкатенация gzip-членов валидна. */
export function appendRows(path: string, rows: readonly string[]): void {
  if (rows.length === 0) return;
  mkdirSync(dirname(path), { recursive: true });
  const text = (existsSync(path) ? "" : `${FLOW_HEADER}\n`) + rows.join("\n") + "\n";
  appendFileSync(path, gzipSync(text));
}

/**
 * Прочитать серию: дубли по времени (повтор дня после сбоя) схлопываются,
 * побеждает последняя запись; порядок — по времени.
 */
export function readFlow(path: string): string[] {
  if (!existsSync(path)) return [];
  const lines = gunzipSync(readFileSync(path)).toString("utf8").trim().split("\n");
  const byTime = new Map<string, string>();
  for (const l of lines) {
    if (l === FLOW_HEADER || l === "") continue;
    byTime.set(l.slice(0, l.indexOf(",")), l);
  }
  return [...byTime.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, l]) => l);
}

export interface FlowBar {
  time: string;
  deltaQty: number;
  deltaUsd: number;
  cvdQty: number;
  cvdUsd: number;
  row: string[];
}

/** Дельта и CVD (накопление с первого бара серии) для читателя. */
export function withCvd(rows: readonly string[]): FlowBar[] {
  let cq = 0;
  let cu = 0;
  return rows.map((l) => {
    const f = l.split(",");
    const dq = Number(f[2]) - Number(f[3]);
    const du = Number(f[4]) - Number(f[5]);
    cq += dq;
    cu += du;
    return { time: f[0], deltaQty: dq, deltaUsd: du, cvdQty: cq, cvdUsd: cu, row: f };
  });
}

export function loadState(path: string, symbol: string): FlowState {
  if (!existsSync(path)) return emptyState(symbol);
  return JSON.parse(readFileSync(path, "utf8")) as FlowState;
}

/** Атомарная запись состояния: tmp + rename, чтобы сбой не оставил полфайла. */
export function saveState(path: string, state: FlowState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, path);
}

export const flowPaths = (collectDir: string, symbol: string) => ({
  m15: join(collectDir, "orderflow-15m", `${symbol}.csv.gz`),
  h1: join(collectDir, "orderflow-1h", `${symbol}.csv.gz`),
  state: join(collectDir, "orderflow-state", `${symbol}.json`),
});
