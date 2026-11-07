import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { collectSymbol, type DaySource } from "./collect-orderflow.ts";
import {
  advanceState,
  appendRows,
  emptyState,
  flowPaths,
  foldDay,
  histQuantile,
  largeThreshold,
  loadState,
  readFlow,
  withCvd,
  HIST_BINS,
} from "./orderflow.ts";

const FIXTURE = readFileSync(
  join(import.meta.dirname, "fixtures", "btc-aggtrades-2020-01-05-head.csv"),
  "utf8",
)
  .trim()
  .split("\n");
const DAY = "2020-01-05";

/** Независимый ручной пересчёт: тейкер-покупка ⇔ is_buyer_maker=false. */
function manual(lines: string[], barMs: number) {
  const bars = new Map<number, { buy: number; sell: number; buyUsd: number; sellUsd: number; n: number }>();
  for (const l of lines) {
    const f = l.split(",");
    const t = Number(f[5]);
    if (!Number.isFinite(t)) continue;
    const key = Math.floor(t / barMs) * barMs;
    const b = bars.get(key) ?? { buy: 0, sell: 0, buyUsd: 0, sellUsd: 0, n: 0 };
    const q = Number(f[2]);
    const usd = Number(f[1]) * q;
    if (f[6] === "true") {
      b.sell += q;
      b.sellUsd += usd;
    } else {
      b.buy += q;
      b.buyUsd += usd;
    }
    b.n += 1;
    bars.set(key, b);
  }
  return [...bars.entries()].sort((a, b) => a[0] - b[0]);
}

describe("foldDay vs ручной пересчёт (реальный кусок BTC 2020-01-05)", () => {
  for (const [name, ms, pick] of [
    ["15m", 900_000, (f: Awaited<ReturnType<typeof foldDay>>) => f.rows15m],
    ["1h", 3_600_000, (f: Awaited<ReturnType<typeof foldDay>>) => f.rows1h],
  ] as const) {
    test(`${name}: дельта, CVD, число сделок совпадают`, async () => {
      const rows = pick(await foldDay(DAY, FIXTURE, null));
      const exp = manual(FIXTURE, ms);
      expect(rows).toHaveLength(exp.length);
      const bars = withCvd(rows);
      let cvd = 0;
      exp.forEach(([key, b], i) => {
        cvd += b.buy - b.sell;
        expect(bars[i].time).toBe(new Date(key).toISOString());
        expect(Number(bars[i].row[1])).toBe(b.n);
        expect(bars[i].deltaQty).toBeCloseTo(b.buy - b.sell, 6);
        expect(bars[i].deltaUsd).toBeCloseTo(b.buyUsd - b.sellUsd, 2);
        expect(bars[i].cvdQty).toBeCloseTo(cvd, 6);
      });
    });
  }

  test("POC лежит в диапазоне цен бара, absorb ∈ [-1,1], без порога крупных нет", async () => {
    const { rows15m } = await foldDay(DAY, FIXTURE, null);
    for (const l of rows15m) {
      const f = l.split(",");
      expect(Number(f[9])).toBeGreaterThanOrEqual(-1);
      expect(Number(f[9])).toBeLessThanOrEqual(1);
      expect(Number(f[10])).toBeGreaterThan(7000);
      expect(Number(f[10])).toBeLessThan(7500);
      expect(f[8]).toBe("");
      expect(Number(f[6]) + Number(f[7])).toBe(0);
    }
  });

  test("крупные принты: порог применяется, часть объёма попадает в large", async () => {
    const { rows15m } = await foldDay(DAY, FIXTURE, 5000);
    const large = rows15m.reduce((s, l) => s + Number(l.split(",")[6]) + Number(l.split(",")[7]), 0);
    const all = rows15m.reduce((s, l) => s + Number(l.split(",")[4]) + Number(l.split(",")[5]), 0);
    expect(large).toBeGreaterThan(0);
    expect(large).toBeLessThan(all);
  });

  test("сделки вне суток отбрасываются и не плодят бары", async () => {
    const stray = "1,7000,1,1,1,1578009600000,false"; // 2020-01-03
    const r = await foldDay(DAY, [...FIXTURE, stray], null);
    expect(r.dropped).toBe(1);
    expect(r.rows15m).toHaveLength(manual(FIXTURE, 900_000).length);
  });
});

