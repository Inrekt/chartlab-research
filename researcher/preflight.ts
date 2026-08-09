/**
 * Предполётная проверка источников данных.
 *
 * Существует из-за конкретной аварии: `COLLECT_DIR` был задан только в
 * collect.yml, а в nightly.yml и hourly.yml забыт. На раннере каталога с
 * фандингом не оказалось, `readFundingCsv` честно возвращал `null` на каждый
 * символ, атом `funding` честно давал `false` на каждом баре — и семейство
 * funding_pressure получило 212 испытаний со 100% нуля сделок. В журнал это
 * записалось как «правило не даёт сделок», то есть как ВЫВОД О РЫНКЕ.
 *
 * Ошибка инфраструктуры, замаскированная под результат исследования, — худший
 * вид поломки: она не роняет тесты, не пишет в лог ничего тревожного и молча
 * поднимает планку дефляции всем остальным семействам. Поэтому здесь ровно
 * одно правило: отсутствие ИСТОЧНИКА (каталога) — это падение прогона, а не
 * отсутствие данных у символа.
 *
 * Разница принципиальная:
 *   нет файла у одного символа  → у символа нет истории, сделок не будет, ок;
 *   нет каталога / он пуст      → мы не измеряем то, что думаем, что измеряем.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { klinesUrlFromCorpus, marketIsAssumed } from "./binance.ts";
import { HISTORY_DIR, corpusFreshness, corpusVersion } from "./corpus.ts";

/** Корень собранных данных — тот же дефолт, что у читателей CSV. */
export function collectRoot(): string {
  return process.env.COLLECT_DIR ?? join(process.env.HOME ?? "", ".chartlab", "data-repo", "market");
}

/**
 * Корень корпуса свечей. Читается В МОМЕНТ ВЫЗОВА, а не при импорте — как и
 * `collectRoot`. `HISTORY_DIR` в corpus.ts вычисляется один раз при загрузке
 * модуля, и этого достаточно для прогона (переменная задана воркфлоу до
 * старта), но проверять источник по значению, замороженному порядком
 * импортов, — способ однажды измерить не тот каталог. Здесь оба источника
 * подчиняются одному правилу.
 */
export function corpusRoot(): string {
  return process.env.RESEARCHER_HISTORY_DIR ?? HISTORY_DIR;
}

export interface SourceHealth {
  name: string;
  dir: string;
  exists: boolean;
  /** Число CSV-файлов; 0 при отсутствующем каталоге. */
  files: number;
  /** Сколько файлов делает источник пригодным. */
  required: number;
  ok: boolean;
}

/**
 * Источники, от которых зависят условия сетапов. Пороги умышленно низкие:
 * задача — отличить «источника нет» от «источник есть», а не сторожить
 * полноту (полнота — забота канарейки свежести).
 */
const SOURCES: ReadonlyArray<{ name: string; sub: string; required: number }> = [
  { name: "funding", sub: "funding", required: 50 },
  { name: "metrics-1h", sub: "metrics-1h", required: 50 },
];

function countCsv(dir: string): number {
  if (!existsSync(dir)) return 0;
  try {
    // .csv.gz — то, что лежит в репозитории; .csv — то, что оставляет бэкфилл
    // локально. Считаем оба, иначе предохранитель заругался бы на здоровое
    // окружение просто из-за формата хранения.
    return readdirSync(dir).filter((f) => f.endsWith(".csv") || f.endsWith(".csv.gz")).length;
  } catch {
    return 0;
  }
}

/**
 * Минимум файлов корпуса. 324 файла = 162 символа × 2 ТФ; порог 100 отличает
 * «кэш пустой» от «кэш есть» и не придирается к недокачанным символам.
 */
const CORPUS_REQUIRED = 100;

function countCorpus(dir: string): number {
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json.gz")).length;
  } catch {
    return 0;
  }
}

/**
 * Требования разные у ночи и у часового тика, и путать их дорого.
 *
 * Ночь СЧИТАЕТ по корпусу — без него она не даёт «ноль находок», она даёт
 * ноль сделок, записанный в журнал как вывод о рынке.
 *
 * Часовой тик корпус НЕ ЧИТАЕТ вовсе: инкубатор и надзор тянут живые бары с
 * биржи (`fetchBinanceKlines`). Требовать от него 100 файлов значит на
 * холодном кэше либо качать корпус впустую, либо ловить таймаут в 20 минут.
 * Но манифест ему нужен: без него рынок живых баров ПРЕДПОЛАГАЕТСЯ, а
 * предположение здесь — это ровно та авария, когда скрин считал по перпам, а
 * инкубатор догонял спотом.
 */
