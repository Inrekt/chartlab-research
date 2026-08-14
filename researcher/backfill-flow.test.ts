import { describe, expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HEADER,
  mergeRows,
  monthsSince,
  parseKlinesCsv,
  readSeries,
  writeSeries,
} from "./backfill-flow.ts";

/*
 * Серия flow-1h — честная замена порочной колонки takerBuySellVol (та —
 * среднее пятиминутных отношений, её хвосты выбирают тонкие часы). Здесь
 * пишется точный ОБЪЁМ агрессивных покупок из поля [9] клайна.
 *
 * Тесты — про парсер и слияние: сами данные восстановимы из архива, но
 * битый парсер молча породил бы серию, смещённую так же, как та, которую
 * мы заменяем. Ровно этого и нельзя допустить.
 */
describe("парсер архивных клайнов", () => {
  const row = (t: number) =>
    `${t},64000,64100,63900,64050,1196.788,${t + 3_599_999},7.6e7,12345,770.596,4.9e7,0`;

  test("берёт время [0], объём [5] и покупки тейкеров [9]", () => {
    const out = parseKlinesCsv(row(1786251600000));
    expect(out).toHaveLength(1);
    const [iso, volume, takerBuy] = out[0]!.split(",");
    expect(iso).toBe(new Date(1786251600000).toISOString());
    expect(volume).toBe("1196.788");
    expect(takerBuy).toBe("770.596");
  });

  test("заголовок архива пропускается по нечисловому первому полю", () => {
    const csv = `open_time,open,high,low,close,volume,close_time,qv,n,taker_buy_volume,tbqv,ignore\n${row(1700000000000)}`;
    expect(parseKlinesCsv(csv)).toHaveLength(1);
  });

  test("микросекунды (архивы с 2025) нормализуются по величине", () => {
    // 1786251600000000 мкс = 1786251600000 мс. Без нормализации дата уехала
    // бы на десятки тысяч лет — и серия молча склеилась бы в мусор.
    const out = parseKlinesCsv(row(1786251600000000));
    expect(out[0]!.split(",")[0]).toBe(new Date(1786251600000).toISOString());
  });

  test("объём пишется как в архиве, без переформатирования числом", () => {
    // Number() → String() меняет представление (1196.7880 → 1196.788) и
    // ломает побайтовую сверку с корпусом. Строка должна идти как есть.
    const csv = `1700000000000,1,2,0,1,1196.7880,1700003599999,0,0,770.5960,0,0`;
    const [, volume, takerBuy] = parseKlinesCsv(csv)[0]!.split(",");
    expect(volume).toBe("1196.7880");
    expect(takerBuy).toBe("770.5960");
  });
});

describe("слияние строк", () => {
  test("дозапись без дублей, итог отсортирован", () => {
    const existing = ["2026-08-01T00:00:00.000Z,10,5", "2026-08-01T02:00:00.000Z,30,15"];
    const fresh = [
      "2026-08-01T01:00:00.000Z,20,10",
      "2026-08-01T02:00:00.000Z,999,999", // дубль по времени — существующая строка побеждает
    ];
    const merged = mergeRows(existing, fresh);
    expect(merged).toEqual([
      "2026-08-01T00:00:00.000Z,10,5",
      "2026-08-01T01:00:00.000Z,20,10",
      "2026-08-01T02:00:00.000Z,30,15",
    ]);
  });
});

describe("календарь месяцев", () => {
  test("от старта фьючерсов до текущего месяца включительно", () => {
    const months = monthsSince("2019-09", new Date("2020-01-15T00:00:00Z"));
    expect(months).toEqual(["2019-09", "2019-10", "2019-11", "2019-12", "2020-01"]);
  });
});

describe("хранение серии", () => {
  test("запись и чтение сжатого файла обратимы, заголовок не течёт в строки", () => {
    const path = join(mkdtempSync(join(tmpdir(), "flow-")), "X.csv.gz");
    const rows = ["2026-08-01T00:00:00.000Z,10,5", "2026-08-01T01:00:00.000Z,20,10"];
    writeSeries(path, rows);
    expect(readSeries(path)).toEqual(rows);
  });

  test("отсутствующий файл — пустая серия, а не исключение", () => {
    expect(readSeries("/nonexistent/flow/X.csv.gz")).toEqual([]);
  });
});

test("заголовок серии зафиксирован", () => {
  // Совместимость читателей: колонки серии — контракт, менять только с
  // миграцией. Ровно та ошибка, что ловится инвариантом «заголовок ↔ строка»
  // в архиве китов.
  expect(HEADER).toBe("time,volume,takerBuyVolume");
});
