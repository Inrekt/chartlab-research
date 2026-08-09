/**
 * Событийный слой, фундамент (дополнение к learning-machine-v3 от 2026-08-07).
 *
 * Режимы:
 *   lifespans               — времена жизни ВСЕХ когда-либо существовавших
 *                             перпов из S3-листинга архива Binance (включая
 *                             делистнутые: SRMUSDT, FTTUSDT...). Чинит
 *                             survivorship: вселенная «живые на дату t».
 *   announcements --backfill — архив анонсов Binance (листинги 48 /
 *                             делистинги 161) через bapi, с PIT-меткой
 *                             releaseDate. Эндпоинт неофициальный — окно
 *                             возможности, сырой JSON храним вечно.
 *   announcements           — форвард-режим: первая страница обоих каталогов.
 *   exchange-snapshot       — дневной снимок exchangeInfo (onboardDate,
 *                             status, фильтры). Календарное время
 *                             невосполнимо: ревизии видны только снапшотам.
 *
 * Разлоки токенов: DefiLlama emissions ушёл в платный тир (проверено
 * 2026-08-07, вопреки ресёрчу) — источник ищется отдельно, семейство
 * unlock-short ждёт данных.
 *
 * Запуск: npx tsx researcher/collect-events.ts <режим>
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const DIR = process.env.COLLECT_DIR ?? join(process.env.HOME ?? "", ".chartlab", "data-repo", "market");
const S3 = "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision";
const KLINES_PREFIX = "data/futures/um/monthly/klines/";
const BAPI = "https://www.binance.com/bapi/apex/v1/public/apex/cms/article/list/query";
/** 48 — New Cryptocurrency Listing, 161 — Delisting. */
const CATALOGS = [48, 161] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

/** Все ключи S3 по префиксу (маркерная пагинация). */
async function listKeys(prefix: string, delimiter = ""): Promise<string[]> {
  const out: string[] = [];
  let marker = "";
  for (;;) {
    const url = `${S3}?prefix=${encodeURIComponent(prefix)}${delimiter ? `&delimiter=${delimiter}` : ""}${marker ? `&marker=${encodeURIComponent(marker)}` : ""}`;
    const xml = await fetchText(url);
    const tag = delimiter ? /<Prefix>([^<]+)<\/Prefix>/g : /<Key>([^<]+)<\/Key>/g;
    const found = [...xml.matchAll(tag)].map((m) => m[1]).filter((k) => k !== prefix);
    out.push(...found);
    if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) return out;
    const next = xml.match(/<NextMarker>([^<]+)<\/NextMarker>/)?.[1] ?? found.at(-1);
    if (!next || next === marker) return out;
    marker = next;
  }
}

/** Первый и последний месяц архива каждого перпа, когда-либо существовавшего. */
async function runLifespans(): Promise<void> {
  const prefixes = await listKeys(KLINES_PREFIX, "/");
  const symbols = prefixes
    .map((p) => p.slice(KLINES_PREFIX.length).replace(/\/$/, ""))
    .filter(Boolean);
  console.log(`символов в архиве Binance: ${symbols.length}`);

  const lifespans: Record<string, { firstMonth: string; lastMonth: string; months: number }> = {};
  let done = 0;
  for (const symbol of symbols) {
    // 1m — самый ранний интервал у любого символа; месячные файлы вида
    // SYMBOL-1m-YYYY-MM.zip. Берём только .zip (без .CHECKSUM).
    const keys = (await listKeys(`${KLINES_PREFIX}${symbol}/1m/`)).filter((k) => k.endsWith(".zip"));
    const months = keys
      .map((k) => k.match(/-(\d{4}-\d{2})\.zip$/)?.[1])
      .filter((m): m is string => Boolean(m))
      .sort();
    if (months.length > 0) {
      lifespans[symbol] = {
        firstMonth: months[0],
        lastMonth: months[months.length - 1],
        months: months.length,
      };
    }
    done++;
    if (done % 100 === 0) console.log(`  …${done}/${symbols.length}`);
    await sleep(60);
  }

  const outDir = join(DIR, "..", "universe");
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, "perp-lifespans.json");
  writeFileSync(
    path,
    JSON.stringify({ generatedAt: new Date().toISOString(), source: "s3 monthly klines", lifespans }, null, 1),
  );
  const dead = Object.values(lifespans).filter(
    (l) => l.lastMonth < new Date(Date.now() - 90 * 86400e3).toISOString().slice(0, 7),
  ).length;
  console.log(`готово: ${Object.keys(lifespans).length} перпов, из них умерших (архив кончился >90д назад): ${dead}`);
  console.log(`записано: ${path}`);
}

