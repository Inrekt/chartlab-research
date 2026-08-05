/**
 * Бэкфилл истории futures-метрик Binance: открытый интерес, лонг/шорт
 * соотношения, тейкерский поток. data.binance.vision отдаёт это бесплатно
 * дневными zip: BTC с 2020-09, альты — с даты листинга (проверено руками
 * 2026-08-05; помесячных архивов нет — только daily).
 *
 * Сборщики collect.ts копят те же метрики «вперёд» с 31.07.2026 сырыми
 * 5-минутками. Здесь история агрегируется сразу в ЧАСЫ: сырые 5m за 4-6 лет ×
 * 170 монет — это ~25 ГБ ради данных, которые движок всё равно ест часами.
 *
 * Агрегация (зафиксировано, менять только с пере-бэкфиллом):
 * - oi, oiValue — ПОСЛЕДНЕЕ значение часа (это уровень, а не поток);
 * - все ratio — СРЕДНЕЕ по сэмплам часа (12 пятиминуток сглаживают шум);
 * - дубли сэмплов (в архивах Binance встречаются повторы строк) схлопываются
 *   по точному времени сэмпла ДО агрегации, иначе среднее смещается.
 *
 * Каталог: env COLLECT_DIR (по умолчанию ~/.chartlab/data-repo/market),
 * подкаталог metrics-1h. Идемпотентен: возобновляется с последнего ПОЛНОГО
 * дня (день считается полным, если в файле есть его час 23:00) — хвост
 * пересчитывается заново, уже скачанное не перекачивается.
 *
 * Запуск: npx tsx researcher/backfill-metrics.ts [--limit N] [--concurrency 8]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listUniverse } from "./corpus.ts";

const LIST = "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision";
const BULK = "https://data.binance.vision/data/futures/um/daily/metrics";

/** Выходные колонки. Имена Binance (count_/sum_) — артефакты их выгрузки:
 * count_toptrader_* — соотношение по АККАУНТАМ топ-трейдеров,
 * sum_toptrader_* — по ПОЗИЦИЯМ, count_long_short_ratio — глобальное по
 * аккаунтам, sum_taker_* — buy/sell объём тейкеров. Здесь — говорящие имена. */
export const HEADER = "time,oi,oiValue,topLsAccounts,topLsPositions,globalLsAccounts,takerBuySellVol";

export interface MetricSample {
  /** Время сэмпла, мс UTC. */
  time: number;
  oi: number;
  oiValue: number;
  topLsAccounts: number;
  topLsPositions: number;
  globalLsAccounts: number;
  takerBuySellVol: number;
}

/** Разбирает дневной CSV Binance; битые строки пропускает. */
export function parseMetricsCsv(csv: string): MetricSample[] {
  const out: MetricSample[] = [];
  const lines = csv.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length < 8) continue;
    // Время в архивах без зоны — это UTC.
    const time = Date.parse(cols[0].replace(" ", "T") + "Z");
    const vals = cols.slice(2, 8).map(Number);
    if (!Number.isFinite(time) || vals.some((v) => !Number.isFinite(v))) continue;
    out.push({
      time,
      oi: vals[0],
      oiValue: vals[1],
      topLsAccounts: vals[2],
      topLsPositions: vals[3],
      globalLsAccounts: vals[4],
      takerBuySellVol: vals[5],
    });
  }
  return out;
}

const hourIso = (ms: number): string => {
  const d = new Date(ms);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString().slice(0, 13) + ":00:00Z";
};

/** Схлопывает сэмплы в часовые строки CSV (без шапки), сортированные по времени. */
export function aggregateHourly(samples: readonly MetricSample[]): string[] {
  // Дубли по точному времени сэмпла — последний выигрывает.
  const bySample = new Map<number, MetricSample>();
  for (const s of samples) bySample.set(s.time, s);

  interface Bucket {
    lastTime: number;
    oi: number;
    oiValue: number;
    sums: [number, number, number, number];
    n: number;
  }
  const buckets = new Map<string, Bucket>();
  for (const s of bySample.values()) {
    const key = hourIso(s.time);
    let b = buckets.get(key);
    if (!b) {
      b = { lastTime: -1, oi: NaN, oiValue: NaN, sums: [0, 0, 0, 0], n: 0 };
      buckets.set(key, b);
    }
    if (s.time > b.lastTime) {
      b.lastTime = s.time;
      b.oi = s.oi;
      b.oiValue = s.oiValue;
    }
    b.sums[0] += s.topLsAccounts;
    b.sums[1] += s.topLsPositions;
    b.sums[2] += s.globalLsAccounts;
    b.sums[3] += s.takerBuySellVol;
    b.n += 1;
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, b]) => {
      const mean = b.sums.map((v) => (v / b.n).toFixed(8));
      return `${key},${b.oi},${b.oiValue},${mean[0]},${mean[1]},${mean[2]},${mean[3]}`;
    });
}

