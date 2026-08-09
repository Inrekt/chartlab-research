import type { Candle, StrategyConfig, TradeResult } from "../types";
import { EvaluationContext, sharedSeriesCacheFor } from "../strategy/evaluator";
import { cachedLiquidityFeatures, type LiquidityFeatures } from "../liquidations/clusterSeries";
import { atr as atrIndicator } from "../indicators";

interface PendingAdd {
  price: number;
  weight: number;
}

interface OpenPosition {
  direction: "long" | "short";
  entryTime: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  barsHeld: number;
  entryIndex: number;
  /** Суммарный исполненный объём в долях; без доборов ровно 1. */
  units: number;
  /** Σ (объём × цена) по всем исполненным входам — из него средняя цена. */
  costBasis: number;
  /**
   * Знаменатель R: ширина стопа от ПЕРВОГО входа на единичном объёме. Тот же,
   * что и у версии без добора, поэтому R-множители сравнимы напрямую.
   */
  riskBudget: number;
  /** Ещё не исполненные доборы, по возрастанию расстояния от входа. */
  pendingAdds: PendingAdd[];
  /**
   * P&L, уже зафиксированный частичным тейком (в валюте цены, не в R).
   * Складывается с результатом остатка в `closeTrade`.
   */
  realizedPnl: number;
  /** Цена частичного тейка; null — сопровождение не задано или уже сработало. */
  scaleOutPrice: number | null;
}

/**
 * Runs one strategy against one instrument's historical candles, bar by bar.
 * No look-ahead: entry conditions are evaluated using only data available at
 * bar close, and fills happen at the NEXT bar's open — the earliest price a
 * real order could realistically have filled at.
 */
export function runBacktest(candles: Candle[], config: StrategyConfig, symbol: string): TradeResult[] {
  if (candles.length < 2) return [];

  // Символ нужен атомам с внешними данными (фандинг) — по свечам его не узнать.
  const ctx = new EvaluationContext(candles, symbol);
  const atrSeries = atrSeriesFor(candles, config);
  const liq = exitNeedsLiquidity(config) ? cachedLiquidityFeatures(candles) : null;

  const trades: TradeResult[] = [];
  let open: OpenPosition | null = null;

  for (let i = 0; i < candles.length - 1; i++) {
    if (open) {
      const closed = advanceOpenPosition(candles, config, symbol, open, i);
      if (closed) {
        trades.push(closed);
        open = null;
      }
      continue;
    }

    const passesFilters = !config.filters || ctx.evaluateGroup(config.filters, i);
    if (passesFilters && ctx.evaluateGroup(config.entry, i)) {
      open = openPositionAt(candles, config, i, atrSeries, liq);
    }
  }

  return trades;
}

/**
 * Replays the SAME exit rules from a caller-supplied list of signal bars,
 * ignoring the strategy's entry conditions entirely.
 *
 * Exists for the committee's null model: to tell whether a template's edge is
 * real, you compare it against what these exits would have earned entering at
 * random on the same instrument. That comparison is only fair if the exit
 * machinery is byte-identical to the real backtest's — hence sharing
 * `openPositionAt` / `advanceOpenPosition` rather than reimplementing them.
 *
 * `entryIndices` are SIGNAL bars; fills happen at the next bar's open, exactly
 * as in `runBacktest`. Signals arriving while a position is open are skipped,
 * again matching the real engine — otherwise the null could stack overlapping
 * trades the strategy itself could never have taken.
 */
export function simulateExits(
  candles: Candle[],
  config: StrategyConfig,
  symbol: string,
  entryIndices: number[],
): TradeResult[] {
  if (candles.length < 2) return [];

  const atrSeries = atrSeriesFor(candles, config);
  const liq = exitNeedsLiquidity(config) ? cachedLiquidityFeatures(candles) : null;
  const wanted = new Set(entryIndices);
  const trades: TradeResult[] = [];
  let open: OpenPosition | null = null;

  for (let i = 0; i < candles.length - 1; i++) {
    if (open) {
      const closed = advanceOpenPosition(candles, config, symbol, open, i);
      if (closed) {
        trades.push(closed);
        open = null;
      }
      continue;
    }
    if (wanted.has(i)) open = openPositionAt(candles, config, i, atrSeries, liq);
  }

  return trades;
}

export function atrSeriesFor(candles: Candle[], config: StrategyConfig): (number | null)[] | null {
  if (config.exit.stopLoss.type !== "atr") return null;
  // ATR(14) не зависит от конфига вообще — но пересчитывался на КАЖДОГО
  // кандидата (2000 раз на символ за ночь). Живёт в общем кэше серий символа.
  const cache = sharedSeriesCacheFor(candles);
  let series = cache.get("engine:atr14");
  if (!series) {
    series = alignAtr(candles, atrIndicator(candles));
    cache.set("engine:atr14", series);
  }
  return series;
}

