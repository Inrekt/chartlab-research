/**
 * Общие мелочи работы с файловым архивом data.binance.vision: листинг ключей,
 * скачивание с проверкой SHA-256 из соседнего .CHECKSUM, предохранитель диска.
 */
import { createHash } from "node:crypto";
import { createWriteStream, rmSync, statfsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const ARCHIVE = "https://data.binance.vision";
export const MIN_FREE_BYTES = 5 * 1024 ** 3;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Календарь вместо листинга: S3-листинг бакета отвечает по 45 с за страницу
 * (замер 2026-11-07), а 404 на несуществующий файл — десятки миллисекунд.
 */
export function daysBetween(from: string, toInclusive: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${toInclusive}T00:00:00Z`); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** Вчера по UTC: файл за сегодня ещё не опубликован. */
export const yesterdayUtc = (now = Date.now()): string =>
  new Date(now - 86_400_000).toISOString().slice(0, 10);

export class DiskLowError extends Error {}

/** Бросает DiskLowError, если после скачивания `needBytes` свободного места станет < MIN_FREE_BYTES. */
export function assertDiskRoom(dir: string, needBytes: number, minFree = MIN_FREE_BYTES): void {
  mkdirSync(dir, { recursive: true });
  const s = statfsSync(dir);
  const free = s.bavail * s.bsize;
  if (free - needBytes < minFree) {
    throw new DiskLowError(
      `мало места: свободно ${(free / 1024 ** 3).toFixed(1)} ГБ, нужно оставить ≥ ${(minFree / 1024 ** 3).toFixed(0)} ГБ`,
    );
  }
}

/**
 * Скачать `url` в `dest` потоком и сверить SHA-256 с `url + ".CHECKSUM"`.
 * null — файла нет (404). Несовпадение суммы — ошибка (с ретраями).
 */
export async function downloadVerified(url: string, dest: string, retries = 3): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      const sumRes = await fetch(`${url}.CHECKSUM`, { signal: AbortSignal.timeout(30_000) });
      if (sumRes.status === 404) return false;
      if (!sumRes.ok) throw new Error(`checksum ${sumRes.status}`);
      const expected = (await sumRes.text()).trim().split(/\s+/)[0].toLowerCase();
      const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
      if (res.status === 404) return false;
      if (!res.ok || !res.body) throw new Error(`${res.status}`);
      const hash = createHash("sha256");
      await pipeline(
        Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
        async function* (src) {
          for await (const chunk of src) {
            hash.update(chunk as Buffer);
            yield chunk;
          }
        },
        createWriteStream(dest),
      );
      if (hash.digest("hex") !== expected) throw new Error(`SHA-256 не совпал: ${url}`);
      return true;
    } catch (e) {
      rmSync(dest, { force: true });
      if (attempt >= retries) throw e;
      await sleep(2000 * 2 ** attempt);
    }
  }
}

/** Построчный поток единственного CSV из zip через `unzip -p` — без загрузки файла в память. */
export async function* zipLines(zipPath: string): AsyncGenerator<string> {
  const child = spawn("unzip", ["-p", zipPath], { stdio: ["ignore", "pipe", "ignore"] });
  const exit = new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? 1)));
  for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
    yield line;
  }
  const code = await exit;
  if (code !== 0) throw new Error(`unzip завершился с кодом ${code}: ${zipPath}`);
}

