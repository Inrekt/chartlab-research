import { describe, expect, it } from "vitest";
import type { Candle } from "../types";
import { liquidityFeatures, PIVOT_WING } from "./clusterSeries";

const HOUR = 3600;

/** Свечи из массива [low, high] — close посередине, чтобы не мешал. */
function bars(spec: Array<[number, number]>, startSec = 1_700_000_000): Candle[] {
  return spec.map(([low, high], i) => ({
    time: startSec + i * HOUR,
    open: (low + high) / 2,
    high,
    low,
    close: (low + high) / 2,
    volume: 100,
  }));
}

/** Ровный шумовой фон, чтобы ATR был определён и невелик. */
function flatBackground(count: number, mid = 100, halfRange = 1): Array<[number, number]> {
  return Array.from({ length: count }, (_, i) => {
    const drift = Math.sin(i / 7) * 0.2;
    return [mid - halfRange + drift, mid + halfRange + drift] as [number, number];
  });
}

describe("liquidityFeatures — причинность", () => {
  it("значения на баре i не зависят от того, что было ПОСЛЕ i", () => {
    // Это главная проверка модуля: если бы расчёт хоть где-то смотрел вперёд,
    // укороченная история дала бы другие числа на тех же барах.
    const spec = flatBackground(300);
    spec[120] = [99, 108]; // заметный экстремум внутри
    spec[200] = [92, 101];
    const full = liquidityFeatures(bars(spec));
    const prefix = liquidityFeatures(bars(spec.slice(0, 250)));

    for (let i = 0; i < 250; i++) {
      const pairs: Array<[number, number]> = [
        [full.nearAbove[i], prefix.nearAbove[i]],
        [full.nearBelow[i], prefix.nearBelow[i]],
        [full.farAbove[i], prefix.farAbove[i]],
        [full.farBelow[i], prefix.farBelow[i]],
        [full.weightAbove[i], prefix.weightAbove[i]],
        [full.weightBelow[i], prefix.weightBelow[i]],
      ];
      for (const [a, b] of pairs) {
        if (Number.isNaN(a) && Number.isNaN(b)) continue;
        expect(b).toBeCloseTo(a, 10);
      }
    }
  });

  it("уровень появляется только ПОСЛЕ подтверждения пивота, не раньше", () => {
    const spec = flatBackground(120);
    const peakIdx = 60;
    spec[peakIdx] = [100, 112]; // одинокий максимум
    const f = liquidityFeatures(bars(spec));

    // на самом баре пика и сразу после него уровень ещё не подтверждён
    for (let i = peakIdx; i < peakIdx + PIVOT_WING; i++) {
      const known = Number.isFinite(f.nearAbove[i]) && f.nearAbove[i] >= 112;
      expect(known).toBe(false);
    }
    // а через PIVOT_WING баров он известен
    expect(f.nearAbove[peakIdx + PIVOT_WING]).toBeCloseTo(112, 6);
  });

  it("снятый уровень исчезает: цена сходила за него — стопы собраны", () => {
    const spec = flatBackground(160);
    spec[60] = [100, 110]; // пивот-хай 110
    spec[100] = [100, 115]; // цена ушла выше — уровень снят
    const f = liquidityFeatures(bars(spec));

    expect(f.nearAbove[70]).toBeCloseTo(110, 6); // до снятия виден
    // на баре снятия и после — этого уровня уже нет
    expect(f.nearAbove[100] === 110).toBe(false);
    expect(f.nearAbove[110] === 110).toBe(false);
  });

  it("равные максимумы копят вес — за ними больше стопов", () => {
    const spec = flatBackground(200);
    spec[40] = [100, 109];
    spec[80] = [100, 108.97]; // подошли к тому же уровню, НЕ пробив его
    spec[120] = [100, 108.95];
    const f = liquidityFeatures(bars(spec));
    expect(f.weightAbove[130]).toBeGreaterThanOrEqual(3);
  });

  it("максимум ВЫШЕ прежнего снимает уровень, а не усиливает его", () => {
    // Содержательное отличие от «равных максимумов»: если цена пробила
    // старый хай, стопы за ним уже собраны — уровень исчезает, а новый
    // рождается заново с весом 1.
    const spec = flatBackground(200);
    spec[40] = [100, 109];
    spec[80] = [100, 109.05]; // пробили на копейку — это снятие
    const f = liquidityFeatures(bars(spec));
    // самый дальний уровень в горизонте — новый хай, а не старый 109
    expect(f.farAbove[130]).toBeCloseTo(109.05, 6);
    expect(f.farAbove[130]).not.toBeCloseTo(109, 6);
  });

  it("далёкие уровни за горизонтом не считаются «впереди»", () => {
    const spec = flatBackground(200);
    spec[40] = [100, 400]; // абсурдно далёкий максимум
    const f = liquidityFeatures(bars(spec));
    // Уровень 400 существует, но к бару 120 волатильность улеглась, и он
    // ушёл за горизонт: ни ближайшим, ни «самым дальним в горизонте» он уже
    // не считается. (Соседние уровни из фонового шума при этом остаются —
    // проверяем именно отсечение далёкого, а не пустоту.)
    expect(f.nearAbove[120]).toBeLessThan(200);
    expect(f.farAbove[120]).toBeLessThan(200);
  });

  it("пустой и короткий вход не роняют расчёт", () => {
    expect(liquidityFeatures([]).nearAbove.length).toBe(0);
    const short = liquidityFeatures(bars(flatBackground(5)));
    expect(short.nearAbove.length).toBe(5);
  });
});