/** Нужны ли выходам уровни ликвидности (тогда ряд считается один раз на символ). */
export function exitNeedsLiquidity(config: StrategyConfig): boolean {
  return config.exit.stopLoss.type === "liquidity" || config.exit.takeProfit.type === "liquidity";
}

export interface EntryLevels {
  stopPrice: number;
  targetPrice: number;
  /** Расстояние до стопа — единица риска сделки. */
  risk: number;
}

/**
 * Стоп и цель для входа по цене `entryPrice` на сигнальном баре `signalIndex`.
 *
 * Вынесено из `openPositionAt` НЕ ради красоты: этой же функцией считается
 * живой сигнал. Пока расчёт один на двоих, торговый сигнал физически не может
 * разойтись с тем, что проверял бэктест. Скопируй эту логику во второе место —
 * и однажды они разъедутся молча.
 *
 * `null` означает, что сделки нет: риск неизмерим либо у стратегии нет цели.
 */
export function planEntryLevels(
  config: StrategyConfig,
  signalIndex: number,
  entryPrice: number,
  atrSeries: (number | null)[] | null,
  liq: LiquidityFeatures | null,
): EntryLevels | null {
  const long = config.direction === "long";

  // ── Стоп ────────────────────────────────────────────────────────────────
  let stopPrice: number;
  if (config.exit.stopLoss.type === "liquidity") {
    const atrValue = liq?.atrAt[signalIndex] ?? NaN;
    if (!Number.isFinite(atrValue) || atrValue <= 0) return null;
    const buffer = config.exit.stopLoss.value * atrValue;
    // «За всей ликвидностью»: за самым дальним живым скоплением ПРОТИВ сделки.
    const far = long ? liq!.farBelow[signalIndex] : liq!.farAbove[signalIndex];
    // Скоплений против сделки нет — стоп вырождается в обычный ATR-стоп той
    // же ширины. Иначе правило молча стало бы «без стопа».
    const base = Number.isFinite(far) ? far : entryPrice;
    stopPrice = long ? base - buffer : base + buffer;
  } else {
    const risk = computeRisk(config, entryPrice, atrSeries?.[signalIndex] ?? null);
    if (risk === null) return null;
    stopPrice = long ? entryPrice - risk : entryPrice + risk;
  }
  const risk = Math.abs(entryPrice - stopPrice);
  if (!(risk > 0)) return null;

  // ── Цель ────────────────────────────────────────────────────────────────
  let targetPrice: number;
  if (config.exit.takeProfit.type === "liquidity") {
    const atrValue = liq?.atrAt[signalIndex] ?? NaN;
    if (!Number.isFinite(atrValue) || atrValue <= 0) return null;
    const near = long ? liq!.nearAbove[signalIndex] : liq!.nearBelow[signalIndex];
    // Нет магнита впереди — сделки нет: у этой стратегии цель НЕ произвольна,
    // она и есть смысл входа.
    if (!Number.isFinite(near)) return null;
    // Отступ не доходя до уровня: толпа целится в сам уровень, исполнение там
    // худшее.
    const pull = config.exit.takeProfit.value * atrValue;
    targetPrice = long ? near - pull : near + pull;
    if (long ? targetPrice <= entryPrice : targetPrice >= entryPrice) return null;
  } else {
    const rewardDistance =
      config.exit.takeProfit.type === "rr"
        ? risk * config.exit.takeProfit.value
        : config.exit.takeProfit.type === "percent"
          ? entryPrice * (config.exit.takeProfit.value / 100)
          : config.exit.takeProfit.value;
    targetPrice = long ? entryPrice + rewardDistance : entryPrice - rewardDistance;
  }

  return { stopPrice, targetPrice, risk };
}

