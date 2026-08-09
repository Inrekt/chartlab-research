import type { Candle, ConditionAtom, ConditionGroup, IndicatorRef } from "../types";
import { cachedLiquidityFeatures } from "../liquidations/clusterSeries";
import { cachedFundingPercentile, FUNDING_PAYOUTS_PER_DAY } from "../funding/fundingSeries";
import { cachedTakerPercentile, takerImbalance } from "../metrics/metricsSeries";
import {
  adx,
  atr as atrIndicator,
  atrChannel,
  bollinger,
  cci,
  choppiness,
  donchian,
  ema,
  hurst,
  ichimoku,
  keltner,
  macd,
  obv,
  parabolicSar,
  realizedVol,
  realizedVolPercentile,
  roc,
  rsi,
  sma,
  stochastic,
  superTrend,
  vwap,
  williamsR,
  zscore,
} from "../indicators";

/**
 * Aligns a (possibly shorter, offset) indicator series to the full candle
 * array by time, so callers can index it the same way as `candles`.
 */
function alignByTime(candles: Candle[], points: { time: number; value: number }[]): (number | null)[] {
  const byTime = new Map(points.map((p) => [p.time, p.value]));
  return candles.map((c) => byTime.get(c.time) ?? null);
}

function resolveIndicatorSeries(candles: Candle[], ref: IndicatorRef): (number | null)[] {
  switch (ref.kind) {
    case "price":
    case "close":
      return candles.map((c) => c[ref.field ?? "close"] as number);
    case "sma":
      return alignByTime(candles, sma(candles, ref.period ?? 20, ref.field));
    case "ema":
      return alignByTime(candles, ema(candles, ref.period ?? 20, ref.field));
    case "rsi":
      return alignByTime(candles, rsi(candles, ref.period ?? 14));
    case "vwap":
      return alignByTime(candles, vwap(candles));
    case "macd": {
      // Сигнальная линия и гистограмма считались всегда, но наружу отдавалась
      // только линия MACD — из-за чего классический «MACD пересёк сигнальную»,
      // самый ходовой вид этого сигнала, выразить в шаблоне было нельзя.
      const result = macd(candles);
      const key = ref.line === "signal" ? "signal" : ref.line === "histogram" ? "histogram" : "macd";
      return alignByTime(
        candles,
        result.map((p) => ({ time: p.time, value: p[key] })),
      );
    }
    case "bollinger": {
      // `line` обязателен к учёту: раньше здесь всегда возвращалась средняя, и
      // условие «цена ниже нижней полосы» молча означало «цена ниже SMA20» —
      // без ошибки, без предупреждения, с совершенно другим смыслом сигнала.
      const result = bollinger(candles, ref.period ?? 20);
      return alignByTime(candles, channelLine(result, ref.line));
    }
    case "stochastic": {
      const result = stochastic(candles, ref.period ?? 14);
      const key = ref.line === "d" ? "d" : "k";
      return alignByTime(candles, result.map((p) => ({ time: p.time, value: p[key] })));
    }
    case "adx": {
      const result = adx(candles, ref.period ?? 14);
      const key = ref.line === "plusDI" ? "plusDI" : ref.line === "minusDI" ? "minusDI" : "adx";
      return alignByTime(candles, result.map((p) => ({ time: p.time, value: p[key] })));
    }
    case "ichimoku": {
      const result = ichimoku(candles);
      const key = ref.line ?? "tenkan";
      if (key === "kijun" || key === "senkouA" || key === "senkouB" || key === "chikou" || key === "tenkan") {
        return alignByTime(candles, result.map((p) => ({ time: p.time, value: p[key] })));
      }
      return alignByTime(candles, result.map((p) => ({ time: p.time, value: p.tenkan })));
    }
    case "superTrend": {
      const result = superTrend(candles, ref.period ?? 10);
      return alignByTime(candles, result.map((p) => ({ time: p.time, value: p.value })));
    }
    case "parabolicSar":
      return alignByTime(candles, parabolicSar(candles));
    case "cci":
      return alignByTime(candles, cci(candles, ref.period ?? 20));
    case "williamsR":
      return alignByTime(candles, williamsR(candles, ref.period ?? 14));
    case "obv":
      return alignByTime(candles, obv(candles));
    case "keltner": {
      const result = keltner(candles, ref.period ?? 20, ref.atrPeriod ?? 10, ref.mult ?? 2);
      return alignByTime(candles, channelLine(result, ref.line));
    }
    case "donchian": {
      const result = donchian(candles, ref.period ?? 20);
      return alignByTime(candles, channelLine(result, ref.line));
    }
    case "atrChannel": {
      const result = atrChannel(candles, ref.period ?? 20, ref.atrPeriod ?? 14, ref.mult ?? 3);
      return alignByTime(candles, channelLine(result, ref.line));
    }
    case "roc":
      return alignByTime(candles, roc(candles, ref.period ?? 12));
    case "choppiness":
      return alignByTime(candles, choppiness(candles, ref.period ?? 14));
    case "hurst":
      return alignByTime(candles, hurst(candles, ref.period ?? 100));
    case "realizedVol":
      return alignByTime(candles, realizedVol(candles, ref.period ?? 20));
    case "volPercentile":
      return alignByTime(candles, realizedVolPercentile(candles, ref.period ?? 20));
    case "zscore":
      return alignByTime(candles, zscore(candles, ref.period ?? 20));
    default:
      throw new Error(`Unknown indicator kind: ${(ref as IndicatorRef).kind}`);
  }
}

