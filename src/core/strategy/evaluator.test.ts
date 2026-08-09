import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EvaluationContext } from "./evaluator";
import type { Candle, ConditionAtom, IndicatorRef } from "../types";
import {
  clearFundingCache,
  setFundingLoader,
  type FundingHistory,
} from "../funding/fundingSeries";
import {
  clearMetricsCache,
  setMetricsLoader,
  type MetricsHistory,
} from "../metrics/metricsSeries";

/*
 * ВЫЧИСЛИТЕЛЬ УСЛОВИЙ — единственное место, где решается «был вход или нет».
 * Он считает каждое условие на каждом баре, и его ответ дальше никем не
 * перепроверяется: журнал из 56 тысяч испытаний, отбор семейств, живой сигнал —
 * всё стоит на этих булевых значениях. До этого файла у него не было ни одного
 * собственного теста.
 *
 * Что именно тут защищается, в порядке цены ошибки.
 *
 * 1. ЛОЖНОЕ TRUE СОЗДАЁТ СДЕЛКИ ИЗ ВОЗДУХА. Если условие на прогреве, без
 *    символа или на дыре в данных вернёт true, движок откроет позицию там, где
 *    никакого сигнала не было. Такие сделки не отличить от настоящих ни по
 *    одному отчёту: они попадают в статистику, поднимают число наблюдений и
 *    двигают вердикт. Отрицательный результат ещё можно пережить; выдуманный
 *    положительный уводит в торговлю тем, чего нет.
 *
 * 2. ЗАГЛЯДЫВАНИЕ ВПЕРЁД НЕ ПАДАЕТ И НЕ ПИШЕТ В ЛОГ. Условие, подсмотревшее
 *    хотя бы один будущий бар, рисует край, которого в реальном времени не
 *    существует. Единственный способ это поймать — считать на префиксе [0..i] и
 *    на полном ряду и требовать совпадения. Этому посвящён самый ценный блок
 *    файла.
 *
 * 3. СДВИГ. Ряд индикатора КОРОЧЕ массива свечей, поэтому сдвиг легко применить
 *    к индексу самого ряда, а не свечей — промах составит period−1 баров и
 *    будет тем больше, чем длиннее окно. Правило «граница не обновлялась»
 *    проверяло бы тогда другой отрезок истории, а вердикт выглядел бы обычным
 *    отрицательным результатом.
 *
 * 4. ЗЕРКАЛЬНОСТЬ. Лонговое и шортовое семейство — это один и тот же атом с
 *    перевёрнутым направлением. Разъехавшиеся стороны дают систематический
 *    перекос в пользу одной из них, и «шорты не работают» окажется свойством
 *    кода, а не рынка.
 */

const HOUR = 3600;
/** Начало ряда выровнено на границу 8-часовой выплаты фандинга. */
const T0 = 1_700_000_000 - (1_700_000_000 % (8 * HOUR));

/** Свеча с явно заданными o/h/l/c — фикстуры собираются из неё поштучно. */
function bar(i: number, o: number, h: number, l: number, c: number, v = 10): Candle {
  return { time: T0 + i * HOUR, open: o, high: h, low: l, close: c, volume: v };
}

/** Свеча «стоим на цене p» с фиксированным полудиапазоном — ATR предсказуем. */
function at(i: number, p: number, halfRange = 1): Candle {
  return bar(i, p, p + halfRange, p - halfRange, p);
}

/** Зеркало ряда относительно уровня 200: цены переворачиваются, форма сохраняется. */
function mirror(candles: Candle[]): Candle[] {
  return candles.map((c, i) =>
    bar(i, 200 - c.open, 200 - c.low, 200 - c.high, 200 - c.close, c.volume),
  );
}

// --- внешние источники подаются В ПАМЯТИ -----------------------------------
// Это тесты браузерного модуля: читать диск ему запрещено, ровно поэтому
// чтение CSV живёт отдельно в researcher/.

const fundingStore = new Map<string, FundingHistory>();
const metricsStore = new Map<string, MetricsHistory>();

beforeEach(() => {
  fundingStore.clear();
  metricsStore.clear();
  setFundingLoader((symbol) => fundingStore.get(symbol) ?? null);
  setMetricsLoader((symbol) => metricsStore.get(symbol) ?? null);
});

afterEach(() => {
  fundingStore.clear();
  metricsStore.clear();
  clearFundingCache();
  clearMetricsCache();
});

/** Выплаты каждые 8 часов начиная с T0; ставки задаются списком. */
function putFunding(symbol: string, rates: number[]): void {
  fundingStore.set(symbol, {
    times: Float64Array.from(rates.map((_, k) => (T0 + k * 8 * HOUR) * 1000)),
    rates: Float64Array.from(rates),
  });
  clearFundingCache();
}

/** Почасовые отношения тейкерских покупок к продажам начиная с T0. */
function putMetrics(symbol: string, ratios: number[]): void {
  metricsStore.set(symbol, {
    hourStarts: Float64Array.from(ratios.map((_, k) => T0 + k * HOUR)),
    takerRatio: Float64Array.from(ratios),
  });
  clearMetricsCache();
}

// ---------------------------------------------------------------------------
// 1. НЕТ ДАННЫХ — НЕТ СИГНАЛА
// ---------------------------------------------------------------------------