/** Opens a position filled at `signalIndex + 1`'s open, or null if risk is unknowable. */
function openPositionAt(
  candles: Candle[],
  config: StrategyConfig,
  signalIndex: number,
  atrSeries: (number | null)[] | null,
  liq: LiquidityFeatures | null,
): OpenPosition | null {
  const fillBar = candles[signalIndex + 1];
  const entryPrice = fillBar.open;

  const levels = planEntryLevels(config, signalIndex, entryPrice, atrSeries, liq);
  if (!levels) return null;
  const { stopPrice, targetPrice } = levels;

  // Доля вне (0;1) означала бы либо пустой тейк, либо обнуление позиции,
  // которая при этом продолжила бы жить до стопа. Конфиг строит наша же
  // грамматика, поэтому это ошибка программиста: падать надо сразу и громко,
  // а не мерить месяцами не то.
  const so = config.exit.scaleOut;
  if (so && !(so.fraction > 0 && so.fraction < 1)) {
    throw new Error(
      `scaleOut.fraction должна быть строго между 0 и 1, получено ${so.fraction}`,
    );
  }
  if (so && !(so.atR > 0)) {
    throw new Error(`scaleOut.atR должна быть положительной, получено ${so.atR}`);
  }

  const plan = planScaleIn(config, entryPrice, stopPrice, signalIndex, liq);

  return {
    direction: config.direction,
    entryTime: fillBar.time,
    entryPrice,
    stopPrice,
    targetPrice,
    barsHeld: 0,
    entryIndex: signalIndex + 1,
    units: plan.firstWeight,
    costBasis: plan.firstWeight * entryPrice,
    riskBudget: levels.risk,
    pendingAdds: plan.adds,
    realizedPnl: 0,
    // Уровень частичного тейка отсчитывается от ПЕРВОГО входа и ширины стопа
    // на единичном объёме — той же линейки, что и знаменатель R. Иначе
    // варианты с добором и без него мерились бы разными «R».
    scaleOutPrice: config.exit.scaleOut
      ? config.direction === "long"
        ? entryPrice + config.exit.scaleOut.atR * levels.risk
        : entryPrice - config.exit.scaleOut.atR * levels.risk
      : null,
  };
}

/**
 * Планирует доборы на скоплениях ликвидности ПРОТИВ сделки.
 *
 * Уровни известны в момент входа (это те же ближнее/дальнее скопление, что
 * уже считает движок) — дискреции в исполнении нет. Размеры подобраны так,
 * что при исполнении ВСЕХ доборов убыток на стопе равен ровно `riskBudget` —
 * столько же, сколько потеряла бы та же стратегия без добора. Поэтому первый
 * вход получается меньше единицы, и «лучше» не может получиться из-за просто
 * большей ставки.
 */
function planScaleIn(
  config: StrategyConfig,
  entryPrice: number,
  stopPrice: number,
  signalIndex: number,
  liq: LiquidityFeatures | null,
): { firstWeight: number; adds: PendingAdd[] } {
  const none = { firstWeight: 1, adds: [] as PendingAdd[] };
  const wanted = config.exit.scaleInAdds ?? 0;
  if (wanted <= 0 || !liq) return none;

  const long = config.direction === "long";
  const candidates = long
    ? [liq.nearBelow[signalIndex], liq.farBelow[signalIndex]]
    : [liq.nearAbove[signalIndex], liq.farAbove[signalIndex]];

  const levels: number[] = [];
  for (const price of candidates) {
    if (levels.length >= wanted) break;
    if (!Number.isFinite(price)) continue;
    // Строго между входом и стопом. Снаружи это уже не долив внутри живой
    // гипотезы, а другая сделка.
    const inside = long ? price < entryPrice && price > stopPrice : price > entryPrice && price < stopPrice;
    // Уровень один на обе роли — K=2 вырождается в K=1. Это не ошибка, а
    // отсутствие второго скопления.
    if (inside && !levels.includes(price)) levels.push(price);
  }
  if (levels.length === 0) return none;

  const riskBudget = Math.abs(entryPrice - stopPrice);
  const totalRisk = levels.reduce((sum, price) => sum + Math.abs(price - stopPrice), riskBudget);
  const weight = riskBudget / totalRisk;
  return { firstWeight: weight, adds: levels.map((price) => ({ price, weight })) };
}

/** Исполняет доборы, чьи уровни бар прошёл. Мутирует позицию, как и `barsHeld`. */
function fillPendingAdds(open: OpenPosition, bar: Candle): void {
  if (open.pendingAdds.length === 0) return;

  const stillPending: PendingAdd[] = [];
  for (const add of open.pendingAdds) {
    const touched = open.direction === "long" ? bar.low <= add.price : bar.high >= add.price;
    if (!touched) {
      stillPending.push(add);
      continue;
    }
    open.units += add.weight;
    open.costBasis += add.weight * add.price;
  }
  open.pendingAdds = stillPending;
}

