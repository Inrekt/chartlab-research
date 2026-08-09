import type { Candle } from "../types";
import { atr } from "../indicators";

/**
 * ПРИЧИННЫЕ скопления ликвидности — по бару за баром, без единого взгляда
 * вперёд.
 *
 * Про estimateHeatmap.ts: в ЭТОМ репозитории такого файла нет и никогда не
 * было. Он существует только в репозитории приложения (слой отрисовки) и сюда
 * не импортируется ни в одной точке — исследовательский конвейер расчётную
 * карту ликвидаций не читает вообще. Упоминание оставлено как контраст: та
 * карта строится по ВСЕЙ истории сразу (плотность на баре i включает позиции,
 * открытые после i), и для картинки это нормально, а для бэктеста —
 * заглядывание в будущее, которое нарисует несуществующий край. Здесь на
 * каждом баре видно только прошлое. Разбор расхождения:
 * researcher/docs/family-liquidity-magnet-preregistration.md, раздел
 * «Поправка (2026-08-09)».
 *
 * Модель ликвидности — трейдерская, а не биржевая, и считается ТОЛЬКО по OHLC:
 * ни плеча, ни объёма, ни открытого интереса, ни формулы цены ликвидации тут
 * нет. Скопление это уровень, ЗА которым стоят чужие стопы. Уровни рождаются
 * на подтверждённых экстремумах (свинг-хай/лоу) и живут, пока цена их не сняла.
 *
 * Тонкость про вес, которую легко прочитать наоборот. Снятие использует `>=`,
 * а не `>`, и выполняется ДО слияния: экстремум ровно на цене уровня или выше
 * её уровень СНОСИТ, а не усиливает — вес обнуляется, рождается новый уровень
 * с весом 1. Вес копится только на серии почти-равных пивотов, каждый из
 * которых строго ниже сохранённой цены (для above; для below зеркально) и
 * попадает в MERGE_ATR. То есть weight — это «сколько раз подходили, ни разу
 * не дотянув», а не «сколько раз коснулись». Прибито clusterSeries.test.ts.
 *
 * Что отдаётся наружу — не список уровней (его дорого хранить на каждый
 * бар), а четыре числа на бар, которых достаточно и правилу входа, и
 * выходам от уровней:
 *   nearAbove/nearBelow — цена БЛИЖАЙШЕГО живого скопления (магнит-цель);
 *   farAbove/farBelow   — цена САМОГО ДАЛЬНЕГО в окне (за него ставится стоп);
 *   weightAbove/Below   — сила ближайшего (сколько касаний накопил);
 *   atrAt               — ATR бара, чтобы мерить расстояния в ATR.
 */

/** Сколько баров с каждой стороны обязаны быть ниже/выше — подтверждение пивота. */
export const PIVOT_WING = 3;
/** Уровни ближе этого расстояния (в долях ATR) считаются одним и тем же. */
export const MERGE_ATR = 0.25;
/** Дальше этого (в ATR) уровень уже не «впереди», а другая история. */
export const HORIZON_ATR = 12;
/** Потолок живых уровней с каждой стороны — защита от квадратичного роста. */
const MAX_ACTIVE = 64;

export interface LiquidityFeatures {
  /** Цена ближайшего живого скопления выше/ниже; NaN — нет такого. */
  nearAbove: Float64Array;
  nearBelow: Float64Array;
  /** Самое дальнее живое скопление в пределах горизонта — «вся ликвидность». */
  farAbove: Float64Array;
  farBelow: Float64Array;
  /** Сила ближайшего скопления: 1 + число повторных касаний. */
  weightAbove: Float64Array;
  weightBelow: Float64Array;
  /** ATR того же бара — единица измерения расстояний. */
  atrAt: Float64Array;
}

interface Level {
  price: number;
  weight: number;
}

/** Пивот-хай: строго выше PIVOT_WING соседей с обеих сторон. */
function isPivotHigh(candles: readonly Candle[], i: number): boolean {
  const h = candles[i].high;
  for (let w = 1; w <= PIVOT_WING; w++) {
    if (candles[i - w].high >= h || candles[i + w].high >= h) return false;
  }
  return true;
}

function isPivotLow(candles: readonly Candle[], i: number): boolean {
  const l = candles[i].low;
  for (let w = 1; w <= PIVOT_WING; w++) {
    if (candles[i - w].low <= l || candles[i + w].low <= l) return false;
  }
  return true;
}

/** Добавляет уровень, сливая с близким: равные максимумы копят вес. */
function addLevel(levels: Level[], price: number, tolerance: number): void {
  for (const lv of levels) {
    if (Math.abs(lv.price - price) <= tolerance) {
      lv.weight += 1;
      // цену держим у более раннего уровня: стопы стоят там, где их поставили
      return;
    }
  }
  levels.push({ price, weight: 1 });
}

