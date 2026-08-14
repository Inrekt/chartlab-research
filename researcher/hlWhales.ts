/**
 * Форвардный архив позиций китов Hyperliquid.
 *
 * ЗАЧЕМ ЭТО ВООБЩЕ СУЩЕСТВУЕТ. Hyperliquid — единственная крупная площадка, где
 * позиции видны поимённо: размер, плечо, цена входа и ЦЕНА ЛИКВИДАЦИИ каждого
 * кошелька. Цена ликвидации — это не мнение и не индикатор, это обязательство:
 * кит с плечом 10x на уровне X обязан выйти, когда цена дойдёт до X, и выйдет
 * не он, а движок биржи. Ровно тот «кто платит», которого требует пре-регистрация.
 *
 * И этих данных НЕТ ЗАДНИМ ЧИСЛОМ. API отдаёт только текущий срез: истории
 * позиций не существует ни в самом API, ни в архивах. Каждый несобранный час
 * исчезает навсегда — поэтому сборщик пишет с сегодняшнего дня, ещё до того как
 * появится хоть одна гипотеза, которая эти данные попросит. Собирать широко
 * статистически бесплатно; проверять гипотезы — нет.
 *
 * ЧТО ПИШЕТСЯ: СЫРЫЕ позиции, а не агрегаты. Агрегат по монете (перевес лонгов,
 * карта скоплений ликвидаций) пересчитывается из сырья в любой момент и любым
 * способом; сырьё из агрегата не восстанавливается никогда. По той же причине
 * здесь НЕ применяется фильтр маркет-мейкеров: это решение анализа, и оно
 * обязано остаться обратимым. Признак двусторонней книги пишется отдельной
 * колонкой — фильтруй при чтении, если захочешь.
 *
 * ⚠️ ОШИБКА ВЫЖИВШЕГО, встроенная в источник. Вселенная кошельков отбирается по
 * лидерборду — то есть по прибыли, УЖЕ заработанной к моменту отбора. Кошелёк
 * попадает в выборку потому, что сегодня богат. Для механизма «принудительный
 * выход по ликвидации» это почти безвредно (нас интересует чужое обязательство,
 * а не чужая правота), но для любой гипотезы вида «повторяй за умными деньгами»
 * это смертельный дефект. Поэтому дата отбора вселенной И её критерии пишутся в
 * файл: будущий анализ обязан иметь возможность это учесть.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const INFO_URL = "https://api.hyperliquid.xyz/info";
const LEADERBOARD_URL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";

/** Лимит биржи — 1200 единиц веса в минуту на IP, запрос позиций весит 2. */
const SCAN_CONCURRENCY = 8;
const REQUEST_TIMEOUT_MS = 20_000;
/** Лидерборд — ~33 МБ JSON, качать его каждый час незачем и невежливо. */
const LEADERBOARD_TIMEOUT_MS = 120_000;

/**
 * Пороги вселенной совпадают с ботом владельца НАМЕРЕННО: там они выбраны не
 * от балды, а замером (scripts/quality.ts) — отбор только по размеру счёта
 * затаскивал убыточные кошельки с огромными позициями, их ставки гасили ставки
 * настоящих китов, и перекос схлопывался в ~2%.
 */
export const UNIVERSE_MIN_ACCOUNT_USD = 5_000_000;
export const UNIVERSE_MIN_PROFIT_USD = 5_000_000;
export const UNIVERSE_MAX_WALLETS = 400;

/**
 * Порог записи ниже боевого порога бота ($500k) намеренно: фильтр всегда можно
 * ужесточить при чтении, а недописанную строку не вернуть. $100k отсекает
 * хвост из тысяч мелочей, не трогая ничего, что способно двинуть цену.
 */
export const MIN_RECORDED_USD = 100_000;

export interface WhalePosition {
  readonly address: string;
  readonly coin: string;
  readonly isLong: boolean;
  readonly sizeUsd: number;
  readonly leverage: number;
  readonly entryPx: number;
  readonly liquidationPx: number | null;
  readonly markPx: number;
  readonly unrealizedPnl: number;
}

export interface UniverseCache {
  readonly day: string;
  readonly pickedAt: string;
  readonly minAccountUsd: number;
  readonly minProfitUsd: number;
  readonly maxWallets: number;
  readonly addresses: readonly string[];
}

function marketDir(): string {
  const base =
    process.env.COLLECT_DIR ?? join(process.env.HOME ?? homedir(), ".chartlab", "data-repo", "market");
  return join(base, "hl-whales");
}

export function universePath(): string {
  return join(marketDir(), "universe.json");
}

export function leaderboardPath(day: string): string {
  return join(marketDir(), "leaderboard", `${day}.json.gz`);
}

