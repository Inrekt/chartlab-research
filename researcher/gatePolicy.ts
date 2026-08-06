/**
 * Файрвол ворот и вскрытие кандидата — пункт 4 фазы 1 (learning-machine-v3).
 *
 * Машина учится на причинах смерти своих кандидатов. Чтобы обучение не
 * превратилось в подгонку второго порядка (генератор, подстраивающийся под
 * собственные финальные проверки), ворота разделены ПРОГРАММНО:
 *
 * - ОБУЧАЕМЫЕ — по ним считается depth-score и на них смотрит любой анализ
 *   почти-прошедших: халвинги, активность, стресс издержек, плато.
 * - НЕПРИКАСАЕМЫЕ — измерительный прибор; их выходы обучению не видны:
 *   нуль-модель, FDR, годовая стабильность, дефляция, Уилсон, out-of-time —
 *   и ШИРОТА, потому что она считается на скрытых 20% монет: пусти её в
 *   обучающий сигнал, и генератор начнёт целиться в отложенный набор.
 *   (Ранняя редакция learning-machine-v3 относила широту к обучаемым —
 *   исправлено здесь в строгую сторону, документ обновлён.)
 *
 * Единственный законный потребитель неприкасаемых выходов — человек.
 */

/** Порядок воронки; funnel-позиция нужна для depth-score. */
const FUNNEL_ORDER = [
  "halving_16",
  "halving_128",
  "gate_activity",
  "gate_breadth",
  "gate_cost_stress",
  "gate_plateau",
  "gate_null",
  "gate_fdr",
  "gate_temporal",
  "gate_dsr",
  "gate_wilson",
  "gate_oot",
] as const;

export type GateName = (typeof FUNNEL_ORDER)[number];

export const LEARNABLE_GATES: readonly GateName[] = [
  "halving_16",
  "halving_128",
  "gate_activity",
  "gate_cost_stress",
  "gate_plateau",
];

export const UNTOUCHABLE_GATES: readonly GateName[] = [
  "gate_breadth",
  "gate_null",
  "gate_fdr",
  "gate_temporal",
  "gate_dsr",
  "gate_wilson",
  "gate_oot",
];

const LEARNABLE_SET = new Set<string>(LEARNABLE_GATES);

export function isLearnable(gate: string): boolean {
  return LEARNABLE_SET.has(gate);
}

/**
 * Depth-score ∈ [0, 1]: доля ОБУЧАЕМЫХ ворот, пройденных до гибели.
 *
 * Смерть на неприкасаемых воротах даёт долю обучаемых, стоящих в воронке
 * раньше них, — сам факт «дошёл до нуль-модели» обучению виден (это глубина),
 * а вот ПОКАЗАНИЯ нуль-модели — нет. Неизвестное имя ворот — 0: осторожная
 * оценка, а не исключение, чтобы вскрытие не роняло ночь.
 */
export function depthScore(gateKilled: string): number {
  const idx = (FUNNEL_ORDER as readonly string[]).indexOf(gateKilled);
  if (idx < 0) return 0;
  let passed = 0;
  for (let i = 0; i < idx; i++) {
    if (LEARNABLE_SET.has(FUNNEL_ORDER[i])) passed++;
  }
  return passed / LEARNABLE_GATES.length;
}

/**
 * Таксономия причин смерти. Грубая намеренно: классы должны быть настолько
 * разными, чтобы по ним можно было ДЕЙСТВОВАТЬ, а не оттенками одного и того
 * же. Для халвингов класс уточняется экономикой: валовое ожидание больше
 * нуля при чистом меньше-равно нуля — это «экономика съела», живая зона.
 */
export type DeathCause =
  | "too_few_trades" // активности не хватает, чтобы судить
  | "no_signal" // валовое ожидание ≤ 0 — сигнала нет
  | "economics_only" // сигнал есть, издержки съедают — чинится горизонтом
  | "not_robust" // рассыпается на соседях/годах
  | "untouchable" // убит измерительным прибором; подробности обучению не видны
  | "unknown";

export function classifyDeath(
  gate: string,
  extra?: { trades?: number; minTrades?: number; grossExpectancy?: number; netExpectancy?: number },
): DeathCause {
  if (!isLearnable(gate)) {
    return (FUNNEL_ORDER as readonly string[]).includes(gate) ? "untouchable" : "unknown";
  }
  if (gate === "gate_activity") return "too_few_trades";
  if (gate === "gate_cost_stress") return "economics_only";
  if (gate === "gate_plateau") return "not_robust";
  // Халвинги: смотрим, ЧЕМ именно убило.
  if (extra) {
    if (extra.trades !== undefined && extra.minTrades !== undefined && extra.trades < extra.minTrades) {
      return "too_few_trades";
    }
    if (extra.grossExpectancy !== undefined && extra.netExpectancy !== undefined) {
      if (extra.grossExpectancy > 0 && extra.netExpectancy <= 0) return "economics_only";
      return "no_signal";
    }
  }
  return "unknown";
}
