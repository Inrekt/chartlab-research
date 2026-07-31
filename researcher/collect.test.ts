import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { appendCsvRows, hourlyLastRows } from "./collect.ts";

const HEADER = "create_time,symbol,sum_open_interest,sum_open_interest_value,count_toptrader_long_short_ratio,sum_toptrader_long_short_ratio,count_long_short_ratio,sum_taker_long_short_vol_ratio";

const row = (ts: string, oi: number) => `${ts},BTCUSDT,${oi},1,1,1,1,1`;

describe("hourlyLastRows", () => {
  test("keeps the LAST 5-minute row of each hour, sorted by hour", () => {
    const csv = [
      HEADER,
      row("2026-07-30 10:00:00", 100),
      row("2026-07-30 10:05:00", 101),
      row("2026-07-30 10:55:00", 111), // последний в часе 10 — победитель
      row("2026-07-30 11:00:00", 200),
      row("2026-07-30 09:55:00", 50), // ранний час в конце файла — сортировка обязана поднять его первым
    ].join("\n");
    const rows = hourlyLastRows(csv);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("09:55:00");
    expect(rows[1]).toContain("10:55:00");
    expect(rows[2]).toContain("11:00:00");
  });

  test("empty or header-only csv → no rows; alien header → error", () => {
    expect(hourlyLastRows("")).toEqual([]);
    expect(hourlyLastRows(HEADER)).toEqual([]);
    expect(() => hourlyLastRows("a,b,c\n1,2,3")).toThrow(/create_time/);
  });
});

describe("appendCsvRows", () => {
  const fresh = () => join(mkdtempSync(join(tmpdir(), "coll-")), "t.csv");

  test("creates file with header, appends, and dedups by first column", () => {
    const path = fresh();
    expect(appendCsvRows(path, "date,v", ["2026-07-30,1", "2026-07-31,2"])).toBe(2);
    // повторная подача того же дня + один новый — добавится только новый
    expect(appendCsvRows(path, "date,v", ["2026-07-31,999", "2026-08-01,3"])).toBe(1);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toEqual(["date,v", "2026-07-30,1", "2026-07-31,2", "2026-08-01,3"]);
  });
});
