import type { PropProfile } from "./propGovernor";
import { PROFILES } from "./propGovernor";

/**
 * Реестр проп-фирм, у которых челлендж покупается за крипту И выплата приходит
 * криптой. Оба условия обязательны: фирма с картой на входе или банковским
 * переводом на выходе для владельца бесполезна.
 *
 * Все числа взяты из документации фирм и помечены датой чтения. Ничего не
 * додумано: если параметр на странице не указан, он стоит как `null`, а не
 * как «наверное, как у всех». Проп-правила — это то место, где придуманное
 * число стоит счёта целиком.
 */

export type FirmId = "upscale" | "hyrotrader" | "breakout";

export interface PropFirm {
  id: FirmId;
  label: string;
  site: string;
  /** Чем оплачивается челлендж. */
  buyWith: string;
  /** В чём приходит выплата. */
  payoutIn: string;
  /** Доля прибыли трейдера. */
  profitSplit: string;
  /** Размеры счетов. */
  accountSizes: string;
  /**
   * Разрешены ли боты. Для нас вопрос закрыт независимо от ответа фирмы:
   * владелец открывает сделки РУКАМИ, машина только находит их. Поле оставлено
   * для случая, если исполнение когда-нибудь захотят автоматизировать.
   */
  botsAllowed: boolean | null;
  /** Когда правила читались с сайта. */
  checkedOn: string;
  profiles: PropProfile[];
}

/**
 * HyroTrader. Прочитано 2026-08-05 с hyrotrader.com.
 * Тип общей просадки (статическая или трейлинг) на сайте НЕ указан — до
 * выяснения считаем трейлинговой, потому что это строгий вариант: ошибиться в
 * мягкую сторону здесь дороже.
 */
const HYRO_ONE_STEP: PropProfile = {
  id: "accelerated",
  label: "HyroTrader One Step",
  profitTargetPct: 0.1,
  minProfitableDays: 5,
  dailyLossPct: 0.04,
  totalLossPct: 0.06,
  totalLossBasis: "maxBalance",
  maxDayShareOfProfit: null,
};

const HYRO_TWO_STEP_1: PropProfile = {
  ...HYRO_ONE_STEP,
  id: "basic_stage1",
  label: "HyroTrader Two Step, фаза 1",
  profitTargetPct: 0.1,
};

const HYRO_TWO_STEP_2: PropProfile = {
  ...HYRO_ONE_STEP,
  id: "basic_stage2",
  label: "HyroTrader Two Step, фаза 2",
  profitTargetPct: 0.05,
};

/**
 * Breakout. Прочитано 2026-08-05 с breakoutprop.com.
 * Все челленджи одноэтапные, просадка ЯВНО статическая («equity floor set at
 * account start»), дневной лимит обнуляется в 00:30 UTC — не в полночь.
 * Отдельно ценно: правила консистентности нет, минимума торговых дней нет,
 * ограничения по времени нет.
 */
const BREAKOUT_BASE = {
  minProfitableDays: 0,
  dailyLossPct: 0.03,
  totalLossBasis: "initial" as const,
  maxDayShareOfProfit: null,
};

const BREAKOUT_CLASSIC: PropProfile = {
  ...BREAKOUT_BASE,
  id: "accelerated",
  label: "Breakout 1-Step Classic",
  profitTargetPct: 0.1,
  totalLossPct: 0.06,
};

const BREAKOUT_PRO: PropProfile = {
  ...BREAKOUT_BASE,
  id: "accelerated",
  label: "Breakout 1-Step Pro",
  profitTargetPct: 0.12,
  totalLossPct: 0.05,
};

const BREAKOUT_TURBO: PropProfile = {
  ...BREAKOUT_BASE,
  id: "accelerated",
  label: "Breakout 1-Step Turbo",
  profitTargetPct: 0.09,
  totalLossPct: 0.03,
};

export const FIRMS: Record<FirmId, PropFirm> = {
  upscale: {
    id: "upscale",
    label: "Upscale",
    site: "upscale.trade",
    buyWith: "крипта",
    payoutIn: "крипта, без KYC",
    profitSplit: "80% по умолчанию, 90% за доплату",
    accountSizes: "$5 000 — $200 000, всего до $400 000",
    // На странице правил про ботов не сказано ни слова — не выдумываем.
    botsAllowed: null,
    checkedOn: "2026-08-05",
    profiles: [
      PROFILES.basic_stage1,
      PROFILES.basic_stage2,
      PROFILES.accelerated,
      PROFILES.turbo,
      PROFILES.funded_after_basic,
      PROFILES.funded_after_accelerated,
      PROFILES.funded_turbo,
    ],
  },
  hyrotrader: {
    id: "hyrotrader",
    label: "HyroTrader",
    site: "hyrotrader.com",
    buyWith: "крипта, Visa, Mastercard",
    payoutIn: "USDT или USDC, в течение нескольких часов",
    profitSplit: "80%, до 90% при масштабировании",
    accountSizes: "$5 000 — $200 000 USDT",
    botsAllowed: null,
    checkedOn: "2026-08-05",
    profiles: [HYRO_ONE_STEP, HYRO_TWO_STEP_1, HYRO_TWO_STEP_2],
  },
  breakout: {
    id: "breakout",
    label: "Breakout",
    site: "breakoutprop.com",
    buyWith: "крипта, разовый платёж",
    payoutIn: "крипта, по требованию 24/7, минимум $50",
    profitSplit: "80%, 90% за доплату при покупке",
    accountSizes: "$5 000 — $200 000",
    botsAllowed: null,
    checkedOn: "2026-08-05",
    profiles: [BREAKOUT_CLASSIC, BREAKOUT_PRO, BREAKOUT_TURBO],
  },
};