describe("снесённый уровень записывается — иначе доза ненаблюдаема", () => {
  /*
   * В пре-регистрациях ДВУХ семейств заявлена проверка «край сильнее там, где
   * кластер стопов был крупнее». Выполнить её было нельзя: снятие происходит
   * ДО чтения признаков, и снесённый уровень из фич исчезал. Дефект
   * наблюдаемости не даёт неверный ответ — он не даёт никакого, а проверка в
   * документе при этом выглядит выполненной.
   */
  const bar = (i: number, o: number, h: number, l: number, c: number): Candle => ({
    time: 1_700_000_000 + i * 3600,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: 1,
  });

  it("вес и цена снесённого скопления доступны на баре сноса", () => {
    const spec: Candle[] = [];
    let i = 0;
    // Пила под уровнем: копит вес на почти-равных вершинах (каждая строго ниже).
    for (const top of [110, 109.99, 109.98]) {
      spec.push(bar(i++, 100, 101, 99, 100));
      spec.push(bar(i++, 100, 101, 99, 100));
      spec.push(bar(i++, 100, 101, 99, 100));
      spec.push(bar(i++, 105, top, 104, 105)); // пивот-хай
      spec.push(bar(i++, 100, 101, 99, 100));
      spec.push(bar(i++, 100, 101, 99, 100));
      spec.push(bar(i++, 100, 101, 99, 100));
    }
    // Вынос: high выше сохранённой цены уровня — уровень сносится.
    const sweepIdx = i;
    spec.push(bar(i++, 105, 115, 104, 114));
    for (let k = 0; k < 5; k++) spec.push(bar(i++, 110, 111, 109, 110));

    const f = liquidityFeatures(spec);
    expect(f.sweptAboveWeight[sweepIdx]).toBeGreaterThanOrEqual(1);
    expect(f.sweptAbovePrice[sweepIdx]).toBeCloseTo(110, 5);
  });

  it("на барах без сноса поле пусто — не ноль", () => {
    // Ноль означал бы «снесли уровень нулевого веса», чего не бывает. Путаница
    // «нет данных» с «данные равны нулю» — тот же класс тихих ошибок, что
    // вырожденный стоп.
    const flat = Array.from({ length: 40 }, (_, k) => bar(k, 100, 101, 99, 100));
    const f = liquidityFeatures(flat);
    expect([...f.sweptAboveWeight].every((v) => Number.isNaN(v))).toBe(true);
    expect([...f.sweptBelowWeight].every((v) => Number.isNaN(v))).toBe(true);
  });
});
