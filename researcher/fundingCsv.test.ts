import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFundingCsv } from "./fundingCsv.ts";

/**
 * Разбор CSV со ставками. Живёт здесь, а не рядом с ядром: ядро браузерное и
 * файлов не читает, поэтому и тест на чтение файлов ему не место.
 */

let root: string;
let prev: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "funding-csv-"));
  mkdirSync(join(root, "funding"), { recursive: true });
  prev = process.env.COLLECT_DIR;
  process.env.COLLECT_DIR = root;
});

afterEach(() => {
  if (prev === undefined) delete process.env.COLLECT_DIR;
  else process.env.COLLECT_DIR = prev;
  rmSync(root, { recursive: true, force: true });
});

const write = (symbol: string, body: string): void =>
  writeFileSync(join(root, "funding", `${symbol}.csv`), body);

describe("чтение ставок фандинга с диска", () => {
  it("разбирает время и ставку", () => {
    write("XT", "time,fundingRate\n2020-01-01T00:00:00.000Z,-0.00012\n2020-01-01T08:00:00.000Z,0.0003\n");
    const h = readFundingCsv("XT")!;
    expect(h.times.length).toBe(2);
    expect(h.times[0]).toBe(Date.parse("2020-01-01T00:00:00.000Z"));
    expect(h.rates[1]).toBeCloseTo(0.0003, 9);
  });

  it("битые строки пропускаются, а не роняют разбор", () => {
    // Файл дописывается коллектором на живую; оборванная последняя строка —
    // штатная ситуация, а не повод потерять весь символ.
    write("XT", "time,fundingRate\nмусор\n2020-01-01T00:00:00.000Z,0.001\n2020-01-0\n");
    const h = readFundingCsv("XT")!;
    expect(h.times.length).toBe(1);
  });

  it("файла нет — null, и это не ошибка", () => {
    expect(readFundingCsv("НЕТ-ТАКОГО")).toBeNull();
  });

  it("файл с одной шапкой — null, а не пустая история", () => {
    write("XT", "time,fundingRate\n");
    expect(readFundingCsv("XT")).toBeNull();
  });
});
