/**
 * Сборщик ордерфлоу из aggTrades Binance USDⓈ-M (data.binance.vision).
 *
 * По одному дневному zip за раз: скачать → сверить SHA-256 → потоково свернуть
 * (см. orderflow.ts) → дописать 15m/1h → сохранить состояние → удалить сырьё.
 * Resumable: состояние (`lastDay`) пишется ПОСЛЕ данных; повтор дня после
 * сбоя даёт дубль строк, который читатель схлопывает по времени.
 *
 * Вселенная — `orderflow-universe.json`, зафиксирована по прошлому нотионалу
 * на 2025-08-01 (до экзамена), без выбора по результатам. Пересчёт:
 *   npx tsx researcher/collect-orderflow.ts --select --history-dir <history-perp>
 *
 * Запуск:   npx tsx researcher/collect-orderflow.ts [--symbols BTCUSDT,ETHUSDT]
 *           [--from 2019-12-31] [--concurrency 3] [--max-days N]
 * Каталог:  env COLLECT_DIR → orderflow-15m|1h|state/
 * Диск:     перед каждым файлом свободно должно остаться ≥ 5 ГБ, иначе стоп (код 3).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ARCHIVE,
  DiskLowError,
  assertDiskRoom,
  downloadVerified,
  daysBetween,
  yesterdayUtc,
  zipLines,
} from "./binanceArchive.ts";
import {
  advanceState,
  appendRows,
  flowPaths,
  foldDay,
  largeThreshold,
  loadState,
  saveState,
} from "./orderflow.ts";
import { loadCandles } from "./corpus.ts";
import { monthlyNotional } from "./liquidityCosts.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const UNIVERSE_FILE = join(HERE, "orderflow-universe.json");
export const SELECTION_ASOF = "2025-08-01";
export const UNIVERSE_SIZE = 30;
const SELECT_MONTHS = 6;
const MIN_HISTORY_MONTHS = 12;

const COLLECT_DIR =
  process.env.COLLECT_DIR ?? join(process.env.HOME ?? "", ".chartlab", "data-repo", "market");

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

/**
 * Топ-N по среднему нотионалу $/бар (1h) за SELECT_MONTHS месяцев ДО `asOf`,
 * среди символов с историей ≥ MIN_HISTORY_MONTHS месяцев до `asOf`. Только
 * ликвидность, никаких результатов стратегий.
 */
export function selectUniverse(
  symbols: readonly string[],
  candlesFor: (s: string) => ReturnType<typeof loadCandles>,
  asOf = SELECTION_ASOF,
  n = UNIVERSE_SIZE,
): { symbol: string; notional: number }[] {
  const end = new Date(`${asOf}T00:00:00Z`);
  const monthsBack = (k: number) => {
    const d = new Date(end);
    d.setUTCMonth(d.getUTCMonth() - k);
    return d.toISOString().slice(0, 7);
  };
  const window = new Set(Array.from({ length: SELECT_MONTHS }, (_, i) => monthsBack(i + 1)));
  const minStart = Math.floor(
    Date.parse(`${monthsBack(MIN_HISTORY_MONTHS)}-01T00:00:00Z`) / 1000,
  );
  const scored: { symbol: string; notional: number }[] = [];
  const present = new Set(symbols);
  for (const symbol of symbols) {
    // Спотовый дубль мем-монеты (PEPEUSDT ↔ 1000PEPEUSDT): тот же актив, на перпах
    // торгуется только «1000»-форма — берём её одну, иначе вселенная теряет слоты.
    if (present.has(`1000${symbol}`)) continue;
    const candles = candlesFor(symbol);
    if (!candles || candles.length === 0 || candles[0].time > minStart) continue;
    const byMonth = monthlyNotional(candles);
    const vals = [...window].map((m) => byMonth.get(m)).filter((v): v is number => v !== undefined);
    if (vals.length < SELECT_MONTHS) continue;
    scored.push({ symbol, notional: vals.reduce((a, b) => a + b, 0) / vals.length });
  }
  return scored.sort((a, b) => b.notional - a.notional || a.symbol.localeCompare(b.symbol)).slice(0, n);
}

export function loadUniverseFile(path = UNIVERSE_FILE): string[] {
  return (JSON.parse(readFileSync(path, "utf8")) as { symbols: string[] }).symbols;
}

export interface DaySource {
  day: string;
  /** Размер архива в байтах — для предохранителя диска. */
  size: number;
  /** Подготовить строки дня; `cleanup` вызывается всегда (удаляет сырьё). */
  open(): Promise<{ lines: AsyncIterable<string> | Iterable<string>; cleanup(): void } | null>;
}

/**
 * Свернуть недостающие дни одного символа по возрастанию. Дни ≤ `lastDay`
 * состояния пропускаются. Возвращает число свёрнутых дней.
 */
