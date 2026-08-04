/**
 * Один этап или два? Ответ считается, а не выбирается по вкусу.
 *
 * Прохождение челленджа — это задача о первом достижении: успеть набрать цель
 * раньше, чем упрёшься в дневной или общий лимит. У неё есть неочевидное
 * свойство: при СЛАБОМ крае решает не цель и не лимит по отдельности, а их
 * отношение и то, сколько раз подряд нужно повторить успех.
 *
 * Модель намеренно простая и вся на виду:
 * - сделки идут внутри дня по одной, и лимит проверяется ПОСЛЕ КАЖДОЙ, а не по
 *   итогам дня. Иначе внутридневной провал был бы не виден, а фирмы меряют
 *   именно его;
 * - сделки одного дня скоррелированы (общий дневной фактор): наши стратегии
 *   торгуют десятки монет сразу, и плохой день у них общий, а не независимый;
 * - размер риска на сделку подбирается ПОД КАЖДУЮ фирму отдельно — трейдер
 *   сайзится под правила, и сравнивать надо лучший размер с лучшим.
 *
 * Запуск: npx tsx researcher/propFit.ts
 */

interface Phase {
  targetPct: number;
  dailyLossPct: number | null;
  totalLossPct: number;
  totalLossBasis: "initial" | "maxBalance";
  minProfitableDays: number;
}

interface Challenge {
  firm: string;
  name: string;
  phases: Phase[];
}

/** Прибыльный день — прирост ≥0.5% от стартового баланса этапа. */
const PROFITABLE_DAY = 0.005;
/** Потолок по времени. У Breakout лимита нет; берём общий, чтобы сравнение было честным. */
const MAX_DAYS = 180;
const TRADES_PER_DAY = 3;
/** Разброс R-множителя одной сделки. */
const R_SD = 1.3;
/** Доля общей (дневной) компоненты в разбросе — сделки дня скоррелированы. */
const INTRADAY_CORR = 0.6;

const CHALLENGES: Challenge[] = [
  {
    firm: "Upscale",
    name: "Basic (2 этапа)",
    phases: [
      { targetPct: 0.05, dailyLossPct: 0.05, totalLossPct: 0.1, totalLossBasis: "initial", minProfitableDays: 3 },
      { targetPct: 0.08, dailyLossPct: 0.05, totalLossPct: 0.1, totalLossBasis: "initial", minProfitableDays: 5 },
    ],
  },
  {
    firm: "Upscale",
    name: "Accelerated (1 этап)",
    phases: [
      { targetPct: 0.1, dailyLossPct: 0.03, totalLossPct: 0.06, totalLossBasis: "initial", minProfitableDays: 3 },
    ],
  },
  {
    firm: "HyroTrader",
    name: "Two Step",
    phases: [
      { targetPct: 0.1, dailyLossPct: 0.04, totalLossPct: 0.06, totalLossBasis: "maxBalance", minProfitableDays: 5 },
      { targetPct: 0.05, dailyLossPct: 0.04, totalLossPct: 0.06, totalLossBasis: "maxBalance", minProfitableDays: 5 },
    ],
  },
  {
    firm: "HyroTrader",
    name: "One Step",
    phases: [
      { targetPct: 0.1, dailyLossPct: 0.04, totalLossPct: 0.06, totalLossBasis: "maxBalance", minProfitableDays: 5 },
    ],
  },
  {
    firm: "Breakout",
    name: "1-Step Classic",
    phases: [
      { targetPct: 0.1, dailyLossPct: 0.03, totalLossPct: 0.06, totalLossBasis: "initial", minProfitableDays: 0 },
    ],
  },
  {
    firm: "Breakout",
    name: "1-Step Pro",
    phases: [
      { targetPct: 0.12, dailyLossPct: 0.03, totalLossPct: 0.05, totalLossBasis: "initial", minProfitableDays: 0 },
    ],
  },
  {
    firm: "Breakout",
    name: "1-Step Turbo",
    phases: [
      { targetPct: 0.09, dailyLossPct: 0.03, totalLossPct: 0.03, totalLossBasis: "initial", minProfitableDays: 0 },
    ],
  },
];

