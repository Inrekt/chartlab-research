import { describe, expect, test } from "vitest";
import {
  CSV_HEADER,
  LEADERBOARD_SNAPSHOT_MIN_USD,
  snapshotWorthy,
  MIN_RECORDED_USD,
  UNIVERSE_MIN_ACCOUNT_USD,
  UNIVERSE_MIN_PROFIT_USD,
  isMarketMakerBook,
  pickUniverse,
  toCsvRow,
  universeIsStale,
  utcDay,
  type WhalePosition,
} from "./hlWhales.ts";

/*
 * Архив китов — данные, которых НЕ БУДЕТ ВТОРОГО РАЗА. Hyperliquid отдаёт
 * только текущий срез, истории позиций нет нигде. Значит цена тихой ошибки
 * здесь выше обычной: битую строку нельзя перезалить, её можно только
 * обнаружить через полгода и выбросить вместе с полугодом.
 *
 * Поэтому тесты тут не про «работает ли сеть», а про форму записи.
 */
const position = (over: Partial<WhalePosition> = {}): WhalePosition => ({
  address: "0xabc",
  coin: "ETH",
  isLong: true,
  sizeUsd: 1_000_000,
  leverage: 5,
  entryPx: 3000,
  liquidationPx: 2500,
  markPx: 3100,
  unrealizedPnl: 33_000,
  ...over,
});

describe("форма строки архива", () => {
  test("число колонок совпадает с заголовком", () => {
    // Ровно тот разъезд, который ловится только через полгода: кто-то добавит
    // поле в строку и забудет заголовок, и весь архив за период станет
    // нечитаемым — потому что колонки поедут, а файл останется валидным CSV.
    const row = toCsvRow("2026-08-10T00:00:00.000Z", position(), false);
    expect(row.split(",")).toHaveLength(CSV_HEADER.split(",").length);
  });

  test("отсутствующая цена ликвидации пишется ПУСТЫМ полем, а не словом", () => {
    // "null" в числовой колонке — классическая тихая порча: файл читается,
    // Number("null") даёт NaN, и позиция беззвучно выпадает из любой карты
    // скоплений. Пустое поле честно означает «биржа не дала числа».
    const row = toCsvRow("2026-08-10T00:00:00.000Z", position({ liquidationPx: null }), false);
    const liq = row.split(",")[7];
    expect(liq).toBe("");
    expect(row).not.toContain("null");
  });

  test("признак маркет-мейкера пишется, а строка НЕ выбрасывается", () => {
    // Фильтрация — решение анализа и обязана остаться обратимой. Если бы
    // сборщик отбрасывал двусторонние книги, вернуть их было бы неоткуда.
    const row = toCsvRow("2026-08-10T00:00:00.000Z", position(), true);
    expect(row.endsWith(",1")).toBe(true);
  });

  test("порог записи ниже боевого порога бота", () => {
    // Фильтр всегда можно ужесточить при чтении; недописанную строку — нет.
    expect(MIN_RECORDED_USD).toBeLessThan(500_000);
  });
});

