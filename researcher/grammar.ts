/**
 * Закрытая типизированная грамматика пространства стратегий исследователя.
 *
 * Требование владельца: искать как аналитик — конфлюэнс (сетап + независимые
 * подтверждения из РАЗНЫХ семейств), а не одиночный индикатор. Одиночные
 * сигналы в пространстве есть, но сетапы, помеченные requiresContext, обязаны
 * идти с фильтром-контекстом, и максимум один фильтр берётся из каждого
 * семейства: три осциллятора об одном и том же — это одно подтверждение.
 *
 * Пространство ЗАКРЫТО и исчислимо (grammarSize() считает его точно), поэтому
 * каждая попытка учитывается в журнале испытаний и дефляция (DSR, нуль-модель)
 * честна. Параметры сеток грубые и НАВСЕГДА одинаковы для всех символов —
 * межсимвольная ширина остаётся главной защитой от переподгонки.
 *
 * Модуль генерирует StrategyConfig для того же evaluator, которым считает
 * бэктест и комитет — инвариант паритета: скрин, инкубатор и живой скан
 * исполняют одни и те же правила одним и тем же кодом.
 */
import type {
  ConditionAtom,
  ConditionGroup,
  Interval,
  StrategyConfig,
} from "../src/core/types/index.ts";

export type SignalTf = Extract<Interval, "1h" | "4h" | "1d">;
export type Direction = "long" | "short";
export type FilterFamily = "trend" | "momentum" | "volatility" | "volume" | "location";

export const SIGNAL_TFS: readonly SignalTf[] = ["1h", "4h", "1d"];
const DIRECTIONS: readonly Direction[] = ["long", "short"];
const FILTER_FAMILIES: readonly FilterFamily[] = [
  "trend",
  "momentum",
  "volatility",
  "volume",
  "location",
];

/** Больше трёх подтверждений не берём: каждое условие режет выборку сделок
 * и умножает число испытаний — планка шума растёт быстрее качества. */
export const MAX_FILTERS = 3;

interface FilterDef {
  id: string;
  family: FilterFamily;
  build: (dir: Direction) => ConditionAtom;
}

const up = (dir: Direction) => dir === "long";

export const FILTERS: readonly FilterDef[] = [
  {
    id: "trend_sma200",
    family: "trend",
    build: (d) => ({
      kind: "comparison",
      left: { kind: "close" },
      op: up(d) ? ">" : "<",
      right: { kind: "sma", period: 200 },
    }),
  },
  {
    id: "trend_adx20",
    family: "trend",
    build: () => ({
      kind: "comparison",
      left: { kind: "adx", period: 14, line: "adx" },
      op: ">",
      right: 20,
    }),
  },
  {
    id: "trend_adx25",
    family: "trend",
    build: () => ({
      kind: "comparison",
      left: { kind: "adx", period: 14, line: "adx" },
      op: ">",
      right: 25,
    }),
  },
  {
    id: "mom_rsi_regime",
    family: "momentum",
    build: (d) => ({
      kind: "comparison",
      left: { kind: "rsi", period: 14 },
      op: up(d) ? ">" : "<",
      right: 50,
    }),
  },
  {
    id: "mom_macd_hist",
    family: "momentum",
    build: (d) => ({
      kind: "comparison",
      left: { kind: "macd", line: "histogram" },
      op: up(d) ? ">" : "<",
      right: 0,
    }),
  },
  {
    id: "mom_roc_sign",
    family: "momentum",
    build: (d) => ({
      kind: "comparison",
      left: { kind: "roc", period: 12 },
      op: up(d) ? ">" : "<",
      right: 0,
    }),
  },
  {
    id: "vol_squeeze",
    family: "volatility",
    build: () => ({
      kind: "comparison",
      left: { kind: "volPercentile", period: 20 },
      op: "<",
      right: 30,
    }),
  },
  {
    id: "vol_expansion",
    family: "volatility",
    build: () => ({
      kind: "comparison",
      left: { kind: "volPercentile", period: 20 },
      op: ">",
      right: 70,
    }),
  },
  {
    id: "vol_trending",
    family: "volatility",
    build: () => ({
      kind: "comparison",
      left: { kind: "choppiness", period: 14 },
      op: "<",
      right: 38.2,
    }),
  },
  {
    id: "volume_above_20",
    family: "volume",
    build: () => ({
      kind: "comparison",
      left: { kind: "close", field: "volume" },
      op: ">",
      right: { kind: "sma", period: 20, field: "volume" },
    }),
  },
  {
    id: "volume_above_50",
    family: "volume",
    build: () => ({
      kind: "comparison",
      left: { kind: "close", field: "volume" },
      op: ">",
      right: { kind: "sma", period: 50, field: "volume" },
    }),
  },
  {
    id: "loc_upper_half",
    family: "location",
    build: (d) => ({
      kind: "comparison",
      left: { kind: "close" },
      op: up(d) ? ">" : "<",
      right: { kind: "donchian", period: 20, line: "middle" },
    }),
  },
  {
    id: "loc_room_to_run",
    family: "location",
    build: (d) => ({
      kind: "comparison",
      left: { kind: "close" },
      op: up(d) ? "<" : ">",
      right: { kind: "keltner", period: 20, line: up(d) ? "upper" : "lower" },
    }),
  },
];

const FILTERS_BY_ID = new Map(FILTERS.map((f) => [f.id, f]));

export interface SetupDef {
  /**
   * На какой половине вселенной по ликвидности живёт семейство.
   * Разворот — только неликвидная половина, моментум — только ликвидная
   * (IRFA: усреднение по всем монетам гасит оба эффекта). Отсутствие поля —
   * вся вселенная.
   */
  universeTier?: "liquid" | "illiquid";
  id: string;
  /** Семейство сетапа — ключ приоров выборки и кластеров журнала. */
  family: string;
  /** Вес выборки из литературы: моментум/тренд/пробой чаще, сезонность реже. */
  prior: number;
  /** Конфлюэнс обязателен: хотя бы один фильтр из перечисленных семейств. */
  requiresContext?: readonly FilterFamily[];
  /** Семейства, дублирующие условие самого сетапа, — из комбо исключаются. */
  excludeFamilies?: readonly FilterFamily[];
  /**
   * ПЛАТЯЩАЯ СТОРОНА края — пункт 6 фазы 1 (политика бюджета). Испытания
   * получают ночной бюджет ТОЛЬКО при заполненном поле: без письменного
   * ответа «кто и почему отдаёт нам деньги» семейство не расходует попытки
   * и не поднимает планку дефляции остальным. Слепой перебор заморожен
   * политикой (learning-machine-v3, диагноз 0/44000). Поле — не заклинание:
   * оно обязано ссылаться на механизм из пре-регистрации семейства.
   */
  whoPays?: string;
  /**
   * Правило самодостаточно: комбинации фильтров НЕ перебираются вовсе.
   * Для семейств, где параметры живут в самом сетапе (ликвидити-магнит),
   * добавление 13 фильтров раздуло бы комбинаторику в 252 раза — ровно та
   * подгонка, от которой защищает пре-регистрация малого пространства.
   */
  fixedRule?: boolean;
  /**
   * Собственный пул выходов. Нужен там, где полная сетка из 27 комбинаций
   * дала бы правилу слишком много свободы: эффект расписания легко
   * «подтвердить» подбором тейка, если тейков много.
   */
  exits?: readonly ExitSpec[];
  build: (dir: Direction) => ConditionAtom[];
}

