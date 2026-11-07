/**
 * Докачка свечей 15m для вселенной ордерфлоу (`orderflow-universe.json`) из
 * архива фьючерсов Binance: месячные zip для закрытых месяцев + дневные для
 * хвоста. Каждый zip сверяется по SHA-256.
 *
 * ОТДЕЛЬНАЯ серия `COLLECT_DIR/candles-15m/SYMBOL.csv.gz`. Старый корпус 15m
 * (с 2023, ~/.chartlab/corpus-15m) НЕ читается и НЕ меняется: годовые ворота
 * он не проходит, а подмена тихо сдвинула бы чужие прогоны.
 * Колонки: time,open,high,low,close,volume,takerBuyVolume (time — ISO UTC).
 *
 * Resumable: берётся хвост после последнего бара файла; месяцы целиком до
 * хвоста не скачиваются. Запуск: npx tsx researcher/collect-candles-15m.ts
 * [--symbols A,B] [--from 2019-09]
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { ARCHIVE, DiskLowError, assertDiskRoom, daysBetween, downloadVerified, yesterdayUtc, zipLines } from "./binanceArchive.ts";
import { loadUniverseFile } from "./collect-orderflow.ts";

export const CANDLE_HEADER = "time,open,high,low,close,volume,takerBuyVolume";

const COLLECT_DIR =
  process.env.COLLECT_DIR ?? join(process.env.HOME ?? "", ".chartlab", "data-repo", "market");

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

/** Строка клайнов Binance → «ISO,o,h,l,c,vol,takerBuy»; заголовок/мусор → null. */
export function klineLine(line: string): string | null {
  const c = line.split(",");
  if (c.length < 10) return null;
  const raw = Number(c[0]);
  if (!Number.isFinite(raw)) return null;
  const ms = raw > 1e14 ? Math.floor(raw / 1000) : raw; // микросекунды → мс
  const [o, h, l, cl] = [c[1], c[2], c[3], c[4]].map(Number);
  if (!(o > 0 && h > 0 && l > 0 && cl > 0)) return null; // пустое поле ≠ 0
  return `${new Date(ms).toISOString()},${c[1]},${c[2]},${c[3]},${c[4]},${c[5]},${c[9]}`;
}

export function readCandles(path: string): string[] {
  if (!existsSync(path)) return [];
  return gunzipSync(readFileSync(path)).toString("utf8").trim().split("\n").slice(1);
}

/** Слить по времени без дублей (побеждает новая строка), атомарно записать. */
export function writeCandles(path: string, existing: readonly string[], fresh: readonly string[]): number {
  const byTime = new Map<string, string>();
  for (const l of [...existing, ...fresh]) byTime.set(l.slice(0, l.indexOf(",")), l);
  const rows = [...byTime.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, l]) => l);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, gzipSync(`${CANDLE_HEADER}\n${rows.join("\n")}\n`));
  renameSync(tmp, path);
  return rows.length;
}

function nextMonth(m: string): string {
  const d = new Date(`${m}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 7);
}

async function collectSymbol(symbol: string, from: string, scratch: string): Promise<number> {
  const path = join(COLLECT_DIR, "candles-15m", `${symbol}.csv.gz`);
  const existing = readCandles(path);
  const lastMs = existing.length ? Date.parse(existing[existing.length - 1].split(",")[0]) : 0;
  // Месячные архивы — закрытые месяцы, дневные — хвост текущего. Несуществующий
  // файл даёт быстрый 404 (символ ещё не торговался) — пропускаем.
  const yday = yesterdayUtc();
  const thisMonth = yday.slice(0, 7);
  const todo: string[] = [];
  for (let m = from; m < thisMonth; m = nextMonth(m)) {
    if (Date.parse(`${m}-01T00:00:00Z`) + 32 * 86_400_000 <= lastMs) continue;
    todo.push(`monthly/klines/${symbol}/15m/${symbol}-15m-${m}.zip`);
  }
  for (const day of daysBetween(`${thisMonth}-01`, yday)) {
    if (Date.parse(`${day}T23:59:59Z`) <= lastMs) continue;
    todo.push(`daily/klines/${symbol}/15m/${symbol}-15m-${day}.zip`);
  }
  const fresh: string[] = [];
  for (const key of todo) {
    assertDiskRoom(scratch, 50 * 1024 * 1024);
    const zip = join(scratch, key.split("/").pop() as string);
    try {
      if (!(await downloadVerified(`${ARCHIVE}/data/futures/um/${key}`, zip))) continue;
      for await (const line of zipLines(zip)) {
        const r = klineLine(line);
        if (r) fresh.push(r);
      }
    } finally {
      rmSync(zip, { force: true });
    }
  }
  if (fresh.length === 0) return 0;
  return writeCandles(path, existing, fresh) - existing.length;
}

async function main(): Promise<void> {
  const symbols = arg("symbols", "") ? arg("symbols", "").split(",") : loadUniverseFile();
  const from = arg("from", "2019-09");
  const scratch = join(tmpdir(), "candles15m-scratch");
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  let stopped: DiskLowError | null = null;
  const queue = [...symbols];
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      for (;;) {
        const s = queue.shift();
        if (!s || stopped) return;
        try {
          console.error(`${new Date().toISOString()} ${s}: +${await collectSymbol(s, from, scratch)} баров 15m`);
        } catch (e) {
          if (e instanceof DiskLowError) {
            stopped = e;
            return;
          }
          console.error(`${new Date().toISOString()} ${s}: ОШИБКА ${(e as Error).message}`);
        }
      }
    }),
  );
  rmSync(scratch, { recursive: true, force: true });
  const st = stopped as DiskLowError | null;
  if (st) {
    console.error(`СТОП: ${st.message}`);
    process.exitCode = 3;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