/**
 * Порог попадания в дневной снимок лидерборда.
 *
 * Полный лидерборд — 34 МБ и ~41 тыс. кошельков, писать его ежедневно в git
 * нельзя. Но резать по боевым порогам вселенной ($5M/$5M) — значит встроить
 * ошибку выжившего в сам архив: кит, потерявший половину счёта, выпал бы из
 * снимков РАНЬШЕ, чем его вынесло, и его агония осталась бы незаписанной.
 * Порог в $1M по ЛЮБОЙ из осей (счёт ИЛИ прибыль за всё время) держит в
 * кадре и растущих, и умирающих, при размере снимка в сотни килобайт.
 */
export const LEADERBOARD_SNAPSHOT_MIN_USD = 1_000_000;

export interface LeaderboardEntry {
  readonly address: string;
  readonly accountValue: number;
  readonly allTimePnl: number;
  readonly dayPnl: number;
}

export function snapshotWorthy(row: LeaderboardEntry): boolean {
  return (
    row.accountValue >= LEADERBOARD_SNAPSHOT_MIN_USD ||
    row.allTimePnl >= LEADERBOARD_SNAPSHOT_MIN_USD
  );
}

export function positionsPath(day: string): string {
  return join(marketDir(), "positions", `${day}.csv`);
}

export const CSV_HEADER =
  "ts,address,coin,side,sizeUsd,leverage,entryPx,liqPx,markPx,upnl,mmBook";

/** Строка архива. Числа не округляются: округление — тоже потеря, и необратимая. */
export function toCsvRow(ts: string, p: WhalePosition, mmBook: boolean): string {
  return [
    ts,
    p.address,
    p.coin,
    p.isLong ? "long" : "short",
    p.sizeUsd,
    p.leverage,
    p.entryPx,
    p.liquidationPx === null ? "" : p.liquidationPx,
    p.markPx,
    p.unrealizedPnl,
    mmBook ? "1" : "0",
  ].join(",");
}

/**
 * Двусторонняя книга — почерк маркет-мейкера: лонги и шорты сопоставимы по
 * объёму, значит это торговля спредом, а не ставка на направление. Считаем
 * ПРИЗНАК, но не выбрасываем строки: см. заголовок файла.
 */
export function isMarketMakerBook(positions: readonly WhalePosition[]): boolean {
  const big = positions.filter((p) => p.sizeUsd >= 500_000);
  if (big.length < 4) return false;
  const longUsd = big.filter((p) => p.isLong).reduce((sum, p) => sum + p.sizeUsd, 0);
  const shortUsd = big.filter((p) => !p.isLong).reduce((sum, p) => sum + p.sizeUsd, 0);
  const smaller = Math.min(longUsd, shortUsd);
  const larger = Math.max(longUsd, shortUsd);
  return larger > 0 && smaller / larger >= 0.6;
}

/** UTC-день среза. Файлы режутся по UTC, как и всё остальное в проекте. */
export function utcDay(iso: string): string {
  return iso.slice(0, 10);
}

/** Кэш вселенной протух, если он с другого дня — или его нет вовсе. */
export function universeIsStale(cache: UniverseCache | null, today: string): boolean {
  return cache === null || cache.day !== today;
}

interface RawWindowPerf {
  pnl: string;
}

interface RawLeaderboardRow {
  ethAddress: string;
  accountValue: string;
  windowPerformances: ReadonlyArray<readonly [string, RawWindowPerf]>;
}

interface RawAssetPosition {
  position: {
    coin: string;
    szi: string;
    entryPx: string | null;
    liquidationPx: string | null;
    positionValue: string;
    unrealizedPnl: string;
    leverage: { value: number };
  };
}

function windowPnl(row: RawLeaderboardRow, window: string): number {
  const entry = row.windowPerformances.find(([name]) => name === window);
  return entry ? Number(entry[1].pnl) : 0;
}

export function pickUniverse(
  rows: ReadonlyArray<{ address: string; accountValue: number; allTimePnl: number }>,
): string[] {
  return [...rows]
    .filter((r) => r.accountValue >= UNIVERSE_MIN_ACCOUNT_USD && r.allTimePnl >= UNIVERSE_MIN_PROFIT_USD)
    .sort((a, b) => b.allTimePnl - a.allTimePnl)
    .slice(0, UNIVERSE_MAX_WALLETS)
    .map((r) => r.address);
}