const BASE_SETUPS: readonly SetupDef[] = [
  {
    id: "trend_cross_50",
    family: "trend_following",
    prior: 3,
    build: (d) => [
      {
        kind: "crossover",
        direction: up(d) ? "above" : "below",
        a: { kind: "close" },
        b: { kind: "sma", period: 50 },
      },
    ],
  },
  {
    id: "trend_cross_100",
    family: "trend_following",
    prior: 3,
    build: (d) => [
      {
        kind: "crossover",
        direction: up(d) ? "above" : "below",
        a: { kind: "close" },
        b: { kind: "sma", period: 100 },
      },
    ],
  },
  {
    id: "donchian_breakout_20",
    family: "breakout",
    prior: 3,
    build: (d) => [
      {
        kind: "crossover",
        direction: up(d) ? "above" : "below",
        a: { kind: "close" },
        // shift:1 — канал БЕЗ текущего бара, иначе close ≤ high ≤ upper и
        // пробой невозможен по построению (см. комментарий к IndicatorRef).
        b: { kind: "donchian", period: 20, line: up(d) ? "upper" : "lower", shift: 1 },
      },
    ],
  },
  {
    id: "donchian_breakout_55",
    family: "breakout",
    prior: 3,
    build: (d) => [
      {
        kind: "crossover",
        direction: up(d) ? "above" : "below",
        a: { kind: "close" },
        b: { kind: "donchian", period: 55, line: up(d) ? "upper" : "lower", shift: 1 },
      },
    ],
  },
  {
    id: "squeeze_break_donchian",
    family: "breakout",
    prior: 3,
    excludeFamilies: ["volatility"],
    build: (d) => [
      { kind: "comparison", left: { kind: "volPercentile", period: 20 }, op: "<", right: 30 },
      {
        kind: "crossover",
        direction: up(d) ? "above" : "below",
        a: { kind: "close" },
        b: { kind: "donchian", period: 20, line: up(d) ? "upper" : "lower", shift: 1 },
      },
    ],
  },
  {
    id: "squeeze_break_keltner",
    family: "breakout",
    prior: 3,
    excludeFamilies: ["volatility"],
    build: (d) => [
      { kind: "comparison", left: { kind: "volPercentile", period: 20 }, op: "<", right: 30 },
      {
        kind: "crossover",
        direction: up(d) ? "above" : "below",
        a: { kind: "close" },
        b: { kind: "keltner", period: 20, line: up(d) ? "upper" : "lower" },
      },
    ],
  },
  {
    id: "pullback_rsi_40",
    family: "pullback",
    prior: 3,
    requiresContext: ["trend"],
    build: (d) => [
      {
        kind: "crossover",
        direction: up(d) ? "above" : "below",
        a: { kind: "rsi", period: 14 },
        b: up(d) ? 40 : 60,
      },
    ],
  },
  {
    id: "pullback_rsi_45",
    family: "pullback",
    prior: 3,
    requiresContext: ["trend"],
    build: (d) => [
      {
        kind: "crossover",
        direction: up(d) ? "above" : "below",
        a: { kind: "rsi", period: 14 },
        b: up(d) ? 45 : 55,
      },
    ],
  },
  {
    id: "momentum_roc_zero",
    family: "momentum",
    // Срез по ликвидности — пункт 3 фазы 1 (IRFA): см. universeTier в SetupDef.
    universeTier: "liquid",
    prior: 3,
    build: (d) => [
      {
        kind: "crossover",
        direction: up(d) ? "above" : "below",
        a: { kind: "roc", period: 12 },
        b: 0,
      },
    ],
  },
  {
    id: "momentum_macd_zero",
    family: "momentum",
    // Срез по ликвидности — пункт 3 фазы 1 (IRFA): см. universeTier в SetupDef.
    universeTier: "liquid",
    prior: 3,
    build: (d) => [
      {
        kind: "crossover",
        direction: up(d) ? "above" : "below",
        // без line — evaluator по умолчанию отдаёт главную линию MACD
        a: { kind: "macd" },
        b: 0,
      },
    ],
  },
  {
    id: "momentum_macd_signal",
    family: "momentum",
    // Срез по ликвидности — пункт 3 фазы 1 (IRFA): см. universeTier в SetupDef.
    universeTier: "liquid",
    prior: 3,
    build: (d) => [
      {
        kind: "crossover",
        direction: up(d) ? "above" : "below",
        a: { kind: "macd" },
        b: { kind: "macd", line: "signal" },
      },
    ],
  },
  {
    id: "divergence_rsi_30",
    family: "divergence",
    prior: 2,
    build: (d) => [
      { kind: "divergence", osc: "rsi", direction: up(d) ? "bullish" : "bearish", lookback: 30 },
    ],
  },
  {
    id: "divergence_macd_30",
    family: "divergence",
    prior: 2,
    build: (d) => [
      { kind: "divergence", osc: "macd", direction: up(d) ? "bullish" : "bearish", lookback: 30 },
    ],
  },
  {
    id: "pattern_pinbar",
    family: "pattern",
    prior: 1,
    requiresContext: ["trend", "location"],
    build: () => [{ kind: "priceAction", pattern: "pinbar", lookback: 5 }],
  },
  {
    id: "pattern_engulfing",
    family: "pattern",
    prior: 1,
    requiresContext: ["trend", "location"],
    build: () => [{ kind: "priceAction", pattern: "engulfing", lookback: 5 }],
  },
  {
    id: "meanrev_keltner_20",
    family: "mean_reversion",
    // Срез по ликвидности — пункт 3 фазы 1 (IRFA): см. universeTier в SetupDef.
    universeTier: "illiquid",
    prior: 2,
    build: (d) => [
      {
        kind: "crossover",
        direction: up(d) ? "above" : "below",
        a: { kind: "close" },
        b: { kind: "keltner", period: 20, line: up(d) ? "lower" : "upper" },
      },
    ],
  },
  {
    id: "meanrev_bollinger_20",
    family: "mean_reversion",
    // Срез по ликвидности — пункт 3 фазы 1 (IRFA): см. universeTier в SetupDef.
    universeTier: "illiquid",
    prior: 2,
    build: (d) => [
      {
        kind: "crossover",
        direction: up(d) ? "above" : "below",
        a: { kind: "close" },
        b: { kind: "bollinger", period: 20, line: up(d) ? "lower" : "upper" },
      },
    ],
  },
  {
    id: "seasonal_monday",
    family: "seasonality",
    prior: 0.5,
    requiresContext: ["trend", "momentum"],
    build: () => [{ kind: "time", dayOfWeek: [1] }],
  },
  {
    id: "seasonal_friday",
    family: "seasonality",
    prior: 0.5,
    requiresContext: ["trend", "momentum"],
    build: () => [{ kind: "time", dayOfWeek: [5] }],
  },
];


