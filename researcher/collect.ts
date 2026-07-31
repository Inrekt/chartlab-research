/**
 * Ежесуточный сборщик НЕВОССТАНОВИМЫХ данных.
 *
 * Принцип отбора: сюда входит только то, что нельзя купить/скачать задним
 * числом. Открытый интерес и лонг/шорт-соотношения Binance живут в API 30
 * дней; опционная поверхность Deribit — только текущий срез; Fear&Greed и
 * макро-ряды FRED восстановимы, но копеечны — берём заодно, чтобы бэктесты
 * не зависели от чужого аптайма. Funding сюда НЕ входит: его история
 * полная и не сгорает — бэкфилл отдельным разовым скриптом.
 *
 * Гео: раннеры GitHub — US, api.binance.com/fapi отдают 451. Поэтому метрики
 * идут через bulk-зеркало data.binance.vision (CDN, доступен отовсюду,
 * дневные ZIP-CSV с ~конца 2021 — заодно это и бэкфилл). Deribit может быть
 * закрыт с части локаций — источник обёрнут в мягкий пропуск с пометкой в
 * сводке; постоянный дом для него — раннер во Франкфурте.
 *
 * Каждый источник независим: упал один — остальные собираются, ошибка
 * попадает в сводку. Полный провал всех источников = ненулевой выход.
 *
 * Запуск: npx tsx researcher/collect.ts [--date YYYY-MM-DD] [--symbols N]
 * Каталог: env COLLECT_DIR (в облаке — data/market приватного репо).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listUniverse } from "./corpus.ts";

const VISION = "https://data.binance.vision/data/futures/um/daily/metrics";
const DERIBIT = "https://www.deribit.com/api/v2/public";
const FRED_SERIES = [
  "DGS2", "DGS10", "T10Y2Y", "VIXCLS", "DTWEXBGS", "BAMLH0A0HYM2", "DFF", "RRPONTSYD", "WALCL",
] as const;

export interface SourceReport {
  source: string;
  ok: boolean;
  detail: string;
}

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

/**
 * Bulk-файлы выкладываются с лагом: вчерашний днём ещё может отсутствовать
 * (проверено: D-1 → 404, D-2 → 200). Поэтому по умолчанию собираем ДВА дня —
 * позавчера (гарантированно есть) и вчера (если уже выложен); дедуп по
 * времени делает повторную подачу бесплатной, пропусков не бывает.
 */
function defaultDates(): string[] {
  const day = (back: number) => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
  return [day(2), day(1)];
}

async function fetchOk(url: string, timeoutMs = 30_000): Promise<Response> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res;
}

/**
 * Дневной CSV метрик (5-минутные строки) → почасовые срезы «последнее
 * значение часа». Для 1h/4h-стратегий этого достаточно, а журнал в git не
 * разбухает (24 строки/день/символ вместо 288).
 */
export function hourlyLastRows(csv: string): string[] {
  const lines = csv.trim().split("\n");
  if (lines.length < 2) return [];
  const header = lines[0];
  const tsCol = header.split(",").findIndex((c) => c.trim() === "create_time");
  if (tsCol < 0) throw new Error(`нет колонки create_time: ${header}`);
  const lastOfHour = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const ts = line.split(",")[tsCol]?.trim();
    if (!ts) continue;
    const hour = ts.slice(0, 13); // YYYY-MM-DD HH
    lastOfHour.set(hour, line); // строки идут по времени — последняя победит
  }
  return [...lastOfHour.keys()].sort().map((h) => lastOfHour.get(h)!);
}

/** Дописывает строки в CSV с дедупликацией по первому полю-времени. */
export function appendCsvRows(path: string, header: string, rows: string[]): number {
  let existingKeys = new Set<string>();
  if (existsSync(path)) {
    const lines = readFileSync(path, "utf8").trim().split("\n").slice(1);
    existingKeys = new Set(lines.map((l) => l.split(",")[0]));
  } else {
    writeFileSync(path, header + "\n");
  }
  const fresh = rows.filter((r) => !existingKeys.has(r.split(",")[0]));
  if (fresh.length > 0) appendFileSync(path, fresh.join("\n") + "\n");
  return fresh.length;
}

async function collectBinanceMetrics(dir: string, date: string, symbols: string[]): Promise<SourceReport> {
  const outDir = join(dir, "binance-metrics");
  mkdirSync(outDir, { recursive: true });
  const scratch = join(tmpdir(), `metrics-${date}`);
  mkdirSync(scratch, { recursive: true });
  let okCount = 0;
  let missing = 0;
  let appended = 0;
  const errors: string[] = [];

  const worker = async (symbol: string) => {
    const zipPath = join(scratch, `${symbol}.zip`);
    try {
      const res = await fetch(`${VISION}/${symbol}/${symbol}-metrics-${date}.zip`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 404) {
        missing += 1; // молодой листинг/делистинг — не ошибка
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
      const csv = execFileSync("unzip", ["-p", zipPath], { maxBuffer: 64 * 1024 * 1024 }).toString();
      const rows = hourlyLastRows(csv);
      const header = csv.split("\n")[0].trim();
      appended += appendCsvRows(join(outDir, `${symbol}.csv`), header, rows);
      okCount += 1;
    } catch (e) {
      errors.push(`${symbol}: ${(e as Error).message}`);
    } finally {
      rmSync(zipPath, { force: true });
    }
  };

  // умеренная конкурентность — CDN щадящий, но нам спешить некуда
  const queue = [...symbols];
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (queue.length > 0) await worker(queue.pop()!);
    }),
  );
  rmSync(scratch, { recursive: true, force: true });

  const ok = okCount > 0;
  return {
    source: "binance-metrics",
    ok,
    detail: `${date}: символов ${okCount}/${symbols.length}, новых строк ${appended}, нет файла ${missing}` +
      (errors.length > 0 ? `, ошибок ${errors.length} (${errors.slice(0, 3).join("; ")})` : ""),
  };
}

