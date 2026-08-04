/**
 * Стенд калибровки ворот: мощность и ложные проходы на синтетике с
 * КОНТРОЛИРУЕМОЙ истиной. Пороги ворот эпохи-3 фиксируются по этим кривым
 * ДО внедрения (пре-регистрация) — не наоборот.
 *
 * Почему стенд, а не «подкрутим и посмотрим»: подбор порогов по живому
 * журналу — это подгонка под выборку. Здесь истина задана руками (край μ,
 * шум σ, кросс-корреляция ρ), и любые ворота обязаны показать две цифры:
 * false-pass на чистом нуле и recall на крае 0.10–0.15R.
 *
 * Ключевая деталь — КРОСС-КОРРЕЛЯЦИЯ: крипто-монеты ходят вместе (ρ дневных
 * доходностей 0.5–0.8), поэтому «4500 сделок по 128 символам» — это далеко
 * не 4500 независимых наблюдений. Модель: сделки привязаны к дням, внутри
 * дня общий фактор F_t, r = μ + √ρ·F_t + √(1−ρ)·ε. Наивный пулированный
 * t-стат на таких данных лжёт; честный — по ДНЕВНЫМ портфельным доходностям
 * (кластеризация ошибок по времени). Стенд измеряет оба, чтобы это показать
 * числом, а не лозунгом.
 *
 * Запуск: npx tsx researcher/calibrate.ts [--streams 400] [--seed 20260731]
 * Выход: таблица в stderr + JSON в stdout (для пре-регистрации).
 */
import { expectedMaxSharpe, median, moments, normCdf } from "./stats.ts";

/** Параметры мира, в котором живёт один синтетический кандидат. */
export interface StreamParams {
  /** Истинный край на сделку, в net R. 0 — чистый нуль. */
  mu: number;
  /** Шум сделки, σ в R (по журналу ≈ 1.1). */
  sigma: number;
  /** Кросс-корреляция сделок одного дня (общий рыночный фактор). */
  rho: number;
  /** Символов в пуле (стадия-B: ~103 активных). */
  nSym: number;
  /** Среднее сделок на символ (по журналу ≈ 35, разброс большой). */
  tradesPerSym: number;
  /** Торговых дней, на которые размазаны сделки (~5 лет ≈ 1800). */
  days: number;
  seed: number;
}

export interface Stream {
  /** perSymbol[s] = список {day, r} сделок символа s. */
  perSymbol: { day: number; r: number }[][];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Бокс–Мюллер поверх детерминированного PRNG. */
function gauss(rand: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    const m = Math.sqrt(-2 * Math.log(u));
    spare = m * Math.sin(2 * Math.PI * v);
    return m * Math.cos(2 * Math.PI * v);
  };
}

export function generateStream(p: StreamParams): Stream {
  const rand = mulberry32(p.seed);
  const g = gauss(rand);
  // общий фактор дня — один на все символы, источник кросс-корреляции
  const dayFactor = new Map<number, number>();
  const factorFor = (day: number): number => {
    let f = dayFactor.get(day);
    if (f === undefined) {
      f = g();
      dayFactor.set(day, f);
    }
    return f;
  };
  const perSymbol: { day: number; r: number }[][] = [];
  for (let s = 0; s < p.nSym; s++) {
    // Пуассоновский разброс числа сделок вокруг среднего (усечённый снизу 1)
    const n = Math.max(1, Math.round(p.tradesPerSym * (0.4 + 1.2 * rand())));
    const trades: { day: number; r: number }[] = [];
    for (let i = 0; i < n; i++) {
      const day = Math.floor(rand() * p.days);
      const r = p.mu + p.sigma * (Math.sqrt(p.rho) * factorFor(day) + Math.sqrt(1 - p.rho) * g());
      trades.push({ day, r });
    }
    trades.sort((a, b) => a.day - b.day);
    perSymbol.push(trades);
  }
  return { perSymbol };
}

