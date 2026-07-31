/**
 * Нуль-модель v3: разностный тест против случайных входов, СОХРАНЯЮЩИХ
 * РАСПИСАНИЕ кандидата. Пре-регистрация порогов: docs/gates-v3-preregistration.md.
 *
 * Чинит три измеренных дефекта старых ворот (recall 0.000 на любом крае):
 *
 * 1. МОЩНОСТЬ. Старый порог — медианный per-symbol z ≥ 3 на ~35 сделках на
 *    символ — требовал края 0.3–0.6R, которого не существует. Новая
 *    статистика — t по ДНЕВНЫМ портфельным доходностям всего пула сделок:
 *    ложный проход 1%, recall 85–97% на крае 0.10R (стенд calibrate.ts).
 *
 * 2. ЧЕСТНОСТЬ ПРИ КРОСС-КОРРЕЛЯЦИИ. Сделки одного дня по 100 монетам — это
 *    почти одна ставка (ρ 0.5–0.8). Дневная агрегация кластеризует ошибки по
 *    времени; пул сделок лгал бы о числе независимых наблюдений.
 *
 * 3. ДВЕ ХАЛЯВЫ. Базлайн входит в те же (день-недели × час)-бакеты, что и
 *    кандидат: сезонность больше не получает z даром против равномерного
 *    нуля (старые ворота пропускали ТОЛЬКО её), а лонг-на-росте не проходит
 *    за счёт беты — базлайн ловит тот же дрейф символа.
 *
 * Механика выходов у базлайна — родная (simulateExits тем же конфигом), как
 * и в старой нуль-модели: сравнение честно только при побайтово том же
 * исполнении.
 */
import type { Candle, StrategyConfig, TradeResult } from "../src/core/types/index.ts";
import { simulateExits } from "../src/core/backtest/engine.ts";
import { tradeCostInR } from "../src/core/committee/costModel.ts";
import { moments } from "./stats.ts";

/** Прогонов базлайна на кандидата (как в старой нуль-модели). */
export const SCHED_NULL_RUNS = 20;
/** Порог разностного t — пре-регистрирован, по живым данным не трогать. */
export const POOLED_T_MIN = 2.6;
/**
 * Порог того же теста на окне out-of-time. Ниже, чем in-sample, и это не
 * поблажка, а арифметика мощности: на 12 месяцах наблюдений в пять раз
 * меньше. Замер стенда (calibrate.ts --mode oot, 500 потоков): при t≥2.6
 * OOT-ворота убивали бы 76-81% НАСТОЯЩИХ кандидатов с краем 0.10R; при
 * t≥1.3 ложный проход 9%, recall 64-71%. OOT стоит последним — за ним ещё
 * живой инкубатор, поэтому цена ложного пропуска ниже цены ложного отказа.
 */
export const OOT_T_MIN = 1.3;
/** Минимум непустых дней разностного ряда. */
export const MIN_CLUSTER_DAYS = 60;
/** Первый допустимый сигнальный бар (прогрев индикаторов). */
const FIRST_ELIGIBLE = 200;

const DAY_SEC = 86_400;

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

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Бакет расписания: день недели × час, UTC. */
export function scheduleBucket(timeSec: number): number {
  const d = new Date(timeSec * 1000);
  return d.getUTCDay() * 24 + d.getUTCHours();
}

/** Профиль расписания кандидата: бакет → число входов. */
export function scheduleProfile(entryTimes: readonly number[]): Map<number, number> {
  const profile = new Map<number, number>();
  for (const t of entryTimes) {
    const b = scheduleBucket(t);
    profile.set(b, (profile.get(b) ?? 0) + 1);
  }
  return profile;
}

/**
 * Выбор `count` случайных СИГНАЛЬНЫХ баров, чьи fill-бары (i+1) распределены
 * по бакетам пропорционально профилю. Пустой в этом символе бакет
 * откатывается к равномерному выбору — символ мог не торговаться в те часы.
 */
export function sampleScheduledEntries(
  candles: readonly Candle[],
  count: number,
  profile: ReadonlyMap<number, number>,
  rand: () => number,
  /**
   * Не брать бары, чей fill-бар раньше этого времени. Нужно для OOT-окна:
   * туда подмешаны бары прогрева ДО границы, и без этого фильтра базлайн
   * торговал бы в периоде, недоступном кандидату.
   */
  minFillTimeSec = 0,
): number[] {
  const lastSignal = candles.length - 2;
  if (lastSignal < FIRST_ELIGIBLE || count <= 0) return [];
  // индекс бакет → сигнальные бары
  const byBucket = new Map<number, number[]>();
  const all: number[] = [];
  for (let i = FIRST_ELIGIBLE; i <= lastSignal; i++) {
    if (candles[i + 1].time < minFillTimeSec) continue;
    const b = scheduleBucket(candles[i + 1].time);
    let list = byBucket.get(b);
    if (!list) {
      list = [];
      byBucket.set(b, list);
    }
    list.push(i);
    all.push(i);
  }
  if (all.length === 0) return [];
  // рулетка по массе профиля
  const buckets = [...profile.entries()];
  const totalMass = buckets.reduce((s, [, n]) => s + n, 0);
  const picked = new Set<number>();
  let guard = count * 50;
  while (picked.size < count && guard-- > 0) {
    let roll = rand() * totalMass;
    let bucket = buckets[buckets.length - 1][0];
    for (const [b, mass] of buckets) {
      roll -= mass;
      if (roll <= 0) {
        bucket = b;
        break;
      }
    }
    const pool = byBucket.get(bucket) ?? all;
    picked.add(pool[Math.floor(rand() * pool.length)]);
  }
  return [...picked].sort((a, b) => a - b);
}