export interface PreflightOptions {
  /** Ночь — true. Часовой тик — false: он корпус не читает. */
  requireCorpusFiles?: boolean;
}

/** Состояние всех источников — для отчёта, статуса и панели экрана. */
export function dataSourceHealth(): SourceHealth[] {
  const root = collectRoot();
  const sources = SOURCES.map(({ name, sub, required }) => {
    const dir = join(root, sub);
    const files = countCsv(dir);
    return { name, dir, exists: existsSync(dir), files, required, ok: files >= required };
  });

  // Корпус свечей проверяется отдельно: он живёт НЕ в COLLECT_DIR, а в
  // собственном каталоге (в облаке — кэш раннера, локально — public/data).
  // Без этой проверки пустой кэш дал бы ночь без единой сделки, и журнал
  // записал бы это как вывод о рынке — ровно та авария, от которой этот
  // модуль и защищает.
  const corpusDir = corpusRoot();
  const corpusFiles = countCorpus(corpusDir);
  sources.push({
    name: "корпус свечей",
    dir: corpusDir,
    exists: existsSync(corpusDir),
    files: corpusFiles,
    required: CORPUS_REQUIRED,
    ok: corpusFiles >= CORPUS_REQUIRED,
  });

  return sources;
}

/**
 * Пороги свежести корпуса.
 *
 * Почему два, а не один. Отставание на сутки-двое — нормальная жизнь: биржа
 * бывает недоступна, шаг дозаписи умышленно не роняет прогон. Ночь на
 * пятилетней истории с двухдневным хвостом остаётся честной ночью.
 *
 * А вот на длинной дистанции просроченность перестаёт быть косметикой:
 * инкубатор тянет свежие бары ПРЯМО С БИРЖИ, а скрин считает по замороженному
 * корпусу — и они начинают жить в разных временах. Кандидат отбирается на
 * одном рынке, а догоняется на другом, то есть форвард измеряет не то, что
 * отбор. Две недели — не круглое число, а измеренная длительность реальной
 * аварии: столько корпус простоял незамеченным.
 */
const CORPUS_WARN_DAYS = 3;
const CORPUS_FAIL_DAYS = 14;

export interface FreshnessVerdict {
  ageDays: number | null;
  newestIso: string | null;
  laggingSymbols: number;
  level: "ok" | "warn" | "fail" | "unknown";
}

/** Свежесть корпуса с вердиктом — для статуса, тревог и предполётной проверки. */
export function corpusFreshnessVerdict(now = Date.now()): FreshnessVerdict {
  const { newestIso, ageDays, laggingSymbols } = corpusFreshness(corpusRoot(), now);
  const level =
    ageDays === null
      ? "unknown"
      : ageDays >= CORPUS_FAIL_DAYS
        ? "fail"
        : ageDays >= CORPUS_WARN_DAYS
          ? "warn"
          : "ok";
  return { ageDays, newestIso, laggingSymbols, level };
}

/**
 * Печатает рынок живых баров рядом с версией корпуса.
 *
 * Существует потому, что эти две настройки уже разъезжались молча: путь к
 * манифесту в `binance.ts` был прибит к `public/data/history`, а корпус
 * переехал в кэш раннера — функция перестала находить манифест и вернула
 * СПОТ, пока скрин считал по перпам. Обе половины машины при этом рапортовали
 * успех. Единственная защита от повторения — показывать пару вместе на каждом
 * прогоне, а не проверять каждую по отдельности.
 */
export function reportLiveMarket(): void {
  const perp = klinesUrlFromCorpus().includes("fapi");
  console.error(`рынок: корпус ${corpusVersion(corpusRoot())}, живые бары — ${perp ? "перпы" : "спот"}`);
  if (marketIsAssumed(corpusRoot())) {
    console.error(
      "⚠️ манифеста корпуса нет — рынок ПРЕДПОЛОЖЕН спотовым, а не установлен. " +
        "Если корпус фьючерсный, инкубатор догоняет не тот рынок. " +
        "Чинить: npx tsx researcher/collect-candles.ts --scan",
    );
  }
}

/**
 * Падает, если хоть один источник недоступен. Вызывать в НАЧАЛЕ прогона:
 * секунда проверки против ночи испытаний, записанных в журнал как выводы.
 *
 * `process.exit` здесь неуместен — бросаем, чтобы вызывающий мог решить
 * (тесты и разовые утилиты имеют право работать без собранных данных).
 */