// ── Репликация решающего слоя текущих ворот (эпоха-2) ──────────────────────

export interface GateOutcome {
  activity: boolean;
  breadthShare: boolean;
  nullMedianTop5: boolean;
  dsr: boolean;
  /** v3-кандидаты */
  breadthBinomial: boolean;
  pooledClusteredT: boolean;
}

/** Константы текущих ворот — дословно из gates.ts (пиновано тестом). */
export const CURRENT = {
  minTotalTrades: 100,
  minActiveSymbols: 8,
  minTradesPerActive: 5,
  breadthShare: 0.6,
  nullZMin: 3,
  nullTopSymbols: 5,
  dsrMin: 0.95,
} as const;

/** v3-пороги-КАНДИДАТЫ (фиксируются пре-регистрацией по кривым стенда). */
export const V3 = {
  /** Биномиальный тест широты против p=0.5, односторонний. */
  breadthAlpha: 0.05,
  /** Пулированный t по дневным портфельным доходностям (кластеризация ошибок). */
  pooledTMin: 2.6,
} as const;

export function evaluateGates(stream: Stream, nEffective: number, batchVarSR: number): GateOutcome {
  const perSym = stream.perSymbol;
  const all = perSym.flat();
  const total = all.length;
  const active = perSym.filter((t) => t.length >= CURRENT.minTradesPerActive).length;
  const activity = total >= CURRENT.minTotalTrades && active >= CURRENT.minActiveSymbols;

  const traded = perSym.filter((t) => t.length > 0);
  const positive = traded.filter((t) => moments(t.map((x) => x.r)).mean > 0).length;
  const share = traded.length > 0 ? positive / traded.length : 0;
  const breadthShare = share >= CURRENT.breadthShare;

  // Биномиальный вариант: P(X ≥ positive | p=0.5) по нормальному приближению
  const nT = traded.length;
  const zBin = (positive - nT / 2 - 0.5) / Math.sqrt(nT / 4);
  const breadthBinomial = 1 - normCdf(zBin) < V3.breadthAlpha;

  // Текущая нуль-модель как t-стат по символу: медиана top-5 по числу сделок
  const bySize = [...perSym].sort((a, b) => b.length - a.length).slice(0, CURRENT.nullTopSymbols);
  const zs = bySize.map((t) => {
    const m = moments(t.map((x) => x.r));
    return m.stdDev > 0 ? (m.mean * Math.sqrt(t.length)) / m.stdDev : 0;
  });
  const nullMedianTop5 = zs.length >= 3 && median(zs) >= CURRENT.nullZMin;

  // v3: дневные портфельные доходности → t по дням (честно при кросс-корреляции)
  const byDay = new Map<number, number>();
  for (const t of all) byDay.set(t.day, (byDay.get(t.day) ?? 0) + t.r);
  const daily = [...byDay.values()];
  const dm = moments(daily);
  const pooledT = dm.stdDev > 0 ? (dm.mean * Math.sqrt(daily.length)) / dm.stdDev : 0;
  const pooledClusteredT = daily.length >= 60 && pooledT >= V3.pooledTMin;

  // DSR на пуле сделок — формулы боевые
  const rs = all.map((t) => t.r);
  const m = moments(rs);
  const sr = m.stdDev > 0 ? m.mean / m.stdDev : 0;
  const varFloor = (1 + (sr * sr) / 2) / Math.max(rs.length, 2);
  const varSR = Math.max(batchVarSR, varFloor);
  const sr0 = expectedMaxSharpe(Math.max(nEffective, 1), varSR);
  // упрощение: без skew/kurt-поправки — на нормальной синтетике они ≈ 0/3
  const dsrStat = ((sr - sr0) * Math.sqrt(Math.max(rs.length - 1, 1))) / 1;
  const dsr = normCdf(dsrStat) >= CURRENT.dsrMin;

  return { activity, breadthShare, nullMedianTop5, dsr, breadthBinomial, pooledClusteredT };
}