// ── Семейство «ликвидити-магнит» (стратегия владельца) ──────────────────────
// Пре-регистрация: docs/family-liquidity-magnet-preregistration.md.
// Параметры вынесены в сетапы, а не в фильтры: они и есть правило, а не
// подтверждение. 3 порога растянутости × 3 порога плотности × 2 окна = 18
// сетапов; вместе с 3 запасами стопа, 2 направлениями и 2 ТФ — ровно 216
// вариаций, как записано заранее.
const LIQ_STRETCH_ATRS = [1.5, 2.5, 3.5] as const;
const LIQ_MIN_WEIGHTS = [1, 2, 3] as const;
const LIQ_WINDOWS: readonly (readonly [number, number])[] = [
  [1, 6],
  [2, 10],
] as const;

export interface LiquidityParams {
  stretchAtr: number;
  minWeight: number;
  window: readonly [number, number];
}

const LIQ_PARAMS = new Map<string, LiquidityParams>();

function liquiditySetupId(p: LiquidityParams): string {
  return `liqmag_x${p.stretchAtr}_w${p.minWeight}_r${p.window[0]}-${p.window[1]}`;
}

const LIQUIDITY_SETUPS: readonly SetupDef[] = LIQ_STRETCH_ATRS.flatMap((stretchAtr) =>
  LIQ_MIN_WEIGHTS.flatMap((minWeight) =>
    LIQ_WINDOWS.map((window) => {
      const params: LiquidityParams = { stretchAtr, minWeight, window };
      const id = liquiditySetupId(params);
      LIQ_PARAMS.set(id, params);
      return {
        id,
        family: "liquidity_magnet",
        /*
         * ⚠️ ПОПРАВЛЕНО 2026-08-09. Раньше здесь стояло «перегруженные плечом
         * лонги: биржа закрывает их принудительно, их ликвидации — топливо
         * возврата». Это описывало НЕ ТОТ механизм, который меряет код.
         *
         * Проверено чтением `src/core/liquidations/clusterSeries.ts`: уровни —
         * это подтверждённые свинг-пивоты (строго выше трёх соседей с каждой
         * стороны), вес — число повторных подходов к той же цене в пределах
         * 0.25 ATR. Ни плеча, ни объёма, ни открытого интереса, ни формулы
         * цены ликвидации в расчёте нет вовсе. Расчётная карта ликвидаций
         * существует в репозитории ПРИЛОЖЕНИЯ, но исследовательский конвейер
         * её не импортирует ни в одной точке.
         *
         * Следствие, которое важно не потерять: 648 испытаний этого семейства
         * закрыли правило «растянутость + неснятый повторный пивот», а
         * гипотеза ликвидационного магнита не проверялась НИ РАЗУ. Считать те
         * 648 свидетельством против ликвидационной механики нельзя.
         */
        whoPays:
          "участники с защитными заявками на повторно подтверждённом ценовом уровне: " +
          "уровень читается всеми одинаково, потому что цена подходила к нему не раз и не пробила, " +
          "и заявки там накапливаются как координационный эффект; при касании они исполняются " +
          "принудительно и по цене, которую их владелец не выбирает",
        fixedRule: true,
        // Приор невелик: семейство новое и непроверенное, а перекос выборки
        // в его пользу был бы формой подгонки под ожидание владельца.
        prior: 2,
        // Контекстные фильтры не требуются и не исключаются: правило
        // самодостаточно (растянутость + магнит), фильтры лишь сужают.
        build: (dir: Direction): ConditionAtom[] => {
          // Шорт: цена растянута ВВЕРХ, магнит СНИЗУ. Лонг зеркально.
          const short = dir === "short";
          return [
            {
              kind: "stretch",
              period: 50,
              direction: short ? "above" : "below",
              minAtr: stretchAtr,
            },
            {
              kind: "liquidity",
              side: short ? "below" : "above",
              minAtr: window[0],
              maxAtr: window[1],
              minWeight,
            },
          ];
        },
      } satisfies SetupDef;
    }),
  ),
);


// ── Семейство «часы фандинга» ───────────────────────────────────────────────
// Пре-регистрация: docs/family-funding-hours-preregistration.md.
// Расчёт фандинга на Binance идёт в 00/08/16 UTC — это расписание, по
// которому деньги физически переходят между сторонами. Правило намеренно
// БЕЗ индикаторов: любой фильтр смешал бы эффект расписания с эффектом
// фильтра, и нельзя было бы сказать, что именно сработало.
const FUNDING_HOURS_UTC = [0, 8, 16] as const;

/** Урезанный пул выходов: 27 комбинаций дали бы сезонности слишком много свободы. */
const FUNDING_EXITS: readonly RrExit[] = [1, 2, 3].flatMap((takeR) =>
  [10, 20].map((maxBars) => ({ stopAtr: 2, takeR, maxBars })),
);

const FUNDING_SETUPS: readonly SetupDef[] = FUNDING_HOURS_UTC.map((hour) => ({
  id: `funding_hour_${String(hour).padStart(2, "0")}`,
  family: "funding_hours",
  whoPays:
    "стороны, обязанные платить фандинг по расписанию 00/08/16 UTC и ребалансирующиеся к расчёту (пре-регистрация семейства)",
  // Приор низкий: ожидание слабое, и эффект скорее всего съеден издержками.
  prior: 0.5,
  fixedRule: true,
  exits: FUNDING_EXITS,
  build: (): ConditionAtom[] => [{ kind: "time", hourRangeUtc: [hour, hour + 1] }],
}));

// ── Семейство «перегруженное плечо» ─────────────────────────────────────────
// Пре-регистрация: docs/family-funding-preregistration.md.
// Экстремальная ставка означает, что одна сторона рынка платит за право
// оставаться в позиции — тот же носитель причины, что у ликвидити-магнита.
// Сторона фандинга зафиксирована ВЫСОКОЙ: в крипте ставка положительна почти
// всегда, поэтому «перегружены шорты» — редкий хвост без выборки.
const FUND_WINDOWS_DAYS = [30, 90] as const;
const FUND_PERCENTILES = [80, 90, 95] as const;