export function assertDataSources(opts: PreflightOptions = {}): void {
  const requireCorpusFiles = opts.requireCorpusFiles ?? true;
  const health = dataSourceHealth();
  const broken = health
    .filter((h) => !h.ok)
    .filter((h) => requireCorpusFiles || h.name !== "корпус свечей");

  // Рынок обязан быть УСТАНОВЛЕН, а не предположен — но только там, где
  // корпус выбран осознанно. Старый корпус в public/data/history манифеста не
  // имеет и доказанно спотовый: падать на нём было бы ложной тревогой.
  // А вот если на корпус указали переменной окружения (облако, кэш раннера) и
  // манифеста там нет — мы не знаем рынок, и угадывать нельзя.
  if (process.env.RESEARCHER_HISTORY_DIR && marketIsAssumed(corpusRoot())) {
    throw new Error(
      [
        `Предполётная проверка: рынок корпуса неизвестен — ${corpusRoot()}`,
        "Каталог указан явно через RESEARCHER_HISTORY_DIR, файлы свечей в нём есть,",
        "а манифеста нет. Спот и перпы дают РАЗНЫЕ цены (сверено байт в байт),",
        "и предположение здесь развело бы скрин с инкубатором молча.",
        "",
        "Чинить: npx tsx researcher/collect-candles.ts --scan — он пересоберёт манифест",
        "по фактическому содержимому каталога.",
      ].join("\n"),
    );
  }

  const fresh = corpusFreshnessVerdict();
  if (broken.length === 0) {
    // Просроченность корпуса останавливает ТОЛЬКО того, кто по нему считает.
    // Часовой тик берёт бары с биржи, и мёртвый корпус ему не мешает.
    if (fresh.level === "fail" && requireCorpusFiles) {
      throw new Error(
        [
          "Предполётная проверка: корпус свечей просрочен.",
          `  самый свежий бар: ${fresh.newestIso} (${fresh.ageDays!.toFixed(1)} сут назад)`,
          `  порог остановки: ${CORPUS_FAIL_DAYS} сут`,
          "",
          "Прогон ОСТАНОВЛЕН намеренно. Инкубатор тянет свежие бары прямо с биржи,",
          "а скрин считал бы по замороженному корпусу — кандидат отбирался бы на",
          "одном рынке, а догонялся на другом, и форвард измерял бы не то, что отбор.",
          "",
          `Чинить: шаг «Top up corpus from exchange» (RESEARCHER_HISTORY_DIR = ${corpusRoot()}).`,
          "Он намеренно continue-on-error, поэтому его падение видно только здесь.",
        ].join("\n"),
      );
    }
    reportLiveMarket();
    // Просроченность в пределах нормы — это НЕ повод останавливать ночь, но
    // молчать о ней нельзя: именно молчание и дало двухнедельный простой.
    if (fresh.level === "warn") {
      console.warn(
        `⚠️ корпус отстаёт на ${fresh.ageDays!.toFixed(1)} сут (последний бар ${fresh.newestIso}); ` +
          `порог остановки — ${CORPUS_FAIL_DAYS} сут`,
      );
    }
    return;
  }

  const lines = broken.map(
    (h) =>
      `  ${h.name}: ${h.exists ? `каталог есть, но файлов ${h.files} < ${h.required}` : "КАТАЛОГА НЕТ"} — ${h.dir}`,
  );
  throw new Error(
    [
      "Предполётная проверка: источники данных недоступны.",
      ...lines,
      "",
      `COLLECT_DIR = ${process.env.COLLECT_DIR ?? "(не задан, взят дефолт ~/.chartlab/data-repo/market)"}`,
      `RESEARCHER_HISTORY_DIR = ${process.env.RESEARCHER_HISTORY_DIR ?? "(не задан, взят дефолт public/data/history)"}`,
      "",
      "Прогон ОСТАНОВЛЕН намеренно. Испытания без источника дали бы ноль сделок,",
      "и это записалось бы в журнал как вывод о рынке, а не как поломка окружения.",
      "",
      "Куда смотреть:",
      "  фандинг и метрики — COLLECT_DIR и монтирование приватного data-репо;",
      "  корпус свечей — RESEARCHER_HISTORY_DIR и шаг дозаписи с биржи",
      "  (в облаке корпус лежит в кэше раннера, а не в git: он воспроизводим).",
    ].join("\n"),
  );
}