describe("порог крупных принтов без look-ahead", () => {
  const hist = (bin: number, n: number) => {
    const h = new Array<number>(HIST_BINS).fill(0);
    h[bin] = n;
    return h;
  };
  test("для дня D используются только дни строго раньше D и нужно ≥ 5 дней", () => {
    let st = emptyState("X");
    for (let d = 1; d <= 4; d++) st = advanceState(st, `2020-01-0${d}`, hist(50, 100));
    expect(largeThreshold(st, "2020-01-05")).toBeNull();
    st = advanceState(st, "2020-01-05", hist(50, 100));
    expect(largeThreshold(st, "2020-01-06")).not.toBeNull();
    // сегодняшняя (и будущая) гистограмма порог дня не меняет
    const before = largeThreshold(st, "2020-01-05");
    const st2 = advanceState(st, "2020-01-09", hist(200, 1e6));
    expect(largeThreshold(st2, "2020-01-05")).toBe(before);
  });
  test("квантиль монотонен по q", () => {
    const h = new Array<number>(HIST_BINS).fill(1);
    expect(histQuantile(h, 0.5)).toBeLessThan(histQuantile(h, 0.99));
  });
});

describe("resumability и хранение", () => {
  const mkDays = (n: number, opened: string[]): DaySource[] =>
    Array.from({ length: n }, (_, i) => {
      const day = `2020-01-${String(5 + i).padStart(2, "0")}`;
      return {
        day,
        size: 1,
        async open() {
          opened.push(day);
          const lines = FIXTURE.map((l) => {
            const f = l.split(",");
            const t = Number(f[5]);
            if (!Number.isFinite(t)) return l;
            f[5] = String(t + i * 86_400_000);
            return f.join(",");
          });
          return { lines, cleanup: () => {} };
        },
      };
    });

  test("повторный запуск не пересчитывает готовые дни и не дублирует строки", async () => {
    const dir = mkdtempSync(join(tmpdir(), "of-"));
    const opened: string[] = [];
    expect(await collectSymbol("BTCUSDT", mkDays(3, opened), dir, { maxDays: 2 })).toBe(2);
    expect(opened).toEqual(["2020-01-05", "2020-01-06"]);
    const p = flowPaths(dir, "BTCUSDT");
    expect(loadState(p.state, "BTCUSDT").lastDay).toBe("2020-01-06");

    opened.length = 0;
    expect(await collectSymbol("BTCUSDT", mkDays(3, opened), dir)).toBe(1);
    expect(opened).toEqual(["2020-01-07"]);
    expect(await collectSymbol("BTCUSDT", mkDays(3, opened), dir)).toBe(0);

    const rows = readFlow(p.m15);
    const perDay = manual(FIXTURE, 900_000).length;
    expect(rows).toHaveLength(perDay * 3);
    expect(new Set(rows.map((r) => r.split(",")[0])).size).toBe(rows.length);
  });

  test("сбой между записью данных и состояния: день повторяется, читатель схлопывает дубль", async () => {
    const dir = mkdtempSync(join(tmpdir(), "of-"));
    const p = flowPaths(dir, "ETHUSDT");
    const fold = await foldDay(DAY, FIXTURE, null);
    appendRows(p.m15, fold.rows15m); // данные записаны, состояние — нет
    const opened: string[] = [];
    expect(await collectSymbol("ETHUSDT", mkDays(1, opened), dir)).toBe(1);
    expect(readFlow(p.m15)).toHaveLength(fold.rows15m.length);
  });

  test("ошибка открытия дня не двигает состояние; cleanup вызывается даже при сбое свёртки", async () => {
    const dir = mkdtempSync(join(tmpdir(), "of-"));
    let cleaned = false;
    const bad: DaySource = {
      day: DAY,
      size: 1,
      async open() {
        return {
          lines: (async function* () {
            yield FIXTURE[1];
            throw new Error("unzip упал");
          })(),
          cleanup: () => (cleaned = true),
        };
      },
    };
    await expect(collectSymbol("SOLUSDT", [bad], dir)).rejects.toThrow("unzip");
    expect(cleaned).toBe(true);
    expect(loadState(flowPaths(dir, "SOLUSDT").state, "SOLUSDT").lastDay).toBeNull();
    writeFileSync(join(dir, "x"), "");
  });
});
