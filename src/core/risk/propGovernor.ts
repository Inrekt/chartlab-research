/**
 * Риск-губернатор под правила пропа Upscale.
 *
 * Числа взяты из документации фирмы (doc.bookflow.sh, раздел «Challenge &
 * Trading Rules», прочитано 2026-08-05), а не придуманы. Пересматривать их
 * можно только сверившись с той же страницей: ошибка здесь стоит счёта
 * целиком, потому что нарушение лимита у Upscale означает НЕМЕДЛЕННОЕ
 * закрытие аккаунта и потерю всей накопленной прибыли.
 *
 * Три вещи, из-за которых губернатор вообще нужен:
 *
 * 1. Баланс считается ВМЕСТЕ с нереализованным PnL. Просадка фиксируется в
 *    момент, когда она случилась, а не когда позиция закрыта. Открытая
 *    минусующая позиция убивает счёт, даже если трейдер её не трогал.
 * 2. Дневной лимит независим и обнуляется в 00:00 UTC.
 * 3. У Turbo общий лимит ТРЕЙЛИНГОВЫЙ — считается от максимального баланса,
 *    а после вывода максимум переустанавливается вниз.
 */

export type ProfileId =
  | "basic_stage1"
  | "basic_stage2"
  | "accelerated"
  | "turbo"
  | "funded_after_basic"
  | "funded_after_accelerated"
  | "funded_turbo";

export interface PropProfile {
  id: ProfileId;
  label: string;
  /** Цель по РЕАЛИЗОВАННОМУ PnL, доля счёта. null — цели нет (funded/Turbo). */
  profitTargetPct: number | null;
  /** Сколько прибыльных дней нужно (для прохода или для выплаты). */
  minProfitableDays: number;
  /** Дневной лимит убытка, доля. null — дневного лимита нет (Turbo). */
  dailyLossPct: number | null;
  /** Общий лимит убытка, доля. */
  totalLossPct: number;
  /** От чего считается общий лимит: от стартового или от максимального баланса. */
  totalLossBasis: "initial" | "maxBalance";
  /** Правило консистентности на выводе: доля самого прибыльного дня. */
  maxDayShareOfProfit: number | null;
}

/** Прибыльным день считается при приросте ≥0.5% от НАЧАЛЬНОГО баланса. */
export const PROFITABLE_DAY_PCT = 0.005;

export const PROFILES: Record<ProfileId, PropProfile> = {
  basic_stage1: {
    id: "basic_stage1",
    label: "Basic, этап 1",
    profitTargetPct: 0.05,
    minProfitableDays: 3,
    dailyLossPct: 0.05,
    totalLossPct: 0.1,
    totalLossBasis: "initial",
    maxDayShareOfProfit: null,
  },
  basic_stage2: {
    id: "basic_stage2",
    label: "Basic, этап 2",
    profitTargetPct: 0.08,
    minProfitableDays: 5,
    dailyLossPct: 0.05,
    totalLossPct: 0.1,
    totalLossBasis: "initial",
    maxDayShareOfProfit: null,
  },
  accelerated: {
    id: "accelerated",
    label: "Accelerated, один этап",
    profitTargetPct: 0.1,
    minProfitableDays: 3,
    dailyLossPct: 0.03,
    totalLossPct: 0.06,
    totalLossBasis: "initial",
    maxDayShareOfProfit: null,
  },
  turbo: {
    id: "turbo",
    label: "Turbo, финансирование сразу",
    profitTargetPct: null,
    minProfitableDays: 5,
    // У Turbo дневного лимита в правилах НЕТ — только общий, и он трейлинговый.
    dailyLossPct: null,
    totalLossPct: 0.06,
    totalLossBasis: "maxBalance",
    maxDayShareOfProfit: 0.3,
  },
  funded_after_basic: {
    id: "funded_after_basic",
    label: "Funded после Basic",
    profitTargetPct: null,
    minProfitableDays: 5,
    dailyLossPct: 0.05,
    totalLossPct: 0.1,
    totalLossBasis: "initial",
    maxDayShareOfProfit: null,
  },
  funded_after_accelerated: {
    id: "funded_after_accelerated",
    label: "Funded после Accelerated",
    profitTargetPct: null,
    minProfitableDays: 5,
    dailyLossPct: 0.03,
    totalLossPct: 0.06,
    totalLossBasis: "initial",
    maxDayShareOfProfit: null,
  },
  funded_turbo: {
    id: "funded_turbo",
    label: "Funded Turbo",
    profitTargetPct: null,
    minProfitableDays: 5,
    dailyLossPct: null,
    totalLossPct: 0.06,
    totalLossBasis: "maxBalance",
    maxDayShareOfProfit: 0.3,
  },
};

/**
 * Доля свободного запаса, которую разрешено поставить на одну сделку.
 *
 * Не 100% осознанно: между решением и исполнением цена уходит, стоп исполняется
 * с проскальзыванием, а пробой лимита у Upscale карается не предупреждением, а
 * закрытием счёта. Дешевле недоторговать, чем один раз промахнуться.
 */
export const HEADROOM_USE = 0.8;

