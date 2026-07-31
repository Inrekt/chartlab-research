/**
 * Разовый бэкфилл истории ставок фандинга.
 *
 * Фандинг — единственная деривативная величина, которую МОЖНО получить
 * задним числом: Binance выкладывает помесячные архивы с 2020-01, и они не
 * ревизуются. Поэтому её нет в ежесуточном сборщике (там только то, что
 * сгорает) — она берётся один раз и целиком.
 *
 * Зачем: ставка фандинга — это цена, которую перегруженная сторона платит
 * противоположной, то есть прямое измерение того самого контрагента, чья
 * вынужденность лежит в основе семейства «ликвидити-магнит» и будущего
 * «funding-carry». Без неё второе проверяемое предсказание («эффект сильнее
 * там, где плечо перегружено») нечем проверить.
 *
 * Запуск: npx tsx researcher/backfill-funding.ts [--symbols N] [--from 2020-01]
 * Каталог: env COLLECT_DIR (в облаке — data/market приватного репо).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listUniverse } from "./corpus.ts";

const BULK = "https://data.binance.vision/data/futures/um/monthly/fundingRate";
/** Раньше этого месяца помесячных архивов нет даже у BTCUSDT. */
const FIRST_MONTH = "2020-01";

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
  const lastY = now.getUTCFullYear();
  const lastM = now.getUTCMonth() + 1;
  while (y < lastY || (y === lastY && m <= lastM)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/** Строки CSV → «время,ставка», отсортированные и без заголовка. */
export function parseFundingCsv(csv: string): string[] {
  const lines = csv.trim().split("\n");
  if (lines.length === 0) return [];
  const header = lines[0].toLowerCase();
  const hasHeader = header.includes("calc_time") || header.includes("funding");
  const cols = hasHeader ? header.split(",").map((c) => c.trim()) : [];
  const timeIdx = hasHeader ? cols.findIndex((c) => c.includes("time")) : 0;
  const rateIdx = hasHeader ? cols.findIndex((c) => c.includes("rate")) : 2;
  const out: string[] = [];
  for (const line of lines.slice(hasHeader ? 1 : 0)) {
    const parts = line.split(",");
    const rawTime = parts[timeIdx >= 0 ? timeIdx : 0]?.trim();
    const rate = parts[rateIdx >= 0 ? rateIdx : 2]?.trim();
    if (!rawTime || rate === undefined) continue;
    // время бывает в миллисекундах эпохи либо уже строкой даты
    const ms = Number(rawTime);
    const iso = Number.isFinite(ms) && ms > 1e11
      ? new Date(ms).toISOString()
      : new Date(rawTime.replace(" ", "T") + "Z").toISOString();
    if (iso === "Invalid Date") continue;
    out.push(`${iso},${rate}`);
  }
  return out;
}

async function main(): Promise<void> {
  const dir = join(
    process.env.COLLECT_DIR ?? join(process.env.HOME ?? "", ".chartlab", "data-repo", "market"),
    "funding",
  );
  mkdirSync(dir, { recursive: true });
  const limit = Number(arg("symbols", "0"));
  const months = monthsSince(arg("from", FIRST_MONTH));
  const universe = listUniverse("1h");
  const symbols = limit > 0 ? universe.slice(0, limit) : universe;
  const scratch = join(tmpdir(), "funding-backfill");
  mkdirSync(scratch, { recursive: true });

  let done = 0;
  let withData = 0;
  let rowsTotal = 0;

  const worker = async (symbol: string) => {
    const outPath = join(dir, `${symbol}.csv`);
    // Уже скачанное не трогаем: бэкфилл идемпотентен и досогружаем.
    const known = new Set<string>(
      existsSync(outPath)
        ? readFileSync(outPath, "utf8").trim().split("\n").slice(1).map((l) => l.split(",")[0])
        : [],
    );
    const rows: string[] = [];
    for (const month of months) {
      const zip = join(scratch, `${symbol}-${month}.zip`);
      try {
        const res = await fetch(`${BULK}/${symbol}/${symbol}-fundingRate-${month}.zip`, {
          signal: AbortSignal.timeout(25_000),
        });
        if (res.status === 404) continue; // символа тогда ещё не было
        if (!res.ok) continue;
        writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
        const csv = execFileSync("unzip", ["-p", zip], { maxBuffer: 32 * 1024 * 1024 }).toString();
        for (const row of parseFundingCsv(csv)) {
          if (!known.has(row.split(",")[0])) rows.push(row);
        }
      } catch {
        // сеть моргнула — этот месяц догрузится при следующем запуске
      } finally {
        rmSync(zip, { force: true });
      }
    }
    if (rows.length > 0) {
      const existing = existsSync(outPath)
        ? readFileSync(outPath, "utf8").trim().split("\n").slice(1)
        : [];
      const all = [...existing, ...rows].sort();
      writeFileSync(outPath, "time,fundingRate\n" + all.join("\n") + "\n");
      withData += 1;
      rowsTotal += rows.length;
    }
    done += 1;
    if (done % 20 === 0) console.error(`  ${done}/${symbols.length} символов…`);
  };

  const queue = [...symbols];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (queue.length > 0) await worker(queue.pop()!);
    }),
  );
  rmSync(scratch, { recursive: true, force: true });
  console.log(
    JSON.stringify({
      dir,
      месяцев: months.length,
      символов: symbols.length,
      "с данными": withData,
      "новых строк": rowsTotal,
    }),
  );
}

const isMain = process.argv[1]?.endsWith("backfill-funding.ts");
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
