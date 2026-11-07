/**
 * Каталог механизмов «кто платит» — «мозг» исследователя без нейросети.
 *
 * Идея ставится в очередь не потому, что комбинация кубиков ещё не
 * перебиралась, а потому, что у неё есть ПЛАТЕЛЬЩИК: конкретная сторона,
 * которая по понятной причине систематически отдаёт деньги. Каталог описывает
 * эти стороны; генератор (brain.ts) собирает из них гипотезы
 * «механизм × доступные кубики × вселенная» и отсеивает негодное.
 *
 * Статусы:
 * - open        — механизм не проверялся; генератор вправе предлагать;
 * - refuted     — опровергнут нашими же замерами; генератор его НЕ предлагает.
 *                 Вернуть можно только наводкой владельца с НОВОЙ гипотезой
 *                 (другая причина, по которой платят), и это пишется в
 *                 пре-регистрацию — иначе это подбор порогов под проигравшее;
 * - closed      — закрыт собственным правилом остановки; то же, что refuted;
 * - in_grammar  — семейство уже живёт в грамматике и получает ночной бюджет;
 *                 гипотеза была бы дублем;
 * - in_progress — семейство строится в другой ветке; не дублируем.
 *
 * ⚠️ `plausibleEdgeBp` и `eventsPerSymbolYear` — грубые априорные оценки для
 * отсева «есть ли вообще смысл», а не прогноз. Ошибка в них стоит только
 * пропущенной или лишней ПРЕДЛОЖЕННОЙ идеи: в счётчик множественности идёт лишь
 * поставленная в прогон, а вердикт выносят ворота на данных.
 */
import type { SignalTf } from "./grammar.ts";

/** Виды данных. Совпадают с каталогами market/ в data-репо, кроме candles. */
export type DataKind =
  | "candles"
  | "funding"
  | "metrics"
  | "flow"
  | "orderflow15m"
  | "announcements"
  | "hlWhales"
  | "unlocks";

/**
 * Кубики — виды атомов условий в ядре (`ConditionAtom.kind`) плюс те, которых
 * ещё нет (тогда гипотеза требует кода и сама в прогон не уходит).
 */
export type CubeId =
  | "liquidity"
  | "sessionRange"
  | "time"
  | "stretch"
  | "funding"
  | "takerFlow"
  | "crowdTopDivergence"
  | "oiChange"
  | "topLongShort"
  | "forcedFlow"
  // нет в ядре на 2026-11-07:
  | "calendarMonthEnd"
  | "unlockCalendar"
  | "crossSectionRank";

/** Кубики, которые реально есть в ядре сегодня (src/core/types ConditionAtom). */
export const CORE_CUBES: readonly CubeId[] = [
  "liquidity",
  "sessionRange",
  "time",
  "stretch",
  "funding",
  "takerFlow",
  "crowdTopDivergence",
  "oiChange",
  "topLongShort",
  "forcedFlow",
];

export type MechanismStatus = "open" | "refuted" | "closed" | "in_grammar" | "in_progress";

export interface Refutation {
  /** Семейство в журнале или документе. */
  family: string;
  doc: string;
  evidence: string;
  date: string;
}

export interface Mechanism {
  id: string;
  title: string;
  /** Кто платит и почему он не может не платить. */
  whoPays: string;
  requiresData: readonly DataKind[];
  /** Альтернативные наборы кубиков, каждым из которых выражается триггер. */
  cubeSets: readonly (readonly CubeId[])[];
  /** Когда срабатывает. */
  trigger: string;
  directions: readonly ("long" | "short")[];
  /** В какую сторону и почему. */
  directionRule: string;
  /** Естественный выход: когда плательщик закончил платить. */
  naturalExit: string;
  exitType: "rr" | "trail" | "time";
  /** Таймфреймы, на которых механизм осмыслен. Свинг (4h/1d) в приоритете. */
  tfs: readonly SignalTf[];
  eventsPerSymbolYear: Partial<Record<SignalTf, number>>;
  plausibleEdgeBp: Partial<Record<SignalTf, number>>;
  holdHours: Partial<Record<SignalTf, number>>;
  universe: { tier?: "liquid" | "illiquid"; topN?: number };
  /** Слова для сопоставления наводок владельца (в нижнем регистре). */
  keywords: readonly string[];
  status: MechanismStatus;
  refutedBy?: readonly Refutation[];
  note?: string;
}