describe("прогрев: пока индикатора нет, условие ложно", () => {
  /** SMA(20) на двадцати барах существует ровно с индекса 19. */
  const twenty = Array.from({ length: 20 }, (_, i) => at(i, 100));

  it("valueAt на прогреве отдаёт null, а не ноль и не первое известное", () => {
    // Ноль здесь означал бы «средняя на нуле», и любое «цена выше средней»
    // стало бы истинным на всём прогреве — на каждом символе, каждую ночь.
    const ctx = new EvaluationContext(twenty);
    expect(ctx.valueAt({ kind: "sma", period: 20 }, 0)).toBeNull();
    expect(ctx.valueAt({ kind: "sma", period: 20 }, 18)).toBeNull();
    expect(ctx.valueAt({ kind: "sma", period: 20 }, 19)).toBe(100);
  });

  it("сравнение с отсутствующим операндом ложно ПРИ ЛЮБОМ операторе", () => {
    // Отдельно проверяются < и <=: соблазн реализации — «неизвестное меньше
    // чего угодно». Тогда условие «RSI ниже 30» горело бы на прогреве, то есть
    // в начале КАЖДОГО прогона, и сделки бы кучковались на первых барах
    // истории — там, где их проще всего принять за настоящие.
    const ctx = new EvaluationContext(twenty);
    for (const op of [">", "<", ">=", "<="] as const) {
      expect(
        ctx.evaluateAtom({ kind: "comparison", left: { kind: "sma", period: 20 }, op, right: 100 }, 5),
        `оператор ${op}`,
      ).toBe(false);
    }
  });

  it("оба операнда — индикаторы: достаточно отсутствия одного", () => {
    const ctx = new EvaluationContext(twenty);
    const atom: ConditionAtom = {
      kind: "comparison",
      left: { kind: "close" },
      op: ">",
      right: { kind: "sma", period: 20 },
    };
    expect(ctx.evaluateAtom(atom, 10)).toBe(false);
    expect(ctx.evaluateAtom(atom, 19)).toBe(false); // 100 > 100 — уже настоящий ответ
  });

  it("пересечение на нулевом баре ложно: предыдущего бара не существует", () => {
    // Без этой проверки первый бар каждого символа мог бы дать «пересечение»
    // из сравнения с несуществующим прошлым — по одной выдуманной сделке на
    // каждый прогон, и все они попадут в статистику как обычные.
    const ctx = new EvaluationContext(twenty);
    expect(
      ctx.evaluateAtom({ kind: "crossover", direction: "above", a: { kind: "close" }, b: 50 }, 0),
    ).toBe(false);
  });

  it("пересечение ложно, пока предыдущий бар ещё в прогреве", () => {
    const ctx = new EvaluationContext(twenty);
    const atom: ConditionAtom = {
      kind: "crossover",
      direction: "above",
      a: { kind: "sma", period: 20 },
      b: { kind: "close" },
    };
    expect(ctx.evaluateAtom(atom, 19)).toBe(false); // значение на 18 отсутствует
  });

  it("NaN в ряду не проходит ни один оператор сравнения", () => {
    // Дыра в данных приходит не только как null: битая свеча даёт NaN, и он
    // ПРОХОДИТ проверку «=== null». Защищает только семантика IEEE-сравнений —
    // и именно она тут прибита. Реализация вида `!(a <= b)` для «>» сломала бы
    // это молча: NaN стал бы истиной на каждом баре с дырой.
    const candles = Array.from({ length: 30 }, (_, i) => at(i, 100));
    candles[25] = bar(25, 100, 101, 99, Number.NaN);
    const ctx = new EvaluationContext(candles);
    expect(ctx.valueAt({ kind: "close" }, 25)).toBeNaN();
    for (const op of [">", "<", ">=", "<="] as const) {
      expect(
        ctx.evaluateAtom({ kind: "comparison", left: { kind: "close" }, op, right: 50 }, 25),
        `оператор ${op}`,
      ).toBe(false);
    }
    expect(
      ctx.evaluateAtom({ kind: "crossover", direction: "above", a: { kind: "close" }, b: 50 }, 25),
    ).toBe(false);
  });

  it("растянутость ложна, пока нет ATR или средней", () => {
    // Растянутость меряется В ATR. Если бы отсутствующий ATR подставлялся
    // нулём или единицей, «цена ушла на 2 ATR» означало бы «цена ушла на 2
    // доллара» — правило перестало бы быть сравнимым между символами, оставаясь
    // на вид тем же самым.
    const candles = Array.from({ length: 30 }, (_, i) => at(i, 100 + i));
    const ctx = new EvaluationContext(candles);
    expect(ctx.evaluateAtom({ kind: "stretch", period: 20, direction: "above", minAtr: 0.1 }, 5)).toBe(false);
  });

  it("растянутость ложна на ряду с нулевой волатильностью", () => {
    // ATR = 0 — деление на ноль дало бы Infinity, а Infinity >= minAtr это
    // true: константный ряд объявлялся бы «предельно растянутым» на каждом баре.
    const candles = Array.from({ length: 40 }, (_, i) => bar(i, 100, 100, 100, 100));
    const ctx = new EvaluationContext(candles);
    expect(ctx.evaluateAtom({ kind: "stretch", period: 20, direction: "above", minAtr: 0.5 }, 35)).toBe(false);
    expect(ctx.evaluateAtom({ kind: "stretch", period: 20, direction: "below", minAtr: 0.5 }, 35)).toBe(false);
  });

  it("ликвидность ложна, пока нет ATR, и на ряду без волатильности", () => {
    const warming = Array.from({ length: 30 }, (_, i) => at(i, 120));
    expect(
      new EvaluationContext(warming).evaluateAtom(
        { kind: "liquidity", side: "above", minAtr: 1, maxAtr: 8, minWeight: 1 },
        3,
      ),
    ).toBe(false);
    const flat = Array.from({ length: 40 }, (_, i) => bar(i, 100, 100, 100, 100));
    expect(
      new EvaluationContext(flat).evaluateAtom(
        { kind: "liquidity", side: "above", minAtr: 1, maxAtr: 8, minWeight: 1 },
        35,
      ),
    ).toBe(false);
  });

  it("дивергенция ложна, пока пивот нечем подтвердить", () => {
    // Пивот подтверждается через 2 бара после экстремума, значит до бара 4
    // подтверждать нечего. Ранний true означал бы сигнал, построенный на
    // экстремуме, который ещё не состоялся.
    const candles = Array.from({ length: 30 }, (_, i) => at(i, 100 - i));
    const ctx = new EvaluationContext(candles);
    for (const i of [0, 1, 2, 3]) {
      expect(
        ctx.evaluateAtom({ kind: "divergence", osc: "rsi", direction: "bullish", lookback: 30 }, i),
        `бар ${i}`,
      ).toBe(false);
    }
  });

  it("паттерн ложен, пока не набран заявленный прогрев", () => {
    const candles = [
      at(0, 100),
      at(1, 100),
      at(2, 100),
      bar(3, 100, 101, 99, 99.5),
      bar(4, 99, 102, 98.9, 101),
      at(5, 101),
    ];
    const ctx = new EvaluationContext(candles);
    expect(ctx.evaluateAtom({ kind: "priceAction", pattern: "engulfing", lookback: 5 }, 4)).toBe(false);
    expect(ctx.evaluateAtom({ kind: "priceAction", pattern: "engulfing", lookback: 4 }, 4)).toBe(true);
  });

  it("пинбар ложен на баре нулевого размаха (деления на ноль не будет)", () => {
    const candles = [at(0, 100), bar(1, 100, 100, 100, 100), at(2, 100)];
    const ctx = new EvaluationContext(candles);
    expect(ctx.evaluateAtom({ kind: "priceAction", pattern: "pinbar", lookback: 1 }, 1)).toBe(false);
  });
});