/**
 * Гипотеза семейства про МОМЕНТ входа, а не про настройку выхода, поэтому
 * ширина стопа фиксирована, а варьируется только то, чего мы честно не знаем:
 * цель в R и горизонт удержания (за сколько разряжается перегруженность).
 */
const FUND_PRESSURE_EXITS: readonly RrExit[] = [1, 2, 3].flatMap((takeR) =>
  [10, 20, 40].map((maxBars) => ({ stopAtr: 2, takeR, maxBars })),
);

const fundPressureSetupId = (windowDays: number, percentile: number): string =>
  `fundpress_w${windowDays}_p${percentile}`;

/** Параметры сетапа по id — нужны соседям по сетке для ворот плато. */
const FUND_PARAMS = new Map<string, { windowDays: number; percentile: number }>(
  FUND_WINDOWS_DAYS.flatMap((windowDays) =>
    FUND_PERCENTILES.map(
      (percentile) =>
        [fundPressureSetupId(windowDays, percentile), { windowDays, percentile }] as const,
    ),
  ),
);

const FUNDING_PRESSURE_SETUPS: readonly SetupDef[] = FUND_WINDOWS_DAYS.flatMap((windowDays) =>
  FUND_PERCENTILES.map((percentile) => ({
    id: fundPressureSetupId(windowDays, percentile),
    family: "funding_pressure",
    whoPays:
      "сторона, платящая экстремальный фандинг за право оставаться в позиции; ex-ante ожидание распада carry записано в пре-регистрации",
    // Приор низкий: экстремумы фандинга — самый известный публичный индикатор
    // в крипте, и лёгкий край здесь давно бы съели.
    prior: 0.5,
    fixedRule: true,
    exits: FUND_PRESSURE_EXITS,
    // Направление сделки НЕ влияет на условие: сетап один и тот же, а лонг
    // против высокого фандинга — внутренний контроль к шорту.
    build: (): ConditionAtom[] => [
      { kind: "funding", direction: "above", percentile, windowDays },
    ],
  })),
);


// ── Семейство: свип границы недельного боковика (сетап владельца) ───────────
//
// Пре-регистрация ЗАМОРОЖЕНА до этого кода: docs/family-range-sweep-preregistration.md.
// Гипотеза словами владельца: инструмент несколько недель в боковике, затем
// импульс выносит верхнюю границу и снимает скопление стопов над ней; вход в
// шорт на выносе, цель — первый крупный столб ликвидности по пути.
//
// ⚠️ РЕШЕНИЕ ПО ДИСЦИПЛИНЕ, а не по лени: варьируется ТОЛЬКО новая величина —
// длина окна боковика. Растянутость, вес кластера и окно поиска магнита взяты
// серединами уже исследованных сеток liquidity_magnet и НЕ перебираются
// заново. Новая гипотеза — «режим боковика имеет значение», и она должна
// проверяться изолированно: перебор старых осей поверх новой раздул бы
// пространство в 18 раз и смешал бы два вопроса в один.
//
// Окно объявлено в БАРАХ, потому что привязки сетапа к таймфрейму в грамматике
// нет: 504 бара — три недели на 1ч, 126 — три недели на 4ч. Обе величины
// обоснованы механизмом, а не подобраны.
const RANGE_SWEEP_BARS = [126, 252, 504] as const;
/** Середины исследованных сеток liquidity_magnet — фиксированы намеренно. */
const RANGE_SWEEP_MIN_WEIGHT = 2;
const RANGE_SWEEP_WINDOW: readonly [number, number] = [2, 10];

const RANGE_SWEEP_PARAMS = new Map<string, number>();

const RANGE_SWEEP_SETUPS: readonly SetupDef[] = RANGE_SWEEP_BARS.map((bars) => {
  const id = `rangesweep_b${bars}`;
  RANGE_SWEEP_PARAMS.set(id, bars);
  return {
    id,
    family: "range_sweep",
    whoPays:
      "стопы шортов, стоявшие над границей боковика: их принудительное закрытие и есть топливо выноса, " +
      "и когда кластер выбран, покупателей по этим ценам не остаётся; плюс плечевой покупатель пробоя, " +
      "вошедший в уже снятую ликвидность — над ним пусто, и он становится вынужденным продавцом " +
      "(пре-регистрация family-range-sweep, механизм подтверждён владельцем 2026-08-09)",
    fixedRule: true,
    // Приор выше, чем у слепых семейств: гипотеза принесена владельцем с
    // собственным торговым опытом, а не порождена перебором. Но не высокий:
    // опыт — не доказательство, и семейство ещё ни разу не проверялось.
    prior: 3,
    build: (dir: Direction): ConditionAtom[] => {
      // Зеркальность сохранена, но механизм описан для ШОРТА на выносе ВВЕРХ.
      const short = dir === "short";
      const swept = short ? "upper" : "lower";
      const opposite = short ? "lower" : "upper";
      return [
        // 1. Боковик: за последние `bars` баров НЕ обновлён верх предыдущего
        //    такого же окна. Сдвиг 1 исключает сам бар выноса — иначе условие
        //    отменяло бы себя же.
        {
          kind: "comparison",
          left: { kind: "donchian", period: bars, line: swept, shift: 1 },
          op: short ? "<=" : ">=",
          right: { kind: "donchian", period: bars, line: swept, shift: 1 + bars },
        },
        // 2. …и низ тоже не обновлён: боковик — это отсутствие НОВОГО
        //    экстремума с ОБЕИХ сторон, иначе это тренд с паузой.
        {
          kind: "comparison",
          left: { kind: "donchian", period: bars, line: opposite, shift: 1 },
          op: short ? ">=" : "<=",
          right: { kind: "donchian", period: bars, line: opposite, shift: 1 + bars },
        },
        // 3. Вынос: цена вышла за границу боковика. Канал берётся со сдвигом 1
        //    (без текущего бара), иначе пробой невозможен по построению.
        {
          kind: "comparison",
          left: { kind: "close" },
          op: short ? ">" : "<",
          right: { kind: "donchian", period: bars, line: swept, shift: 1 },
        },
        // 4. Цель существует: крупное скопление ликвидности с ПРОТИВОПОЛОЖНОЙ
        //    стороны — тот самый «первый крупный столб», к которому, по словам
        //    владельца, рынок и идёт после снятия ликвидности.
        {
          kind: "liquidity",
          side: short ? "below" : "above",
          minAtr: RANGE_SWEEP_WINDOW[0],
          maxAtr: RANGE_SWEEP_WINDOW[1],
          minWeight: RANGE_SWEEP_MIN_WEIGHT,
        },
      ];
    },
  } satisfies SetupDef;
});