describe("вселенная кошельков", () => {
  test("нужны ОБА порога: богатый и доказанно прибыльный", () => {
    // Отбор только по размеру счёта затаскивал убыточные кошельки с огромными
    // позициями — их ставки гасили ставки настоящих китов, и перекос
    // схлопывался почти в ноль. Замер владельца, не гипотеза.
    const picked = pickUniverse([
      { address: "богатый_убыточный", accountValue: UNIVERSE_MIN_ACCOUNT_USD * 10, allTimePnl: -1 },
      { address: "прибыльный_мелкий", accountValue: 1000, allTimePnl: UNIVERSE_MIN_PROFIT_USD * 10 },
      { address: "оба", accountValue: UNIVERSE_MIN_ACCOUNT_USD, allTimePnl: UNIVERSE_MIN_PROFIT_USD },
    ]);
    expect(picked).toEqual(["оба"]);
  });

  test("сортировка по прибыли, а не по размеру счёта", () => {
    const picked = pickUniverse([
      { address: "б", accountValue: 1e9, allTimePnl: UNIVERSE_MIN_PROFIT_USD + 1 },
      { address: "а", accountValue: UNIVERSE_MIN_ACCOUNT_USD, allTimePnl: UNIVERSE_MIN_PROFIT_USD + 2 },
    ]);
    expect(picked[0]).toBe("а");
  });

  test("кэш протухает по UTC-дню, а не по времени жизни", () => {
    // Лидерборд весит ~33 МБ. Обновление раз в сутки — вежливость к источнику;
    // привязка к КАЛЕНДАРНОМУ дню, а не к «24 часа назад», делает дату отбора
    // воспроизводимой: без неё ошибку выжившего не учесть задним числом.
    const cache = {
      day: "2026-08-10",
      pickedAt: "2026-08-10T00:00:00.000Z",
      minAccountUsd: UNIVERSE_MIN_ACCOUNT_USD,
      minProfitUsd: UNIVERSE_MIN_PROFIT_USD,
      maxWallets: 400,
      addresses: ["0x1"],
    };
    expect(universeIsStale(cache, "2026-08-10")).toBe(false);
    expect(universeIsStale(cache, "2026-08-11")).toBe(true);
    expect(universeIsStale(null, "2026-08-10")).toBe(true);
  });

  test("день среза берётся по UTC", () => {
    expect(utcDay("2026-08-10T23:59:59.999Z")).toBe("2026-08-10");
  });
});

describe("снимок лидерборда", () => {
  test("порог по ЛЮБОЙ из осей — счёт ИЛИ прибыль", () => {
    // Резать по боевым порогам вселенной нельзя: кит, потерявший половину
    // счёта, выпал бы из снимков РАНЬШЕ, чем его вынесло, и агония осталась
    // бы незаписанной — ошибка выжившего, встроенная в сам архив.
    const rich = { address: "a", accountValue: 2_000_000, allTimePnl: -5_000_000, dayPnl: 0 };
    const dying = { address: "b", accountValue: 90_000, allTimePnl: 3_000_000, dayPnl: -800_000 };
    const dust = { address: "c", accountValue: 50_000, allTimePnl: 10_000, dayPnl: 0 };
    expect(snapshotWorthy(rich)).toBe(true); // богатый, пусть и убыточный
    expect(snapshotWorthy(dying)).toBe(true); // почти вынесенный ветеран
    expect(snapshotWorthy(dust)).toBe(false);
  });

  test("порог снимка мягче порогов вселенной", () => {
    // Снимок обязан видеть ШИРЕ, чем боевой отбор: иначе он не фиксирует
    // тех, кто в вселенную ещё/уже не входит, и терять их — весь смысл.
    expect(LEADERBOARD_SNAPSHOT_MIN_USD).toBeLessThan(UNIVERSE_MIN_ACCOUNT_USD);
    expect(LEADERBOARD_SNAPSHOT_MIN_USD).toBeLessThan(UNIVERSE_MIN_PROFIT_USD);
  });
});

describe("признак двусторонней книги", () => {
  test("сопоставимые лонги и шорты — почерк маркет-мейкера", () => {
    const book = [
      position({ coin: "A", isLong: true, sizeUsd: 1_000_000 }),
      position({ coin: "B", isLong: true, sizeUsd: 1_000_000 }),
      position({ coin: "C", isLong: false, sizeUsd: 900_000 }),
      position({ coin: "D", isLong: false, sizeUsd: 900_000 }),
    ];
    expect(isMarketMakerBook(book)).toBe(true);
  });

  test("направленная ставка маркет-мейкером не считается", () => {
    const book = [
      position({ coin: "A", isLong: true, sizeUsd: 5_000_000 }),
      position({ coin: "B", isLong: true, sizeUsd: 5_000_000 }),
      position({ coin: "C", isLong: true, sizeUsd: 5_000_000 }),
      position({ coin: "D", isLong: false, sizeUsd: 600_000 }),
    ];
    expect(isMarketMakerBook(book)).toBe(false);
  });

  test("на трёх позициях признак молчит — выборка слишком мала", () => {
    const book = [
      position({ coin: "A", isLong: true, sizeUsd: 1_000_000 }),
      position({ coin: "B", isLong: false, sizeUsd: 1_000_000 }),
      position({ coin: "C", isLong: false, sizeUsd: 900_000 }),
    ];
    expect(isMarketMakerBook(book)).toBe(false);
  });
});
