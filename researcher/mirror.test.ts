import { describe, expect, test } from "vitest";
import { deflateRawSync } from "node:zlib";
import { parseKlineCsv, unzipSingleEntry } from "./collect-candles.ts";

/** Минимальный корректный zip с одним файлом — как их отдаёт архив Binance. */
function makeZip(name: string, content: string, method: 0 | 8 = 8): Buffer {
  const nameBuf = Buffer.from(name);
  const raw = Buffer.from(content);
  const data = method === 8 ? deflateRawSync(raw) : raw;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42); // смещение локального заголовка

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBuf.length, 12);
  const cdStart = local.length + nameBuf.length + data.length;
  eocd.writeUInt32LE(cdStart, 16);

  return Buffer.concat([local, nameBuf, data, central, nameBuf, eocd]);
}

describe("разбор архива Binance", () => {
  test("распаковка идёт через центральный каталог, а не локальный заголовок", () => {
    // При выставленном бите 3 размеры в локальном заголовке нулевые и лежат в
    // дескрипторе ПОСЛЕ данных. Центральный каталог хранит их всегда — иначе
    // разбор развалился бы на части архивов молча.
    const csv = "1577750400000,7200.1,7250.0,7180.0,7240.5,123.45";
    expect(unzipSingleEntry(makeZip("BTCUSDT-1h-2019-12-31.csv", csv))).toBe(csv);
  });

  test("нежатый метод хранения тоже читается", () => {
    expect(unzipSingleEntry(makeZip("a.csv", "1,2,3,4,5,6", 0))).toBe("1,2,3,4,5,6");
  });

  test("битый архив падает явно, а не отдаёт мусор", () => {
    expect(() => unzipSingleEntry(Buffer.alloc(50))).toThrow(/End of Central Directory/);
  });
});

describe("разбор CSV свечей", () => {
  test("строка заголовка пропускается", () => {
    // У части файлов архива заголовок есть, у части нет.
    const csv = "open_time,open,high,low,close,volume\n1577750400000,1,2,0.5,1.5,10";
    const out = parseKlineCsv(csv);
    expect(out).toHaveLength(1);
    expect(out[0].close).toBe(1.5);
  });

  test("МИКРОсекундные таймстемпы распознаются", () => {
    // Binance перевёл часть архивов на микросекунды. Наивный разбор дал бы
    // бары в 54-м тысячелетии — они молча выпали бы из любого окна, и корпус
    // оказался бы пустым без единой ошибки.
    const ms = parseKlineCsv("1577750400000,1,2,0.5,1.5,10")[0];
    const us = parseKlineCsv("1577750400000000,1,2,0.5,1.5,10")[0];
    expect(ms.time).toBe(1_577_750_400);
    expect(us.time).toBe(ms.time);
  });

  test("пустые поля НЕ превращаются в нулевую цену", () => {
    // Number("") === 0, поэтому пустая строка архива дала бы бар с ценой 0:
    // он прошёл бы проверку на конечность, обнулил доходности и сломал любое
    // деление на цену. Ноль опаснее NaN тем, что выглядит числом.
    const out = parseKlineCsv("1577750400000,,,,,\n1577754000000,1,2,0.5,1.5,10");
    expect(out).toHaveLength(1);
    expect(out[0].close).toBe(1.5);
  });

  test("нулевая цена в архиве отбрасывается", () => {
    expect(parseKlineCsv("1577750400000,0,0,0,0,0")).toHaveLength(0);
  });
});