/** Advances an open position by one bar; returns the closed trade, or null if still open. */
function advanceOpenPosition(
  candles: Candle[],
  config: StrategyConfig,
  symbol: string,
  open: OpenPosition,
  index: number,
): TradeResult | null {
  const bar = candles[index];
  open.barsHeld += 1;

  const hitStop = open.direction === "long" ? bar.low <= open.stopPrice : bar.high >= open.stopPrice;
  const hitTarget = open.direction === "long" ? bar.high >= open.targetPrice : bar.low <= open.targetPrice;
  const timedOut = config.exit.maxBarsInTrade != null && open.barsHeld >= config.exit.maxBarsInTrade;

  // Внутрибарный порядок тиков неизвестен, и от него зависит результат.
  // Трактуем сомнение ПРОТИВ стратегии: на баре стопа доборы считаются
  // исполненными (цена и правда обязана была пройти через них по дороге к
  // стопу, а убыток от этого полный, а не урезанный), на баре цели — нет
  // (иначе прибыль росла бы из одного предположения о порядке тиков, ведь
  // долив всегда улучшает среднюю цену).
  if (hitStop || !hitTarget) fillPendingAdds(open, bar);

  /*
   * Частичный тейк и перенос стопа в безубыток.
   *
   * Порядок тиков внутри бара неизвестен, и сомнение трактуется ПРОТИВ
   * стратегии — как и везде в этом движке. Поэтому на баре, где задет и стоп,
   * и уровень частичного тейка, считается, что первым сработал СТОП: позиция
   * уходит целиком в убыток, частичная фиксация не засчитывается. Иначе
   * прибыль росла бы из предположения о порядке тиков, а это ровно тот способ
   * приукрасить результат, который здесь запрещён.
   *
   * Перенос стопа к средней цене входа делается СРАЗУ, но на этом же баре уже
   * не проверяется: цена, дошедшая до уровня тейка, могла вернуться к входу в
   * том же баре, и мы бы не узнали. Проверка начнётся со следующего бара.
   */
  if (open.scaleOutPrice !== null && !hitStop) {
    const reached =
      open.direction === "long" ? bar.high >= open.scaleOutPrice : bar.low <= open.scaleOutPrice;
    if (reached) {
      const so = config.exit.scaleOut!;
      const closedUnits = open.units * so.fraction;
      const avgEntry = open.units > 0 ? open.costBasis / open.units : open.entryPrice;
      open.realizedPnl +=
        open.direction === "long"
          ? closedUnits * (open.scaleOutPrice - avgEntry)
          : closedUnits * (avgEntry - open.scaleOutPrice);
      open.units -= closedUnits;
      open.costBasis = open.units * avgEntry;
      open.scaleOutPrice = null;
      if (so.toBreakeven) open.stopPrice = avgEntry;
    }
  }

  if (!hitStop && !hitTarget && !timedOut) return null;
  // Гэп через стоп исполняется по ОТКРЫТИЮ, а не по цене стопа: если бар
  // открылся уже за стопом (каскад ликвидаций, ночная новость, разрыв
  // выходных на FX), цены стопа в этом баре не существовало, и выйти по
  // ней было физически нельзя. Считать иначе — обрезать левый хвост по
  // построению и приукрасить и skew карточки выпускника, и вероятность
  // нарушить дневной лимит проп-фирмы. Для цели такой поправки нет: гэп
  // в нашу пользу тоже исполняется по цели, а не по лучшему открытию,
  // иначе прибыль росла бы из предположения о порядке тиков.
  const stopFill =
    open.direction === "long"
      ? Math.min(bar.open, open.stopPrice)
      : Math.max(bar.open, open.stopPrice);
  const exitPrice = hitStop ? stopFill : hitTarget ? open.targetPrice : bar.close;
  return closeTrade(symbol, open, bar.time, exitPrice);
}

function computeRisk(config: StrategyConfig, entryPrice: number, atrValue: number | null): number | null {
  const { stopLoss } = config.exit;
  if (stopLoss.type === "atr") {
    if (atrValue === null) return null;
    return atrValue * stopLoss.value;
  }
  if (stopLoss.type === "percent") {
    return entryPrice * (stopLoss.value / 100);
  }
  return stopLoss.value; // fixed absolute price distance
}

function closeTrade(symbol: string, open: OpenPosition, exitTime: number, exitPrice: number): TradeResult {
  // Средняя цена позиции; без доборов units = 1 и это ровно цена входа.
  const avgEntry = open.units > 0 ? open.costBasis / open.units : open.entryPrice;
  // P&L взвешен по объёму, а знаменатель R — ширина стопа от ПЕРВОГО входа на
  // единичном объёме. Так вариант с добором и без него мерятся одной линейкой.
  // Уже зафиксированное частичным тейком складывается с результатом остатка:
  // без этого частичная фиксация просто исчезала бы из P&L.
  const pnl =
    open.realizedPnl +
    (open.direction === "long"
      ? open.units * exitPrice - open.costBasis
      : open.costBasis - open.units * exitPrice);
  const rMultiple = open.riskBudget === 0 ? 0 : pnl / open.riskBudget;

  return {
    symbol,
    direction: open.direction,
    entryTime: open.entryTime,
    entryPrice: avgEntry,
    exitTime,
    exitPrice,
    stopPrice: open.stopPrice,
    targetPrice: open.targetPrice,
    rMultiple,
    won: rMultiple > 0,
    barsHeld: open.barsHeld,
  };
}

function alignAtr(candles: Candle[], points: { time: number; value: number }[]): (number | null)[] {
  const byTime = new Map(points.map((p) => [p.time, p.value]));
  return candles.map((c) => byTime.get(c.time) ?? null);
}
