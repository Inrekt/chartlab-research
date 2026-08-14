import { beforeEach, describe, expect, it } from "vitest";
import type { Candle } from "../types";
import { setMetricsLoader, type MetricsHistory } from "../metrics/metricsSeries";
import { forcedFlowSeries, setFlowLoader, type FlowHistory } from "./flowSeries";
import { EvaluationContext } from "../strategy/evaluator";

/*
 * Атом «Принудительный поток» — конъюнкция односторонний поток ∧ падение OI.
 * Сигнал живёт ТОЛЬКО в совпадении: голый поток усредняет делеверидж (есть
 * плательщик → откат) и новое позиционирование (плательщика нет → продолжение)
 * в ноль. Тест разводит режимы так, что каждый ответ предсказан ЗАРАНЕЕ.
 *
 * Пре-регистрация: researcher/docs/family-forced-flow-preregistration.md.
 */
const H = 3600;
const T0 = 1_700_000_000;

const bar = (i: number): Candle => ({
  time: T0 + i * H,
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 1000,
});

// 4 свечи, режимы разведены:
//  0: продажи 0.70, OI падает  → deleverageLong=TRUE
//  1: продажи 0.70, OI РАСТЁТ  → deleverageLong=FALSE (ключевой различитель)
//  2: продажи 0.50, OI падает  → обе стороны FALSE (поток не односторонний)
//  3: продажи 0.30 (покупки 0.70), OI падает → deleverageShort=TRUE
const CANDLES = Array.from({ length: 4 }, (_, i) => bar(i));
const SELL = [0.7, 0.7, 0.5, 0.3];
// OI: нужен ещё час ДО T0 (смежный для свечи 0). Значения дают:
//  свеча0 97/100=−3%, свеча1 101/97=+4.1%, свеча2 98/101=−3%, свеча3 95/98=−3%.
const OI_HOURS = [T0 - H, T0, T0 + H, T0 + 2 * H, T0 + 3 * H];
const OI_VALS = [100, 97, 101, 98, 95];

const flowHistory = (): FlowHistory => ({
  hourStarts: Float64Array.from(CANDLES.map((c) => c.time)),
  sellFrac: Float64Array.from(SELL),
});
const metricsHistory = (): MetricsHistory => ({
  hourStarts: Float64Array.from(OI_HOURS),
  takerRatio: Float64Array.from(OI_HOURS.map(() => 1)),
  oi: Float64Array.from(OI_VALS),
});

const ATOM_LONG = {
  kind: "forcedFlow" as const,
  direction: "deleverageLong" as const,
  flowThreshold: 0.62,
  oiDropThreshold: -0.02,
};
const ATOM_SHORT = { ...ATOM_LONG, direction: "deleverageShort" as const };

describe("серия принудительного потока", () => {
  beforeEach(() => {
    setFlowLoader((s) => (s === "SYM" ? flowHistory() : null));
    setMetricsLoader((s) => (s === "SYM" ? metricsHistory() : null));
  });

  it("sellFrac выравнивается к свечам, oiChg считается через смежный час", () => {
    const s = forcedFlowSeries(CANDLES, "SYM");
    expect(Array.from(s.sellFrac)).toEqual(SELL);
    expect(s.oiChg[0]).toBeCloseTo(97 / 100 - 1, 10);
    expect(s.oiChg[1]).toBeCloseTo(101 / 97 - 1, 10);
    expect(s.oiChg[2]).toBeCloseTo(98 / 101 - 1, 10);
    expect(s.oiChg[3]).toBeCloseTo(95 / 98 - 1, 10);
  });

  it("guard смежности: дыра в OI перед баром → oiChg = NaN, а не ложный скачок", () => {
    // Убираем смежный час T0-H → у свечи 0 нет предыдущего OI. Без guard'а
    // расчёт взял бы более ранний час и выдал выдуманный скачок; guard молчит.
    setMetricsLoader((s) =>
      s === "SYM"
        ? {
            hourStarts: Float64Array.from(OI_HOURS.slice(1)),
            takerRatio: Float64Array.from(OI_HOURS.slice(1).map(() => 1)),
            oi: Float64Array.from(OI_VALS.slice(1)),
          }
        : null,
    );
    const s = forcedFlowSeries(CANDLES, "SYM");
    expect(Number.isNaN(s.oiChg[0])).toBe(true); // нет смежного часа → молчим
    expect(s.oiChg[1]).toBeCloseTo(101 / 97 - 1, 10); // у остальных всё есть
  });

  it("дыра в потоке ИЛИ в OI → атом молчит, а не false из-за одной половины", () => {
    setFlowLoader(() => null); // потока нет вовсе
    const ctx = new EvaluationContext(CANDLES, "SYM");
    for (let i = 0; i < 4; i++) expect(ctx.evaluateAtom(ATOM_LONG, i)).toBe(false);
  });
});

describe("атом forcedFlow: конъюнкция потока и делевериджа", () => {
  beforeEach(() => {
    setFlowLoader((s) => (s === "SYM" ? flowHistory() : null));
    setMetricsLoader((s) => (s === "SYM" ? metricsHistory() : null));
  });

  it("deleverageLong: срабатывает ТОЛЬКО при продажах И падении OI", () => {
    const ctx = new EvaluationContext(CANDLES, "SYM");
    expect(ctx.evaluateAtom(ATOM_LONG, 0)).toBe(true); // продажи 0.70 + OI −3%
    expect(ctx.evaluateAtom(ATOM_LONG, 1)).toBe(false); // продажи 0.70, но OI РАСТЁТ
    expect(ctx.evaluateAtom(ATOM_LONG, 2)).toBe(false); // OI падает, но поток слабый
    expect(ctx.evaluateAtom(ATOM_LONG, 3)).toBe(false); // продажи всего 0.30
  });

  it("ключевой различитель: тот же поток при РАСТУЩЕМ OI не срабатывает", () => {
    // Ровно то, ради чего семейство существует: OI-направление отделяет
    // принуждённый делеверидж от добровольного нового позиционирования.
    const ctx = new EvaluationContext(CANDLES, "SYM");
    expect(ctx.evaluateAtom(ATOM_LONG, 0)).toBe(true); // OI падает
    expect(ctx.evaluateAtom(ATOM_LONG, 1)).toBe(false); // OI растёт — плательщика нет
  });

  it("deleverageShort: сторона зеркальна — проверяет ПОКУПКИ (1−sellFrac)", () => {
    const ctx = new EvaluationContext(CANDLES, "SYM");
    expect(ctx.evaluateAtom(ATOM_SHORT, 3)).toBe(true); // покупки 0.70 + OI −3%
    expect(ctx.evaluateAtom(ATOM_SHORT, 0)).toBe(false); // покупки всего 0.30
    expect(ctx.evaluateAtom(ATOM_SHORT, 2)).toBe(false); // покупки 0.50 < порога
  });

  it("нет символа у контекста → атом false (нет данных о потоке)", () => {
    const ctx = new EvaluationContext(CANDLES, "НЕТ_ТАКОГО");
    expect(ctx.evaluateAtom(ATOM_LONG, 0)).toBe(false);
  });
});