interface Article {
  id: number;
  code: string;
  title: string;
  releaseDate: number;
  catalogId: number;
}

async function fetchCatalogPage(catalogId: number, pageNo: number): Promise<{ articles: Article[]; total: number }> {
  const raw = await fetchText(`${BAPI}?type=1&pageNo=${pageNo}&pageSize=20&catalogId=${catalogId}`);
  const parsed = JSON.parse(raw);
  const cat = parsed?.data?.catalogs?.[0];
  const articles = (cat?.articles ?? []).map((a: Record<string, unknown>) => ({
    id: a.id,
    code: a.code,
    title: a.title,
    releaseDate: a.releaseDate,
    catalogId,
  }));
  return { articles, total: Number(cat?.total ?? 0) };
}

/** Append-only JSONL с дедупом по id — PIT-архив анонсов. */
async function runAnnouncements(backfill: boolean): Promise<void> {
  const outDir = join(DIR, "events");
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, "binance-announcements.jsonl");
  const known = new Set<number>(
    existsSync(path)
      ? readFileSync(path, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l).id as number)
      : [],
  );

  let added = 0;
  for (const catalogId of CATALOGS) {
    const first = await fetchCatalogPage(catalogId, 1);
    const pages = backfill ? Math.ceil(first.total / 20) : 1;
    for (let page = 1; page <= pages; page++) {
      const { articles } = page === 1 ? first : await fetchCatalogPage(catalogId, page);
      for (const a of articles) {
        if (known.has(a.id)) continue;
        known.add(a.id);
        appendFileSync(path, JSON.stringify({ ...a, fetchedAt: new Date().toISOString() }) + "\n");
        added++;
      }
      // WAF терпим к жилым IP при вежливом темпе; с раннеров может резать.
      if (page < pages) await sleep(2500);
    }
  }
  console.log(`анонсы: +${added} новых, всего в архиве ${known.size}`);
}

/** Дневной снимок exchangeInfo: onboardDate, status, deliveryDate, фильтры. */
async function runExchangeSnapshot(): Promise<void> {
  const raw = await fetchText("https://fapi.binance.com/fapi/v1/exchangeInfo");
  const outDir = join(DIR, "snapshots", "exchangeInfo");
  mkdirSync(outDir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const path = join(outDir, `${day}.json.gz`);
  writeFileSync(path, gzipSync(raw));
  const parsed = JSON.parse(raw);
  console.log(`exchangeInfo: ${parsed.symbols.length} символов → ${path}`);
}

/**
 * Постоянная блокировка не должна тонуть в `continue-on-error`.
 *
 * Шаги сбора умышленно не роняют воркфлоу: bapi Binance регулярно отвечает
 * WAF, и терять из-за этого уже собранное нельзя. Но у той же поблажки есть
 * цена — 451 (закрыто по юрисдикции) выглядит точно так же, и снимок состава
 * биржи молча не собирался, пока воркфлоу рапортовал успех. За 2026-08-08
 * срез потерян НАВСЕГДА: точка во времени задним числом не снимается.
 *
 * `::warning::` попадает в сводку прогона, не роняя его: временный сбой
 * по-прежнему прощается, постоянный виден.
 */
async function run(mode: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const text = String(error);
    if (/\b(451|403)\b/.test(text)) {
      console.log(
        `::warning title=Источник закрыт по юрисдикции::${mode}: ${text.split("\n")[0]} — ` +
          "это НЕ временный сбой, ретраи не помогут. Форвардный срез за сегодня потерян " +
          "безвозвратно. Собирать с машины, откуда биржа доступна (см. RUNBOOK, раздел про среду).",
      );
      return;
    }
    throw error;
  }
}

const mode = process.argv[2];
if (mode === "lifespans") await run(mode, runLifespans);
else if (mode === "announcements") {
  await run(mode, () => runAnnouncements(process.argv.includes("--backfill")));
} else if (mode === "exchange-snapshot") await run(mode, runExchangeSnapshot);
else {
  console.error("режимы: lifespans | announcements [--backfill] | exchange-snapshot");
  process.exit(1);
}