export interface StrategyStats {
  /** Доходность по календарным дням, в долях счёта. */
  dailyReturns: readonly number[];
}

export interface ProfileFit {
  firm: FirmId;
  firmLabel: string;
  profileLabel: string;
  passes: boolean;
  /** Худший дневной убыток, доля счёта (положительное число). */
  worstDay: number;
  /** Максимальная просадка от пика, доля. */
  worstDrawdown: number;
  /** Доля дней, прошедших порог прибыльного дня. */
  profitableDays: number;
  /** Доля самого прибыльного дня в общей прибыли. */
  bestDayShare: number;
  /** Что именно не подошло; пусто, если подошло всё. */
  blockers: string[];
}

/**
 * ВАЖНАЯ ОГОВОРКА, которая относится ко всем результатам ниже.
 *
 * Фирмы меряют просадку по балансу ВНУТРИ дня и с учётом нереализованного
 * PnL — то есть по худшей точке, до которой доходила открытая позиция. Здесь
 * же считается по дневным итогам, а они этот провал сглаживают. Значит оценка
 * СИСТЕМАТИЧЕСКИ ОПТИМИСТИЧНА: реальная худшая точка была ниже.
 *
 * Поэтому «подходит» здесь означает «не отсеивается сразу», а не «пройдёт».
 */
export const FIT_CAVEAT =
  "оценка по дневным итогам — внутридневные провалы глубже, чем видно здесь";

function drawdownAndDays(returns: readonly number[]): {
  worstDay: number;
  worstDrawdown: number;
  bestDayShare: number;
} {
  let equity = 1;
  let peak = 1;
  let worstDrawdown = 0;
  let worstDay = 0;
  let gains = 0;
  let bestGain = 0;

  for (const r of returns) {
    equity *= 1 + r;
    peak = Math.max(peak, equity);
    worstDrawdown = Math.max(worstDrawdown, (peak - equity) / peak);
    worstDay = Math.max(worstDay, -r);
    if (r > 0) {
      gains += r;
      bestGain = Math.max(bestGain, r);
    }
  }

  return {
    worstDay,
    worstDrawdown,
    bestDayShare: gains > 0 ? bestGain / gains : 0,
  };
}

/** Подходит ли стратегия под конкретный профиль фирмы. */
export function fitProfile(
  firm: PropFirm,
  profile: PropProfile,
  stats: StrategyStats,
  profitableDayPct = 0.005,
): ProfileFit {
  const { worstDay, worstDrawdown, bestDayShare } = drawdownAndDays(stats.dailyReturns);
  const profitableDays = stats.dailyReturns.filter((r) => r >= profitableDayPct).length;
  const blockers: string[] = [];

  if (profile.dailyLossPct !== null && worstDay >= profile.dailyLossPct) {
    blockers.push(
      `худший день −${(worstDay * 100).toFixed(1)}% при лимите ${(profile.dailyLossPct * 100).toFixed(0)}%`,
    );
  }
  if (worstDrawdown >= profile.totalLossPct) {
    blockers.push(
      `просадка ${(worstDrawdown * 100).toFixed(1)}% при лимите ${(profile.totalLossPct * 100).toFixed(0)}%`,
    );
  }
  if (profitableDays < profile.minProfitableDays) {
    blockers.push(`прибыльных дней ${profitableDays} из нужных ${profile.minProfitableDays}`);
  }
  if (profile.maxDayShareOfProfit !== null && bestDayShare >= profile.maxDayShareOfProfit) {
    blockers.push(
      `лучший день даёт ${(bestDayShare * 100).toFixed(0)}% прибыли при пороге ${(profile.maxDayShareOfProfit * 100).toFixed(0)}%`,
    );
  }

  return {
    firm: firm.id,
    firmLabel: firm.label,
    profileLabel: profile.label,
    passes: blockers.length === 0,
    worstDay,
    worstDrawdown,
    profitableDays,
    bestDayShare,
    blockers,
  };
}

/**
 * Под какие фирмы и режимы стратегия годится. Возвращает ВСЕ варианты, включая
 * неподходящие с причиной: «не подходит и почему» полезнее короткого списка
 * прошедших — по причине видно, что чинить.
 */
export function fitAllFirms(stats: StrategyStats): ProfileFit[] {
  return Object.values(FIRMS).flatMap((firm) =>
    firm.profiles.map((profile) => fitProfile(firm, profile, stats)),
  );
}
