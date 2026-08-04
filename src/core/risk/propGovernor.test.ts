import { describe, expect, it } from "vitest";
import {
  consistencyShortfall,
  dailyFloor,
  govern,
  HEADROOM_USE,
  isProfitableDay,
  PROFILES,
  totalFloor,
  type AccountState,
} from "./propGovernor";

const account = (over: Partial<AccountState> = {}): AccountState => ({
  initialBalance: 100_000,
  equity: 100_000,
  startOfDayEquity: 100_000,
  maxBalance: 100_000,
  ...over,
});

const trade = { entryPrice: 100, stopPrice: 99, riskFraction: 0.005 };

describe("полы по правилам Upscale", () => {
  it("Basic: дневной 5%, общий 10% от стартового", () => {
    const p = PROFILES.basic_stage1;
    expect(dailyFloor(p, account())).toBe(95_000);
    expect(totalFloor(p, account())).toBe(90_000);
  });

  it("Accelerated строже: дневной 3%, общий 6%", () => {
    const p = PROFILES.accelerated;
    expect(dailyFloor(p, account())).toBe(97_000);
    expect(totalFloor(p, account())).toBeCloseTo(94_000, 6);
  });

  it("у Turbo дневного лимита нет, а общий трейлингом от максимума", () => {
    const p = PROFILES.turbo;
    expect(dailyFloor(p, account())).toBeNull();
    // максимум вырос до 120к → пол поднимается вместе с ним
    expect(totalFloor(p, account({ maxBalance: 120_000 }))).toBeCloseTo(112_800, 6);
  });

  it("трейлинговый пол не опускается ниже стартового баланса", () => {
    // Иначе просевший в первый день счёт получил бы лимит мягче правил.
    const p = PROFILES.turbo;
    expect(totalFloor(p, account({ maxBalance: 80_000 }))).toBeCloseTo(94_000, 6);
  });

  it("дневной пол берётся по СТРОГОЙ трактовке правил", () => {
    // Формулировка двойственная: «5% от начального капитала» и «от баланса на
    // начало дня». При счёте в плюсе это разные числа; берём меньшую базу.
    const p = PROFILES.basic_stage1;
    const grown = account({ equity: 120_000, startOfDayEquity: 120_000 });
    // строгая: 120 000 − 5% от 100 000 = 115 000 (мягкая дала бы 114 000)
    expect(dailyFloor(p, grown)).toBe(115_000);
  });
});

describe("губернатор: размер сделки", () => {
  it("при полном запасе даёт запрошенный риск", () => {
    const d = govern(PROFILES.basic_stage1, account(), trade);
    expect(d.allowed).toBe(true);
    expect(d.riskAmount).toBeCloseTo(500, 6); // 0.5% от 100к
    expect(d.units).toBeCloseTo(500, 6); // стоп шириной 1
  });

  it("урезает размер, когда дневного запаса меньше желаемого", () => {
    // День уже минусовой: до дневного пола осталось немного.
    const state = account({ equity: 95_400, startOfDayEquity: 100_000 });
    const d = govern(PROFILES.basic_stage1, state, trade);
    expect(d.allowed).toBe(true);
    expect(d.headroom.daily).toBeCloseTo(400, 6);
    expect(d.riskAmount).toBeCloseTo(400 * HEADROOM_USE, 6);
    expect(d.notes.join(" ")).toContain("дневным запасом");
  });

  it("никогда не ставит на кон больше, чем осталось до пола", () => {
    // Главное свойство: срабатывание стопа не должно убивать счёт.
    const state = account({ equity: 95_100, startOfDayEquity: 100_000 });
    const d = govern(PROFILES.basic_stage1, state, trade);
    const floor = dailyFloor(PROFILES.basic_stage1, state)!;
    expect(state.equity - d.riskAmount).toBeGreaterThan(floor);
  });

  it("дневной лимит выбран — сделок нет до 00:00 UTC", () => {
    const state = account({ equity: 95_000, startOfDayEquity: 100_000 });
    const d = govern(PROFILES.basic_stage1, state, trade);
    expect(d.allowed).toBe(false);
    expect(d.units).toBe(0);
    expect(d.notes.join(" ")).toContain("дневной лимит");
  });

  it("общий лимит пробит — сделок нет вообще", () => {
    const state = account({ equity: 89_000, startOfDayEquity: 89_500 });
    const d = govern(PROFILES.basic_stage1, state, trade);
    expect(d.allowed).toBe(false);
    expect(d.notes.join(" ")).toContain("общий лимит");
  });

  it("у Turbo размер ограничивает трейлинговый пол, а не дневной", () => {
    const p = PROFILES.turbo;
    const state = account({ equity: 112_900, startOfDayEquity: 118_000, maxBalance: 120_000 });
    const d = govern(p, state, trade);
    expect(d.headroom.daily).toBe(Infinity);
    expect(d.headroom.total).toBeCloseTo(100, 6);
    expect(d.riskAmount).toBeCloseTo(100 * HEADROOM_USE, 6);
  });

  it("сделка без измеримого риска запрещена", () => {
    const d = govern(PROFILES.basic_stage1, account(), { ...trade, stopPrice: 100 });
    expect(d.allowed).toBe(false);
    expect(d.notes.join(" ")).toContain("стоп совпадает");
  });
});

describe("правило консистентности на выводе", () => {
  const turbo = PROFILES.turbo;

  it("считает пример из документации фирмы", () => {
    // 200 + 300 + 1500 + 300 + 200 = 2500, доля лучшего дня 60% → блок,
    // и добрать нужно ровно 2500 (чтобы всего стало 5000).
    const r = consistencyShortfall(turbo, [200, 300, 1500, 300, 200]);
    expect(r.blocked).toBe(true);
    expect(r.share).toBeCloseTo(0.6, 6);
    expect(r.needMore).toBeCloseTo(2500, 6);
  });

  it("ровный набор дней вывод не блокирует", () => {
    const r = consistencyShortfall(turbo, [500, 520, 480, 510, 490]);
    expect(r.blocked).toBe(false);
    expect(r.needMore).toBe(0);
  });

  it("к профилям без правила консистентности не применяется", () => {
    const r = consistencyShortfall(PROFILES.funded_after_basic, [100, 5000]);
    expect(r.blocked).toBe(false);
  });
});

describe("прибыльный день", () => {
  it("порог — 0.5% от НАЧАЛЬНОГО баланса и не растёт вместе со счётом", () => {
    expect(isProfitableDay(100_000, 500)).toBe(true);
    expect(isProfitableDay(100_000, 499)).toBe(false);
  });
});