/** value[i] = base[i − shift]; первые shift позиций — null (данных ещё не было). */
function shiftSeries(series: (number | null)[], shift: number): (number | null)[] {
  const out = new Array<number | null>(series.length).fill(null);
  for (let i = shift; i < series.length; i++) out[i] = series[i - shift];
  return out;
}

interface ChannelPoint {
  time: number;
  upper: number;
  lower: number;
  middle: number;
}

/** Выбор линии канала; по умолчанию middle — сравнение с центром канала. */
function channelLine(
  points: ChannelPoint[],
  line: IndicatorRef["line"],
): { time: number; value: number }[] {
  const key = line === "upper" || line === "lower" ? line : "middle";
  return points.map((p) => ({ time: p.time, value: p[key] }));
}

/**
 * Ключ кэша серии. JSON.stringify на каждый вызов valueAt был второй половиной
 * всего времени бэктеста (4 операнда × каждый бар × 44к баров); ref-объекты
 * стратегии стабильны на всю её жизнь, поэтому строка считается один раз.
 */
const refKeyCache = new WeakMap<IndicatorRef, string>();
const divergenceRefCache = new WeakMap<object, IndicatorRef>();

/** Стабильные ref-объекты для растянутости: свежий на каждый бар пробивал бы кэш. */
/** Общий с движком ключ кэша ATR — одна линейка на входы и на стопы. */
export const ATR_CACHE_KEY = "engine:atr14";
const stretchRefs = new Map<number, IndicatorRef>();
function stretchRefFor(period: number): IndicatorRef {
  let ref = stretchRefs.get(period);
  if (!ref) {
    ref = { kind: "sma", period };
    stretchRefs.set(period, ref);
  }
  return ref;
}
function refKey(ref: IndicatorRef): string {
  let key = refKeyCache.get(ref);
  if (!key) {
    key = JSON.stringify(ref);
    refKeyCache.set(ref, key);
  }
  return key;
}

/**
 * Разделяемый кэш индикаторных серий НА МАССИВ СВЕЧЕЙ, переживающий отдельные
 * бэктесты. Серия зависит только от (свечи, ref) — не от стратегии, а ночной
 * скрин гоняет тысячи кандидатов по одному и тому же символу: без этого кэша
 * одна и та же SMA200 считалась заново на каждого кандидата (~10 000 полных
 * проходов вместо ~25 уникальных на символ).
 *
 * Инвалидация — по отпечатку (длина, время краёв, последний close): живой
 * график дописывает бары в тот же массив и мутирует close последнего бара,
 * оба случая обязаны сбрасывать кэш. Правки середины истории не отслеживаются
 * — так никто не делает; появится такой код — сначала поменять это место.
 */
interface SharedSeriesEntry {
  len: number;
  firstTime: number;
  lastTime: number;
  lastClose: number;
  /** Живой бар меняет high/low/volume раньше close — см. проверку ниже. */
  lastHigh: number;
  lastLow: number;
  lastVolume: number;
  series: Map<string, (number | null)[]>;
}
const sharedSeriesCache = new WeakMap<Candle[], SharedSeriesEntry>();

