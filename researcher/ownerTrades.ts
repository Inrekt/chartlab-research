/**
 * Приём сделок владельца и снимок рыночной обстановки в момент входа.
 *
 * Зачем это существует. Правило владельца формализовали трижды, и трижды
 * выяснялось, что проверялось НЕ ТО: частота вышла в 8 раз ниже реальной,
 * сопровождение сделки было другим, издержки считались сломанным прибором.
 * Угадывание правила по описанию словами исчерпано. Здесь лежит то, по чему
 * его можно ВОССТАНОВИТЬ, — фактические точки входа.
 *
 * Ключевое свойство снимка: он невосстановим задним числом. Через полгода от
 * сделки останется цена, а скопления ликвидности, состояние диапазона и то,
 * что именно снёс вынос, придётся считать по данным, которых к тому моменту
 * может не быть в прежнем виде. Поэтому снимок делается при ЗАПИСИ сделки.
 *
 * ⚠️ Чего этот модуль НЕ делает и делать не должен: он не судит о сделке, не
 * считает её прибыльность и не отбирает «удачные». Запись данных не бывает
 * переобучением — переобучением бывает анализ, и он живёт отдельно, со своей
 * пре-регистрацией.
 */
import { pathToFileURL } from "node:url";
import { cachedLiquidityFeatures } from "../src/core/liquidations/clusterSeries.ts";
import { loadCandles } from "./corpus.ts";
import { TrialLedger } from "./ledger.ts";
import { DB_PATH } from "./paths.ts";
import type { SignalTf } from "./grammar.ts";

/** Окна, по которым описывается состояние диапазона (те же, что у свипа). */
const RANGE_WINDOWS = [126, 252, 504] as const;

export interface TradeContext {
  tf: SignalTf;
  /** Время бара, на котором стоит вход (не сама сделка, а бар корпуса). */
  barIso: string;
  atr: number | null;
  /** Что свип снёс на этом баре — сердце механизма владельца. */
  sweptAboveWeight: number | null;
  sweptBelowWeight: number | null;
  sweptAbovePrice: number | null;
  sweptBelowPrice: number | null;
  /** Живые скопления вокруг цены на момент входа. */
  nearAbove: number | null;
  nearBelow: number | null;
  weightAbove: number | null;
  weightBelow: number | null;
  /**
   * Состояние диапазона по каждому окну: границы и признак «границы не
   * обновлялись» — та самая «зажатость», которую мы трижды формализовали
   * по-разному.
   */
  range: {
    bars: number;
    upper: number | null;
    lower: number | null;
    upperHeld: boolean | null;
    lowerHeld: boolean | null;
    /** На сколько ATR цена ушла за верх/низ диапазона. Глубина выноса. */
    breakAboveAtr: number | null;
    breakBelowAtr: number | null;
  }[];
}

const finite = (x: number | undefined): number | null =>
  x !== undefined && Number.isFinite(x) ? x : null;

/** Максимум high на срезе [from, to). NaN, если срез пуст. */
function maxHigh(c: readonly { high: number }[], from: number, to: number): number {
  let m = Number.NEGATIVE_INFINITY;
  for (let i = Math.max(0, from); i < to; i++) if (c[i].high > m) m = c[i].high;
  return Number.isFinite(m) ? m : NaN;
}
function minLow(c: readonly { low: number }[], from: number, to: number): number {
  let m = Number.POSITIVE_INFINITY;
  for (let i = Math.max(0, from); i < to; i++) if (c[i].low < m) m = c[i].low;
  return Number.isFinite(m) ? m : NaN;
}

/**
 * Снимок обстановки на баре, СОДЕРЖАЩЕМ момент входа.
 *
 * Берётся именно этот бар, а не следующий: нас интересует, что владелец видел,
 * когда решал войти. Заглядывания вперёд нет — все величины считаются из
 * прошлого относительно этого бара.
 *
 * `null` — законный ответ: корпус может не покрывать символ или дату, и
 * подставлять вместо этого нули значило бы сочинить обстановку, которой никто
 * не наблюдал.
 */
