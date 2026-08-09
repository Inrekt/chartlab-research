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
import { assertDataSources } from "./preflight.ts";
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
