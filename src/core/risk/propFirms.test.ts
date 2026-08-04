import { describe, expect, it } from "vitest";
import { fitAllFirms, fitProfile, FIRMS } from "./propFirms";
import { PROFILES } from "./propGovernor";

/** Ровная прибыльная кривая: 40 дней по +0.6%, ни одного минуса. */
const steady = { dailyReturns: Array.from({ length: 40 }, () => 0.006) };

describe("реестр фирм", () => {
  it("у каждой фирмы записано, чем платить и в чём выплата", () => {
    for (const firm of Object.values(FIRMS)) {
      expect(firm.buyWith).toMatch(/крипт/i);
      expect(firm.payoutIn).toMatch(/крипт|USDT|USDC/i);
      expect(firm.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(firm.profiles.length).toBeGreaterThan(0);
    }
  });

  it("неизвестное не выдаётся за известное", () => {
    // Про ботов ни у одной фирмы в документации не сказано — поле обязано
    // оставаться null, а не превращаться в удобное «разрешено».
    for (const firm of Object.values(FIRMS)) {
      expect([true, false, null]).toContain(firm.botsAllowed);
    }
    expect(FIRMS.upscale.botsAllowed).toBeNull();
  });
});

describe("подбор фирмы под стратегию", () => {
  it("ровная прибыльная стратегия проходит везде", () => {
    const fits = fitAllFirms(steady);
    expect(fits.length).toBeGreaterThan(0);
    for (const f of fits) expect(f.passes).toBe(true);
  });

  it("один тяжёлый день отсекает строгие фирмы и оставляет мягкие", () => {
    // −4.5%: пробивает дневной лимит Accelerated (3%) и HyroTrader (4%),
    // но не Basic (5%).
    const stats = { dailyReturns: [...steady.dailyReturns, -0.045] };
    const basic = fitProfile(FIRMS.upscale, PROFILES.basic_stage1, stats);
    const accelerated = fitProfile(FIRMS.upscale, PROFILES.accelerated, stats);

    expect(basic.passes).toBe(true);
    expect(accelerated.passes).toBe(false);
    expect(accelerated.blockers.join(" ")).toContain("худший день");
  });

  it("глубокая просадка бьёт по общему лимиту, а не по дневному", () => {
    // Семь дней по −1%: каждый день в пределах любого лимита, а суммарно −6.8%.
    const stats = { dailyReturns: Array.from({ length: 7 }, () => -0.01) };
    const f = fitProfile(FIRMS.upscale, PROFILES.accelerated, stats);
    expect(f.passes).toBe(false);
    expect(f.blockers.join(" ")).toContain("просадка");
    expect(f.blockers.join(" ")).not.toContain("худший день");
  });

  it("Turbo блокируется правилом консистентности, хотя лимиты не пробиты", () => {
    // Один день делает почти всю прибыль — риска нет, но выплату не дадут.
    const stats = { dailyReturns: [0.006, 0.006, 0.006, 0.006, 0.006, 0.2] };
    const f = fitProfile(FIRMS.upscale, PROFILES.turbo, stats);
    expect(f.passes).toBe(false);
    expect(f.blockers.join(" ")).toContain("лучший день");
    expect(f.bestDayShare).toBeGreaterThan(0.3);
  });

  it("редкие сделки валят требование прибыльных дней", () => {
    const stats = { dailyReturns: [0.02, 0, 0, 0, 0, 0, 0, 0] };
    const f = fitProfile(FIRMS.upscale, PROFILES.basic_stage1, stats);
    expect(f.passes).toBe(false);
    expect(f.blockers.join(" ")).toContain("прибыльных дней 1");
  });

  it("просадка считается от пика, а не от старта", () => {
    // Рост на 20%, потом падение на 10% от достигнутого пика.
    const stats = { dailyReturns: [0.2, -0.1] };
    const f = fitProfile(FIRMS.upscale, PROFILES.basic_stage1, stats);
    expect(f.worstDrawdown).toBeCloseTo(0.1, 6);
  });
});