export function sharedSeriesCacheFor(candles: Candle[]): Map<string, (number | null)[]> {
  const first = candles[0];
  const last = candles[candles.length - 1];
  let entry = sharedSeriesCache.get(candles);
  if (
    !entry ||
    entry.len !== candles.length ||
    entry.firstTime !== (first?.time ?? 0) ||
    entry.lastTime !== (last?.time ?? 0) ||
    entry.lastClose !== (last?.close ?? 0) ||
    // Живой бар меняет не только close: сначала обновляются high/low/volume, и
    // close вполне может остаться прежним (тик ушёл вверх и вернулся). Без них
    // отпечаток не менялся, и отдавался ряд, посчитанный ДО движения — ATR
    // меньше настоящего завышает растянутость и включает вход, которого нет, а
    // устаревшая граница канала показывает пробой уровня, которого там уже
    // нет. Обе ошибки молчат: значение выглядит обычным числом.
    entry.lastHigh !== (last?.high ?? 0) ||
    entry.lastLow !== (last?.low ?? 0) ||
    entry.lastVolume !== (last?.volume ?? 0)
  ) {
    entry = {
      len: candles.length,
      firstTime: first?.time ?? 0,
      lastTime: last?.time ?? 0,
      lastClose: last?.close ?? 0,
      lastHigh: last?.high ?? 0,
      lastLow: last?.low ?? 0,
      lastVolume: last?.volume ?? 0,
      series: new Map(),
    };
    sharedSeriesCache.set(candles, entry);
  }
  return entry.series;
}

/**
 * Precomputes and caches every indicator series a strategy references, so
 * evaluating bar-by-bar during a backtest is O(1) per condition instead of
 * recomputing full indicator history at every bar.
 */
export class EvaluationContext {
  private cache: Map<string, (number | null)[]>;
  private candles: Candle[];
  /** Нужен только атомам, чьи данные внешние по отношению к свечам (фандинг). */
  private symbol?: string;

  constructor(candles: Candle[], symbol?: string) {
    this.candles = candles;
    this.cache = sharedSeriesCacheFor(candles);
    this.symbol = symbol;
  }

  private seriesFor(ref: IndicatorRef): (number | null)[] {
    const key = refKey(ref);
    let series = this.cache.get(key);
    if (!series) {
      series = resolveIndicatorSeries(this.candles, ref);
      if (ref.shift && ref.shift > 0) series = shiftSeries(series, ref.shift);
      this.cache.set(key, series);
    }
    return series;
  }

  valueAt(ref: IndicatorRef, index: number): number | null {
    const series = this.seriesFor(ref);
    return series[index] ?? null;
  }

  /**
   * ATR(14), выровненный по индексу свечей. Ключ кэша тот же, что у движка
   * (engine.ts), — ряд считается один раз на символ и делится между
   * условиями входа и расчётом стопа: иначе «растянутость на 2 ATR» и
   * «стоп 2 ATR» мерили бы разными линейками.
   */
  private atrAt(index: number): number | null {
    let series = this.cache.get(ATR_CACHE_KEY);
    if (!series) {
      series = alignByTime(this.candles, atrIndicator(this.candles));
      this.cache.set(ATR_CACHE_KEY, series);
    }
    return series[index] ?? null;
  }

  private resolveOperand(operand: IndicatorRef | number, index: number): number | null {
    return typeof operand === "number" ? operand : this.valueAt(operand, index);
  }

