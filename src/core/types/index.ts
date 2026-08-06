export type Interval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

export interface Candle {
  time: number; // unix seconds, bar open time
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type AssetClass = "crypto" | "forex" | "stock" | "index" | "commodity";

export interface Instrument {
  symbol: string; // canonical symbol used across the app, e.g. "BTCUSDT", "EURUSD"
  displayName: string;
  assetClass: AssetClass;
  source: DataSourceId;
}

export type DataSourceId = "binance" | "stooq" | "yahoo";

export interface IndicatorRef {
  kind:
    | "sma"
    | "ema"
    | "rsi"
    | "macd"
    | "bollinger"
    | "vwap"
    | "close"
    | "price"
    | "stochastic"
    | "adx"
    | "ichimoku"
    | "superTrend"
    | "parabolicSar"
    | "cci"
    | "williamsR"
    | "obv"
    | "keltner"
    | "donchian"
    | "atrChannel"
    | "roc"
    | "choppiness"
    | "hurst"
    | "realizedVol"
    | "volPercentile"
    | "zscore";
  period?: number;
  field?: "open" | "high" | "low" | "close" | "volume";
  /** Sub-series selector for multi-line indicators (e.g. ADX's "plusDI", Ichimoku's "tenkan", каналы: upper/lower/middle). */
  line?:
    | "k"
    | "d"
    | "plusDI"
    | "minusDI"
    | "adx"
    | "tenkan"
    | "kijun"
    | "senkouA"
    | "senkouB"
    | "chikou"
    | "line"
    | "upper"
    | "lower"
    | "middle"
    | "signal"
    | "histogram";
  /** Ширина канала в ATR/σ для keltner/atrChannel (по умолчанию своя у каждого индикатора). */
  mult?: number;
  /** Период ATR для канальных индикаторов, когда он отличается от основного периода. */
  atrPeriod?: number;
  /**
   * Сдвиг серии на N баров назад: значение на баре i берётся с бара i−N.
   * Нужен пробойным логикам — «close выше канала Дончиана, посчитанного БЕЗ
   * текущего бара» (иначе close ≤ high ≤ upper и пробой невозможен по
   * построению).
   */
  shift?: number;
}

export type ConditionAtom =
  | { kind: "crossover"; direction: "above" | "below"; a: IndicatorRef; b: IndicatorRef | number }
  | { kind: "comparison"; left: IndicatorRef; op: ">" | "<" | ">=" | "<="; right: IndicatorRef | number }
  | { kind: "priceAction"; pattern: "engulfing" | "pinbar" | "insideBar"; lookback: number }
  /**
   * Сезонность по времени СИГНАЛЬНОГО бара (UTC): день недели 0=вс..6=сб,
   * hourRangeUtc = [от, до) в часах. На дневных барах hourRangeUtc не имеет
   * смысла и должен быть опущен.
   */
  | { kind: "time"; dayOfWeek?: number[]; hourRangeUtc?: [number, number] }
  /**
   * Дивергенция цена/осциллятор по подтверждённым пивотам (пивот = экстремум
   * против 2 соседей с каждой стороны, подтверждается через 2 бара —
   * без заглядывания вперёд). Срабатывает ТОЛЬКО на баре подтверждения второго
   * пивота, чтобы сигнал не «горел» много баров подряд.
   */
  | { kind: "divergence"; osc: "rsi" | "macd"; direction: "bullish" | "bearish"; lookback: number; period?: number }
  /**
   * Растянутость цены от средней, В ATR — «уже переоценено жёстко».
   * Именно в ATR, а не в процентах: 5% для BTC и для мем-коина это разные
   * события, а в единицах собственной волатильности они сравнимы, и правило
   * остаётся одним для всей вселенной.
   */
  | { kind: "stretch"; period: number; direction: "above" | "below"; minAtr: number }
  /**
   * Впереди по ходу сделки есть живое скопление ликвидности (уровень, за
   * которым стоят чужие стопы) — магнит-цель. Расстояние меряется в ATR,
   * плотность — в числе подходов к уровню.
   *
   * side: "above" — скопление выше цены (цель для лонга, стоп-зона для
   * шорта), "below" — ниже. Считается ПРИЧИННО (clusterSeries.ts): на баре
   * видно только прошлое.
   */
  | { kind: "liquidity"; side: "above" | "below"; minAtr: number; maxAtr: number; minWeight: number }
  /**
   * Ставка финансирования перпетуала в верхних/нижних `percentile` процентах
   * СВОЕЙ недавней истории (окно `windowDays`). Измеряет перегруженность
   * плеча: экстремальная ставка означает, что одна сторона платит за право
   * оставаться в позиции. Сравнение относительное, потому что у разных монет
   * свой масштаб ставки.
   *
   * Требует символа в контексте вычисления: без него ряд не построить, и
   * условие честно возвращает false.
   */
  | { kind: "funding"; direction: "above" | "below"; percentile: number; windowDays: number }
  /**
   * Дисбаланс тейкерского потока бара в верхних (`buy`) или нижних (`sell`)
   * процентах собственной скользящей истории. Меряет агрессоров, бьющих по
   * рынку: перекос — это толпа, покупающая по любой цене. Источник —
   * почасовые futures-метрики; без символа и без данных условие ложно.
   * Пре-регистрация: researcher/docs/atoms-taker-flow-preregistration.md.
   */
  | { kind: "takerFlow"; direction: "buy" | "sell"; percentile: number; windowDays: number };

export interface ConditionGroup {
  operator: "AND" | "OR";
  conditions: (ConditionAtom | ConditionGroup)[];
}

export interface StrategyConfig {
  id: string;
  ownerId: string; // reserved for future multi-user support; single fixed value today
  name: string;
  timeframe: Interval;
  direction: "long" | "short";
  symbols: string[]; // instruments this strategy watches/is backtested against
  entry: ConditionGroup;
  exit: {
    /**
     * `liquidity` — стоп за ВСЕЙ ликвидностью против сделки: за самым дальним
     * живым скоплением в горизонте, плюс запас `value` в ATR. Если скоплений
     * против сделки нет, стоп вырождается в обычный ATR-стоп шириной `value`
     * — иначе правило молча превратилось бы в «без стопа».
     */
    stopLoss: { type: "atr" | "percent" | "fixed" | "liquidity"; value: number };
    /**
     * `liquidity` — цель на ближайшем живом скоплении по ходу сделки
     * (магнит). Цена цели берётся с ОТСТУПОМ `value` в ATR не доходя до
     * уровня: толпа целится в сам уровень, поэтому исполнение там худшее.
     * Нет скопления впереди — сделка не открывается вовсе (цели нет).
     */
    takeProfit: { type: "rr" | "percent" | "fixed" | "liquidity"; value: number };
    maxBarsInTrade?: number;
    /**
     * Доборы: сколько раз позиция доливается на скоплениях ликвидности ПРОТИВ
     * сделки (0, 1 или 2). Уровни фиксируются в момент входа — ближнее и
     * дальнее живое скопление, — а размеры подбираются так, что при полном
     * исполнении убыток на стопе равен 1R, то есть ровно столько же, сколько
     * у той же стратегии без добора. Требует `stopLoss.type === "liquidity"`.
     * См. `researcher/docs/family-scale-in-preregistration.md`.
     */
    scaleInAdds?: number;
  };
  filters?: ConditionGroup;
}

export interface TradeResult {
  symbol: string;
  direction: "long" | "short";
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  stopPrice: number;
  targetPrice: number;
  rMultiple: number; // realized profit/loss expressed in units of initial risk
  won: boolean;
  barsHeld: number;
}

export interface BacktestStats {
  totalTrades: number;
  winRate: number;
  avgRR: number;
  profitFactor: number;
  expectancy: number;
  maxDrawdownR: number;
  avgBarsHeld: number;
}