// ── Прогон сетки истины ────────────────────────────────────────────────────

interface CellReport {
  mu: number;
  rho: number;
  streams: number;
  passRate: Record<keyof GateOutcome, number>;
}

export function runGrid(streams: number, seed: number): CellReport[] {
  const MUS = [0, 0.05, 0.1, 0.15];
  const RHOS = [0.3, 0.6];
  const out: CellReport[] = [];
  for (const mu of MUS) {
    for (const rho of RHOS) {
      const counts: Record<keyof GateOutcome, number> = {
        activity: 0, breadthShare: 0, nullMedianTop5: 0, dsr: 0, breadthBinomial: 0, pooledClusteredT: 0,
      };
      for (let i = 0; i < streams; i++) {
        const stream = generateStream({
          mu, sigma: 1.1, rho, nSym: 103, tradesPerSym: 35, days: 1800,
          seed: seed + i * 7919 + Math.round(mu * 1000) * 31 + Math.round(rho * 10),
        });
        // N_eff и дисперсия партии — типичные боевые величины эпохи-2
        const g = evaluateGates(stream, 4700, 0.0063);
        for (const k of Object.keys(counts) as (keyof GateOutcome)[]) if (g[k]) counts[k] += 1;
      }
      out.push({
        mu, rho, streams,
        passRate: Object.fromEntries(
          Object.entries(counts).map(([k, v]) => [k, Number((v / streams).toFixed(3))]),
        ) as Record<keyof GateOutcome, number>,
      });
    }
  }
  return out;
}

/** Сырой t дневного портфельного ряда — вход для выбора порогов. */
export function pooledDailyT(stream: Stream): { t: number; days: number } {
  const byDay = new Map<number, number>();
  for (const t of stream.perSymbol.flat()) byDay.set(t.day, (byDay.get(t.day) ?? 0) + t.r);
  const daily = [...byDay.values()];
  const m = moments(daily);
  return {
    t: m.stdDev > 0 ? (m.mean * Math.sqrt(daily.length)) / m.stdDev : 0,
    days: daily.length,
  };
}

/** Пороги-кандидаты для OOT-ворот (12 мес — мощности сильно меньше). */
export const OOT_THRESHOLDS = [0.5, 1.0, 1.3, 1.65, 2.0, 2.6] as const;

interface OotRow {
  mu: number;
  rho: number;
  medianT: number;
  passRate: Record<string, number>;
}

/**
 * Сетка для окна out-of-time: 12 месяцев, ~7 сделок на символ в год (по
 * журналу кандидат имеет ~35 сделок на символ за 5 лет). Отвечает на вопрос
 * «какой порог t даёт приемлемую пару (ложный проход, recall) на ГОДЕ
 * данных» — в 5 раз меньше наблюдений, чем на полной истории.
 */