/*
 * ── Свип границы боковика, версия 2 ──────────────────────────────────────────
 *
 * Отдельное семейство, а не правка первого: 108 испытаний v1 лежат в журнале
 * со своим вердиктом, и переиспользовать имя значило бы смешать два разных
 * правила в одной родословной — а родословная теперь определяет планку
 * дефляции.
 *
 * Что изменено против v1 и почему (пре-регистрация family-range-sweep-v2):
 *
 * 1. УБРАНО требование, чтобы скопление ликвидности с противоположной стороны
 *    уже существовало в момент выноса. Оно сужало семейство в 8 раз (0.12
 *    против 0.99 сделки на монету в год) и неверно по существу: владелец
 *    входит на выносе, а рынок идёт собирать ликвидность ПОСЛЕ. Это было
 *    следствие механизма, превращённое во входное условие, — заодно
 *    подглядывание в будущее на уровне замысла. Кластер остаётся способом
 *    ВЫХОДА, где ему и место.
 *
 * 2. ЗАЖАТОСТЬ стала ОСЬЮ сетки, а не константой. «Боковик» по описанию
 *    двусторонен, но двусторонность — половина сужения. Честный выход не
 *    угадывать, а объявить обе точки ДО прогона и заплатить бюджетом проб.
 */
const RANGE_SWEEP2_SIDES = ["swept", "both"] as const;
type RangeSweep2Side = (typeof RANGE_SWEEP2_SIDES)[number];

/** Сопровождение сделки: половина на 0.5R, стоп в безубыток. */
export const RANGE_SWEEP2_SCALE_OUT = { atR: 0.5, fraction: 0.5, toBreakeven: true } as const;

const rangeSweep2Id = (bars: number, side: RangeSweep2Side) => `rangesweep2_b${bars}_${side}`;
const RANGE_SWEEP2_PARAMS = new Map<string, { bars: number; side: RangeSweep2Side }>();

const RANGE_SWEEP2_SETUPS: readonly SetupDef[] = RANGE_SWEEP_BARS.flatMap((bars) =>
  RANGE_SWEEP2_SIDES.map((side): SetupDef => {
    const id = rangeSweep2Id(bars, side);
    RANGE_SWEEP2_PARAMS.set(id, { bars, side });
    return {
      id,
      family: "range_sweep_v2",
      whoPays:
        "стопы шортов, стоявшие над границей боковика: их принудительное закрытие и есть топливо выноса, " +
        "и когда кластер выбран, покупателей по этим ценам не остаётся; плюс плечевой покупатель пробоя, " +
        "вошедший в уже снятую ликвидность — над ним пусто, и он становится вынужденным продавцом " +
        "(механизм подтверждён владельцем, пре-регистрация family-range-sweep-v2)",
      fixedRule: true,
      // Тот же приор, что у v1: гипотеза принесена владельцем с собственным
      // торговым опытом. Не выше — опыт не доказательство, и первая версия
      // правила края не показала.
      prior: 3,
      build: (dir: Direction): ConditionAtom[] => {
        const short = dir === "short";
        const swept = short ? "upper" : "lower";
        const opposite = short ? "lower" : "upper";
        const atoms: ConditionAtom[] = [
          // Граница не обновлялась: верх последних `bars` баров не выше верха
          // предыдущего такого же окна. Сдвиг 1 исключает сам бар выноса.
          {
            kind: "comparison",
            left: { kind: "donchian", period: bars, line: swept, shift: 1 },
            op: short ? "<=" : ">=",
            right: { kind: "donchian", period: bars, line: swept, shift: 1 + bars },
          },
        ];
        if (side === "both") {
          atoms.push({
            kind: "comparison",
            left: { kind: "donchian", period: bars, line: opposite, shift: 1 },
            op: short ? ">=" : "<=",
            right: { kind: "donchian", period: bars, line: opposite, shift: 1 + bars },
          });
        }
        // Вынос: цена вышла за границу боковика.
        atoms.push({
          kind: "comparison",
          left: { kind: "close" },
          op: short ? ">" : "<",
          right: { kind: "donchian", period: bars, line: swept, shift: 1 },
        });
        return atoms;
      },
    };
  }),
);

/*
 * ── Свип v3: вход ПЕРВОЙ версии плюс сопровождение ───────────────────────────
 *
 * Единственная непроверенная комбинация. v1 гонялась с фильтром «цель
 * существует», но без сопровождения (движок его не умел). v2 — с
 * сопровождением, но без фильтра, и оказалась ХУЖЕ: матожидание до издержек
 * ушло с +0.0245R на −0.0360R. То есть фильтр нёс информацию, а я поменял в
 * одном опыте две вещи сразу и не смог сказать, что на что повлияло.
 *
 * v3 исправляет это единственно честным способом: берёт вход v1 БЕЗ ЕДИНОГО
 * изменения и добавляет ровно одну новую вещь — сопровождение.
 *
 * Вход не копируется, а ПЕРЕИСПОЛЬЗУЕТСЯ (`build` первой версии), чтобы он
 * физически не мог разойтись при будущих правках: копия рано или поздно
 * разъезжается молча, и тогда сравнение v1 против v3 перестанет быть
 * сравнением одной переменной.
 */
const rangeSweep3Id = (bars: number) => `rangesweep3_b${bars}`;
const RANGE_SWEEP3_PARAMS = new Map<string, number>();

const RANGE_SWEEP3_SETUPS: readonly SetupDef[] = RANGE_SWEEP_SETUPS.map((v1) => {
  const bars = RANGE_SWEEP_PARAMS.get(v1.id)!;
  const id = rangeSweep3Id(bars);
  RANGE_SWEEP3_PARAMS.set(id, bars);
  return {
    ...v1,
    id,
    family: "range_sweep_v3",
    whoPays: v1.whoPays,
    // build берётся у v1 как есть — см. комментарий выше.
  };
});

export const SETUPS: readonly SetupDef[] = [
  ...BASE_SETUPS,
  ...LIQUIDITY_SETUPS,
  ...FUNDING_SETUPS,
  ...FUNDING_PRESSURE_SETUPS,
  ...RANGE_SWEEP_SETUPS,
  ...RANGE_SWEEP2_SETUPS,
  ...RANGE_SWEEP3_SETUPS,
];

/**
 * Соседи сетапа по СЕТКЕ ПАРАМЕТРОВ семейства — ±1 шаг по одному измерению.
 * Нужны воротам плато: у этого семейства почти вся параметризация живёт в
 * сетапе, а не в выходе, поэтому без этого у кандидата было бы меньше трёх
 * соседей и плато отсекло бы семейство целиком, ничего не проверив.
 * Для остальных семейств — пусто: их соседи задаются сеткой выходов.
 */