export async function collectSymbol(
  symbol: string,
  days: readonly DaySource[],
  collectDir: string,
  opts: { maxDays?: number; beforeDay?: (d: DaySource) => void } = {},
): Promise<number> {
  const p = flowPaths(collectDir, symbol);
  let state = loadState(p.state, symbol);
  let done = 0;
  const staleBefore = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
  for (const d of [...days].sort((a, b) => (a.day < b.day ? -1 : 1))) {
    if (state.lastDay !== null && d.day <= state.lastDay) continue;
    if (state.scannedThrough && d.day <= state.scannedThrough) continue;
    if (opts.maxDays !== undefined && done >= opts.maxDays) break;
    opts.beforeDay?.(d);
    const src = await d.open();
    if (src === null) {
      // Файла нет. Для давних дней это окончательно (символ ещё не торговался) —
      // запоминаем, чтобы не опрашивать заново; свежие дни могут просто не быть опубликованы.
      if (d.day < staleBefore) {
        state = { ...state, scannedThrough: d.day };
        saveState(p.state, state);
      }
      continue;
    }
    try {
      const fold = await foldDay(d.day, src.lines, largeThreshold(state, d.day));
      appendRows(p.m15, fold.rows15m);
      appendRows(p.h1, fold.rows1h);
      state = advanceState(state, d.day, fold.hist);
      saveState(p.state, state);
      done += 1;
    } finally {
      src.cleanup();
    }
  }
  return done;
}

/** Консервативная оценка размера дневного архива для предохранителя диска (BTC ≲ 0.5 ГБ). */
const DAY_ZIP_BUDGET = 1024 ** 3;

function networkDays(symbol: string, from: string, scratch: string): DaySource[] {
  return daysBetween(from, yesterdayUtc()).map((day) => ({
    day,
    size: DAY_ZIP_BUDGET,
    async open() {
      const zip = join(scratch, `${symbol}-${day}.zip`);
      const url = `${ARCHIVE}/data/futures/um/daily/aggTrades/${symbol}/${symbol}-aggTrades-${day}.zip`;
      if (!(await downloadVerified(url, zip))) return null;
      return { lines: zipLines(zip), cleanup: () => rmSync(zip, { force: true }) };
    },
  }));
}

async function main(): Promise<void> {
  if (process.argv.includes("--select")) {
    const dir = arg("history-dir", process.env.RESEARCHER_HISTORY_DIR ?? "");
    if (!dir) throw new Error("--select требует --history-dir <каталог history-perp>");
    const { listUniverse } = await import("./corpus.ts");
    const syms = listUniverse("1h", dir);
    const picked = selectUniverse(syms, (s) => loadCandles(s, "1h", dir));
    writeFileSync(
      UNIVERSE_FILE,
      JSON.stringify(
        {
          asOf: SELECTION_ASOF,
          rule: `топ-${UNIVERSE_SIZE} по среднему нотионалу $/бар (1h) за ${SELECT_MONTHS} мес до asOf; история ≥ ${MIN_HISTORY_MONTHS} мес до asOf; только ликвидность`,
          symbols: picked.map((x) => x.symbol),
          notionalUsdPerHour: Object.fromEntries(picked.map((x) => [x.symbol, Math.round(x.notional)])),
        },
        null,
        1,
      ) + "\n",
    );
    console.error(`вселенная: ${picked.map((x) => x.symbol).join(" ")}`);
    return;
  }

  const symbols = arg("symbols", "") ? arg("symbols", "").split(",") : loadUniverseFile();
  const from = arg("from", "2019-12-01");
  const concurrency = Number(arg("concurrency", "3"));
  const maxDays = arg("max-days", "") ? Number(arg("max-days", "")) : undefined;
  const scratch = join(tmpdir(), "orderflow-scratch");
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });

  let stop: DiskLowError | null = null;
  const queue = [...symbols];
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        const symbol = queue.shift();
        if (!symbol || stop) return;
        try {
          const days = networkDays(symbol, from, scratch);
          const n = await collectSymbol(symbol, days, COLLECT_DIR, {
            maxDays,
            beforeDay: (d) => assertDiskRoom(scratch, d.size),
          });
          console.error(`${new Date().toISOString()} ${symbol}: +${n} дн.`);
        } catch (e) {
          if (e instanceof DiskLowError) {
            stop = e;
            return;
          }
          // сбой одного символа не валит остальные; повтор — на следующем запуске
          console.error(`${new Date().toISOString()} ${symbol}: ОШИБКА ${(e as Error).message}`);
        }
      }
    }),
  );
  rmSync(scratch, { recursive: true, force: true });
  const stopped = stop as DiskLowError | null;
  if (stopped) {
    console.error(`СТОП: ${stopped.message}`);
    process.exitCode = 3;
    return;
  }
  console.error(`готово за ${Math.round((Date.now() - t0) / 60000)} мин`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}

