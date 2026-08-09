/**
 * Ежечасный тик — догонка инкубатора и надзора на свежих закрытых барах.
 * Дёшев (секунды сети + движка); если Mac спал — следующий тик догонит,
 * честность обеспечена заморозкой правил, а не непрерывностью работы.
 */
import { join } from "node:path";
import { corpusCandleSource, runIncubation, type CandleSource } from "./incubate.ts";
import { ExchangeBlockedError, fetchBinanceKlines } from "./binance.ts";
import { writeStatus } from "./statusFile.ts";
import { DB_PATH, DEFAULT_VAULT_DIR } from "./paths.ts";
import { assertDataSources, corpusFreshnessVerdict } from "./preflight.ts";
import { runSupervision } from "./supervise.ts";

// Инкубатор гоняет тот же движок, что и ночь. Без источников кандидат набирал
// бы ноль форвард-сделок и умер бы «по календарю» через 365 дней — с виду
// честная смерть, на деле потерянный год.
//
// Но КОРПУС тику не нужен: и инкубатор, и надзор тянут живые бары с биржи.
// Требовать здесь 100 файлов значит на холодном кэше качать корпус впустую
// внутри 20-минутного джоба. Манифест при этом всё равно проверяется — без
// него рынок живых баров предполагается, а это ровно та авария, когда скрин
// считал по перпам, а инкубатор догонял спотом.
assertDataSources({ requireCorpusFiles: false });

const cardsDir = join(DEFAULT_VAULT_DIR, "Карточки");
const log = (m: string) => console.error(m);

/**
 * Живая биржа, а при блокировке — корпус.
 *
 * Раннеры GitHub получают от REST Binance 451, и без запасного пути инкубация
 * в облаке невозможна: кандидат просидел бы 365 дней с нулём форвард-сделок и
 * умер бы как «не доказавший край», то есть авария среды записалась бы в
 * журнал как вывод о рынке.
 *
 * Корпус отстаёт примерно на сутки, и это безвредно: форвард-тест накапливает
 * ЗАКРЫТЫЕ сделки, а узнать о закрытой сделке позже — не преимущество.
 * Переключение ЛОГИРУЕТСЯ: подмена источника не должна быть незаметной.
 */
let usedFallback = false;
const source: CandleSource = async (symbol, tf, startSec) => {
  if (usedFallback) return corpusCandleSource()(symbol, tf, startSec);
  try {
    return await fetchBinanceKlines(symbol, tf, startSec);
  } catch (error) {
    if (!(error instanceof ExchangeBlockedError)) throw error;
    usedFallback = true;
    log(
      "⚠️ биржа закрыта по юрисдикции — инкубация переходит на КОРПУС. " +
        "Отставание около суток, форвард от этого не страдает; живые сигналы " +
        "потребуют хоста с прямым доступом.",
    );

    // В запасном режиме просроченность корпуса становится СМЕРТЕЛЬНОЙ, хотя
    // при живой бирже она безразлична. Источник отвечает успешно — просто
    // пустотой, — поэтому предохранитель «упали все символы» здесь молчит, и
    // кандидат копил бы календарь без единой сделки, пока не умрёт «не
    // доказавшим край». Ровно та подмена аварии выводом о рынке, против
    // которой построена вся машина.
    const fresh = corpusFreshnessVerdict();
    if (fresh.level === "fail") {
      throw new Error(
        [
          "Инкубация невозможна: биржа закрыта, а корпус просрочен.",
          `  последний бар корпуса: ${fresh.newestIso} (${fresh.ageDays?.toFixed(1)} сут назад)`,
          "",
          "Запасной источник отвечает пустотой, а не ошибкой, поэтому без этой",
          "проверки кандидат молча просидел бы 365 дней и был бы списан как",
          "не доказавший край. Чинить: ночной сбор корпуса из архива.",
        ].join("\n"),
      );
    }
    return corpusCandleSource()(symbol, tf, startSec);
  }
};

const incubation = await runIncubation({ dbPath: DB_PATH, vaultCardsDir: cardsDir, log, source });
const supervision = await runSupervision({
  dbPath: DB_PATH,
  vaultCardsDir: cardsDir,
  log,
  source,
});
// screens: [] ⇒ воронка последней ночи переносится из предыдущего статуса.
writeStatus({ screens: [], incubation, supervision });
console.log(JSON.stringify({ at: new Date().toISOString(), incubation, supervision }));