export function setupNeighbors(setupId: string): string[] {
  // Соседи по длине окна боковика — единственной варьируемой оси семейства.
  // Без них ворота плато отсекли бы весь свип, не проверив ни одного правила.
  const rangeBars = RANGE_SWEEP_PARAMS.get(setupId);
  if (rangeBars !== undefined) {
    const i = RANGE_SWEEP_BARS.indexOf(rangeBars as (typeof RANGE_SWEEP_BARS)[number]);
    return [-1, 1]
      .map((d) => RANGE_SWEEP_BARS[i + d])
      .filter((v): v is (typeof RANGE_SWEEP_BARS)[number] => v !== undefined)
      .map((v) => `rangesweep_b${v}`);
  }

  // Соседи v3 — та же единственная ось, что и у v1.
  const rs3 = RANGE_SWEEP3_PARAMS.get(setupId);
  if (rs3 !== undefined) {
    const i = RANGE_SWEEP_BARS.indexOf(rs3 as (typeof RANGE_SWEEP_BARS)[number]);
    return [-1, 1]
      .map((d) => RANGE_SWEEP_BARS[i + d])
      .filter((v): v is (typeof RANGE_SWEEP_BARS)[number] => v !== undefined)
      .map((v) => rangeSweep3Id(v));
  }

  // Соседи v2 — по той же единственной варьируемой оси (длина окна), внутри
  // своего режима зажатости: плато обязано мерить устойчивость ПРАВИЛА, а не
  // прыжок между двумя разными определениями боковика.
  const rs2 = RANGE_SWEEP2_PARAMS.get(setupId);
  if (rs2) {
    const i = RANGE_SWEEP_BARS.indexOf(rs2.bars as (typeof RANGE_SWEEP_BARS)[number]);
    return [-1, 1]
      .map((d) => RANGE_SWEEP_BARS[i + d])
      .filter((v): v is (typeof RANGE_SWEEP_BARS)[number] => v !== undefined)
      .map((v) => rangeSweep2Id(v, rs2.side));
  }

  const fund = FUND_PARAMS.get(setupId);
  if (fund) {
    // Без соседей плато отсекло бы семейство, ничего не проверив: у выхода
    // варьируются два измерения, но плато смотрит на устойчивость ПРАВИЛА.
    const out: string[] = [];
    for (const w of FUND_WINDOWS_DAYS) {
      if (w !== fund.windowDays) out.push(fundPressureSetupId(w, fund.percentile));
    }
    const i = (FUND_PERCENTILES as readonly number[]).indexOf(fund.percentile);
    for (const d of [-1, 1]) {
      const j = i + d;
      if (j >= 0 && j < FUND_PERCENTILES.length) {
        out.push(fundPressureSetupId(fund.windowDays, FUND_PERCENTILES[j]));
      }
    }
    return out.filter((id) => FUND_PARAMS.has(id));
  }

  const p = LIQ_PARAMS.get(setupId);
  if (!p) return [];
  const out: string[] = [];
  const step = <T,>(grid: readonly T[], current: T, make: (v: T) => LiquidityParams) => {
    const i = grid.indexOf(current);
    for (const d of [-1, 1]) {
      const j = i + d;
      if (j < 0 || j >= grid.length) continue;
      const id = liquiditySetupId(make(grid[j]));
      if (LIQ_PARAMS.has(id)) out.push(id);
    }
  };
  step(LIQ_STRETCH_ATRS, p.stretchAtr as (typeof LIQ_STRETCH_ATRS)[number], (v) => ({ ...p, stretchAtr: v }));
  step(LIQ_MIN_WEIGHTS, p.minWeight as (typeof LIQ_MIN_WEIGHTS)[number], (v) => ({ ...p, minWeight: v }));
  step(LIQ_WINDOWS, LIQ_WINDOWS.find((w) => w[0] === p.window[0] && w[1] === p.window[1])!, (v) => ({
    ...p,
    window: v,
  }));
  return out;
}

/** Выходы, допустимые для сетапа: у семейства — свои, уровневые. */
export function exitsFor(setupId: string): readonly ExitSpec[] {
  // Свип боковика выходит ПО ЛИКВИДНОСТИ, как и магнит: цель — столб, а не
  // фиксированное R. Общий пул выходов здесь не подошёл бы по смыслу.
  if (LIQ_PARAMS.has(setupId) || RANGE_SWEEP_PARAMS.has(setupId) || RANGE_SWEEP2_PARAMS.has(setupId) || RANGE_SWEEP3_PARAMS.has(setupId))
    return LIQUIDITY_EXITS;
  const own = SETUPS.find((s) => s.id === setupId)?.exits;
  return own ?? EXITS;
}

const SETUPS_BY_ID = new Map(SETUPS.map((s) => [s.id, s]));

/**
 * Выход кратностью риска: стоп в ATR, цель в R. `kind` опционален —
 * записи журнала эпох 1-2 его не несут, и их id обязаны читаться так же.
 */
export interface RrExit {
  kind?: "rr";
  stopAtr: number;
  takeR: number;
  maxBars: number;
}

/**
 * Выход от уровней ликвидности: стоп ЗА всей ликвидностью против сделки с
 * запасом в ATR, цель — не доходя до ближайшего скопления по ходу. Риск
 * здесь ПЕРЕМЕННЫЙ (зависит от расположения уровней), поэтому «takeR» у
 * такой стратегии не существует в принципе — см. обобщение ворот Уилсона.
 */
export interface LiquidityExit {
  kind: "liquidity";
  stopBufferAtr: number;
  targetPullAtr: number;
  maxBars: number;
  /**
   * Сколько доборов на скоплениях ПРОТИВ сделки. Ноль обязателен в сетке как
   * внутренний базлайн: без него нельзя сказать, дают ли доборы хоть что-то.
   * Риск нормирован — см. docs/family-scale-in-preregistration.md.
   */
  adds: number;
}

export type ExitSpec = RrExit | LiquidityExit;

export function isLiquidityExit(exit: ExitSpec): exit is LiquidityExit {
  return exit.kind === "liquidity";
}

const STOPS = [1.5, 2, 3] as const;
const TAKES = [1, 2, 3] as const;
const MAX_BARS = [10, 20, 40] as const;

export const EXITS: readonly RrExit[] = STOPS.flatMap((stopAtr) =>
  TAKES.flatMap((takeR) => MAX_BARS.map((maxBars) => ({ stopAtr, takeR, maxBars }))),
);

/** Запас за дальней ликвидностью, в ATR — первое измерение выхода семейства. */
const LIQ_STOP_BUFFERS = [0.25, 0.5, 1] as const;
/** Число доборов — второе измерение. Ноль обязателен как внутренний базлайн. */
const LIQ_SCALE_IN_ADDS = [0, 1, 2] as const;
/** Отступ цели не доходя до уровня и потолок баров — зафиксированы пре-регистрацией. */
const LIQ_TARGET_PULL = 0.2;
const LIQ_MAX_BARS = 40;