export function runOotSweep(streams: number, seed: number): OotRow[] {
  const MUS = [0, 0.05, 0.1, 0.15];
  const RHOS = [0.3, 0.6];
  const out: OotRow[] = [];
  for (const mu of MUS) {
    for (const rho of RHOS) {
      const ts: number[] = [];
      for (let i = 0; i < streams; i++) {
        const stream = generateStream({
          mu, sigma: 1.1, rho, nSym: 100, tradesPerSym: 7, days: 365,
          seed: seed + i * 6151 + Math.round(mu * 1000) * 17 + Math.round(rho * 10),
        });
        ts.push(pooledDailyT(stream).t);
      }
      const passRate: Record<string, number> = {};
      for (const thr of OOT_THRESHOLDS) {
        passRate[String(thr)] = Number((ts.filter((t) => t >= thr).length / streams).toFixed(3));
      }
      out.push({ mu, rho, medianT: Number(median(ts).toFixed(2)), passRate });
    }
  }
  return out;
}

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const isMain = process.argv[1]?.endsWith("calibrate.ts");
if (isMain && arg("mode", "gates") === "dsr") {
  const batches = Number(arg("batches", "400"));
  const seed = Number(arg("seed", "20260804"));
  const tau = Number(arg("tau", "0.03"));
  const rows = runDsrSweep(batches, seed, tau);
  console.error(`Партия 600 кандидатов, истинная дисперсия Шарпа ${tau}, N_eff 8500, финалист 4000 сделок`);
  console.table(rows);
  console.log(JSON.stringify({ mode: "dsr", batches, seed, tau, rows }, null, 1));
} else if (isMain && arg("mode", "gates") === "oot") {
  const streams = Number(arg("streams", "400"));
  const seed = Number(arg("seed", "20260731"));
  const sweep = runOotSweep(streams, seed);
  console.error(`OOT-окно: 365 дней, 100 символов × ~7 сделок/год, ${streams} потоков/ячейку`);
  console.error(`μ(R)  ρ    медиана t | доля прохода при t ≥ ${OOT_THRESHOLDS.join(" / ")}`);
  for (const r of sweep) {
    const rates = OOT_THRESHOLDS.map((thr) => r.passRate[String(thr)].toFixed(2)).join("  ");
    console.error(`${r.mu.toFixed(2)}  ${r.rho.toFixed(1)}   ${r.medianT.toFixed(2).padStart(6)}   |  ${rates}`);
  }
  console.log(JSON.stringify({ mode: "oot", streams, seed, sweep }, null, 1));
} else if (isMain) {
  const streams = Number(arg("streams", "400"));
  const seed = Number(arg("seed", "20260731"));
  const grid = runGrid(streams, seed);
  console.error("μ(R)  ρ    | activity breadth60 binomial | nullTop5 pooledT | DSR");
  for (const c of grid) {
    const p = c.passRate;
    console.error(
      `${c.mu.toFixed(2)}  ${c.rho.toFixed(1)}  |   ${p.activity.toFixed(2)}     ${p.breadthShare.toFixed(2)}     ${p.breadthBinomial.toFixed(2)}   |   ${p.nullMedianTop5.toFixed(3)}   ${p.pooledClusteredT.toFixed(2)}  | ${p.dsr.toFixed(2)}`,
    );
  }
  console.log(JSON.stringify({ streams, seed, grid }, null, 1));
}

// ── Режим DSR: чем мерить дисперсию партии ──────────────────────────────────

export interface DsrEstimators {
  naive: number;
  thick: number;
  robust: number;
  debiased: number;
  /** Только измеримые кандидаты И вычет шума оценивания — кандидат в бой. */
  thickDebiased: number;
}

/**
 * Оценки дисперсии Шарпов партии четырьмя способами.
 *
 * Задача не «сделать планку ниже», а «перестать измерять шум». Наблюдаемый
 * Шарп кандидата с 8 сделками — почти чистая ошибка оценивания (её SD ≈
 * 1/√T), и один такой кандидат способен задрать планку всей ночи. В боевом
 * журнале 03.08 это дало sr0 = 4.11 при Шарпах кандидатов 0.08–0.15: ворота
 * перестали быть проверкой и стали отказом по построению.
 */
