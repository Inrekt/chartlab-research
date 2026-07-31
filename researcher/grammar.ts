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
   * Правило самодостаточно: комбинации фильтров НЕ перебираются вовсе.
   * Для семейств, где параметры живут в самом сетапе (ликвидити-магнит),
   * добавление 13 фильтров раздуло бы комбинаторику в 252 раза — ровно та
   * подгонка, от которой защищает пре-регистрация малого пространства.
   */
  fixedRule?: boolean;
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

export const SETUPS: readonly SetupDef[] = [...BASE_SETUPS, ...LIQUIDITY_SETUPS];

/**
 * Соседи сетапа по СЕТКЕ ПАРАМЕТРОВ семейства — ±1 шаг по одному измерению.
 * Нужны воротам плато: у этого семейства почти вся параметризация живёт в
 * сетапе, а не в выходе, поэтому без этого у кандидата было бы меньше трёх
 * соседей и плато отсекло бы семейство целиком, ничего не проверив.
 * Для остальных семейств — пусто: их соседи задаются сеткой выходов.
 */
export function setupNeighbors(setupId: string): string[] {
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
  return LIQ_PARAMS.has(setupId) ? LIQUIDITY_EXITS : EXITS;
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

/** Запас за дальней ликвидностью, в ATR — единственное измерение выхода семейства. */
const LIQ_STOP_BUFFERS = [0.25, 0.5, 1] as const;
/** Отступ цели не доходя до уровня и потолок баров — зафиксированы пре-регистрацией. */
const LIQ_TARGET_PULL = 0.2;
const LIQ_MAX_BARS = 40;

export const LIQUIDITY_EXITS: readonly LiquidityExit[] = LIQ_STOP_BUFFERS.map((stopBufferAtr) => ({
  kind: "liquidity" as const,
  stopBufferAtr,
  targetPullAtr: LIQ_TARGET_PULL,
  maxBars: LIQ_MAX_BARS,
}));

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
    return `q${exit.stopBufferAtr}p${exit.targetPullAtr}b${exit.maxBars}`;
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
  const totalPrior = SETUPS.reduce((sum, s) => sum + s.prior, 0);
  const picked: CandidateSpec[] = [];
  const seen = new Set<string>();
  const maxAttempts = n * 200;

  for (let attempt = 0; attempt < maxAttempts && picked.length < n; attempt++) {
    let roll = rand() * totalPrior;
    let setup = SETUPS[SETUPS.length - 1];
    for (const s of SETUPS) {
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
          }
        : {
            stopLoss: { type: "atr" as const, value: spec.exit.stopAtr },
            takeProfit: { type: "rr" as const, value: spec.exit.takeR },
          }),
      maxBarsInTrade: spec.exit.maxBars,
    },
    filters,
  };
}