/** Все дневные zip-ключи символа через листинг S3 (с пагинацией). */
async function listKeys(symbol: string): Promise<string[]> {
  const prefix = `data/futures/um/daily/metrics/${symbol}/`;
  const keys: string[] = [];
  let marker = "";
  for (;;) {
    const url = `${LIST}?delimiter=/&prefix=${encodeURIComponent(prefix)}${
      marker ? `&marker=${encodeURIComponent(marker)}` : ""
    }`;
    const res = await fetch(url, { signal: AbortSignal.timeout(25_000) });
    if (!res.ok) throw new Error(`листинг ${symbol}: HTTP ${res.status}`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1]);
    const next = xml.match(/<NextMarker>([^<]+)<\/NextMarker>/);
    if (!next) break;
    marker = next[1];
  }
  return keys.filter((k) => k.endsWith(".zip"));
}

const keyDate = (key: string): string => key.slice(-14, -4); // ...-YYYY-MM-DD.zip

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) ? v : fallback;
}

async function main(): Promise<void> {
  const base =
    process.env.COLLECT_DIR ?? join(process.env.HOME ?? "", ".chartlab", "data-repo", "market");
  const dir = join(base, "metrics-1h");
  mkdirSync(dir, { recursive: true });
  const scratch = join(tmpdir(), "metrics-backfill");
  mkdirSync(scratch, { recursive: true });

  const limit = arg("limit", 0);
  const concurrency = arg("concurrency", 8);
  const universe = listUniverse("1h");
  const symbols = limit > 0 ? universe.slice(0, limit) : universe;

  let done = 0;
  let zipsTotal = 0;

  const worker = async (symbol: string): Promise<void> => {
    const outPath = join(dir, `${symbol}.csv`);
    const existing = existsSync(outPath)
      ? readFileSync(outPath, "utf8").trim().split("\n").slice(1)
      : [];

    // Возобновление с последнего ПОЛНОГО дня: день полон, если есть его 23:00.
    let lastFullDate = "";
    for (const row of existing) {
      if (row.slice(11, 13) === "23") {
        const d = row.slice(0, 10);
        if (d > lastFullDate) lastFullDate = d;
      }
    }

    // Сеть моргает (проверено: те же минуты, когда таймауты ловил и охотник
    // Oracle) — листинг повторяем, а не пропускаем символ целиком.
    let keys: string[] | null = null;
    for (let attempt = 1; attempt <= 3 && !keys; attempt++) {
      try {
        keys = (await listKeys(symbol)).filter((k) => keyDate(k) > lastFullDate);
      } catch (e) {
        if (attempt === 3) {
          console.log(`  ${symbol}: листинг не удался трижды (${(e as Error).message}) — пропуск`);
          return;
        }
        await new Promise((r) => setTimeout(r, 5_000 * attempt));
      }
    }
    if (!keys) return;

    const samples: MetricSample[] = [];
    for (const key of keys) {
      const zip = join(scratch, key.split("/").at(-1)!);
      try {
        const res = await fetch(`https://data.binance.vision/${key}`, {
          signal: AbortSignal.timeout(25_000),
        });
        if (!res.ok) continue;
        writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
        samples.push(
          ...parseMetricsCsv(
            execFileSync("unzip", ["-p", zip], { maxBuffer: 64 * 1024 * 1024 }).toString(),
          ),
        );
        zipsTotal += 1;
      } catch {
        // сеть моргнула — день догрузится следующим запуском
      } finally {
        rmSync(zip, { force: true });
      }
    }

    if (samples.length > 0) {
      const fresh = aggregateHourly(samples);
      const freshFrom = fresh[0].slice(0, 13);
      // Хвост после lastFullDate пересчитан заново — старые строки этого
      // диапазона выбрасываются, иначе дубли.
      const kept = existing.filter((r) => r.slice(0, 13) < freshFrom);
      writeFileSync(outPath, HEADER + "\n" + [...kept, ...fresh].join("\n") + "\n");
    }
    done += 1;
    if (done % 10 === 0 || done === symbols.length) {
      console.log(`[${new Date().toISOString()}] ${done}/${symbols.length} символов, zip скачано ${zipsTotal}`);
    }
  };

  const queue = [...symbols];
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        const symbol = queue.shift();
        if (!symbol) return;
        await worker(symbol);
      }
    }),
  );
  console.log(`Готово: ${done} символов, ${zipsTotal} дневных архивов.`);
}

if (process.argv[1]?.endsWith("backfill-metrics.ts")) {
  void main();
}