export function batchVarianceEstimators(
  sharpes: readonly number[],
  tradeCounts: readonly number[],
  minTradesForVariance = 40,
): DsrEstimators {
  const naive = moments(sharpes).stdDev ** 2;
  const idx = tradeCounts.map((t, i) => (t >= minTradesForVariance ? i : -1)).filter((i) => i >= 0);
  const thickS = idx.map((i) => sharpes[i]);
  const thick = thickS.length >= 5 ? moments(thickS).stdDev ** 2 : naive;
  // Робастная: MAD × 1.4826 — один вырожденный кандидат не тянет оценку.
  const med = median(thickS.length >= 5 ? thickS : sharpes);
  const base = thickS.length >= 5 ? thickS : sharpes;
  const mad = median(base.map((s) => Math.abs(s - med)));
  const robust = (1.4826 * mad) ** 2;
  const meanEstVar =
    sharpes.length > 0
      ? sharpes.reduce((sum, s, i) => sum + (1 + (s * s) / 2) / Math.max(tradeCounts[i], 2), 0) /
        sharpes.length
      : 0;
  const thickEstVar =
    idx.length > 0
      ? idx.reduce(
          (sum, i) => sum + (1 + (sharpes[i] * sharpes[i]) / 2) / Math.max(tradeCounts[i], 2),
          0,
        ) / idx.length
      : meanEstVar;
  return {
    naive,
    thick,
    robust,
    debiased: Math.max(0, naive - meanEstVar),
    thickDebiased: Math.max(0, thick - thickEstVar),
  };
}

/** Реалистичное число сделок: много тонких, немного толстых. */
function sampleTradeCount(rand: () => number): number {
  const u = rand();
  if (u < 0.55) return 8 + Math.floor(rand() * 32); // 8–40, «еле живые»
  if (u < 0.85) return 40 + Math.floor(rand() * 260);
  return 300 + Math.floor(rand() * 4700);
}

interface DsrRow {
  оценка: string;
  "sr0 (медиана)": number;
  "ложный проход": number;
  "recall Шарп 0.10": number;
}

/**
 * Под глобальным нулём (истинная дисперсия τ) и при истинном крае считаем,
 * какую долю кандидатов пропустят ворота DSR при каждой оценке дисперсии.
 * Кандидат, доходящий до DSR, имеет много сделок — берём T = 4000.
 */
export function runDsrSweep(batches: number, seed: number, tau = 0.03): DsrRow[] {
  const B = 600;
  const N_EFF = 8500;
  const T_FINAL = 4000;
  const keys: (keyof DsrEstimators)[] = ["naive", "thick", "robust", "debiased", "thickDebiased"];
  const sr0s: Record<string, number[]> = { naive: [], thick: [], robust: [], debiased: [], thickDebiased: [] };
  const falsePass: Record<string, number> = { naive: 0, thick: 0, robust: 0, debiased: 0, thickDebiased: 0 };
  const recall: Record<string, number> = { naive: 0, thick: 0, robust: 0, debiased: 0, thickDebiased: 0 };

  for (let b = 0; b < batches; b++) {
    const rand = mulberry32(seed + b * 7919);
    const g = gauss(rand);
    const sharpes: number[] = [];
    const counts: number[] = [];
    for (let i = 0; i < B; i++) {
      const T = sampleTradeCount(rand);
      const trueS = tau * g(); // истинная дисперсия партии
      const noise = Math.sqrt((1 + (trueS * trueS) / 2) / T) * g();
      sharpes.push(trueS + noise);
      counts.push(T);
    }
    const est = batchVarianceEstimators(sharpes, counts);
    // финалист под нулём и с краем — оба с T_FINAL сделок
    const nullS = Math.sqrt(1 / T_FINAL) * g();
    const edgeS = 0.1 + Math.sqrt(1 / T_FINAL) * g();
    for (const k of keys) {
      const varFloor = 1 / T_FINAL;
      const varSR = Math.max(est[k], varFloor);
      const sr0 = expectedMaxSharpe(N_EFF, varSR);
      sr0s[k].push(sr0);
      const dsr = (s: number) => normCdf(((s - sr0) * Math.sqrt(T_FINAL - 1)) / 1);
      if (dsr(nullS) >= 0.95) falsePass[k] += 1;
      if (dsr(edgeS) >= 0.95) recall[k] += 1;
    }
  }
  return keys.map((k) => ({
    оценка: k,
    "sr0 (медиана)": Number(median(sr0s[k]).toFixed(3)),
    "ложный проход": Number((falsePass[k] / batches).toFixed(3)),
    "recall Шарп 0.10": Number((recall[k] / batches).toFixed(3)),
  }));
}
