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
  | { kind: "divergence"; osc: "rsi" | "macd"; direction: "bullish" | "bearish"; lookback: number; period?: number };

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
    stopLoss: { type: "atr" | "percent" | "fixed"; value: number };
    takeProfit: { type: "rr" | "percent" | "fixed"; value: number };
    maxBarsInTrade?: number;
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
