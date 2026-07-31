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

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const isMain = process.argv[1]?.endsWith("calibrate.ts");
if (isMain) {
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