export function snapshotContext(
  symbol: string,
  tf: SignalTf,
  entrySec: number,
): TradeContext | null {
  const candles = loadCandles(symbol, tf);
  if (!candles || candles.length < 40) return null;

  // Бар, в который попадает момент входа: последний с time <= entrySec.
  let idx = -1;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].time <= entrySec) idx = i;
    else break;
  }
  if (idx < 0) return null;

  const liq = cachedLiquidityFeatures(candles);
  const atr = finite(liq.atrAt[idx]);
  const close = candles[idx].close;

  const range = RANGE_WINDOWS.map((bars) => {
    const haveTwoWindows = idx - 2 * bars >= 0;
    const upper = idx - bars >= 0 ? maxHigh(candles, idx - bars, idx) : NaN;
    const lower = idx - bars >= 0 ? minLow(candles, idx - bars, idx) : NaN;
    const prevUpper = haveTwoWindows ? maxHigh(candles, idx - 2 * bars, idx - bars) : NaN;
    const prevLower = haveTwoWindows ? minLow(candles, idx - 2 * bars, idx - bars) : NaN;
    return {
      bars,
      upper: finite(upper),
      lower: finite(lower),
      // «Держалась» = за последнее окно граница не обновлена против предыдущего.
      upperHeld: Number.isFinite(upper) && Number.isFinite(prevUpper) ? upper <= prevUpper : null,
      lowerHeld: Number.isFinite(lower) && Number.isFinite(prevLower) ? lower >= prevLower : null,
      // Глубина выноса в ATR — величина, которую ни одна из трёх версий
      // правила не варьировала вовсе, хотя «сбрило ликвидность» это про неё.
      breakAboveAtr:
        atr && Number.isFinite(upper) && atr > 0 ? (close - (upper as number)) / atr : null,
      breakBelowAtr:
        atr && Number.isFinite(lower) && atr > 0 ? ((lower as number) - close) / atr : null,
    };
  });

  return {
    tf,
    barIso: new Date(candles[idx].time * 1000).toISOString(),
    atr,
    sweptAboveWeight: finite(liq.sweptAboveWeight[idx]),
    sweptBelowWeight: finite(liq.sweptBelowWeight[idx]),
    sweptAbovePrice: finite(liq.sweptAbovePrice[idx]),
    sweptBelowPrice: finite(liq.sweptBelowPrice[idx]),
    nearAbove: finite(liq.nearAbove[idx]),
    nearBelow: finite(liq.nearBelow[idx]),
    weightAbove: finite(liq.weightAbove[idx]),
    weightBelow: finite(liq.weightBelow[idx]),
    range,
  };
}

export interface OwnerTradeInput {
  symbol: string;
  direction: "long" | "short";
  entryIso: string;
  entryPrice: number;
  stopPrice?: number;
  targetPrice?: number;
  exitIso?: string;
  exitPrice?: number;
  note?: string;
  setupLabel?: string;
  tf?: SignalTf;
}

/**
 * Записать сделку владельца вместе со снимком обстановки.
 *
 * Снимок делается по ОБОИМ рабочим таймфреймам: какой из них соответствует его
 * восприятию, заранее неизвестно, а посчитать оба стоит копейки.
 */
export function recordOwnerTrade(
  input: OwnerTradeInput,
  opts: { dbPath?: string; source?: string } = {},
): { id: number; context: Record<string, TradeContext | null> } {
  const entrySec = Math.floor(Date.parse(input.entryIso) / 1000);
  if (!Number.isFinite(entrySec)) {
    throw new Error(`не разобрал дату входа: ${input.entryIso}`);
  }
  const context: Record<string, TradeContext | null> = {};
  for (const tf of (input.tf ? [input.tf] : ["1h", "4h"]) as SignalTf[]) {
    context[tf] = snapshotContext(input.symbol, tf, entrySec);
  }

  const ledger = new TrialLedger(opts.dbPath ?? DB_PATH);
  try {
    const id = ledger.addOwnerTrade({
      symbol: input.symbol,
      direction: input.direction,
      entryIso: input.entryIso,
      entryPrice: input.entryPrice,
      stopPrice: input.stopPrice ?? null,
      targetPrice: input.targetPrice ?? null,
      exitIso: input.exitIso ?? null,
      exitPrice: input.exitPrice ?? null,
      note: input.note ?? null,
      setupLabel: input.setupLabel ?? null,
      context,
      source: opts.source ?? "manual",
    });
    return { id, context };
  } finally {
    ledger.close();
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
// npx tsx researcher/ownerTrades.ts --symbol SOLUSDT --dir short \
//   --at 2026-03-14T12:00Z --entry 187.8 --stop 189.6 --target 182 --note "свип хая Азии"
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const symbol = arg("symbol");
  const dir = arg("dir");
  const at = arg("at");
  const entry = Number(arg("entry"));
  if (!symbol || (dir !== "long" && dir !== "short") || !at || !Number.isFinite(entry)) {
    console.error(
      "нужно: --symbol SOLUSDT --dir short|long --at 2026-03-14T12:00Z --entry 187.8 " +
        "[--stop 189.6] [--target 182] [--note '...'] [--label '...']",
    );
    process.exit(2);
  }
  const num = (n: string) => {
    const v = Number(arg(n));
    return Number.isFinite(v) ? v : undefined;
  };
  const { id, context } = recordOwnerTrade({
    symbol,
    direction: dir,
    entryIso: at,
    entryPrice: entry,
    stopPrice: num("stop"),
    targetPrice: num("target"),
    note: arg("note"),
    setupLabel: arg("label"),
  });
  console.error(`записана сделка #${id}`);
  for (const [tf, ctx] of Object.entries(context)) {
    if (!ctx) {
      console.error(`  ${tf}: корпус не покрывает символ или дату — снимка нет`);
      continue;
    }
    const swept = dir === "short" ? ctx.sweptAboveWeight : ctx.sweptBelowWeight;
    const r126 = ctx.range.find((r) => r.bars === 126);
    console.error(
      `  ${tf}: бар ${ctx.barIso}, снесено скопление веса ${swept ?? "—"}, ` +
        `границы держались ${r126?.upperHeld ?? "?"}/${r126?.lowerHeld ?? "?"}, ` +
        `вынос за верх ${r126?.breakAboveAtr?.toFixed(2) ?? "—"} ATR`,
    );
  }
  console.log(JSON.stringify({ id, context }, null, 2));
}
