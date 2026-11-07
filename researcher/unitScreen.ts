/**
 * Ранний отсев на символо-годах (P2, search-v4).
 *
 * Прежний отсев брал 16, затем 128 символов целиком и убивал 74% кандидатов на
 * первом шаге — по горстке символов, среди которых могли оказаться монеты без
 * единого бара окна. Теперь единица отсева — символ × календарный год
 * (порядок — по хэшу соль:символ:год), а бюджет — число сделок: стадия A берёт
 * единицы по порядку, пока кандидат не наберёт 150 сделок, стадия B — до 600.
 *
 * Модуль не знает про движок: прогон символа приходит снаружи (runSymbol), что
 * даёт синтетические тесты порядка, префиксности и бюджета. Пре-регистрация:
 * docs/search-v4-preregistration.md, раздел P2.
 */
import type { TradeResult } from "../src/core/types/index.ts";
import { candidateId, type CandidateSpec } from "./grammar.ts";
import { fnv1a } from "./hash.ts";
import { monthKey } from "./liquidityCosts.ts";
import type { Membership } from "./universe.ts";
import { monthStartSec } from "./universe.ts";

/** Бюджет сделок стадии A: набрали — стоп, проверяем t_net. */
export const STAGE_A_TRADE_BUDGET = 150;
/** Бюджет сделок стадии B. */
export const STAGE_B_TRADE_BUDGET = 600;
/** Стадия A проходит при t_net > −0.5 (чистые R). */
export const STAGE_A_MIN_T = -0.5;
/** Семейство с пространством меньше этого идёт без деления. */
export const NO_DIVISION_SPACE = 2000;
/** Вселенная не больше этого числа символов — без деления. */
export const NO_DIVISION_UNIVERSE = 48;
/** Сколько единиц догружается за раунд: символ запускается раз на раунд. */
const TAKE_CHUNK = 32;

export interface PoolUnit {
  symbol: string;
  /** Календарный год UTC. */
  year: number;
}

/** Календарный год UTC по unix-секундам. */
export function yearOf(timeSec: number): number {
  return new Date(timeSec * 1000).getUTCFullYear();
}

/** Ключ порядка единицы: стабилен от ночи к ночи при той же соли. */
export function unitHash(salt: number, unit: PoolUnit): number {
  return fnv1a(`${salt}:${unit.symbol}:${unit.year}`);
}

/** Единицы в порядке отсева: по хэшу `соль:символ:год`, ничья — по символу и году. */
export function orderUnits(units: readonly PoolUnit[], salt: number): PoolUnit[] {
  return [...units].sort(
    (a, b) =>
      unitHash(salt, a) - unitHash(salt, b) ||
      (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : a.year - b.year),
  );
}

/**
 * Единицы вселенной: символ × год, в который символ был членом хотя бы одного
 * месяца ДО границы окна (`beforeSec`). Порядок — orderUnits.
 */
export function memberUnits(
  membership: Membership,
  symbols: readonly string[],
  beforeSec: number,
  salt: number,
): PoolUnit[] {
  const units: PoolUnit[] = [];
  for (const symbol of symbols) {
    const years = new Set<number>();
    for (const month of membership.monthsOf(symbol)) {
      if (monthStartSec(month) < beforeSec) years.add(Number(month.slice(0, 4)));
    }
    for (const year of years) units.push({ symbol, year });
  }
  return orderUnits(units, salt);
}

/** Без деления: маленькое пространство ИЛИ маленькая вселенная. */
export function isNoDivision(familySpace: number, universeSize: number): boolean {
  return familySpace < NO_DIVISION_SPACE || universeSize <= NO_DIVISION_UNIVERSE;
}

/** t = mean / (sd/√n) по чистым R, sd выборочная; вырожденный разброс — ±∞/0. */
export function netT(netRs: readonly number[]): number {
  const n = netRs.length;
  if (n < 2) return 0;
  const mean = netRs.reduce((a, b) => a + b, 0) / n;
  const variance = netRs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  if (sd < 1e-12) return mean > 0 ? Infinity : mean < 0 ? -Infinity : 0;
  return (mean * Math.sqrt(n)) / sd;
}

export interface PoolTradesDeps {
  /** Сырой прогон кандидатов на ОДНОМ символе окна поиска (свечи грузятся раз). */
  runSymbol(symbol: string, specs: readonly CandidateSpec[]): Map<string, TradeResult[]>;
  /** Месяц входа сделки — месяц членства символа? Иначе сделка не считается. */
  isMember(symbol: string, entryTimeSec: number): boolean;
}