export interface AccountState {
  /** Стартовый баланс счёта (от него считаются проценты). */
  initialBalance: number;
  /** Текущий баланс ВКЛЮЧАЯ нереализованный PnL открытых позиций. */
  equity: number;
  /** Баланс на 00:00 UTC текущего дня. */
  startOfDayEquity: number;
  /** Максимальный баланс за всё время (для трейлингового лимита Turbo). */
  maxBalance: number;
}

export interface TradeProposal {
  entryPrice: number;
  stopPrice: number;
  /** Желаемый риск сделки в долях счёта, например 0.005 = полпроцента. */
  riskFraction: number;
}

export interface GovernorDecision {
  allowed: boolean;
  /** Размер позиции в единицах инструмента. 0, если торговать нельзя. */
  units: number;
  /** Сколько денег на кону, если стоп исполнится по цене стопа. */
  riskAmount: number;
  /** Сколько ещё можно потерять до каждого из лимитов. */
  headroom: { daily: number; total: number };
  /** Что именно ограничило размер или запретило сделку. */
  notes: string[];
}

/**
 * Пол по дневному лимиту.
 *
 * В правилах формулировка двойственная: «5% от начального капитала» и тут же
 * «отсчитывается от баланса на начало дня». Пока счёт в плюсе это разные
 * числа, и разница — живые деньги. Берём СТРОГИЙ вариант: процент от
 * меньшей из двух баз. Ошибка в мягкую сторону стоит счёта, в строгую —
 * недобранной прибыли.
 */
export function dailyFloor(profile: PropProfile, state: AccountState): number | null {
  if (profile.dailyLossPct === null) return null;
  const base = Math.min(state.initialBalance, state.startOfDayEquity);
  return state.startOfDayEquity - profile.dailyLossPct * base;
}

/** Пол по общему лимиту: от стартового баланса либо трейлингом от максимума. */
export function totalFloor(profile: PropProfile, state: AccountState): number {
  const base =
    profile.totalLossBasis === "maxBalance"
      ? Math.max(state.maxBalance, state.initialBalance)
      : state.initialBalance;
  return base * (1 - profile.totalLossPct);
}

/**
 * Решение по конкретной сделке: можно ли и каким размером.
 *
 * Размер подбирается так, чтобы срабатывание стопа НЕ пробило ни дневной, ни
 * общий пол — с запасом `HEADROOM_USE`. Если хотя бы один пол уже пробит,
 * сделки нет вообще.
 */
export function govern(
  profile: PropProfile,
  state: AccountState,
  proposal: TradeProposal,
): GovernorDecision {
  const notes: string[] = [];
  const floorDaily = dailyFloor(profile, state);
  const floorTotal = totalFloor(profile, state);

  const headroomDaily = floorDaily === null ? Infinity : state.equity - floorDaily;
  const headroomTotal = state.equity - floorTotal;
  const headroom = { daily: headroomDaily, total: headroomTotal };

  const blocked = (reason: string): GovernorDecision => ({
    allowed: false,
    units: 0,
    riskAmount: 0,
    headroom,
    notes: [...notes, reason],
  });

  if (headroomTotal <= 0) return blocked("общий лимит уже пробит — счёт под закрытием");
  if (headroomDaily <= 0) return blocked("дневной лимит уже выбран — до 00:00 UTC сделок нет");

  const stopDistance = Math.abs(proposal.entryPrice - proposal.stopPrice);
  if (!(stopDistance > 0)) return blocked("стоп совпадает с входом — риск неизмерим");

  // Сколько денег готовы потерять: желание владельца, урезанное запасом до
  // каждого из полов.
  const wanted = state.equity * proposal.riskFraction;
  const allowedByDaily = headroomDaily * HEADROOM_USE;
  const allowedByTotal = headroomTotal * HEADROOM_USE;
  const riskAmount = Math.min(wanted, allowedByDaily, allowedByTotal);

  if (riskAmount < wanted) {
    notes.push(
      allowedByDaily <= allowedByTotal
        ? "размер урезан дневным запасом"
        : "размер урезан общим запасом",
    );
  }
  if (riskAmount <= 0) return blocked("свободного запаса не осталось");

  return {
    allowed: true,
    units: riskAmount / stopDistance,
    riskAmount,
    headroom,
    notes,
  };
}

/**
 * Правило консистентности на выводе (у Upscale — только Turbo): выплата
 * блокируется, если самый прибыльный день составляет ≥30% всей прибыли.
 *
 * Возвращает, сколько ЕЩЁ прибыли нужно набрать, чтобы доля опустилась до
 * порога. Ноль означает «вывод открыт».
 */
export function consistencyShortfall(
  profile: PropProfile,
  dailyProfits: readonly number[],
): { blocked: boolean; share: number; needMore: number } {
  const limit = profile.maxDayShareOfProfit;
  const gains = dailyProfits.filter((p) => p > 0);
  const total = gains.reduce((sum, p) => sum + p, 0);
  if (limit === null || total <= 0) return { blocked: false, share: 0, needMore: 0 };

  const best = Math.max(...gains);
  const share = best / total;
  if (share < limit) return { blocked: false, share, needMore: 0 };

  // Нужно довести общую прибыль до best / limit.
  return { blocked: true, share, needMore: best / limit - total };
}

/** День считается прибыльным при приросте ≥0.5% от начального баланса. */
export function isProfitableDay(initialBalance: number, dayChange: number): boolean {
  return dayChange >= PROFITABLE_DAY_PCT * initialBalance;
}