export const MECHANISMS: readonly Mechanism[] = [
  {
    id: "stops_beyond_level",
    title: "Стопы за уровнем",
    whoPays:
      "Трейдеры, поставившие стопы за очевидным уровнем (граница боковика, сессии, равные хаи): " +
      "их рыночные стопы дают ликвидность крупному участнику, который выбивает уровень и разворачивает.",
    requiresData: ["candles"],
    cubeSets: [["liquidity"], ["sessionRange"]],
    trigger: "Цена прокалывает уровень со скоплением стопов и закрывается обратно.",
    directions: ["long", "short"],
    directionRule: "Против прокола: прокол вверх — шорт, вниз — лонг.",
    naturalExit: "Противоположная граница диапазона или следующее скопление ликвидности.",
    exitType: "rr",
    tfs: ["4h", "1d", "1h"],
    eventsPerSymbolYear: { "1h": 40, "4h": 12, "1d": 3 },
    plausibleEdgeBp: { "1h": 25, "4h": 60, "1d": 150 },
    holdHours: { "1h": 15, "4h": 40, "1d": 120 },
    universe: {},
    keywords: ["стоп", "свип", "sweep", "уровень", "боковик", "равные хаи", "ликвидност", "выбив"],
    status: "refuted",
    refutedBy: [
      {
        family: "range_sweep v1–v3",
        doc: "family-range-sweep*-preregistration.md",
        evidence: "432 кандидата, 0 валидаций; v1 White RC p=0.53/0.82, v3 убит шириной и плато",
        date: "2026-08-09",
      },
      {
        family: "session_sweep",
        doc: "family-session-sweep-preregistration.md",
        evidence: "108 испытаний, до издержек −0.0034R на 128 символах; закрыто правилом остановки",
        date: "2026-08-19",
      },
      {
        family: "liquidity_magnet",
        doc: "family-liquidity-magnet-preregistration.md",
        evidence: "648 спек, нетто −0.09…−0.15R на всех весах скопления",
        date: "2026-08-09",
      },
      {
        family: "проверка дозы",
        doc: "mechanism-check-cluster-dose.md",
        evidence: "край не растёт с весом скопления — механизм не подтверждён",
        date: "2026-08-09",
      },
    ],
  },
  {
    id: "forced_liquidations",
    title: "Принудительные ликвидации",
    whoPays:
      "Позиции с плечом, которые движок биржи закрывает рынком без оглядки на цену; " +
      "после каскада цена должна вернуться.",
    requiresData: ["candles", "metrics"],
    cubeSets: [["forcedFlow"], ["oiChange"]],
    trigger: "Резкий сброс открытого интереса вместе с ценовым импульсом.",
    directions: ["long", "short"],
    directionRule: "Против каскада: выбило лонги — лонг, шорты — шорт.",
    naturalExit: "Возврат к уровню до каскада или 1–3 дня.",
    exitType: "time",
    tfs: ["4h", "1d", "1h"],
    eventsPerSymbolYear: { "1h": 30, "4h": 10, "1d": 3 },
    plausibleEdgeBp: { "1h": 30, "4h": 70, "1d": 150 },
    holdHours: { "1h": 6, "4h": 24, "1d": 72 },
    universe: {},
    keywords: ["ликвидац", "каскад", "делеверидж", "deleverage", "liquidation", "сброс oi", "вынос"],
    status: "refuted",
    refutedBy: [
      {
        family: "forced_flow_deleverage_fade",
        doc: "family-forced-flow-preregistration.md",
        evidence: "4192 события, нетто −0.35% за 6 ч, t = −10.7",
        date: "2026-08-17",
      },
      {
        family: "liquidation_cascade (черновик)",
        doc: "DRAFT-family-liquidation-cascade.md",
        evidence: "не регистрировать — тот же механизм; решение владельца, вариант B",
        date: "2026-11-07",
      },
    ],
  },
  {
    id: "funding_extreme_fade",
    title: "Плательщики фандинга — разворот на экстремуме",
    whoPays:
      "Перегруженная сторона перпа платит фандинг и в итоге закрывается; ставка на её капитуляцию " +
      "по одной монете во времени.",
    requiresData: ["candles", "funding"],
    cubeSets: [["funding"]],
    trigger: "Фандинг монеты в крайнем перцентиле своей истории.",
    directions: ["long", "short"],
    directionRule: "Против перегруженной стороны.",
    naturalExit: "Нормализация фандинга.",
    exitType: "time",
    tfs: ["4h", "1d"],
    eventsPerSymbolYear: { "4h": 20, "1d": 6 },
    plausibleEdgeBp: { "4h": 40, "1d": 100 },
    holdHours: { "4h": 24, "1d": 96 },
    universe: {},
    keywords: ["фандинг экстрем", "перегрет", "funding extreme"],
    status: "closed",
    refutedBy: [
      {
        family: "исследование фандинга (не пре-рег.)",
        doc: "funding-cross-section-study.md",
        evidence: "p95: n=331 550, нетто −0.078%, t=−8.4; p99: −0.074%, t=−4.8",
        date: "2026-08-17",
      },
    ],
  },
  {
    id: "funding_pressure",
    title: "Плательщики фандинга — давление (семейство в грамматике)",
    whoPays: "Перегруженное плечо платит фандинг держателям противоположной стороны.",
    requiresData: ["candles", "funding"],
    cubeSets: [["funding"]],
    trigger: "Фандинг в крайнем перцентиле плюс подтверждение цены.",
    directions: ["long", "short"],
    directionRule: "Против плательщика.",
    naturalExit: "Сетка выходов семейства.",
    exitType: "rr",
    tfs: ["4h", "1d"],
    eventsPerSymbolYear: { "4h": 20, "1d": 6 },
    plausibleEdgeBp: { "4h": 50, "1d": 120 },
    holdHours: { "4h": 40, "1d": 120 },
    universe: {},
    keywords: ["фандинг", "funding"],
    status: "in_grammar",
    note: "funding_pressure и funding_hours уже получают ночной бюджет.",
  },
  {
    id: "funding_carry_cross_section",
    title: "Плательщики фандинга — поперечный перекос",
    whoPays:
      "Монеты с самым дорогим лонговым фандингом переоценены толпой с плечом; корзина " +
      "«шорт дорогих / лонг дешёвых» получает и фандинг, и возврат перекоса.",
    requiresData: ["candles", "funding"],
    cubeSets: [["crossSectionRank", "funding"]],
    trigger: "Ежедневный ранг монет по фандингу; крайние децили.",
    directions: ["long", "short"],
    directionRule: "Шорт верхнего дециля, лонг нижнего.",
    naturalExit: "Ребалансировка через сутки.",
    exitType: "time",
    tfs: ["1d"],
    eventsPerSymbolYear: { "1d": 36 },
    plausibleEdgeBp: { "1d": 60 },
    holdHours: { "1d": 24 },
    universe: { tier: "liquid" },
    keywords: ["поперечн", "корзин", "кросс-секц", "cross-section", "ранг", "carry"],
    status: "open",
    note: "Исследование 2026-08-17 видело ≈+0.2%/день до издержек; нужен портфельный оценщик (P6).",
  },
  {
    id: "session_open_flow",
    title: "Открытие сессий",
    whoPays:
      "Институциональные потоки на открытии США/Европы исполняются рыночно в узкое окно и " +
      "двигают цену предсказуемо по направлению накопленного перекоса.",
    requiresData: ["candles", "flow"],
    cubeSets: [["time", "takerFlow"]],
    trigger: "Первые часы сессии при сильном перекосе агрессора в ту же сторону.",
    directions: ["long", "short"],
    directionRule: "По направлению агрессора.",
    naturalExit: "Конец окна сессии.",
    exitType: "time",
    tfs: ["1h"],
    eventsPerSymbolYear: { "1h": 60 },
    plausibleEdgeBp: { "1h": 15 },
    holdHours: { "1h": 4 },
    universe: { tier: "liquid" },
    keywords: ["сесси", "открыти", "нью-йорк", "лондон", "азия", "session open"],
    status: "open",
    note: "Сессионный уровень на 4h — фикция (бар пересекает границу), поэтому только 1h.",
  },
  {
    id: "month_end_rebalance",
    title: "Ребалансировка конца месяца",
    whoPays:
      "Фонды и ETF с фиксированными долями обязаны продать подорожавшее и докупить подешевевшее " +
      "в последние дни месяца — по календарю, а не по цене.",
    requiresData: ["candles"],
    cubeSets: [["calendarMonthEnd"]],
    trigger: "Последние 2 торговых дня месяца после сильного месячного движения.",
    directions: ["long", "short"],
    directionRule: "Против движения месяца.",
    naturalExit: "Первый день нового месяца.",
    exitType: "time",
    tfs: ["1d"],
    eventsPerSymbolYear: { "1d": 12 },
    plausibleEdgeBp: { "1d": 80 },
    holdHours: { "1d": 48 },
    universe: { topN: 20 },
    keywords: ["ребаланс", "конец месяца", "rebalanc", "квартал", "etf"],
    status: "open",
  },
  {
    id: "token_unlocks",
    title: "Разлоки токенов",
    whoPays:
      "Ранние инвесторы и команда получают разлоченные токены и продают их; рынок закладывает " +
      "давление заранее, а продают они после.",
    requiresData: ["candles", "unlocks"],
    cubeSets: [["unlockCalendar"]],
    trigger: "За N дней до крупного разлока (> 2% предложения).",
    directions: ["short"],
    directionRule: "Шорт до разлока.",
    naturalExit: "День разлока или через 3 дня после.",
    exitType: "time",
    tfs: ["1d"],
    eventsPerSymbolYear: { "1d": 4 },
    plausibleEdgeBp: { "1d": 250 },
    holdHours: { "1d": 168 },
    universe: { tier: "illiquid" },
    keywords: ["разлок", "unlock", "вестинг", "vesting"],
    status: "open",
    note: "Календаря разлоков в data-репо нет — без него идея не проходит проверку данных.",
  },
  {
    id: "crowd_vs_whales",
    title: "Толпа против китов",
    whoPays:
      "Розничная толпа набирает позицию против топ-трейдеров и оказывается выжатой.",
    requiresData: ["candles", "metrics"],
    cubeSets: [["crowdTopDivergence"], ["topLongShort"]],
    trigger: "Доля лонгов толпы и топ-трейдеров расходятся в крайних перцентилях.",
    directions: ["long", "short"],
    directionRule: "На стороне топ-трейдеров.",
    naturalExit: "Схождение долей или 1–3 дня.",
    exitType: "time",
    tfs: ["4h", "1d"],
    eventsPerSymbolYear: { "4h": 15, "1d": 5 },
    plausibleEdgeBp: { "4h": 60, "1d": 140 },
    holdHours: { "4h": 24, "1d": 72 },
    universe: {},
    keywords: ["толп", "кит", "whale", "топ-трейдер", "long/short", "лонг-шорт", "розниц"],
    status: "refuted",
    refutedBy: [
      {
        family: "crowd_top_divergence",
        doc: "family-crowd-top-divergence-preregistration.md",
        evidence: "все 12 вариантов сетки отрицательны",
        date: "2026-08-18",
      },
    ],
  },
  {
    id: "trapped_new_positions",
    title: "Запертые новые позиции",
    whoPays:
      "Те, кто массово открыл плечо (рост OI), а цена не пошла: у них отрицательный PnL и " +
      "фандинг против, их выход рыночными ордерами толкает цену против них.",
    requiresData: ["candles", "metrics", "funding"],
    cubeSets: [["oiChange", "funding"]],
    trigger: "Рост OI в верхнем перцентиле при фандинге в крайнем перцентиле той же стороны.",
    directions: ["long", "short"],
    directionRule: "Против запертой стороны: набирали лонги — шорт.",
    naturalExit: "Сброс OI обратно к уровню до набора или 5 дней.",
    exitType: "time",
    tfs: ["4h", "1d"],
    eventsPerSymbolYear: { "4h": 8, "1d": 3 },
    plausibleEdgeBp: { "4h": 120, "1d": 250 },
    holdHours: { "4h": 48, "1d": 120 },
    universe: {},
    keywords: ["запер", "trapped", "набор oi", "рост oi", "открытый интерес", "open interest"],
    status: "open",
    note:
      "Граница с forced_liquidations: вход ДО ликвидаций, по набору позиций (рост OI), " +
      "а не по их сбросу. Регистрация — только отдельной пре-регистрацией.",
  },
  {
    id: "aggressive_flow_absorption",
    title: "Поглощение агрессора (ордерфлоу)",
    whoPays: "Агрессивные рыночные покупатели/продавцы, чей поток поглощён лимитным крупняком.",
    requiresData: ["candles", "orderflow15m"],
    cubeSets: [["takerFlow"]],
    trigger: "Сильный перекос агрессора без движения цены.",
    directions: ["long", "short"],
    directionRule: "Против поглощённого агрессора.",
    naturalExit: "Сетка выходов семейства.",
    exitType: "rr",
    tfs: ["4h", "1h"],
    eventsPerSymbolYear: { "4h": 12, "1h": 40 },
    plausibleEdgeBp: { "4h": 60, "1h": 25 },
    holdHours: { "4h": 40, "1h": 15 },
    universe: { tier: "liquid" },
    keywords: ["ордерфлоу", "orderflow", "агрессор", "дельта", "cvd", "поглощ", "absorption"],
    status: "in_progress",
    note: "Семейство ордерфлоу строится в отдельной ветке.",
  },
];

const BY_ID = new Map(MECHANISMS.map((m) => [m.id, m]));

export function mechanismById(id: string): Mechanism | undefined {
  return BY_ID.get(id);
}

/** Опровергнутые и закрытые механизмы — генератор их сам не предлагает. */
export function isDeadMechanism(m: Mechanism): boolean {
  return m.status === "refuted" || m.status === "closed";
}
