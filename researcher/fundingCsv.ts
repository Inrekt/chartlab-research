import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setFundingLoader, type FundingHistory } from "../src/core/funding/fundingSeries.ts";

/**
 * Чтение ставок фандинга с диска. ТОЛЬКО для ноды.
 *
 * Лежит в researcher/, а не в src/core/, и это не вкусовщина: src/core — общий
 * код, который собирается и в браузер. Пока чтение файлов лежало там, сборка
 * приложения падала на `node:fs`. Падала правильно: браузерный код не должен
 * уметь читать диск.
 */

function fundingDir(): string {
  const base =
    process.env.COLLECT_DIR ?? join(process.env.HOME ?? "", ".chartlab", "data-repo", "market");
  return join(base, "funding");
}

/** Разбирает CSV вида `time,fundingRate`. `null`, если файла нет. */
export function readFundingCsv(symbol: string): FundingHistory | null {
  const path = join(fundingDir(), `${symbol}.csv`);
  if (!existsSync(path)) return null;

  const lines = readFileSync(path, "utf8").split("\n");
  const times: number[] = [];
  const rates: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const comma = line.indexOf(",");
    if (comma < 0) continue;
    const time = Date.parse(line.slice(0, comma));
    const rate = Number(line.slice(comma + 1));
    if (!Number.isFinite(time) || !Number.isFinite(rate)) continue;
    times.push(time);
    rates.push(rate);
  }

  if (times.length === 0) return null;
  return { times: Float64Array.from(times), rates: Float64Array.from(rates) };
}

/**
 * Подключает чтение с диска как источник ставок.
 *
 * Зовётся из `researcher/corpus.ts` — единственного места, через которое
 * проходит ЛЮБОЙ исследовательский вход. Если подключать это в каждой точке
 * входа отдельно, однажды забудут в одной, и целое семейство молча перестанет
 * давать сделки, не сломав ни одного теста.
 */
export function useCsvFunding(): void {
  setFundingLoader(readFundingCsv);
}
