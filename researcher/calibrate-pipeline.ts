/**
 * Стенд конвейера отсева v8 против v9 (поиск v4) на синтетике с известной
 * истиной. Доказательство из пре-регистрации
 * docs/search-v4-preregistration.md, «Доказательства до выпуска», п. 1:
 * доля ложных выпусков на чистом нуле у v9 не выше, чем у v8, плюс две
 * стандартные ошибки.
 *
 * Конвейер воспроизводит решающий слой обеих версий:
 * - v8: стадия-16 (по символам, ≥ 8 сделок и net > 0), стадия-128 (≥ 40
 *   сделок, net > 0, доля плюсовых СИМВОЛОВ ≥ 0.45), затем активность,
 *   ширина ≥ 0.6 по символам с любым числом сделок, t дневного портфеля ≥ 2.6.
 * - v9: стадия A по символо-годам до ≥ 150 сделок, t_net > −0.5; стадия B до
 *   ≥ 600 сделок, net > 0, доля плюсовых ЕДИНИЦ (P3) ≥ 0.45; затем те же
 *   активность и t, ширина ≥ 0.6 по единицам. Малое семейство (флаг
 *   `noDivision`) идёт сразу к воротам.
 *
 * Отложенный набор, плато, годы, OOT и DSR одинаковы в обеих версиях или
 * меряются отдельно (`calibrate.ts --mode dsr`) — здесь их нет.
 *
 * Запуск: npx tsx researcher/calibrate-pipeline.ts [--streams 2000] [--seed 20260731]
 */
import { generateStream, type Stream, V3, CURRENT } from "./calibrate.ts";
import { breadthUnits, type SymbolNet } from "./gates.ts";
import { moments } from "./stats.ts";

const DAYS_PER_YEAR = 365;

/** Пороги v8 — дословно из screen.ts на main до поиска v4. */
const V8 = { stageASymbols: 16, stageAMinTrades: 8, stageBSymbols: 128, stageBMinTrades: 40, stageBShare: 0.45 };
/** Пороги v9 — дословно из пре-регистрации. */
const V9 = { stageABudget: 150, stageAMinT: -0.5, stageBBudget: 600, stageBShare: 0.45 };

type Trade = { day: number; r: number };

const mean = (rs: readonly number[]): number => (rs.length > 0 ? rs.reduce((a, b) => a + b, 0) / rs.length : 0);

function tStat(rs: readonly number[]): number {
  const m = moments(rs);
  return m.stdDev > 0 ? (m.mean * Math.sqrt(rs.length)) / m.stdDev : 0;
}

function symbolNets(perSymbol: readonly (readonly Trade[])[]): SymbolNet[] {
  return perSymbol.map((ts, i) => ({ symbol: `S${i}`, trades: ts.length, netExpectancy: mean(ts.map((t) => t.r)) }));
}

function shareBySymbol(perSymbol: readonly (readonly Trade[])[]): number {
  const traded = perSymbol.filter((t) => t.length > 0);
  return traded.length > 0 ? traded.filter((t) => mean(t.map((x) => x.r)) > 0).length / traded.length : 0;
}

function shareByUnits(perSymbol: readonly (readonly Trade[])[]): number {
  const units = breadthUnits(symbolNets(perSymbol), 0xc0ffee);
  return units.length > 0 ? units.filter((u) => u.netExpectancy > 0).length / units.length : 0;
}

function gauntlet(perSymbol: readonly (readonly Trade[])[], share: (p: readonly (readonly Trade[])[]) => number): boolean {
  const all = perSymbol.flat();
  const active = perSymbol.filter((t) => t.length >= CURRENT.minTradesPerActive).length;
  if (all.length < CURRENT.minTotalTrades || active < CURRENT.minActiveSymbols) return false;
  if (share(perSymbol) < CURRENT.breadthShare) return false;
  const byDay = new Map<number, number>();
  for (const t of all) byDay.set(t.day, (byDay.get(t.day) ?? 0) + t.r);
  const daily = [...byDay.values()];
  return daily.length >= 60 && tStat(daily) >= V3.pooledTMin;
}

export function releaseV8(stream: Stream): boolean {
  const ps = stream.perSymbol;
  const a = ps.slice(0, V8.stageASymbols).flat();
  if (a.length < V8.stageAMinTrades || mean(a.map((t) => t.r)) <= 0) return false;
  const bSyms = ps.slice(0, V8.stageBSymbols);
  const b = bSyms.flat();
  if (b.length < V8.stageBMinTrades || mean(b.map((t) => t.r)) <= 0) return false;
  if (shareBySymbol(bSyms) < V8.stageBShare) return false;
  return gauntlet(ps, shareBySymbol);
}