async function fetchLeaderboard(): Promise<LeaderboardEntry[]> {
  const res = await fetch(LEADERBOARD_URL, { signal: AbortSignal.timeout(LEADERBOARD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Лидерборд Hyperliquid: HTTP ${res.status}`);
  const raw = (await res.json()) as { leaderboardRows: RawLeaderboardRow[] };
  return raw.leaderboardRows.map((row) => ({
    address: row.ethAddress,
    accountValue: Number(row.accountValue),
    allTimePnl: windowPnl(row, "allTime"),
    dayPnl: windowPnl(row, "day"),
  }));
}

/**
 * Дневной снимок лидерборда — лечение ошибки выжившего ВПЕРЁД.
 *
 * Историю позиций кошелька можно достать только для адресов, которые известны
 * СЕГОДНЯ, а известны они из сегодняшнего лидерборда. Кит, которого вынесло в
 * прошлом году, из него выпал — и любая восстановленная задним числом панель
 * систематически лишена ровно тех китов, ради которых ликвидационные гипотезы
 * строятся. Снимок фиксирует состав на дату t; исчезновение кошелька из
 * будущих снимков — само по себе данные, и другого способа записать его нет.
 */
function snapshotLeaderboard(rows: readonly LeaderboardEntry[], nowIso: string): void {
  const path = leaderboardPath(utcDay(nowIso));
  if (existsSync(path)) return; // один снимок в день, первый выигрывает
  const kept = rows.filter(snapshotWorthy);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, gzipSync(JSON.stringify({ takenAt: nowIso, minUsd: LEADERBOARD_SNAPSHOT_MIN_USD, rows: kept })));
}

async function fetchPositions(address: string): Promise<WhalePosition[]> {
  const res = await fetch(INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "clearinghouseState", user: address }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`clearinghouseState ${address}: HTTP ${res.status}`);
  const state = (await res.json()) as { assetPositions: RawAssetPosition[] };
  return state.assetPositions.map(({ position }) => {
    const size = Number(position.szi);
    const sizeUsd = Number(position.positionValue);
    return {
      address,
      coin: position.coin,
      isLong: size > 0,
      sizeUsd,
      leverage: position.leverage.value,
      entryPx: position.entryPx === null ? 0 : Number(position.entryPx),
      liquidationPx: position.liquidationPx === null ? null : Number(position.liquidationPx),
      markPx: size === 0 ? 0 : sizeUsd / Math.abs(size),
      unrealizedPnl: Number(position.unrealizedPnl),
    };
  });
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<{ ok: R[]; failed: number }> {
  const ok: R[] = [];
  let failed = 0;
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const item = items[next++];
      if (item === undefined) continue;
      try {
        ok.push(await fn(item));
      } catch {
        failed += 1;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return { ok, failed };
}

function readUniverse(): UniverseCache | null {
  const path = universePath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as UniverseCache;
  } catch {
    return null;
  }
}

/**
 * Вселенная обновляется раз в сутки: лидерборд весит ~33 МБ, а состав богатых
 * кошельков за час не меняется. Но КАЖДЫЙ отбор датируется — без даты отбора
 * ошибка выжившего становится неустранимой задним числом.
 */
async function ensureUniverse(nowIso: string): Promise<UniverseCache> {
  const today = utcDay(nowIso);
  const cached = readUniverse();
  if (!universeIsStale(cached, today)) return cached as UniverseCache;

  const rows = await fetchLeaderboard();
  snapshotLeaderboard(rows, nowIso);
  const addresses = pickUniverse(rows);
  const fresh: UniverseCache = {
    day: today,
    pickedAt: nowIso,
    minAccountUsd: UNIVERSE_MIN_ACCOUNT_USD,
    minProfitUsd: UNIVERSE_MIN_PROFIT_USD,
    maxWallets: UNIVERSE_MAX_WALLETS,
    addresses,
  };
  mkdirSync(dirname(universePath()), { recursive: true });
  writeFileSync(universePath(), `${JSON.stringify(fresh, null, 2)}\n`);
  return fresh;
}

export interface SnapshotReport {
  readonly takenAt: string;
  readonly wallets: number;
  readonly walletsFailed: number;
  readonly rows: number;
  readonly coins: number;
  readonly path: string;
}

/**
 * Один срез. Бросает на сетевых авариях — вызывающий решает, что это значит.
 * В часовом тике авария источника НЕ должна валить тик: сбор данных не может
 * стоить инкубатору живого часа.
 */
export async function collectWhaleSnapshot(now: () => string = () => new Date().toISOString()): Promise<SnapshotReport> {
  const takenAt = now();
  const universe = await ensureUniverse(takenAt);
  const { ok, failed } = await mapWithConcurrency(universe.addresses, SCAN_CONCURRENCY, fetchPositions);

  const lines: string[] = [];
  const coins = new Set<string>();
  for (const wallet of ok) {
    const mmBook = isMarketMakerBook(wallet);
    for (const position of wallet) {
      if (position.sizeUsd < MIN_RECORDED_USD) continue;
      lines.push(toCsvRow(takenAt, position, mmBook));
      coins.add(position.coin);
    }
  }

  const path = positionsPath(utcDay(takenAt));
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, `${CSV_HEADER}\n`);
  if (lines.length > 0) appendFileSync(path, `${lines.join("\n")}\n`);

  return {
    takenAt,
    wallets: universe.addresses.length,
    walletsFailed: failed,
    rows: lines.length,
    coins: coins.size,
    path,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  collectWhaleSnapshot()
    .then((r) => {
      console.error(
        `киты Hyperliquid: ${r.rows} позиций по ${r.coins} монетам, ` +
          `кошельков ${r.wallets} (сбой у ${r.walletsFailed}) → ${r.path}`,
      );
    })
    .catch((error: unknown) => {
      console.error(`сбор китов не удался: ${error instanceof Error ? error.message : error}`);
      process.exitCode = 1;
    });
}