/** Детерминированный генератор: результат обязан воспроизводиться. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function normal(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

function poisson(rng: () => number, lambda: number): number {
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > limit);
  return k - 1;
}

/** Один прогон одного этапа. Возвращает исход и число потраченных дней. */
function runPhase(
  phase: Phase,
  edgeR: number,
  riskFrac: number,
  rng: () => number,
  daysLeft: number,
): { passed: boolean; failed: boolean; daysUsed: number } {
  const start = 1;
  let equity = start;
  let maxBalance = start;
  let profitableDays = 0;

  const beta = Math.sqrt(INTRADAY_CORR) * R_SD;
  const idio = Math.sqrt(1 - INTRADAY_CORR) * R_SD;

  for (let day = 1; day <= daysLeft; day++) {
    const dayStart = equity;
    const common = normal(rng);
    const trades = poisson(rng, TRADES_PER_DAY);

    for (let t = 0; t < trades; t++) {
      const r = edgeR + beta * common + idio * normal(rng);
      equity *= 1 + riskFrac * r;
      maxBalance = Math.max(maxBalance, equity);

      // Лимит проверяется ПОСЛЕ КАЖДОЙ сделки: фирмы смотрят на баланс с
      // нереализованным PnL, а не на итог дня.
      const floorTotal =
        (phase.totalLossBasis === "maxBalance" ? Math.max(maxBalance, start) : start) *
        (1 - phase.totalLossPct);
      if (equity <= floorTotal) return { passed: false, failed: true, daysUsed: day };

      if (phase.dailyLossPct !== null) {
        const floorDaily = dayStart - phase.dailyLossPct * Math.min(start, dayStart);
        if (equity <= floorDaily) return { passed: false, failed: true, daysUsed: day };
      }

      if (equity >= start * (1 + phase.targetPct) && profitableDays >= phase.minProfitableDays) {
        return { passed: true, failed: false, daysUsed: day };
      }
    }

    if (equity - dayStart >= PROFITABLE_DAY * start) profitableDays++;
  }

  return { passed: false, failed: false, daysUsed: daysLeft };
}

function passProbability(ch: Challenge, edgeR: number, riskFrac: number, runs: number, seed: number): number {
  const rng = makeRng(seed);
  let passed = 0;
  for (let run = 0; run < runs; run++) {
    let ok = true;
    let daysLeft = MAX_DAYS;
    for (const phase of ch.phases) {
      const res = runPhase(phase, edgeR, riskFrac, rng, daysLeft);
      daysLeft -= res.daysUsed;
      if (!res.passed || daysLeft <= 0) {
        ok = false;
        break;
      }
    }
    if (ok) passed++;
  }
  return passed / runs;
}

/** Лучший риск на сделку для данной фирмы: трейдер сайзится под правила. */
function bestRisk(ch: Challenge, edgeR: number, runs: number, seed: number): { risk: number; p: number } {
  let best = { risk: 0, p: 0 };
  for (const risk of [0.00075, 0.001, 0.0015, 0.002, 0.0025, 0.005, 0.0075, 0.01, 0.015, 0.02]) {
    const p = passProbability(ch, edgeR, risk, runs, seed);
    if (p > best.p) best = { risk, p };
  }
  return best;
}

const RUNS = 4000;
const EDGES: Array<[string, number]> = [
  ["края нет (0.00R)", 0],
  ["слабый (0.03R)", 0.03],
  ["как замерили (0.06R)", 0.06],
  ["хороший (0.10R)", 0.1],
];

console.log(`Вероятность пройти челлендж. ${RUNS} прогонов, ${TRADES_PER_DAY} сделки в день,`);
console.log(`корреляция сделок внутри дня ${INTRADAY_CORR}, потолок ${MAX_DAYS} дней.`);
console.log("Риск на сделку подобран под каждую фирму отдельно.\n");

const header = ["фирма и режим".padEnd(28), ...EDGES.map(([label]) => label.padStart(22))].join("");
console.log(header);
console.log("-".repeat(header.length));

for (const ch of CHALLENGES) {
  const cells = EDGES.map(([, edge]) => {
    const { risk, p } = bestRisk(ch, edge, RUNS, 20260805);
    return `${(p * 100).toFixed(1)}% @${(risk * 100).toFixed(2)}%`.padStart(22);
  });
  console.log(`${`${ch.firm} · ${ch.name}`.padEnd(28)}${cells.join("")}`);
}
