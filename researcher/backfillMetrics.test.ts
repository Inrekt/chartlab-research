import { describe, expect, it } from "vitest";
import { aggregateHourly, parseMetricsCsv, HEADER } from "./backfill-metrics.ts";

const T0 = Date.parse("2021-01-01T10:00:00Z");
const MIN = 60_000;

const sample = (offsetMin: number, oi: number, ratio: number) => ({
  time: T0 + offsetMin * MIN,
  oi,
  oiValue: oi * 10,
  topLsAccounts: ratio,
  topLsPositions: ratio + 1,
  globalLsAccounts: ratio + 2,
  takerBuySellVol: ratio + 3,
});

describe("агрегация метрик в часы", () => {
  it("уровень берётся последним, поток — средним", () => {
    // Три пятиминутки одного часа: OI меняется 100 → 300, ratio 1 → 3.
    const rows = aggregateHourly([sample(0, 100, 1), sample(5, 200, 2), sample(55, 300, 3)]);
    expect(rows).toHaveLength(1);
    const cols = rows[0].split(",");
    expect(cols[0]).toBe("2021-01-01T10:00:00Z");
    expect(Number(cols[1])).toBe(300); // oi — ПОСЛЕДНЕЕ значение часа
    expect(Number(cols[3])).toBeCloseTo(2, 9); // ratio — среднее
  });

  it("дубли сэмплов схлопываются ДО среднего — иначе оно смещается", () => {
    // Один и тот же сэмпл дважды (реальный случай в архивах Binance): без
    // дедупликации среднее из [1, 1, 4] дало бы 2, а честное из [1, 4] — 2.5.
    const rows = aggregateHourly([sample(0, 100, 1), sample(0, 100, 1), sample(30, 200, 4)]);
    const cols = rows[0].split(",");
    expect(Number(cols[3])).toBeCloseTo(2.5, 9);
  });

  it("часы сортированы и не смешиваются", () => {
    const rows = aggregateHourly([sample(65, 200, 2), sample(5, 100, 1)]);
    expect(rows).toHaveLength(2);
    expect(rows[0].split(",")[0]).toBe("2021-01-01T10:00:00Z");
    expect(rows[1].split(",")[0]).toBe("2021-01-01T11:00:00Z");
    expect(Number(rows[0].split(",")[1])).toBe(100);
    expect(Number(rows[1].split(",")[1])).toBe(200);
  });

  it("разбор CSV терпит битые строки и повторы шапки", () => {
    const csv = [
      "create_time,symbol,sum_open_interest,sum_open_interest_value,count_toptrader_long_short_ratio,sum_toptrader_long_short_ratio,count_long_short_ratio,sum_taker_long_short_vol_ratio",
      "2021-01-01 10:00:00,BTCUSDT,100,1000,1.5,1.2,1.6,0.4",
      "мусорная строка",
      "2021-01-01 10:05:00,BTCUSDT,110,1100,1.6,1.3,1.7,0.5",
      "",
    ].join("\n");
    const parsed = parseMetricsCsv(csv);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].time).toBe(Date.parse("2021-01-01T10:00:00Z"));
    expect(parsed[1].takerBuySellVol).toBeCloseTo(0.5, 9);
  });

  it("шапка выходного файла согласована с числом колонок", () => {
    const rows = aggregateHourly([sample(0, 100, 1)]);
    expect(rows[0].split(",")).toHaveLength(HEADER.split(",").length);
  });
});