/** Символо-годы в фиксированном псевдослучайном порядке (аналог хэша соли). */
function unitOrder(stream: Stream): { sym: number; year: number }[] {
  const units: { sym: number; year: number; key: number }[] = [];
  const years = new Set<number>();
  for (const ts of stream.perSymbol) for (const t of ts) years.add(Math.floor(t.day / DAYS_PER_YEAR));
  stream.perSymbol.forEach((_, sym) => {
    for (const year of years) {
      // Детерминированный «хэш»: целочисленное перемешивание (sym, year).
      let h = Math.imul(sym + 1, 0x9e3779b1) ^ Math.imul(year + 7, 0x85ebca6b);
      h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
      units.push({ sym, year, key: (h ^ (h >>> 16)) >>> 0 });
    }
  });
  return units.sort((x, y) => x.key - y.key);
}

/** Префикс единиц до бюджета сделок: сделки по символам, только из выбранных лет. */
function prefixToBudget(stream: Stream, order: readonly { sym: number; year: number }[], budget: number): Trade[][] {
  const per: Trade[][] = stream.perSymbol.map(() => []);
  let n = 0;
  for (const u of order) {
    if (n >= budget) break;
    const add = stream.perSymbol[u.sym].filter((t) => Math.floor(t.day / DAYS_PER_YEAR) === u.year);
    per[u.sym].push(...add);
    n += add.length;
  }
  return per;
}

export function releaseV9(stream: Stream, noDivision = false): boolean {
  const ps = stream.perSymbol;
  if (!noDivision) {
    const order = unitOrder(stream);
    const a = prefixToBudget(stream, order, V9.stageABudget).flat();
    if (a.length < V9.stageABudget) return false; // весь пул < 150 сделок
    if (tStat(a.map((t) => t.r)) <= V9.stageAMinT) return false;
    const bPer = prefixToBudget(stream, order, V9.stageBBudget);
    const b = bPer.flat();
    if (mean(b.map((t) => t.r)) <= 0) return false;
    if (shareByUnits(bPer.filter((t) => t.length > 0)) < V9.stageBShare) return false;
  }
  return gauntlet(ps, shareByUnits);
}

export interface PipelineRow {
  regime: string;
  mu: number;
  rho: number;
  v8: number;
  v9: number;
  se: number;
}

/** Режимы мира: плотный (как журнал 1h) и редкий свинговый (1–7 сделок на символ). */
export const REGIMES = [
  { regime: "плотный", nSym: 250, tradesPerSym: 35, noDivision: false },
  { regime: "редкий", nSym: 250, tradesPerSym: 4, noDivision: false },
  { regime: "малый без деления", nSym: 40, tradesPerSym: 12, noDivision: true },
] as const;

export function runPipelineSweep(streams: number, seed: number, mus = [0, 0.05, 0.1]): PipelineRow[] {
  const out: PipelineRow[] = [];
  for (const reg of REGIMES) {
    for (const mu of mus) {
      for (const rho of [0.3, 0.6]) {
        let p8 = 0;
        let p9 = 0;
        for (let i = 0; i < streams; i++) {
          const stream = generateStream({
            mu, sigma: 1.1, rho, nSym: reg.nSym, tradesPerSym: reg.tradesPerSym, days: 1800,
            seed: seed + i * 7919 + Math.round(mu * 1000) * 31 + Math.round(rho * 10) + reg.nSym,
          });
          if (releaseV8(stream)) p8 += 1;
          if (releaseV9(stream, reg.noDivision)) p9 += 1;
        }
        const r8 = p8 / streams;
        const r9 = p9 / streams;
        // СО разности долей (независимые оценки на одних потоках — консервативно)
        const se = Math.sqrt((r8 * (1 - r8) + r9 * (1 - r9)) / streams);
        out.push({ regime: reg.regime, mu, rho, v8: r8, v9: r9, se: Number(se.toFixed(4)) });
      }
    }
  }
  return out;
}

/** Критерий пре-регистрации: на нуле v9 ≤ v8 + 2·СО. */
export function nullCriterionHolds(rows: readonly PipelineRow[]): boolean {
  return rows.filter((r) => r.mu === 0).every((r) => r.v9 <= r.v8 + 2 * r.se);
}

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

if (process.argv[1]?.endsWith("calibrate-pipeline.ts")) {
  const streams = Number(arg("streams", "2000"));
  const seed = Number(arg("seed", "20260731"));
  const rows = runPipelineSweep(streams, seed);
  console.error(`Конвейер v8 против v9, ${streams} потоков/ячейку`);
  console.table(rows);
  const ok = nullCriterionHolds(rows);
  console.error(ok ? "критерий нуля ВЫПОЛНЕН" : "критерий нуля НАРУШЕН");
  console.log(JSON.stringify({ streams, seed, rows, nullCriterion: ok }, null, 1));
  process.exitCode = ok ? 0 : 1;
}
