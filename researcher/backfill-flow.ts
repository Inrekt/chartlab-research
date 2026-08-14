/**
 * Бэкфилл ЧЕСТНОГО потока тейкеров из архивных свечей Binance.
 *
 * ЗАЧЕМ. Действующая колонка takerBuySellVol в metrics-1h измерена ПОРОЧНО:
 * это среднее двенадцати пятиминутных ОТНОШЕНИЙ с равным весом, поэтому её
 * хвосты систематически указывают на ТОНКИЕ часы (замер 2026-08-10 на
 * BTC/ETH/SOL, 110 тыс. часов: медианный объём в хвостах распределения — 0.58
 * от медианы, в середине — 1.02). Кто ищет по ней «мощный односторонний
 * поток», находит тишину. Вдобавок она есть лишь у 156 символов из 362.
 *
 * ЧЕСТНАЯ ЗАМЕНА лежит в самой свече: поле [9] клайна — точный ОБЪЁМ
 * агрессивных покупок за бар (taker buy base volume). Продажи = volume −
 * takerBuy, никакой классификации сделок не нужно. Поле есть у ВСЕХ символов
 * за всю историю.
 *
 * ПОЧЕМУ ОТДЕЛЬНАЯ СЕРИЯ, А НЕ ПОЛЕ В КОРПУСЕ. Корпус читают движок, скрин и
 * инкубатор; менять тип Candle — значит трогать горячий путь и пересобирать
 * сотни мегабайт в git и в кэше облака. Параллельная серия (как funding/ и
 * metrics-1h/) ничего из этого не трогает, подключается загрузчиком по
 * времени бара и остаётся обратимой. Атом-условие появится ПОЗЖЕ и только
 * через пре-регистрацию — этот файл про данные, не про науку.
 *
 * Эти данные ВОССТАНОВИМЫ задним числом (архив не ревизуется), поэтому
 * бэкфилл разовый + ежедневная дозаливка хвоста в collect.ts. Формат строки:
 * time,volume,takerBuyVolume — общий объём пишем рядом намеренно: серия
 * самодостаточна для отношения покупок и сверяема с корпусом побайтово.
 *
 * Запуск: npx tsx researcher/backfill-flow.ts [--symbols N] [--from 2019-09]
 * Каталог: env COLLECT_DIR → <dir>/flow-1h/SYMBOL.csv.gz
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listUniverse } from "./corpus.ts";

const BULK = "https://data.binance.vision/data/futures/um/monthly/klines";
/** Раньше сентября 2019 фьючерсных клайнов нет даже у BTCUSDT. */
const FIRST_MONTH = "2019-09";
const CONCURRENCY = 6;

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