/**
 * Мемоизация по массиву свечей — та же схема, что у кэша индикаторных серий
 * движка: расчёт зависит только от свечей, а ночь гоняет по одному символу
 * тысячи кандидатов. Инвалидация по отпечатку (длина, края, последний
 * close) — живой график дописывает бары в тот же массив.
 */
interface CachedFeatures {
  len: number;
  firstTime: number;
  lastTime: number;
  lastClose: number;
  features: LiquidityFeatures;
}
const featuresCache = new WeakMap<readonly Candle[], CachedFeatures>();

export function cachedLiquidityFeatures(candles: readonly Candle[]): LiquidityFeatures {
  const first = candles[0];
  const last = candles[candles.length - 1];
  const hit = featuresCache.get(candles);
  if (
    hit &&
    hit.len === candles.length &&
    hit.firstTime === (first?.time ?? 0) &&
    hit.lastTime === (last?.time ?? 0) &&
    hit.lastClose === (last?.close ?? 0)
  ) {
    return hit.features;
  }
  const features = liquidityFeatures(candles);
  featuresCache.set(candles, {
    len: candles.length,
    firstTime: first?.time ?? 0,
    lastTime: last?.time ?? 0,
    lastClose: last?.close ?? 0,
    features,
  });
  return features;
}

export function liquidityFeatures(candles: readonly Candle[]): LiquidityFeatures {
  const n = candles.length;
  const out: LiquidityFeatures = {
    nearAbove: new Float64Array(n).fill(NaN),
    nearBelow: new Float64Array(n).fill(NaN),
    farAbove: new Float64Array(n).fill(NaN),
    farBelow: new Float64Array(n).fill(NaN),
    weightAbove: new Float64Array(n).fill(NaN),
    weightBelow: new Float64Array(n).fill(NaN),
    atrAt: new Float64Array(n).fill(NaN),
  };
  if (n === 0) return out;

  // ATR по времени бара — совмещаем с индексом
  const atrByTime = new Map<number, number>();
  for (const p of atr(candles as Candle[])) atrByTime.set(p.time, p.value);

  // Живые уровни: выше рынка (стопы шортистов) и ниже (стопы лонгистов).
  const above: Level[] = [];
  const below: Level[] = [];

  for (let i = 0; i < n; i++) {
    const bar = candles[i];
    const a = atrByTime.get(bar.time) ?? NaN;
    out.atrAt[i] = a;

    // 1. Снятие: уровень исчезает, как только цена его коснулась. Делаем это
    //    ДО чтения фич — на баре снятия уровня уже нет, он отработал.
    for (let k = above.length - 1; k >= 0; k--) {
      if (bar.high >= above[k].price) above.splice(k, 1);
    }
    for (let k = below.length - 1; k >= 0; k--) {
      if (bar.low <= below[k].price) below.splice(k, 1);
    }

    // 2. Рождение: пивот подтверждается только через PIVOT_WING баров после
    //    экстремума, поэтому на баре i мы вправе узнать о пивоте на i-WING.
    const p = i - PIVOT_WING;
    if (p >= PIVOT_WING && p + PIVOT_WING < n) {
      const tolAtr = atrByTime.get(candles[p].time);
      const tol = Number.isFinite(tolAtr) ? (tolAtr as number) * MERGE_ATR : 0;
      if (isPivotHigh(candles, p)) addLevel(above, candles[p].high, tol);
      if (isPivotLow(candles, p)) addLevel(below, candles[p].low, tol);
      if (above.length > MAX_ACTIVE) above.splice(0, above.length - MAX_ACTIVE);
      if (below.length > MAX_ACTIVE) below.splice(0, below.length - MAX_ACTIVE);
    }

    if (!Number.isFinite(a) || a <= 0) continue;
    const horizon = a * HORIZON_ATR;
    const price = bar.close;

    // 3. Чтение фич: ближайший и самый дальний уровень в горизонте.
    let nearA = NaN;
    let farA = NaN;
    let wA = NaN;
    for (const lv of above) {
      if (lv.price <= price || lv.price - price > horizon) continue;
      if (!Number.isFinite(nearA) || lv.price < nearA) {
        nearA = lv.price;
        wA = lv.weight;
      }
      if (!Number.isFinite(farA) || lv.price > farA) farA = lv.price;
    }
    let nearB = NaN;
    let farB = NaN;
    let wB = NaN;
    for (const lv of below) {
      if (lv.price >= price || price - lv.price > horizon) continue;
      if (!Number.isFinite(nearB) || lv.price > nearB) {
        nearB = lv.price;
        wB = lv.weight;
      }
      if (!Number.isFinite(farB) || lv.price < farB) farB = lv.price;
    }
    out.nearAbove[i] = nearA;
    out.farAbove[i] = farA;
    out.weightAbove[i] = wA;
    out.nearBelow[i] = nearB;
    out.farBelow[i] = farB;
    out.weightBelow[i] = wB;
  }

  return out;
}