export const LIQUIDITY_EXITS: readonly LiquidityExit[] = LIQ_STOP_BUFFERS.flatMap((stopBufferAtr) =>
  LIQ_SCALE_IN_ADDS.map((adds) => ({
    kind: "liquidity" as const,
    stopBufferAtr,
    targetPullAtr: LIQ_TARGET_PULL,
    maxBars: LIQ_MAX_BARS,
    adds,
  })),
);

export interface CandidateSpec {
  setup: string;
  direction: Direction;
  timeframe: SignalTf;
  /** id фильтров в порядке FILTERS; ≤3, максимум один на семейство. */
  filters: readonly string[];
  exit: ExitSpec;
}

/** Канонический id: сам является полной записью спеки — хэш не нужен. */
export function candidateId(spec: CandidateSpec): string {
  const filters = spec.filters.length > 0 ? spec.filters.join("+") : "none";
  return `${spec.setup}|${spec.direction}|${spec.timeframe}|${filters}|${exitTag(spec.exit)}`;
}

/** Кодировка выхода в id. Форма rr неизменна с эпохи 1 — журнал сравним. */
function exitTag(exit: ExitSpec): string {
  if (isLiquidityExit(exit)) {
    // Суффикс добора появляется только при adds > 0: иначе id всех записей
    // ночи 03.08 поехали бы, и поведенческая дедупликация перестала бы их
    // узнавать — те же правила погнались бы второй раз как «новые».
    const scaleIn = exit.adds > 0 ? `a${exit.adds}` : "";
    return `q${exit.stopBufferAtr}p${exit.targetPullAtr}b${exit.maxBars}${scaleIn}`;
  }
  return `s${exit.stopAtr}t${exit.takeR}b${exit.maxBars}`;
}

/**
 * Поведенческий id — спека БЕЗ таймфрейма. Бэктест исполняет правило на
 * корпусе ночи, поэтому два кандидата, различающиеся только меткой ТФ,
 * дают побайтово одинаковые сделки. Дедупликация «правило уже гонялось на
 * этом корпусе» обязана сравнивать именно это, иначе одна идея сгорает из
 * журнала трижды (эпоха-1 так и потеряла ~⅔ бюджета каждой ночи).
 */
export function behavioralId(spec: CandidateSpec): string {
  const filters = spec.filters.length > 0 ? spec.filters.join("+") : "none";
  return `${spec.setup}|${spec.direction}|${filters}|${exitTag(spec.exit)}`;
}

/** Ключ корреляционного кластера по умолчанию (до настоящей кластеризации
 * по доходностям): семейство × ТФ × направление. */
export function defaultClusterKey(spec: CandidateSpec): string {
  return `${setupFamily(spec.setup)}:${spec.timeframe}:${spec.direction}`;
}

/** Срез вселенной для сетапа; undefined — вся вселенная. */
export function setupTier(setupId: string): "liquid" | "illiquid" | undefined {
  return SETUPS_BY_ID.get(setupId)?.universeTier;
}

/** Семейства, замороженные политикой бюджета (без платящей стороны). */
export function frozenFamilies(): string[] {
  return [...new Set(SETUPS.filter((s) => !s.whoPays).map((s) => s.family))].sort();
}

export function setupFamily(setupId: string): string {
  const setup = SETUPS_BY_ID.get(setupId);
  if (!setup) throw new Error(`неизвестный сетап: ${setupId}`);
  return setup.family;
}

/** Все допустимые комбо фильтров для сетапа (≤3, один на семейство,
 * requiresContext/excludeFamilies соблюдены). Мемоизировано. */
const combosCache = new Map<string, readonly (readonly string[])[]>();

export function filterCombosFor(setupId: string): readonly (readonly string[])[] {
  const cached = combosCache.get(setupId);
  if (cached) return cached;
  const setup = SETUPS_BY_ID.get(setupId);
  if (!setup) throw new Error(`неизвестный сетап: ${setupId}`);

  if (setup.fixedRule) {
    const only: (readonly string[])[] = [[]];
    combosCache.set(setupId, only);
    return only;
  }

  const families = FILTER_FAMILIES.filter((f) => !setup.excludeFamilies?.includes(f));
  const combos: (readonly string[])[] = [];

  const pick = (fromIdx: number, chosen: string[], chosenFamilies: FilterFamily[]) => {
    const satisfies =
      !setup.requiresContext || chosenFamilies.some((f) => setup.requiresContext!.includes(f));
    if (satisfies) combos.push([...chosen]);
    if (chosen.length >= MAX_FILTERS) return;
    for (let i = fromIdx; i < families.length; i++) {
      const family = families[i];
      for (const filter of FILTERS) {
        if (filter.family !== family) continue;
        chosen.push(filter.id);
        chosenFamilies.push(family);
        pick(i + 1, chosen, chosenFamilies);
        chosen.pop();
        chosenFamilies.pop();
      }
    }
  };
  pick(0, [], []);

  combosCache.set(setupId, combos);
  return combos;
}

/** Точный размер закрытого пространства — «каждая попытка исчислима». */
export function grammarSize(): number {
  // У семейства ликвидности свой набор выходов — считаем по сетапам.
  let total = 0;
  for (const setup of SETUPS) {
    total += filterCombosFor(setup.id).length * exitsFor(setup.id).length;
  }
  return total * DIRECTIONS.length * SIGNAL_TFS.length;
}

/**
 * Размер пространства, доступного НОВЫМ испытаниям, — то есть только семейства
 * с заполненной платящей стороной, и на ОДНОМ таймфрейме (ночь прогоняет
 * вселенные по очереди, каждая со своим корпусом).
 *
 * Нужен, чтобы отличить «сэмплер не дотянул случайно» от «тянуть больше
 * неоткуда». Без этого числа исчерпание пространства выглядит в отчёте как
 * обычная маленькая партия, и машина месяцами «работает», ничего не проверяя.
 */
export function fundableSpaceSize(): number {
  let total = 0;
  for (const setup of SETUPS) {
    if (!setup.whoPays) continue;
    total += filterCombosFor(setup.id).length * exitsFor(setup.id).length;
  }
  return total * DIRECTIONS.length;
}

/** Полное перечисление пространства (ленивое — для подсчётов и аудита). */
export function* enumerateAll(): Generator<CandidateSpec> {
  for (const setup of SETUPS) {
    for (const filters of filterCombosFor(setup.id)) {
      for (const direction of DIRECTIONS) {
        for (const timeframe of SIGNAL_TFS) {
          for (const exit of exitsFor(setup.id)) {
            yield { setup: setup.id, direction, timeframe, filters, exit };
          }
        }
      }
    }
  }
}