async function collectDeribit(dir: string, date: string): Promise<SourceReport> {
  const outDir = join(dir, "deribit");
  mkdirSync(join(outDir, "surface"), { recursive: true });
  const details: string[] = [];
  let anyOk = false;
  for (const ccy of ["BTC", "ETH"]) {
    // DVOL — дневные точки за последние 7 дней (дедуп докроет пропуски)
    try {
      const end = Date.now();
      const start = end - 7 * 86_400_000;
      const res = await fetchOk(
        `${DERIBIT}/get_volatility_index_data?currency=${ccy}&start_timestamp=${start}&end_timestamp=${end}&resolution=1D`,
        15_000,
      );
      const body = (await res.json()) as { result?: { data?: [number, number, number, number, number][] } };
      const rows = (body.result?.data ?? []).map(
        ([ts, open, high, low, close]) =>
          `${new Date(ts).toISOString().slice(0, 10)},${open},${high},${low},${close}`,
      );
      const added = appendCsvRows(join(outDir, `dvol-${ccy}.csv`), "date,open,high,low,close", rows);
      details.push(`DVOL ${ccy}: +${added}`);
      anyOk = true;
    } catch (e) {
      details.push(`DVOL ${ccy}: ${(e as Error).message}`);
    }
    // Срез опционной поверхности — то, чего задним числом не купить вообще
    try {
      const res = await fetchOk(`${DERIBIT}/get_book_summary_by_currency?currency=${ccy}&kind=option`, 20_000);
      const body = await res.text();
      writeFileSync(join(outDir, "surface", `${date}-${ccy}.json.gz`), gzipSync(body));
      details.push(`surface ${ccy}: ok`);
      anyOk = true;
    } catch (e) {
      details.push(`surface ${ccy}: ${(e as Error).message}`);
    }
  }
  return { source: "deribit", ok: anyOk, detail: details.join(" · ") };
}

async function collectFearGreed(dir: string): Promise<SourceReport> {
  const res = await fetchOk("https://api.alternative.me/fng/?limit=0&format=json", 20_000);
  const body = (await res.json()) as { data?: { value: string; value_classification: string; timestamp: string }[] };
  const rows = (body.data ?? [])
    .map((d) => `${new Date(Number(d.timestamp) * 1000).toISOString().slice(0, 10)},${d.value},${d.value_classification.replaceAll(",", " ")}`)
    .sort();
  mkdirSync(join(dir, "sentiment"), { recursive: true });
  // полная история маленькая — честная перезапись, никакого дрейфа дедупа
  writeFileSync(join(dir, "sentiment", "fear-greed.csv"), "date,value,label\n" + rows.join("\n") + "\n");
  return { source: "fear-greed", ok: rows.length > 0, detail: `строк ${rows.length}` };
}

async function collectFred(dir: string): Promise<SourceReport> {
  mkdirSync(join(dir, "macro"), { recursive: true });
  let ok = 0;
  const errors: string[] = [];
  for (const id of FRED_SERIES) {
    try {
      const res = await fetchOk(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`, 20_000);
      writeFileSync(join(dir, "macro", `${id}.csv`), await res.text());
      ok += 1;
    } catch (e) {
      errors.push(`${id}: ${(e as Error).message}`);
    }
  }
  return {
    source: "fred",
    ok: ok > 0,
    detail: `рядов ${ok}/${FRED_SERIES.length}` + (errors.length > 0 ? ` (${errors.join("; ")})` : ""),
  };
}

function snapshotUniverse(dir: string, date: string, symbols: string[]): SourceReport {
  // Состав вселенной на дату — лечит ошибку выжившего задним числом
  mkdirSync(join(dir, "universe"), { recursive: true });
  writeFileSync(
    join(dir, "universe", `${date}.json`),
    JSON.stringify({ date, source: "corpus-1h", count: symbols.length, symbols }, null, 0) + "\n",
  );
  return { source: "universe", ok: true, detail: `символов ${symbols.length}` };
}

async function main(): Promise<void> {
  const dir = process.env.COLLECT_DIR ?? join(process.env.HOME ?? "", ".chartlab", "data-repo", "market");
  const explicit = arg("date", "");
  const dates = explicit !== "" ? [explicit] : defaultDates();
  const limit = Number(arg("symbols", "0"));
  mkdirSync(dir, { recursive: true });

  const universe = listUniverse("1h");
  const symbols = limit > 0 ? universe.slice(0, limit) : universe;

  const reports: SourceReport[] = [];
  for (const date of dates) reports.push(await collectBinanceMetrics(dir, date, symbols));
  reports.push(await collectDeribit(dir, dates.at(-1)!));
  reports.push(await collectFearGreed(dir).catch((e) => ({ source: "fear-greed", ok: false, detail: String(e) })));
  reports.push(await collectFred(dir).catch((e) => ({ source: "fred", ok: false, detail: String(e) })));
  reports.push(snapshotUniverse(dir, dates.at(-1)!, universe));

  for (const r of reports) console.error(`${r.ok ? "✓" : "✗"} ${r.source}: ${r.detail}`);
  console.log(JSON.stringify({ dates, dir, reports }));
  if (!reports.some((r) => r.ok)) process.exit(1); // полный провал — сигнал наружу
}

const isMain = process.argv[1]?.endsWith("collect.ts");
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