describe("нет внешнего ряда — нет сигнала", () => {
  const candles = Array.from({ length: 80 }, (_, i) => at(i, 100 + (i % 5)));

  it("фандинг без символа ложен при ОБОИХ направлениях", () => {
    // Симметрия здесь не косметика: если бы «неизвестно» давало true только
    // одной стороне, шортовые и лонговые семейства получили бы разное число
    // наблюдений на одних и тех же данных, и сравнение семейств стало бы
    // сравнением дефектов.
    putFunding("BTCUSDT", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((x) => x * 1e-4));
    const ctx = new EvaluationContext(candles); // символа нет
    for (const direction of ["above", "below"] as const) {
      expect(
        ctx.evaluateAtom({ kind: "funding", direction, percentile: 80, windowDays: 2 }, 70),
        direction,
      ).toBe(false);
    }
  });

  it("фандинг с символом, но без истории ставок — ложен", () => {
    const ctx = new EvaluationContext(candles, "NOSUCH");
    expect(
      ctx.evaluateAtom({ kind: "funding", direction: "above", percentile: 80, windowDays: 2 }, 70),
    ).toBe(false);
  });

  it("фандинг ложен, пока в окне не набралось выплат", () => {
    // Окно из 6 выплат — это двое суток. На баре 10 их прошло меньше, и
    // процентиль неизвестен. Подстановка «50» здесь выглядела бы безобидно и
    // при этом включала бы половину порогов.
    putFunding("ETHUSDT", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((x) => x * 1e-4));
    const ctx = new EvaluationContext(candles, "ETHUSDT");
    expect(
      ctx.evaluateAtom({ kind: "funding", direction: "above", percentile: 80, windowDays: 2 }, 10),
    ).toBe(false);
  });

  it("тейкерский поток без символа и без метрик — ложен при обоих направлениях", () => {
    const ctx = new EvaluationContext(candles);
    for (const direction of ["buy", "sell"] as const) {
      expect(
        ctx.evaluateAtom({ kind: "takerFlow", direction, percentile: 80, windowDays: 1 }, 70),
        direction,
      ).toBe(false);
    }
    const withSymbol = new EvaluationContext(candles, "NOSUCH");
    expect(
      withSymbol.evaluateAtom({ kind: "takerFlow", direction: "buy", percentile: 80, windowDays: 1 }, 70),
    ).toBe(false);
  });

  it("дыра в метриках не заполняется: окно с пропусками остаётся неизвестным", () => {
    // Пропущенный час у Binance — обычное дело. Интерполяция превратила бы
    // «данных нет» в «поток нейтрален», и атом начал бы срабатывать по
    // выдуманным числам.
    const ratios = Array.from({ length: 80 }, (_, i) => 1 + i * 0.01);
    putMetrics("GAPS", ratios);
    const holed = metricsStore.get("GAPS")!;
    // выбиваем каждый третий час — в окне остаётся меньше 90% данных
    const kept = Array.from({ length: 80 }, (_, i) => i).filter((i) => i % 3 !== 0);
    metricsStore.set("GAPS", {
      hourStarts: Float64Array.from(kept.map((i) => holed.hourStarts[i])),
      takerRatio: Float64Array.from(kept.map((i) => holed.takerRatio[i])),
    });
    clearMetricsCache();
    const fresh = Array.from({ length: 80 }, (_, i) => at(i, 100 + (i % 5)));
    const ctx = new EvaluationContext(fresh, "GAPS");
    expect(
      ctx.evaluateAtom({ kind: "takerFlow", direction: "buy", percentile: 80, windowDays: 1 }, 70),
    ).toBe(false);
  });

  it("дивергенция по CVD без символа ложна — ряд просто не из чего построить", () => {
    // CVD это не индикатор цены, а внешний ряд. Раньше подобные атомы легко
    // становились «всегда истина» в браузере, где источника нет вовсе.
    const ctx = new EvaluationContext(candles);
    for (const direction of ["bullish", "bearish"] as const) {
      expect(
        ctx.evaluateAtom({ kind: "divergence", osc: "cvd", direction, lookback: 30 }, 60),
        direction,
      ).toBe(false);
    }
  });

  it("дивергенция по CVD с символом, но без метрик — ложна", () => {
    const ctx = new EvaluationContext(candles, "NOSUCH");
    expect(
      ctx.evaluateAtom({ kind: "divergence", osc: "cvd", direction: "bullish", lookback: 30 }, 60),
    ).toBe(false);
  });
});

