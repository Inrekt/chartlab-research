/**
 * Бэкфилл ЧАСОВОЙ истории DVOL (индекс подразумеваемой волатильности Deribit)
 * для BTC и ETH — данные для атома VRP (премия за риск волатильности:
 * DVOL − реализованная).
 *
 * Запускается В ОБЛАКЕ (workflow backfill-dvol.yml, вручную): с локальной
 * сети владельца Deribit не отвечает (SSL-обрыв — похоже на гео-блок), а с
 * раннеров GitHub ежедневный сборщик ходит к нему без проблем.
 *
 * История DVOL существует с запуска индекса 2021-03-24. Ежедневный сборщик
 * пишет дневные точки (dvol-BTC.csv); здесь — отдельные часовые файлы
 * dvol-1h-BTC.csv: реализованная волатильность для VRP считается на наших
 * 1h-свечах, и сравнивать её честно с часовым же DVOL.
 *
 * Идемпотентен: продолжает с последнего записанного часа.
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DERIBIT = "https://www.deribit.com/api/v2/public";
/** Запуск индекса DVOL. */
const DVOL_START_MS = Date.parse("2021-03-24T00:00:00Z");
const HOUR_MS = 3_600_000;
/** Окно одного запроса; API отдаёт до ~1000 точек. */
const CHUNK_HOURS = 900;

const HEADER = "time,open,high,low,close";

async function backfillCurrency(dir: string, ccy: "BTC" | "ETH"): Promise<number> {
  const outPath = join(dir, `dvol-1h-${ccy}.csv`);
  let lastMs = DVOL_START_MS - HOUR_MS;
  if (existsSync(outPath)) {
    const lines = readFileSync(outPath, "utf8").trim().split("\n");
    const lastLine = lines.at(-1);
    if (lastLine && !lastLine.startsWith("time")) {
      const t = Date.parse(lastLine.split(",")[0]);
      if (Number.isFinite(t)) lastMs = t;
    }
  } else {
    writeFileSync(outPath, HEADER + "\n");
  }

  let added = 0;
  let from = lastMs + HOUR_MS;
  const now = Date.now();

  while (from < now) {
    const to = Math.min(from + CHUNK_HOURS * HOUR_MS, now);
    const url = `${DERIBIT}/get_volatility_index_data?currency=${ccy}&start_timestamp=${from}&end_timestamp=${to}&resolution=3600`;

    let data: number[][] | null = null;
    for (let attempt = 1; attempt <= 3 && !data; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(25_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { result?: { data?: number[][] } };
        data = body.result?.data ?? [];
      } catch (e) {
        if (attempt === 3) {
          console.log(`  ${ccy}: окно ${new Date(from).toISOString()} не отдалось (${(e as Error).message}) — стоп, дозаберём следующим запуском`);
          return added;
        }
        await new Promise((r) => setTimeout(r, 3_000 * attempt));
      }
    }

    const rows: string[] = [];
    for (const [ts, open, high, low, close] of data!) {
      if (ts <= lastMs) continue;
      rows.push(`${new Date(ts).toISOString()},${open},${high},${low},${close}`);
      lastMs = ts;
    }
    if (rows.length > 0) {
      appendFileSync(outPath, rows.join("\n") + "\n");
      added += rows.length;
    }

    from = to;
    // Вежливая пауза: публичный API, нам некуда торопиться.
    await new Promise((r) => setTimeout(r, 250));
  }
  return added;
}

async function main(): Promise<void> {
  const base =
    process.env.COLLECT_DIR ?? join(process.env.HOME ?? "", ".chartlab", "data-repo", "market");
  const dir = join(base, "deribit");
  mkdirSync(dir, { recursive: true });

  for (const ccy of ["BTC", "ETH"] as const) {
    const added = await backfillCurrency(dir, ccy);
    console.log(`${ccy}: добавлено ${added} часов`);
  }
}

if (process.argv[1]?.endsWith("backfill-dvol.ts")) {
  void main();
}