  evaluateAtom(atom: ConditionAtom, index: number): boolean {
    if (atom.kind === "comparison") {
      const left = this.resolveOperand(atom.left, index);
      const right = this.resolveOperand(atom.right, index);
      if (left === null || right === null) return false;
      switch (atom.op) {
        case ">":
          return left > right;
        case "<":
          return left < right;
        case ">=":
          return left >= right;
        case "<=":
          return left <= right;
      }
    }

    if (atom.kind === "crossover") {
      if (index === 0) return false;
      const aNow = this.resolveOperand(atom.a, index);
      const aPrev = this.resolveOperand(atom.a, index - 1);
      const bNow = this.resolveOperand(atom.b, index);
      const bPrev = this.resolveOperand(atom.b, index - 1);
      if (aNow === null || aPrev === null || bNow === null || bPrev === null) return false;
      return atom.direction === "above" ? aPrev <= bPrev && aNow > bNow : aPrev >= bPrev && aNow < bNow;
    }

    if (atom.kind === "priceAction") {
      return matchesPriceAction(this.candles, index, atom.pattern, atom.lookback);
    }

    if (atom.kind === "time") {
      return matchesTime(this.candles[index], atom);
    }

    if (atom.kind === "stretch") {
      const sma = this.seriesFor(stretchRefFor(atom.period))[index];
      const a = this.atrAt(index);
      if (sma === null || a === null || a <= 0) return false;
      const gap = (this.candles[index].close - sma) / a;
      return atom.direction === "above" ? gap >= atom.minAtr : gap <= -atom.minAtr;
    }

    if (atom.kind === "liquidity") {
      const f = cachedLiquidityFeatures(this.candles);
      const a = f.atrAt[index];
      if (!Number.isFinite(a) || a <= 0) return false;
      const price = this.candles[index].close;
      const level = atom.side === "above" ? f.nearAbove[index] : f.nearBelow[index];
      const weight = atom.side === "above" ? f.weightAbove[index] : f.weightBelow[index];
      if (!Number.isFinite(level) || !Number.isFinite(weight)) return false;
      const distance = Math.abs(level - price) / a;
      return distance >= atom.minAtr && distance <= atom.maxAtr && weight >= atom.minWeight;
    }

    if (atom.kind === "divergence") {
      // CVD — не индикатор цены, а внешний ряд: без символа его не построить.
      if (atom.osc === "cvd") {
        if (!this.symbol) return false;
        return matchesDivergence(this.candles, this.cvdSeries(this.symbol), index, atom);
      }
      // ref мемоизирован на атом: свежий объект на каждый бар пробивал бы
      // WeakMap-ключ и возвращал JSON.stringify в горячий путь.
      let oscRef = divergenceRefCache.get(atom);
      if (!oscRef) {
        oscRef = atom.osc === "rsi" ? { kind: "rsi", period: atom.period ?? 14 } : { kind: "macd" };
        divergenceRefCache.set(atom, oscRef);
      }
      return matchesDivergence(this.candles, this.seriesFor(oscRef), index, atom);
    }

    if (atom.kind === "funding") {
      // Без символа ряд ставок не построить. Возвращаем false, а не «как
      // будто условие выполнено»: неизвестность не должна становиться сигналом.
      if (!this.symbol) return false;
      const rank = cachedFundingPercentile(
        this.candles,
        this.symbol,
        atom.windowDays * FUNDING_PAYOUTS_PER_DAY,
      )[index];
      if (!Number.isFinite(rank)) return false;
      // Порог симметричен: percentile 90 означает «верхние 10%» для above и
      // «нижние 10%» для below.
      return atom.direction === "above"
        ? rank >= atom.percentile
        : rank <= 100 - atom.percentile;
    }

    if (atom.kind === "takerFlow") {
      if (!this.symbol) return false;
      const rank = cachedTakerPercentile(this.candles, this.symbol, atom.windowDays)[index];
      if (!Number.isFinite(rank)) return false;
      // Порог симметричен: percentile 90 означает «верхние 10%» для buy и
      // «нижние 10%» для sell — стороны остаются зеркальной парой.
      return atom.direction === "buy" ? rank >= atom.percentile : rank <= 100 - atom.percentile;
    }

    return false;
  }

  /**
   * Кумулятивная дельта тейкеров: cvd_t = Σ volume_i × imb_i. Объём из свечи,
   * дисбаланс из почасовых метрик. Бары без метрик дают null (не могут быть
   * пивотами дивергенции), накопление продолжается по конечным дельтам —
   * редкая дырка в час не обнуляет весь ряд.
   */
  private cvdSeries(symbol: string): (number | null)[] {
    const key = `cvd:${symbol}`;
    let series = this.cache.get(key);
    if (!series) {
      const imb = takerImbalance(this.candles, symbol);
      series = new Array<number | null>(this.candles.length).fill(null);
      let sum = 0;
      for (let i = 0; i < imb.length; i++) {
        if (!Number.isFinite(imb[i])) continue;
        sum += this.candles[i].volume * imb[i];
        series[i] = sum;
      }
      this.cache.set(key, series);
    }
    return series;
  }

  evaluateGroup(group: ConditionGroup, index: number): boolean {
    const results = group.conditions.map((c) =>
      "operator" in c ? this.evaluateGroup(c, index) : this.evaluateAtom(c, index)
    );
    return group.operator === "AND" ? results.every(Boolean) : results.some(Boolean);
  }
}