describe("сводка: на коротком ряду без внешних данных не истинен НИ ОДИН атом", () => {
  /**
   * Пять баров — меньше прогрева любого индикатора. Единственные исключения,
   * которые здесь НЕ проверяются, — vwap и parabolicSar: они определены с
   * первого (второго) бара по построению, и их значение на баре 1 настоящее, а
   * не выдуманное.
   */
  const short = [at(0, 100), at(1, 101), at(2, 99), at(3, 102), at(4, 98)];

  const warmupKinds: IndicatorRef["kind"][] = [
    "sma", "ema", "rsi", "macd", "bollinger", "stochastic", "adx", "ichimoku",
    "superTrend", "cci", "williamsR", "keltner", "donchian", "atrChannel",
    "roc", "choppiness", "hurst", "realizedVol", "volPercentile", "zscore",
  ];

  const atoms: [string, ConditionAtom][] = [];
  for (const kind of warmupKinds) {
    atoms.push([`${kind} > close`, { kind: "comparison", left: { kind }, op: ">", right: { kind: "close" } }]);
    atoms.push([`${kind} < close`, { kind: "comparison", left: { kind }, op: "<", right: { kind: "close" } }]);
    atoms.push([`${kind} пересекает close`, {
      kind: "crossover", direction: "above", a: { kind }, b: { kind: "close" },
    }]);
  }
  atoms.push(["растянутость вверх", { kind: "stretch", period: 20, direction: "above", minAtr: 0.5 }]);
  atoms.push(["растянутость вниз", { kind: "stretch", period: 20, direction: "below", minAtr: 0.5 }]);
  atoms.push(["ликвидность выше", { kind: "liquidity", side: "above", minAtr: 0.5, maxAtr: 8, minWeight: 1 }]);
  atoms.push(["ликвидность ниже", { kind: "liquidity", side: "below", minAtr: 0.5, maxAtr: 8, minWeight: 1 }]);
  atoms.push(["дивергенция rsi", { kind: "divergence", osc: "rsi", direction: "bullish", lookback: 30 }]);
  atoms.push(["дивергенция macd", { kind: "divergence", osc: "macd", direction: "bearish", lookback: 30 }]);
  atoms.push(["дивергенция cvd", { kind: "divergence", osc: "cvd", direction: "bullish", lookback: 30 }]);
  atoms.push(["фандинг вверх", { kind: "funding", direction: "above", percentile: 80, windowDays: 2 }]);
  atoms.push(["фандинг вниз", { kind: "funding", direction: "below", percentile: 80, windowDays: 2 }]);
  atoms.push(["поток покупок", { kind: "takerFlow", direction: "buy", percentile: 80, windowDays: 1 }]);
  atoms.push(["поток продаж", { kind: "takerFlow", direction: "sell", percentile: 80, windowDays: 1 }]);
  atoms.push(["поглощение", { kind: "priceAction", pattern: "engulfing", lookback: 5 }]);
  atoms.push(["пинбар", { kind: "priceAction", pattern: "pinbar", lookback: 5 }]);
  atoms.push(["внутренний бар", { kind: "priceAction", pattern: "insideBar", lookback: 5 }]);

  it("ни с символом, ни без символа", () => {
    // Один провал здесь — это семейство стратегий, у которого входы стоят на
    // первых барах каждого прогона, а метрики выглядят обычными.
    const truthy: string[] = [];
    for (const symbol of [undefined, "BTCUSDT"]) {
      const ctx = new EvaluationContext(short, symbol);
      for (const [name, atom] of atoms) {
        for (let i = 0; i < short.length; i++) {
          if (ctx.evaluateAtom(atom, i)) truthy.push(`${symbol ?? "без символа"}: ${name} @${i}`);
        }
      }
    }
    expect(truthy).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. СДВИГ
// ---------------------------------------------------------------------------

describe("сдвиг ряда: значение на баре i берётся с бара i−shift", () => {
  /** Монотонный ряд: близость к правильному ответу тут неотличима от него. */
  const rising = Array.from({ length: 40 }, (_, i) => at(i, 100 + i));

  it("сдвиг именно НАЗАД и ровно на столько", () => {
    // Знак ошибки решает всё: сдвиг вперёд — это заглядывание в будущее, и
    // «пробой канала» стал бы пробоем канала, посчитанного по ещё не
    // случившимся барам. Такая стратегия покажет отличный бэктест и ничего
    // не заработает.
    const ctx = new EvaluationContext(rising);
    expect(ctx.valueAt({ kind: "close" }, 30)).toBe(130);
    expect(ctx.valueAt({ kind: "close", shift: 1 }, 30)).toBe(129);
    expect(ctx.valueAt({ kind: "close", shift: 5 }, 30)).toBe(125);
    expect(ctx.valueAt({ kind: "close", shift: 12 }, 30)).toBe(118);
  });

  it("сдвиг считается по индексу СВЕЧЕЙ, а не по индексу короткого ряда", () => {
    // Ряд SMA(20) начинается с бара 19, то есть короче свечей на 19 позиций.
    // Сдвиг, применённый к его собственному индексу, промахнулся бы ровно на
    // эти 19 баров — и тем сильнее, чем длиннее окно, то есть тем незаметнее
    // на коротких проверках.
    const ctx = new EvaluationContext(rising);
    const plain = ctx.valueAt({ kind: "sma", period: 20 }, 25);
    const shifted = ctx.valueAt({ kind: "sma", period: 20, shift: 6 }, 31);
    expect(plain).toBe(115.5); // среднее 106..125
    expect(shifted).toBe(plain);
  });

  it("сдвиг за пределы истории даёт null, а не последнее известное значение", () => {
    // «Последнее известное» — самая правдоподобная из неправильных подстановок:
    // ряд выглядит непрерывным, а условие сравнивает бар с самим собой.
    const ctx = new EvaluationContext(rising);
    expect(ctx.valueAt({ kind: "close", shift: 5 }, 3)).toBeNull();
    expect(ctx.valueAt({ kind: "sma", period: 20, shift: 10 }, 25)).toBeNull();
  });

  it("сдвинутый и несдвинутый ряды — РАЗНЫЕ записи кэша", () => {
    // Кэш серий общий на весь символ и переживает отдельные бэктесты. Совпади
    // ключ — половина кандидатов ночи получила бы чужой ряд, и это никак не
    // проявилось бы, кроме как в результатах.
    const ctx = new EvaluationContext(rising);
    const a = ctx.valueAt({ kind: "sma", period: 20 }, 30);
    const b = ctx.valueAt({ kind: "sma", period: 20, shift: 3 }, 30);
    expect(a).toBe(120.5);
    expect(b).toBe(117.5);
    expect(ctx.valueAt({ kind: "sma", period: 20 }, 30)).toBe(a); // не затёрт сдвинутым
  });

  it("ПЕРЕСЕЧЕНИЕ требует перехода, СРАВНЕНИЕ — состояния: это разные атомы", () => {
    // Различие не педантизм, а причина, по которой правило свипа написано на
    // `comparison`, а не на `crossover`.
    //
    // Фикстура однозначна: пятнадцать баров стоим на 100, потом скачок на 120
    // и удержание. Пересечение обязано сработать РОВНО ОДИН раз — на баре
    // перехода. Сравнение — на баре скачка и на всех последующих, пока цена
    // выше вчерашней границы.
    //
    // Цена путаницы: семейство, написанное не тем атомом, даёт либо ноль
    // сделок, либо сделку на каждом баре — и то и другое выглядит как
    // свойство рынка, а не как ошибка формулировки.
    const flatThenJump = [
      ...Array.from({ length: 15 }, (_, i) => at(i, 100)),
      ...Array.from({ length: 10 }, (_, i) => at(15 + i, 120)),
    ];
    const ctx = new EvaluationContext(flatThenJump);
    // Порог числом, а не каналом: канал после скачка сам подтягивается вверх и
    // гасит различие, которое здесь и надо показать.
    const ref = 110;
    const crossings: number[] = [];
    const comparisons: number[] = [];
    for (let i = 0; i < flatThenJump.length; i++) {
      if (ctx.evaluateAtom({ kind: "crossover", direction: "above", a: { kind: "close" }, b: ref }, i))
        crossings.push(i);
      if (ctx.evaluateAtom({ kind: "comparison", left: { kind: "close" }, op: ">", right: ref }, i))
        comparisons.push(i);
    }
    expect(crossings).toEqual([15]); // ровно один переход, на баре скачка
    expect(comparisons[0]).toBe(15); // состояние начинается там же
    expect(comparisons.length).toBe(10); // и держится все десять баров выше
  });
});


// ---------------------------------------------------------------------------
// 3. ЗАГЛЯДЫВАНИЕ ВПЕРЁД
// ---------------------------------------------------------------------------

/**
 * Ряд для проверки причинности. Форма значения не имеет — важна ширина охвата,
 * поэтому бары порождаются детерминированным генератором (одно и то же на любой
 * машине), а не выписаны руками: смысл теста в том, что проверены ВСЕ виды
 * условий, а не в конкретных ценах.
 */
function causalSeries(count: number): Candle[] {
  let seed = 20260810;
  const next = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price * (1 + (next() - 0.5) * 0.03);
    out.push(
      bar(
        i,
        open,
        Math.max(open, close) * (1 + next() * 0.01),
        Math.min(open, close) * (1 - next() * 0.01),
        close,
        10 + next() * 5,
      ),
    );
    price = close;
  }
  return out;
}

describe("ПРИЧИННОСТЬ: значение на баре i не зависит ни от одного бара после i", () => {
  const CANDLES = causalSeries(320);
  const PROBES = [40, 90, 150, 220, 290, 319];
  const SYMBOL = "CAUSAL";

  const indicatorKinds: IndicatorRef["kind"][] = [
    "sma", "ema", "rsi", "macd", "bollinger", "vwap", "close", "price",
    "stochastic", "adx", "ichimoku", "superTrend", "parabolicSar", "cci",
    "williamsR", "obv", "keltner", "donchian", "atrChannel", "roc",
    "choppiness", "hurst", "realizedVol", "volPercentile", "zscore",
  ];

  /**
   * Сравнивает ответ на префиксе [0..i] с ответом на полном ряду. Это
   * единственный доступный способ поймать заглядывание вперёд: оно не роняет
   * тесты, не пишет в лог и не портит числа — оно просто рисует край, которого
   * в реальном времени не существует, и вся отобранная по нему стратегия
   * оказывается артефактом.
   */
  function mismatches(atoms: [string, ConditionAtom][], symbol?: string): string[] {
    const full = new EvaluationContext(CANDLES, symbol);
    const bad: string[] = [];
    for (const i of PROBES) {
      const prefix = new EvaluationContext(CANDLES.slice(0, i + 1), symbol);
      for (const [name, atom] of atoms) {
        const a = prefix.evaluateAtom(atom, i);
        const b = full.evaluateAtom(atom, i);
        if (a !== b) bad.push(`${name} @${i}: префикс=${a}, полный ряд=${b}`);
      }
    }
    return bad;
  }

  it("сравнения по всем индикаторам", () => {
    const atoms: [string, ConditionAtom][] = indicatorKinds.map((kind) => [
      `${kind} > close`,
      { kind: "comparison", left: { kind }, op: ">", right: { kind: "close" } },
    ]);
    expect(mismatches(atoms)).toEqual([]);
  });

  it("сравнения по всем индикаторам СО СДВИГОМ", () => {
    // Сдвиг — отдельный шанс промахнуться мимо причинности: он переиндексирует
    // ряд, и ошибка знака здесь означает заглядывание ровно на shift баров.
    const atoms: [string, ConditionAtom][] = indicatorKinds.map((kind) => [
      `${kind} shift3 > close`,
      { kind: "comparison", left: { kind, shift: 3 }, op: ">", right: { kind: "close" } },
    ]);
    expect(mismatches(atoms)).toEqual([]);
  });

  it("пересечения по всем индикаторам", () => {
    const atoms: [string, ConditionAtom][] = indicatorKinds.flatMap((kind) => [
      [`${kind} вверх`, { kind: "crossover", direction: "above", a: { kind }, b: { kind: "close" } }],
      [`${kind} вниз`, { kind: "crossover", direction: "below", a: { kind }, b: { kind: "close" } }],
    ]);
    expect(mismatches(atoms)).toEqual([]);
  });

  it("каналы по каждой линии: верх, низ, середина", () => {
    const atoms: [string, ConditionAtom][] = [];
    for (const kind of ["bollinger", "keltner", "donchian", "atrChannel"] as const) {
      for (const line of ["upper", "lower", "middle"] as const) {
        atoms.push([
          `${kind}.${line}`,
          { kind: "comparison", left: { kind, line }, op: ">", right: { kind: "close" } },
        ]);
      }
    }
    expect(mismatches(atoms)).toEqual([]);
  });

  it("паттерны, время, растянутость и ликвидность", () => {
    // Ликвидность — самое опасное место всего списка. Расчётная карта
    // ликвидаций строится по ВСЕЙ истории сразу (плотность на баре i включает
    // позиции, открытые ПОСЛЕ i); для картинки это нормально, для бэктеста —
    // готовый несуществующий край. Здесь проверяется, что причинная версия
    // такой карты действительно причинна.
    const atoms: [string, ConditionAtom][] = [
      ["поглощение", { kind: "priceAction", pattern: "engulfing", lookback: 5 }],
      ["пинбар", { kind: "priceAction", pattern: "pinbar", lookback: 5 }],
      ["внутренний бар", { kind: "priceAction", pattern: "insideBar", lookback: 5 }],
      ["время", { kind: "time", dayOfWeek: [1, 2, 3, 4, 5], hourRangeUtc: [22, 4] }],
      ["растянутость вверх", { kind: "stretch", period: 20, direction: "above", minAtr: 1 }],
      ["растянутость вниз", { kind: "stretch", period: 20, direction: "below", minAtr: 1 }],
      ["ликвидность выше", { kind: "liquidity", side: "above", minAtr: 0.5, maxAtr: 8, minWeight: 1 }],
      ["ликвидность ниже", { kind: "liquidity", side: "below", minAtr: 0.5, maxAtr: 8, minWeight: 1 }],
    ];
    expect(mismatches(atoms)).toEqual([]);
  });

  it("дивергенции: пивот подтверждается прошлым, а не будущим", () => {
    // Пивот — экстремум против двух соседей С КАЖДОЙ стороны, то есть его
    // правое плечо лежит в будущем относительно самого экстремума. Единственная
    // законная реализация — срабатывать на баре ПОДТВЕРЖДЕНИЯ. Если бы сигнал
    // ставился на бар экстремума, вход происходил бы за два бара до того, как о
    // нём вообще можно узнать, — и это лучший способ нарисовать идеальную
    // кривую доходности.
    putMetrics("CAUSAL", Array.from({ length: 400 }, (_, i) => 0.6 + ((i * 37) % 100) / 100));
    const atoms: [string, ConditionAtom][] = [];
    for (const osc of ["rsi", "macd", "cvd"] as const) {
      for (const direction of ["bullish", "bearish"] as const) {
        atoms.push([`${osc} ${direction}`, { kind: "divergence", osc, direction, lookback: 30 }]);
      }
    }
    expect(mismatches(atoms, SYMBOL)).toEqual([]);
  });

  it("фандинг и тейкерский поток: процентиль считается по прошлому окну", () => {
    // Процентиль по ВСЕЙ истории — классическая утечка: «сегодняшняя ставка в
    // верхних 10%» оценивается относительно распределения, которого в тот день
    // ещё не существовало. Внешне такое условие неотличимо от честного.
    putFunding("CAUSAL", Array.from({ length: 200 }, (_, i) => ((i * 13) % 41) * 1e-5));
    putMetrics("CAUSAL", Array.from({ length: 400 }, (_, i) => 0.6 + ((i * 37) % 100) / 100));
    const atoms: [string, ConditionAtom][] = [
      ["фандинг вверх", { kind: "funding", direction: "above", percentile: 70, windowDays: 3 }],
      ["фандинг вниз", { kind: "funding", direction: "below", percentile: 70, windowDays: 3 }],
      ["поток покупок", { kind: "takerFlow", direction: "buy", percentile: 70, windowDays: 2 }],
      ["поток продаж", { kind: "takerFlow", direction: "sell", percentile: 70, windowDays: 2 }],
    ];
    expect(mismatches(atoms, SYMBOL)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. ЗЕРКАЛЬНОСТЬ НАПРАВЛЕНИЙ
// ---------------------------------------------------------------------------

describe("зеркальность: лонговая и шортовая версия атома — одно и то же правило", () => {
  /**
   * Ряд «двадцать спокойных баров, затем рывок вверх на 2 в бар». На зеркале он
   * становится точно таким же рывком вниз.
   */
  const stretched: Candle[] = [
    ...Array.from({ length: 30 }, (_, i) => at(i, 100, 2)),
    ...Array.from({ length: 10 }, (_, i) => at(30 + i, 100 + (i + 1) * 2, 2)),
  ];

  it("растянутость вверх и вниз срабатывают на одних и тех же барах", () => {
    // Разъехавшиеся стороны дают систематический перекос: одна сторона получает
    // больше сделок на тех же данных, и вывод «шорты не работают» окажется
    // свойством вычислителя, а не рынка.
    const up = new EvaluationContext(stretched);
    const down = new EvaluationContext(mirror(stretched));
    const above: number[] = [];
    const below: number[] = [];
    for (let i = 0; i < stretched.length; i++) {
      if (up.evaluateAtom({ kind: "stretch", period: 20, direction: "above", minAtr: 2 }, i)) above.push(i);
      if (down.evaluateAtom({ kind: "stretch", period: 20, direction: "below", minAtr: 2 }, i)) below.push(i);
    }
    expect(above.length).toBeGreaterThan(0); // тест не должен быть пустым с обеих сторон
    expect(below).toEqual(above);
  });

  /**
   * Ряд с одиноким пивот-хаем на баре 22: три соседа с каждой стороны ниже,
   * дальше цена стоит ниже уровня примерно на 5 ATR.
   */
  const withLevel: Candle[] = [
    ...Array.from({ length: 20 }, (_, i) => at(i, 120)),
    at(20, 121), at(21, 123), at(22, 130), at(23, 123), at(24, 121), at(25, 120),
    ...Array.from({ length: 19 }, (_, i) => at(26 + i, 120)),
  ];

  it("скопление ликвидности выше и ниже цены видно одинаково", () => {
    const up = new EvaluationContext(withLevel);
    const down = new EvaluationContext(mirror(withLevel));
    const above: number[] = [];
    const below: number[] = [];
    for (let i = 0; i < withLevel.length; i++) {
      if (up.evaluateAtom({ kind: "liquidity", side: "above", minAtr: 1, maxAtr: 8, minWeight: 1 }, i)) above.push(i);
      if (down.evaluateAtom({ kind: "liquidity", side: "below", minAtr: 1, maxAtr: 8, minWeight: 1 }, i)) below.push(i);
    }
    expect(above.length).toBeGreaterThan(0);
    expect(below).toEqual(above);
  });

  it("порог фандинга симметричен: верхние N% и нижние N%", () => {
    // «Ставка в верхних 10%» и «в нижних 10%» обязаны быть одним порогом,
    // приложенным с разных сторон. Асимметрия здесь означала бы, что лонговое и
    // шортовое семейство фандинга отбирались по разной строгости — и сравнивать
    // их результаты нельзя.
    const candles = Array.from({ length: 80 }, (_, i) => at(i, 100));
    const rising = Array.from({ length: 12 }, (_, k) => (k + 1) * 1e-4);
    putFunding("UP", rising);
    putFunding("DOWN", rising.map((r) => -r)); // зеркало ставок

    const up = new EvaluationContext(candles, "UP");
    const down = new EvaluationContext(Array.from({ length: 80 }, (_, i) => at(i, 100)), "DOWN");
    const i = 70;
    expect(up.evaluateAtom({ kind: "funding", direction: "above", percentile: 80, windowDays: 2 }, i)).toBe(true);
    expect(down.evaluateAtom({ kind: "funding", direction: "below", percentile: 80, windowDays: 2 }, i)).toBe(true);
    // и одинаково молчат, когда порог поднят выше достижимого ранга
    expect(up.evaluateAtom({ kind: "funding", direction: "above", percentile: 95, windowDays: 2 }, i)).toBe(false);
    expect(down.evaluateAtom({ kind: "funding", direction: "below", percentile: 95, windowDays: 2 }, i)).toBe(false);
  });

  it("порог тейкерского потока симметричен: покупки и продажи", () => {
    const ratios = Array.from({ length: 80 }, (_, k) => 1 + k * 0.05);
    putMetrics("BUY", ratios);
    putMetrics("SELL", ratios.map((r) => 1 / r)); // обратное отношение = зеркальный дисбаланс

    const i = 70;
    const buy = new EvaluationContext(Array.from({ length: 80 }, (_, k) => at(k, 100)), "BUY");
    const sell = new EvaluationContext(Array.from({ length: 80 }, (_, k) => at(k, 100)), "SELL");
    expect(buy.evaluateAtom({ kind: "takerFlow", direction: "buy", percentile: 80, windowDays: 1 }, i)).toBe(true);
    expect(sell.evaluateAtom({ kind: "takerFlow", direction: "sell", percentile: 80, windowDays: 1 }, i)).toBe(true);
  });

  it("дивергенция: бычья и медвежья находят один и тот же перелом", () => {
    // Бычья — более низкий минимум цены при более высоком минимуме
    // осциллятора; медвежья обязана быть ровно этим же по максимумам. Если
    // одна сторона реализована через «не выполнено обратное», она начнёт
    // срабатывать там, где пивота нет вовсе.
    const downTrend = [
      140, 138, 136, 134, 132, 130, 128, 126, 124, 122,
      120, 118, 116, 114, 112, 110, 108, 106,
      100, 96, 90, 96, 100,
      104, 106, 108, 106, 104,
      100, 96, 89, 95, 99,
      101, 103, 105, 107, 109,
    ].map((p, i) => at(i, p));
    const upTrend = mirror(downTrend);

    const bull = new EvaluationContext(downTrend);
    const bear = new EvaluationContext(upTrend);
    const bullFired: number[] = [];
    const bearFired: number[] = [];
    for (let i = 0; i < downTrend.length; i++) {
      if (bull.evaluateAtom({ kind: "divergence", osc: "rsi", direction: "bullish", lookback: 30 }, i)) bullFired.push(i);
      if (bear.evaluateAtom({ kind: "divergence", osc: "rsi", direction: "bearish", lookback: 30 }, i)) bearFired.push(i);
    }
    expect(bullFired).toEqual([32]); // подтверждение пивота бара 30 — через два бара
    expect(bearFired).toEqual(bullFired);
  });

  it("дивергенция срабатывает ОДИН раз, а не горит до конца истории", () => {
    // Сигнал, который «горит» много баров подряд, превращает одно событие в
    // десяток сделок и раздувает число наблюдений — то самое, по которому
    // семейство проходит отбор.
    const downTrend = [
      140, 138, 136, 134, 132, 130, 128, 126, 124, 122,
      120, 118, 116, 114, 112, 110, 108, 106,
      100, 96, 90, 96, 100,
      104, 106, 108, 106, 104,
      100, 96, 89, 95, 99,
      101, 103, 105, 107, 109,
    ].map((p, i) => at(i, p));
    const ctx = new EvaluationContext(downTrend);
    let count = 0;
    for (let i = 0; i < downTrend.length; i++) {
      if (ctx.evaluateAtom({ kind: "divergence", osc: "rsi", direction: "bullish", lookback: 30 }, i)) count++;
    }
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. ГРАНИЦЫ СРАВНЕНИЯ
// ---------------------------------------------------------------------------

describe("границы сравнения", () => {
  const flat = Array.from({ length: 30 }, (_, i) => at(i, 100));

  it("равенство: > ложно, >= истинно; < ложно, <= истинно", () => {
    // Порог «RSI >= 30» и «RSI > 30» различаются ровно на баре касания. На
    // ровных уровнях (круглые цены, полки индикаторов) касания не редкость, и
    // перепутанная строгость сдвигает часть входов на бар — то есть меняет
    // цену входа у целого семейства.
    const ctx = new EvaluationContext(flat);
    const left: IndicatorRef = { kind: "close" };
    expect(ctx.evaluateAtom({ kind: "comparison", left, op: ">", right: 100 }, 10)).toBe(false);
    expect(ctx.evaluateAtom({ kind: "comparison", left, op: ">=", right: 100 }, 10)).toBe(true);
    expect(ctx.evaluateAtom({ kind: "comparison", left, op: "<", right: 100 }, 10)).toBe(false);
    expect(ctx.evaluateAtom({ kind: "comparison", left, op: "<=", right: 100 }, 10)).toBe(true);
  });

  it("отрицательные значения сравниваются по величине, а не по модулю", () => {
    // Williams %R живёт в диапазоне −100..0, z-score и MACD свободно уходят в
    // минус. Сравнение по модулю сделало бы «перепроданность» и
    // «перекупленность» одним и тем же условием.
    const ctx = new EvaluationContext(flat);
    const wr: IndicatorRef = { kind: "williamsR", period: 14 };
    // на константном ряду размах равен нулю — реализация отдаёт −50
    expect(ctx.valueAt(wr, 20)).toBe(-50);
    expect(ctx.evaluateAtom({ kind: "comparison", left: wr, op: "<", right: -20 }, 20)).toBe(true);
    expect(ctx.evaluateAtom({ kind: "comparison", left: wr, op: "<", right: -80 }, 20)).toBe(false);
    expect(ctx.evaluateAtom({ kind: "comparison", left: wr, op: ">", right: -80 }, 20)).toBe(true);
  });

  it("пересечение вверх: касание на прошлом баре считается пересечением", () => {
    // Реализация «строго ниже, потом строго выше» пропустила бы вход, где цена
    // легла ровно на уровень и на следующем баре ушла вверх, — а это самый
    // частый вид пробоя круглого уровня.
    const candles = [at(0, 90), at(1, 100), at(2, 110), at(3, 105)];
    const ctx = new EvaluationContext(candles);
    const atom: ConditionAtom = { kind: "crossover", direction: "above", a: { kind: "close" }, b: 100 };
    expect(ctx.evaluateAtom(atom, 1)).toBe(false); // 90 → 100: ещё не выше
    expect(ctx.evaluateAtom(atom, 2)).toBe(true); // 100 → 110: касание, затем выше
    expect(ctx.evaluateAtom(atom, 3)).toBe(false); // 110 → 105: уже был выше
  });

  it("пересечение вниз зеркально касанию сверху", () => {
    const candles = [at(0, 110), at(1, 100), at(2, 90), at(3, 95)];
    const ctx = new EvaluationContext(candles);
    const atom: ConditionAtom = { kind: "crossover", direction: "below", a: { kind: "close" }, b: 100 };
    expect(ctx.evaluateAtom(atom, 1)).toBe(false);
    expect(ctx.evaluateAtom(atom, 2)).toBe(true);
    expect(ctx.evaluateAtom(atom, 3)).toBe(false);
  });

  it("равенство на обоих барах пересечением НЕ считается", () => {
    // Иначе полка (цена стоит ровно на уровне) давала бы «пересечение» на
    // каждом баре полки — десятки входов там, где не произошло ничего.
    const ctx = new EvaluationContext(flat);
    for (const direction of ["above", "below"] as const) {
      expect(
        ctx.evaluateAtom({ kind: "crossover", direction, a: { kind: "close" }, b: 100 }, 10),
        direction,
      ).toBe(false);
    }
  });

  it("ликвидность: границы окна расстояний включительные с обеих сторон", () => {
    // Уровень ровно на minAtr обязан считаться «впереди», иначе окно
    // расстояний тихо у́же заявленного, и часть сделок семейства пропадает без
    // следа в отчётах.
    const ctx = new EvaluationContext([
      ...Array.from({ length: 20 }, (_, i) => at(i, 120)),
      at(20, 121), at(21, 123), at(22, 130), at(23, 123), at(24, 121), at(25, 120),
      ...Array.from({ length: 19 }, (_, i) => at(26 + i, 120)),
    ]);
    const wide = ctx.evaluateAtom({ kind: "liquidity", side: "above", minAtr: 1, maxAtr: 20, minWeight: 1 }, 40);
    const tooFar = ctx.evaluateAtom({ kind: "liquidity", side: "above", minAtr: 1, maxAtr: 0.5, minWeight: 1 }, 40);
    const tooNear = ctx.evaluateAtom({ kind: "liquidity", side: "above", minAtr: 50, maxAtr: 99, minWeight: 1 }, 40);
    const tooLight = ctx.evaluateAtom({ kind: "liquidity", side: "above", minAtr: 1, maxAtr: 20, minWeight: 99 }, 40);
    expect(wide).toBe(true);
    expect(tooFar).toBe(false);
    expect(tooNear).toBe(false);
    expect(tooLight).toBe(false);
  });

  it("время: диапазон часов полуоткрытый и умеет переходить через полночь", () => {
    // [22, 4) — это 22, 23, 0, 1, 2, 3. Реализация «from <= h && h < to» без
    // ветки перехода дала бы ПУСТОЙ фильтр, и «ночная сессия» молча
    // отключилась бы, оставив стратегию торговать круглосуточно.
    const hours = Array.from({ length: 24 }, (_, h) => ({
      candle: { time: T0 + h * HOUR, open: 100, high: 101, low: 99, close: 100, volume: 10 },
      hour: new Date((T0 + h * HOUR) * 1000).getUTCHours(),
    }));
    const candles = hours.map((x) => x.candle);
    const ctx = new EvaluationContext(candles);
    for (let i = 0; i < candles.length; i++) {
      const h = hours[i].hour;
      const expectedNight = h >= 22 || h < 4;
      expect(ctx.evaluateAtom({ kind: "time", hourRangeUtc: [22, 4] }, i), `час ${h}`).toBe(expectedNight);
      const expectedDay = h >= 8 && h < 16;
      expect(ctx.evaluateAtom({ kind: "time", hourRangeUtc: [8, 16] }, i), `час ${h}`).toBe(expectedDay);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. ГРУППЫ УСЛОВИЙ
// ---------------------------------------------------------------------------

describe("группы условий", () => {
  const flat = Array.from({ length: 30 }, (_, i) => at(i, 100));
  const TRUE_ATOM: ConditionAtom = { kind: "comparison", left: { kind: "close" }, op: ">=", right: 100 };
  const FALSE_ATOM: ConditionAtom = { kind: "comparison", left: { kind: "close" }, op: ">", right: 100 };

  it("AND требует всех, OR — хотя бы одного", () => {
    const ctx = new EvaluationContext(flat);
    expect(ctx.evaluateGroup({ operator: "AND", conditions: [TRUE_ATOM, TRUE_ATOM] }, 10)).toBe(true);
    expect(ctx.evaluateGroup({ operator: "AND", conditions: [TRUE_ATOM, FALSE_ATOM] }, 10)).toBe(false);
    expect(ctx.evaluateGroup({ operator: "OR", conditions: [FALSE_ATOM, TRUE_ATOM] }, 10)).toBe(true);
    expect(ctx.evaluateGroup({ operator: "OR", conditions: [FALSE_ATOM, FALSE_ATOM] }, 10)).toBe(false);
  });

  it("вложенные группы вычисляются рекурсивно", () => {
    const ctx = new EvaluationContext(flat);
    expect(
      ctx.evaluateGroup(
        {
          operator: "AND",
          conditions: [TRUE_ATOM, { operator: "OR", conditions: [FALSE_ATOM, TRUE_ATOM] }],
        },
        10,
      ),
    ).toBe(true);
    expect(
      ctx.evaluateGroup(
        {
          operator: "AND",
          conditions: [TRUE_ATOM, { operator: "OR", conditions: [FALSE_ATOM, FALSE_ATOM] }],
        },
        10,
      ),
    ).toBe(false);
  });

  it("одно ложное условие гасит всю AND-группу независимо от позиции", () => {
    const ctx = new EvaluationContext(flat);
    expect(ctx.evaluateGroup({ operator: "AND", conditions: [FALSE_ATOM, TRUE_ATOM, TRUE_ATOM] }, 10)).toBe(false);
    expect(ctx.evaluateGroup({ operator: "AND", conditions: [TRUE_ATOM, TRUE_ATOM, FALSE_ATOM] }, 10)).toBe(false);
  });

  it("МИНА: пустая AND-группа истинна на каждом баре", () => {
    // Это ЗАКРЕПЛЁННОЕ поведение, а не случайность: тесты движка используют
    // пустой вход как «входить всегда». Но это же вакуумная истина — стратегия,
    // у которой условия входа потерялись при загрузке или отфильтровались
    // валидатором, начнёт входить на КАЖДОМ баре, и внешне это будет выглядеть
    // как очень активная стратегия, а не как поломка.
    //
    // Тест стоит здесь, чтобы такая семантика оставалась осознанным решением.
    // Защита от «условия исчезли» обязана жить выше — в проверке конфигурации.
    const ctx = new EvaluationContext(flat);
    expect(ctx.evaluateGroup({ operator: "AND", conditions: [] }, 10)).toBe(true);
    expect(ctx.evaluateGroup({ operator: "OR", conditions: [] }, 10)).toBe(false);
  });

  it("МИНА: атом времени без единого поля истинен всегда", () => {
    // `{ kind: "time" }` без дня недели и без часов — это фильтр, который
    // ничего не фильтрует. Как и пустая группа, он безопасен ровно до тех пор,
    // пока появляется намеренно.
    const ctx = new EvaluationContext(flat);
    expect(ctx.evaluateAtom({ kind: "time" }, 10)).toBe(true);
    // а вот пустой список дней недели не пропускает ни один бар
    expect(ctx.evaluateAtom({ kind: "time", dayOfWeek: [] }, 10)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. ЗАКРЕПЛЕНИЕ СМЫСЛА ПАРАМЕТРОВ
// ---------------------------------------------------------------------------

describe("что параметры атомов на самом деле означают", () => {
  it("lookback у паттерна — ТОЛЬКО прогрев, а не ширина окна поиска", () => {
    // Поглощение, пинбар и внутренний бар смотрят ровно на два бара: текущий и
    // предыдущий. `lookback` не расширяет это окно ни на бар — он лишь глушит
    // сигнал на первых `lookback` барах истории.
    //
    // Закреплено здесь, потому что имя параметра обещает другое: тот, кто
    // подбирает lookback как настройку паттерна, на самом деле подбирает
    // сдвиг начала истории, и «улучшение» от такой настройки — чистый шум.
    const candles = [
      at(0, 100), at(1, 100), at(2, 100),
      bar(3, 100, 101, 99, 99.5), // медвежья
      bar(4, 99, 102, 98.9, 101), // бычье поглощение предыдущей
      at(5, 101),
    ];
    const ctx = new EvaluationContext(candles);
    for (const lookback of [1, 2, 4]) {
      expect(
        ctx.evaluateAtom({ kind: "priceAction", pattern: "engulfing", lookback }, 4),
        `lookback ${lookback}`,
      ).toBe(true);
    }
    // разница появляется только там, где сам бар попадает в прогрев
    expect(ctx.evaluateAtom({ kind: "priceAction", pattern: "engulfing", lookback: 5 }, 4)).toBe(false);
  });

  it("внутренний бар — это диапазон внутри предыдущего, включая совпадение краёв", () => {
    const candles = [
      bar(0, 100, 110, 90, 100),
      bar(1, 100, 105, 95, 100), // строго внутри
      bar(2, 100, 105, 95, 100), // ровно повторяет предыдущий
      bar(3, 100, 106, 95, 100), // выше по хаю — уже не внутренний
    ];
    const ctx = new EvaluationContext(candles);
    expect(ctx.evaluateAtom({ kind: "priceAction", pattern: "insideBar", lookback: 1 }, 1)).toBe(true);
    expect(ctx.evaluateAtom({ kind: "priceAction", pattern: "insideBar", lookback: 1 }, 2)).toBe(true);
    expect(ctx.evaluateAtom({ kind: "priceAction", pattern: "insideBar", lookback: 1 }, 3)).toBe(false);
  });

  it("линия канала выбирается по `line`, а не подменяется серединой", () => {
    // Когда-то здесь всегда возвращалась средняя, и условие «цена ниже нижней
    // полосы» молча означало «цена ниже SMA20»: без ошибки, без
    // предупреждения, с совершенно другим смыслом сигнала.
    const candles = [
      ...Array.from({ length: 19 }, (_, i) => at(i, 100)),
      at(19, 110),
    ];
    const ctx = new EvaluationContext(candles);
    const upper = ctx.valueAt({ kind: "bollinger", period: 20, line: "upper" }, 19)!;
    const middle = ctx.valueAt({ kind: "bollinger", period: 20, line: "middle" }, 19)!;
    const lower = ctx.valueAt({ kind: "bollinger", period: 20, line: "lower" }, 19)!;
    const fallback = ctx.valueAt({ kind: "bollinger", period: 20 }, 19)!;
    expect(upper).toBeGreaterThan(middle);
    expect(lower).toBeLessThan(middle);
    expect(fallback).toBe(middle); // без `line` — середина, это задокументированный выбор
  });

  it("у MACD наружу отдаются все три линии, а не только основная", () => {
    // Без этого «MACD пересёк сигнальную» — самый ходовой вид сигнала —
    // выразить в шаблоне было нельзя.
    const candles = Array.from({ length: 60 }, (_, i) => at(i, 100 + Math.round(Math.sin(i / 3) * 5)));
    const ctx = new EvaluationContext(candles);
    const line = ctx.valueAt({ kind: "macd" }, 55)!;
    const signal = ctx.valueAt({ kind: "macd", line: "signal" }, 55)!;
    const hist = ctx.valueAt({ kind: "macd", line: "histogram" }, 55)!;
    expect(hist).toBeCloseTo(line - signal, 10);
    expect(signal).not.toBe(line);
  });
});

// ---------------------------------------------------------------------------
// 8. НАЙДЕННЫЕ ДЕФЕКТЫ
// ---------------------------------------------------------------------------

describe("НАЙДЕННЫЕ ДЕФЕКТЫ (эти тесты падают намеренно — они описывают баг)", () => {
  it("ДЕФЕКТ 1: паттерн с lookback = 0 на нулевом баре бросает исключение вместо false", () => {
    // Контракт модуля — «нет данных, значит false». Здесь он нарушается
    // единственным способом, который вообще возможен: `index < lookback`
    // случайно защищает нулевой бар только при lookback >= 1. При lookback = 0
    // проверка пропускает бар 0, а поглощению и внутреннему бару нужен
    // ПРЕДЫДУЩИЙ бар, которого не существует, — обращение к candles[-1] даёт
    // undefined и падение на чтении поля.
    //
    // Цена ошибки: не выдуманная сделка, а обрыв прогона. Ночной скрин на 56
    // тысячах испытаний падает на первом же кандидате с таким атомом, и вместе
    // с ним теряются результаты всех остальных, посчитанные до этого момента.
    // Значение 0 разрешено типом ConditionAtom и придёт из первого же
    // рукописного конфига или мутации перебора.
    //
    // Правильная граница — `index < Math.max(1, lookback)`.
    const candles = [at(0, 100), at(1, 100)];
    const ctx = new EvaluationContext(candles);
    expect(ctx.evaluateAtom({ kind: "priceAction", pattern: "engulfing", lookback: 0 }, 0)).toBe(false);
    expect(ctx.evaluateAtom({ kind: "priceAction", pattern: "insideBar", lookback: 0 }, 0)).toBe(false);
  });

  it("ДЕФЕКТ 2: кэш серий не замечает правку high/low/volume последнего бара", () => {
    // Общий кэш индикаторных серий сбрасывается по отпечатку массива свечей:
    // длина, время краёв и close последнего бара. Живой бар меняет не только
    // close — сначала обновляются high, low и volume, и close вполне может
    // остаться прежним (тик ушёл вверх и вернулся). Отпечаток при этом не
    // меняется, и на запрос отдаётся ряд, посчитанный ДО движения.
    //
    // Здесь: канал Дончиана после того, как бар напечатал новый максимум 200,
    // продолжает утверждать, что верх канала равен 101.
    //
    // Цена ошибки — обе стороны сразу. Устаревший ATR (меньше настоящего)
    // завышает растянутость в ATR и включает вход, которого нет; устаревшая
    // граница канала показывает пробой уровня, который уже не там. И то и
    // другое молча: значение выглядит совершенно обычным числом.
    //
    // Комментарий у кэша перечисляет только два случая живого графика —
    // дописывание баров и правку close. Третий (правка экстремумов текущего
    // бара) — ровно то, что живой график делает чаще всего.
    const candles: Candle[] = Array.from({ length: 40 }, (_, i) => at(i, 100));
    const ref: IndicatorRef = { kind: "donchian", period: 10, line: "upper" };

    expect(new EvaluationContext(candles).valueAt(ref, 39)).toBe(101);

    // живой бар пробил вверх; close вернулся на прежнее место
    candles[39] = { ...candles[39], high: 200 };

    expect(new EvaluationContext(candles).valueAt(ref, 39)).toBe(200);
  });
});