/** Список месяцев YYYY-MM от `from` до текущего включительно. */
export function monthsSince(from: string, now = new Date()): string[] {
  const [fy, fm] = from.split("-").map(Number);
  const out: string[] = [];
  let y = fy;
  let m = fm;
  while (y < now.getUTCFullYear() || (y === now.getUTCFullYear() && m <= now.getUTCMonth() + 1)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/**
 * CSV клайнов → строки «ISO,volume,takerBuy».
 *
 * У части архивов первая строка — заголовок (open_time,...), у части его нет;
 * различаем по числовому виду первого поля, как в backfill-funding. Время в
 * архиве — миллисекунды эпохи; с 2025 года встречаются МИКРОсекунды (16
 * знаков) — нормализуем по величине, а не по вере в формат.
 */
export function parseKlinesCsv(csv: string): string[] {
  const out: string[] = [];
  for (const line of csv.trim().split("\n")) {
    const parts = line.split(",");
    if (parts.length < 10) continue;
    const rawTime = Number(parts[0]);
    if (!Number.isFinite(rawTime)) continue; // заголовок
    const ms = rawTime > 1e14 ? rawTime / 1000 : rawTime; // микросекунды → мс
    const volume = Number(parts[5]);
    const takerBuy = Number(parts[9]);
    if (!Number.isFinite(volume) || !Number.isFinite(takerBuy)) continue;
    out.push(`${new Date(ms).toISOString()},${parts[5]},${parts[9]}`);
  }
  return out;
}

/** Слить новые строки с существующими: по времени, без дублей, отсортированно. */
export function mergeRows(existing: readonly string[], fresh: readonly string[]): string[] {
  const known = new Set(existing.map((l) => l.split(",")[0]));
  const add = fresh.filter((l) => !known.has(l.split(",")[0]));
  return [...existing, ...add].sort();
}

export const HEADER = "time,volume,takerBuyVolume";

/**
 * Серия хранится СЖАТОЙ (.csv.gz): ~360 символов по ~60 тыс. часов — это
 * полгигабайта голого CSV в git-репо данных; gzip даёт ~5×. Загрузчики
 * проекта уже предпочитают .csv.gz голому .csv (см. metricsCsv) — формат
 * согласован заранее, а не вдогонку.
 */
export function readSeries(path: string): string[] {
  if (!existsSync(path)) return [];
  const text = gunzipSync(readFileSync(path)).toString("utf8");
  return text.trim().split("\n").slice(1);
}

export function writeSeries(path: string, rows: readonly string[]): void {
  writeFileSync(path, gzipSync(`${HEADER}\n${rows.join("\n")}\n`));
}

async function main(): Promise<void> {
  const dir = join(
    process.env.COLLECT_DIR ?? join(process.env.HOME ?? "", ".chartlab", "data-repo", "market"),
    "flow-1h",
  );
  mkdirSync(dir, { recursive: true });
  const limit = Number(arg("symbols", "0"));
  const months = monthsSince(arg("from", FIRST_MONTH));
  const universe = listUniverse("1h");
  const symbols = limit > 0 ? universe.slice(0, limit) : universe;
  const scratch = join(tmpdir(), "flow-backfill");
  mkdirSync(scratch, { recursive: true });

  let done = 0;
  let withData = 0;
  let rowsTotal = 0;

  const worker = async (symbol: string) => {
    const outPath = join(dir, `${symbol}.csv.gz`);
    const existing = readSeries(outPath);
    const known = new Set(existing.map((l) => l.split(",")[0]));
    const fresh: string[] = [];
    for (const month of months) {
      // Идемпотентность помесячно: если ПОСЛЕДНИЙ час месяца уже есть, месяц
      // скачан целиком (архив месяцами не ревизуется) — пропускаем без сети.
      const lastHour = new Date(`${month}-01T00:00:00Z`);
      lastHour.setUTCMonth(lastHour.getUTCMonth() + 1);
      lastHour.setUTCHours(lastHour.getUTCHours() - 1);
      if (known.has(lastHour.toISOString())) continue;
      const zip = join(scratch, `${symbol}-${month}.zip`);
      try {
        const res = await fetch(`${BULK}/${symbol}/1h/${symbol}-1h-${month}.zip`, {
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) continue; // 404 — символа тогда ещё не было
        writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
        const csv = execFileSync("unzip", ["-p", zip], { maxBuffer: 64 * 1024 * 1024 }).toString();
        for (const row of parseKlinesCsv(csv)) {
          if (!known.has(row.split(",")[0])) fresh.push(row);
        }
      } catch {
        // сеть моргнула — месяц догрузится при следующем запуске
      } finally {
        rmSync(zip, { force: true });
      }
    }
    if (fresh.length > 0) {
      writeSeries(outPath, mergeRows(existing, fresh));
      withData += 1;
      rowsTotal += fresh.length;
    }
    done += 1;
    if (done % 25 === 0) console.error(`  ${done}/${symbols.length} символов…`);
  };

  const queue = [...symbols];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        const s = queue.shift();
        if (!s) return;
        await worker(s);
      }
    }),
  );
  console.error(
    `поток: ${symbols.length} символов, дозаписано у ${withData}, строк ${rowsTotal}`,
  );
}

const isMain = process.argv[1]?.endsWith("backfill-flow.ts");
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