export interface TakeResult {
  /** Сделки выбранных единиц (минимальный префикс, набравший бюджет). */
  trades: TradeResult[];
  /** Сколько единиц понадобилось. */
  unitsUsed: number;
  /** Пул кончился раньше бюджета. */
  exhausted: boolean;
}

type ByYear = Map<number, TradeResult[]>;

/**
 * Кэш сделок кандидатов по символам и годам. Движок гонит символ целиком, а
 * единицы отсева — символо-годы, поэтому прогон символа кэшируется (все годы
 * сразу, уже отфильтрованные по членству), а `take` выбирает из кэша.
 */
export class PoolTrades {
  private readonly cache = new Map<string, Map<string, ByYear>>();
  private readonly deps: PoolTradesDeps;

  constructor(deps: PoolTradesDeps) {
    this.deps = deps;
  }

  /** Догоняет символы, на которых кандидат ещё не гонялся (символ-мажорно). */
  ensure(specs: readonly CandidateSpec[], symbols: readonly string[]): void {
    for (const symbol of symbols) {
      const lacking = specs.filter((s) => !this.cache.get(candidateId(s))?.has(symbol));
      if (lacking.length === 0) continue;
      const raw = this.deps.runSymbol(symbol, lacking);
      for (const spec of lacking) {
        const id = candidateId(spec);
        const byYear: ByYear = new Map();
        for (const t of raw.get(id) ?? []) {
          if (!this.deps.isMember(symbol, t.entryTime)) continue;
          const year = yearOf(t.entryTime);
          const list = byYear.get(year);
          if (list) list.push(t);
          else byYear.set(year, [t]);
        }
        const bySymbol = this.cache.get(id) ?? new Map<string, ByYear>();
        bySymbol.set(symbol, byYear);
        this.cache.set(id, bySymbol);
      }
    }
  }

  private unitTrades(id: string, unit: PoolUnit): readonly TradeResult[] {
    return this.cache.get(id)?.get(unit.symbol)?.get(unit.year) ?? [];
  }

  /**
   * Единицы по порядку, пока кандидат не наберёт `target` сделок (или пул не
   * кончится). Повторный вызов с большим бюджетом продолжает ТОТ ЖЕ порядок:
   * стадия B — продолжение стадии A, а не новая выборка.
   */
  take(
    specs: readonly CandidateSpec[],
    units: readonly PoolUnit[],
    target: number,
    chunk = TAKE_CHUNK,
  ): Map<string, TakeResult> {
    const prefix = new Map<string, number>(); // id → unitsUsed, когда набран бюджет
    let pending = [...specs];
    const counts = new Map(pending.map((s) => [candidateId(s), 0]));
    let cursor = 0;
    while (pending.length > 0 && cursor < units.length) {
      const end = Math.min(cursor + chunk, units.length);
      const symbols = [...new Set(units.slice(cursor, end).map((u) => u.symbol))];
      this.ensure(pending, symbols);
      const stillPending: CandidateSpec[] = [];
      for (const spec of pending) {
        const id = candidateId(spec);
        let count = counts.get(id)!;
        let done = false;
        for (let i = cursor; i < end; i++) {
          count += this.unitTrades(id, units[i]).length;
          if (count >= target) {
            prefix.set(id, i + 1);
            done = true;
            break;
          }
        }
        counts.set(id, count);
        if (!done) stillPending.push(spec);
      }
      pending = stillPending;
      cursor = end;
    }

    const out = new Map<string, TakeResult>();
    for (const spec of specs) {
      const id = candidateId(spec);
      const used = prefix.get(id);
      const unitsUsed = used ?? units.length;
      const trades: TradeResult[] = [];
      for (let i = 0; i < unitsUsed; i++) trades.push(...this.unitTrades(id, units[i]));
      out.set(id, { trades, unitsUsed, exhausted: used === undefined });
    }
    return out;
  }

  /** Все сделки кандидатов по символам пула (символ-мажорно догоняет недостающее). */
  all(specs: readonly CandidateSpec[], symbols: readonly string[]): Map<string, TradeResult[]> {
    this.ensure(specs, symbols);
    const out = new Map<string, TradeResult[]>();
    for (const spec of specs) {
      const id = candidateId(spec);
      const trades: TradeResult[] = [];
      for (const symbol of symbols) {
        for (const list of this.cache.get(id)?.get(symbol)?.values() ?? []) trades.push(...list);
      }
      out.set(id, trades);
    }
    return out;
  }

  /** Забыть кандидата (отклонён — память не держим). */
  drop(spec: CandidateSpec): void {
    this.cache.delete(candidateId(spec));
  }
}

/** Месяц входа сделки — для фильтра членства снаружи. */
export function entryMonth(timeSec: number): string {
  return monthKey(timeSec);
}