/** Детерминированный PRNG — одинаковый сид всегда даёт одинаковую партию. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SampleOptions {
  /**
   * Реальный ТФ прогона. Задан — каждый кандидат получает его вместо
   * случайной метки. До этой опции метка ТФ была фикцией: сэмплер тянул её
   * из трёх значений, а движок поле не читал — треть партии числилась «1d»
   * при том, что ночь 1d не запускалась ни разу.
   */
  tf?: SignalTf;
  /** Поведенческие id (без ТФ), уже РЕАЛЬНО прогнанные на корпусе этого ТФ. */
  excludeBehavioral?: ReadonlySet<string>;
  /**
   * Куда положить диагностику недобора. Сэмплер ОБЯЗАН уметь объяснить, почему
   * партия вышла меньше запроса: 400 000 холостых бросков подряд и молчаливый
   * возврат неполного списка выглядят в отчёте ровно как «сегодня нашлось
   * мало» — и так исчерпание пространства осталось незамеченным.
   */
  diagnostics?: SampleDiagnostics;
}

/** Заполняется сэмплером; поля осмысленны только после вызова. */
export interface SampleDiagnostics {
  requested: number;
  picked: number;
  /** Всё пространство финансируемых семейств на одном ТФ. */
  space: number;
  /**
   * Размер переданных множеств исключения. ВНИМАНИЕ: это весь журнал, а не
   * доля пространства — сравнивать с `space` напрямую нельзя (там все
   * семейства за всю историю, здесь только финансируемые на одном ТФ).
   */
  excludedSetSize: number;
  /** Броски, потраченные впустую: дубль или уже прогнанное правило. */
  wastedAttempts: number;
  /** Исчерпан ли лимит бросков — верный признак, что тянуть больше неоткуда. */
  attemptsExhausted: boolean;
}

/**
 * Выборка n УНИКАЛЬНЫХ кандидатов с приорами по семействам сетапов.
 * exclude — id, уже лежащие в журнале (их не выдаём повторно).
 */
export function sampleCandidates(
  seed: number,
  n: number,
  exclude?: ReadonlySet<string>,
  options?: SampleOptions,
): CandidateSpec[] {
  const rand = mulberry32(seed);
  // ПОЛИТИКА БЮДЖЕТА (пункт 6 фазы 1): новые испытания получают только
  // семейства с заполненной платящей стороной. Пространство грамматики при
  // этом НЕ сужается (enumerateAll/grammarSize нетронуты): журнал, дедуп и
  // дефляция продолжают считать всё пространство — замораживается только
  // расход НОВОГО бюджета на слепой перебор.
  const fundable = SETUPS.filter((s) => s.whoPays);
  const totalPrior = fundable.reduce((sum, s) => sum + s.prior, 0);
  const picked: CandidateSpec[] = [];
  const seen = new Set<string>();
  const maxAttempts = n * 200;
  let attemptsUsed = 0;

  for (let attempt = 0; attempt < maxAttempts && picked.length < n; attempt++) {
    attemptsUsed = attempt + 1;
    let roll = rand() * totalPrior;
    let setup = fundable[fundable.length - 1];
    for (const s of fundable) {
      roll -= s.prior;
      if (roll <= 0) {
        setup = s;
        break;
      }
    }
    const combos = filterCombosFor(setup.id);
    const spec: CandidateSpec = {
      setup: setup.id,
      direction: DIRECTIONS[Math.floor(rand() * DIRECTIONS.length)],
      // rand() зовётся в любом случае: детерминизм партии от сида не должен
      // зависеть от того, передан ли tf.
      timeframe: ((): SignalTf => {
        const rolled = SIGNAL_TFS[Math.floor(rand() * SIGNAL_TFS.length)];
        return options?.tf ?? rolled;
      })(),
      filters: combos[Math.floor(rand() * combos.length)],
      exit: (() => {
        const pool = exitsFor(setup.id);
        return pool[Math.floor(rand() * pool.length)];
      })(),
    };
    const id = candidateId(spec);
    if (seen.has(id) || exclude?.has(id)) continue;
    if (options?.excludeBehavioral?.has(behavioralId(spec))) continue;
    seen.add(id);
    picked.push(spec);
  }

  if (options?.diagnostics) {
    const d = options.diagnostics;
    d.requested = n;
    d.picked = picked.length;
    d.space = fundableSpaceSize();
    d.excludedSetSize = (exclude?.size ?? 0) + (options.excludeBehavioral?.size ?? 0);
    d.wastedAttempts = attemptsUsed - picked.length;
    d.attemptsExhausted = attemptsUsed >= maxAttempts && picked.length < n;
  }
  return picked;
}

/**
 * Спека → StrategyConfig для общего evaluator. Инвариант паритета: это
 * ЕДИНСТВЕННОЕ место, где грамматика превращается в исполняемые правила, —
 * и скрин, и инкубатор, и живой скан получают конфиг только отсюда.
 */
export function toStrategyConfig(spec: CandidateSpec): StrategyConfig {
  const setup = SETUPS_BY_ID.get(spec.setup);
  if (!setup) throw new Error(`неизвестный сетап: ${spec.setup}`);

  const entry: ConditionGroup = {
    operator: "AND",
    conditions: setup.build(spec.direction),
  };
  const filterAtoms = spec.filters.map((id) => {
    const filter = FILTERS_BY_ID.get(id);
    if (!filter) throw new Error(`неизвестный фильтр: ${id}`);
    return filter.build(spec.direction);
  });
  const filters: ConditionGroup | undefined =
    filterAtoms.length > 0 ? { operator: "AND", conditions: filterAtoms } : undefined;

  return {
    id: `researcher:${candidateId(spec)}`,
    ownerId: "researcher",
    name: candidateId(spec),
    timeframe: spec.timeframe,
    direction: spec.direction,
    symbols: [],
    entry,
    exit: {
      ...(isLiquidityExit(spec.exit)
        ? {
            stopLoss: { type: "liquidity" as const, value: spec.exit.stopBufferAtr },
            takeProfit: { type: "liquidity" as const, value: spec.exit.targetPullAtr },
            scaleInAdds: spec.exit.adds,
          }
        : {
            stopLoss: { type: "atr" as const, value: spec.exit.stopAtr },
            takeProfit: { type: "rr" as const, value: spec.exit.takeR },
          }),
      maxBarsInTrade: spec.exit.maxBars,
      // Сопровождение — свойство СЕМЕЙСТВА, а не ось сетки: разведочный замер
      // показал, что результат к уровню частичного тейка нечувствителен
      // (0.3/0.5/1.0R близки), и тратить на него бюджет проб значило бы
      // поднять планку всему семейству ни за что.
      ...(RANGE_SWEEP2_PARAMS.has(spec.setup) || RANGE_SWEEP3_PARAMS.has(spec.setup)
        ? { scaleOut: RANGE_SWEEP2_SCALE_OUT }
        : {}),
    },
    filters,
  };
}