/** Дневные суммы net R (издержки вычтены), день — UTC-сутки времени выхода. */
export function dailyNetSeries(trades: readonly TradeResult[]): Map<number, number> {
  const byDay = new Map<number, number>();
  for (const t of trades) {
    const day = Math.floor(t.exitTime / DAY_SEC);
    byDay.set(day, (byDay.get(day) ?? 0) + (t.rMultiple - tradeCostInR(t)));
  }
  return byDay;
}

export interface ScheduledNullResult {
  pass: boolean;
  t: number;
  days: number;
  meanDiff: number;
  pValue: number;
  reason?: string;
}

/**
 * Разностный тест: дневной ряд кандидата минус средний дневной ряд K
 * базлайнов с тем же расписанием → t = mean·√days / sd.
 */
export function scheduledNullGate(
  tradesBySymbol: ReadonlyMap<string, TradeResult[]>,
  config: StrategyConfig,
  candlesFor: (symbol: string) => Candle[] | null | undefined,
  seed: number,
  opts?: {
    /** Порог t; по умолчанию in-sample. Для OOT-окна — OOT_T_MIN. */
    minT?: number;
    /** Базлайн не входит раньше этого времени (граница OOT-окна). */
    minEntryTime?: number;
  },
): ScheduledNullResult {
  const minT = opts?.minT ?? POOLED_T_MIN;
  const minEntryTime = opts?.minEntryTime ?? 0;
  const allTrades = [...tradesBySymbol.values()].flat();
  const profile = scheduleProfile(allTrades.map((t) => t.entryTime));
  const candidateDaily = dailyNetSeries(allTrades);

  // средний дневной ряд базлайна: сумма по прогонам / K
  const nullDailySum = new Map<number, number>();
  // Символ-мажорно: свечи одного символа читаются один раз на все K прогонов
  // базлайна. Обратный порядок заставлял бы держать в памяти весь корпус.
  for (const [symbol, symTrades] of tradesBySymbol) {
    if (symTrades.length === 0) continue;
    const candles = candlesFor(symbol);
    if (!candles || candles.length < FIRST_ELIGIBLE + 2) continue;
    for (let run = 0; run < SCHED_NULL_RUNS; run++) {
      const rand = mulberry32((seed ^ fnv1a(symbol)) + run * 7919);
      const entries = sampleScheduledEntries(
        candles,
        symTrades.length,
        profile,
        rand,
        minEntryTime,
      );
      if (entries.length === 0) continue;
      for (const [day, r] of dailyNetSeries(simulateExits(candles, config, symbol, entries))) {
        nullDailySum.set(day, (nullDailySum.get(day) ?? 0) + r);
      }
    }
  }

  const days = new Set<number>([...candidateDaily.keys(), ...nullDailySum.keys()]);
  const diffs: number[] = [];
  for (const day of days) {
    diffs.push((candidateDaily.get(day) ?? 0) - (nullDailySum.get(day) ?? 0) / SCHED_NULL_RUNS);
  }
  if (diffs.length < MIN_CLUSTER_DAYS) {
    return {
      pass: false, t: 0, days: diffs.length, meanDiff: 0, pValue: 1,
      reason: `нуль-модель: лишь ${diffs.length} дней < ${MIN_CLUSTER_DAYS}`,
    };
  }
  const m = moments(diffs);
  const t = m.stdDev > 0 ? (m.mean * Math.sqrt(diffs.length)) / m.stdDev : 0;
  const pValue = 1 - normCdfLocal(t);
  return {
    pass: t >= minT,
    t,
    days: diffs.length,
    meanDiff: m.mean,
    pValue,
    reason:
      t >= minT
        ? undefined
        : `нуль-модель: t=${t.toFixed(2)} < ${minT} над базлайном с тем же расписанием`,
  };
}

// локальная Φ — чтобы не плодить импорт-циклов со stats при будущих правках
function normCdfLocal(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (x > 0) p = 1 - p;
  return p;
}