function matchesPriceAction(
  candles: Candle[],
  index: number,
  pattern: "engulfing" | "pinbar" | "insideBar",
  lookback: number
): boolean {
  /*
   * `Math.max(1, lookback)`, а не просто `lookback`.
   *
   * Все три паттерна читают ПРЕДЫДУЩИЙ бар, поэтому нулевой бар для них
   * невычислим при любом lookback. При lookback ≥ 1 он защищён случайно, а при
   * lookback = 0 проверка пропускала бар 0, обращение к candles[-1] давало
   * undefined и падение на чтении поля.
   *
   * Цена не выдуманная сделка, а ОБРЫВ ПРОГОНА: ночь на тысячах испытаний
   * падает на первом же таком кандидате, и вместе с ней теряются результаты
   * всех посчитанных до него. Сейчас грамматика даёт только 5 и 30, то есть
   * дефект латентный — но ноль разрешён типом и придёт из первого же
   * рукописного конфига.
   */
  if (index < Math.max(1, lookback)) return false;
  const curr = candles[index];
  const prev = candles[index - 1];

  if (pattern === "engulfing") {
    const currBullish = curr.close > curr.open;
    const prevBullish = prev.close > prev.open;
    if (currBullish === prevBullish) return false;
    return currBullish
      ? curr.open < prev.close && curr.close > prev.open
      : curr.open > prev.close && curr.close < prev.open;
  }

  if (pattern === "insideBar") {
    return curr.high <= prev.high && curr.low >= prev.low;
  }

  // pinbar: small body, long wick dominating the range
  const range = curr.high - curr.low;
  if (range <= 0) return false;
  const body = Math.abs(curr.close - curr.open);
  const upperWick = curr.high - Math.max(curr.open, curr.close);
  const lowerWick = Math.min(curr.open, curr.close) - curr.low;
  const dominantWick = Math.max(upperWick, lowerWick);
  return body / range < 0.3 && dominantWick / range > 0.6;
}

function matchesTime(
  candle: Candle,
  atom: Extract<ConditionAtom, { kind: "time" }>,
): boolean {
  const date = new Date(candle.time * 1000);
  if (atom.dayOfWeek && !atom.dayOfWeek.includes(date.getUTCDay())) return false;
  if (atom.hourRangeUtc) {
    const [from, to] = atom.hourRangeUtc;
    const hour = date.getUTCHours();
    // Диапазон может переходить через полночь: [22, 4) означает 22..23 и 0..3.
    const inRange = from <= to ? hour >= from && hour < to : hour >= from || hour < to;
    if (!inRange) return false;
  }
  return true;
}

/** Пивот = экстремум строго против PIVOT_WING соседей с каждой стороны. */
const PIVOT_WING = 2;

/**
 * Дивергенция цена/осциллятор. Бычья: цена ставит более низкий минимум, а
 * осциллятор — более высокий; медвежья зеркально по максимумам. Сигнал
 * срабатывает только на баре, где второй пивот ПОДТВЕРДИЛСЯ (через PIVOT_WING
 * баров после экстремума) — никакого заглядывания вперёд и повторных
 * срабатываний на каждом баре.
 */
function matchesDivergence(
  candles: Candle[],
  osc: (number | null)[],
  index: number,
  atom: Extract<ConditionAtom, { kind: "divergence" }>,
): boolean {
  const confirmedPivot = index - PIVOT_WING;
  if (confirmedPivot < PIVOT_WING) return false;
  const bullish = atom.direction === "bullish";
  if (!isPivot(candles, confirmedPivot, bullish)) return false;

  const from = Math.max(PIVOT_WING, index - atom.lookback);
  for (let prev = confirmedPivot - PIVOT_WING - 1; prev >= from; prev--) {
    if (!isPivot(candles, prev, bullish)) continue;
    const oscPrev = osc[prev];
    const oscCurr = osc[confirmedPivot];
    if (oscPrev === null || oscCurr === null) return false;
    if (bullish) {
      return candles[confirmedPivot].low < candles[prev].low && oscCurr > oscPrev;
    }
    return candles[confirmedPivot].high > candles[prev].high && oscCurr < oscPrev;
  }
  return false;
}

function isPivot(candles: Candle[], index: number, low: boolean): boolean {
  for (let w = 1; w <= PIVOT_WING; w++) {
    if (index - w < 0 || index + w >= candles.length) return false;
    if (low) {
      if (candles[index].low >= candles[index - w].low) return false;
      if (candles[index].low >= candles[index + w].low) return false;
    } else {
      if (candles[index].high <= candles[index - w].high) return false;
      if (candles[index].high <= candles[index + w].high) return false;
    }
  }
  return true;
}
