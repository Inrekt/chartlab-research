import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { klinesUrlFromCorpus, marketIsAssumed } from "./binance.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function corpus(opts: { files?: number; source?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), "market-"));
  dirs.push(dir);
  for (let i = 0; i < (opts.files ?? 0); i++) {
    writeFileSync(join(dir, `SYM${i}_1h.json.gz`), "");
  }
  if (opts.source) {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ source: opts.source }));
  }
  return dir;
}

describe("рынок живых баров следует за корпусом", () => {
  test("манифест перпов → fapi, манифест спота → api", () => {
    expect(klinesUrlFromCorpus(corpus({ files: 3, source: "perp" }))).toContain("fapi.binance.com");
    expect(klinesUrlFromCorpus(corpus({ files: 3, source: "spot" }))).toContain("api.binance.com");
  });

  test("каталог корпуса берётся ПАРАМЕТРОМ, а не прибит к public/data/history", () => {
    // Ровно этот баг и случился: путь был прибит, корпус переехал в кэш
    // раннера, манифест по старому адресу перестал существовать — и функция
    // молча вернула спот, пока скрин считал по перпам. Обе половины машины
    // при этом рапортовали успех.
    const moved = corpus({ files: 3, source: "perp" });
    expect(klinesUrlFromCorpus(moved)).toContain("fapi.binance.com");
  });

  test("корпуса нет вовсе → спот, и это НЕ считается предположением", () => {
    // Тесты и разовые утилиты работают без корпуса и сеть не трогают —
    // ронять их незачем.
    const empty = corpus({});
    expect(klinesUrlFromCorpus(empty)).toContain("api.binance.com");
    expect(marketIsAssumed(empty)).toBe(false);
  });

  test("корпус ЕСТЬ, а манифеста нет → рынок предположен, и это видно наружу", () => {
    // Старый спотовый корпус в public/data/history именно такой, и ронять
    // прогон на нём было бы ложной тревогой. Но флаг обязан быть поднят:
    // если такой каталог окажется фьючерсным, инкубатор догонит не тот рынок.
    const legacy = corpus({ files: 5 });
    expect(klinesUrlFromCorpus(legacy)).toContain("api.binance.com");
    expect(marketIsAssumed(legacy)).toBe(true);
  });

  test("битый манифест не роняет прогон, но и не выдаёт себя за знание", () => {
    const dir = mkdtempSync(join(tmpdir(), "market-"));
    dirs.push(dir);
    writeFileSync(join(dir, "SYM_1h.json.gz"), "");
    writeFileSync(join(dir, "manifest.json"), "{ это не json");
    expect(klinesUrlFromCorpus(dir)).toContain("api.binance.com");
  });
});
