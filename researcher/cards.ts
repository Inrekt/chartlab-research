/**
 * Карточка «бери и повторяй» — конечный продукт всей машины.
 *
 * Пишется в Obsidian В МОМЕНТ выпуска и содержит всё, что нужно человеку,
 * чтобы торговать стратегию руками: правила словами, доказательства
 * (форвард-сделки, не бэктест), риск-блок и ЗАРАНЕЕ прописанный стоп-кран.
 * Никакого LLM: каждый факт в карточке — число из журнала.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TradeResult } from "../src/core/types/index.ts";
import { tradeCostInR } from "../src/core/committee/costModel.ts";
import { SETUPS, type CandidateSpec,
  isLiquidityExit,
} from "./grammar.ts";
import { DEFAULT_VAULT_DIR } from "./paths.ts";
import type { IncubationRow, PaperTradeRow } from "./incubationBook.ts";
import { CUSUM_H, CUSUM_K } from "./cusum.ts";
import { moments } from "./stats.ts";

export const DEFAULT_VAULT_CARDS_DIR = join(DEFAULT_VAULT_DIR, "Карточки");

/** Человеческие описания сетапов — на языке трейдера, не кода. */
const SETUP_RU: Record<string, string> = {
  trend_cross_50: "Вход, когда цена закрытия пересекает SMA50 в сторону сделки",
  trend_cross_100: "Вход, когда цена закрытия пересекает SMA100 в сторону сделки",
  donchian_breakout_20: "Пробой 20-барного канала Дончиана (канал считается без текущего бара)",
  donchian_breakout_55: "Пробой 55-барного канала Дончиана (канал считается без текущего бара)",
  squeeze_break_donchian:
    "Сжатие волатильности (перцентиль < 30) + пробой 20-барного канала Дончиана",
  squeeze_break_keltner: "Сжатие волатильности (перцентиль < 30) + выход за канал Кельтнера(20)",
  pullback_rsi_40: "Откат в тренде: RSI(14) возвращается через 40 (long) / 60 (short)",
  pullback_rsi_45: "Откат в тренде: RSI(14) возвращается через 45 (long) / 55 (short)",
  momentum_roc_zero: "Импульс: ROC(12) пересекает ноль в сторону сделки",
  momentum_macd_zero: "Импульс: линия MACD пересекает ноль в сторону сделки",
  momentum_macd_signal: "Импульс: линия MACD пересекает свою сигнальную в сторону сделки",
  divergence_rsi_30: "Дивергенция цена/RSI по подтверждённым пивотам (окно 30 баров)",
  divergence_macd_30: "Дивергенция цена/MACD по подтверждённым пивотам (окно 30 баров)",
  pattern_pinbar: "Пин-бар (окно 5 баров) — только в контексте фильтров",
  pattern_engulfing: "Поглощение (окно 5 баров) — только в контексте фильтров",
  meanrev_keltner_20: "Возврат к средней: цена возвращается в канал Кельтнера(20)",
  meanrev_bollinger_20: "Возврат к средней: цена возвращается в полосы Боллинджера(20)",
  seasonal_monday: "Сезонное окно: сигнальный бар — понедельник (UTC)",
  seasonal_friday: "Сезонное окно: сигнальный бар — пятница (UTC)",
};

const FILTER_RU: Record<string, string> = {
  trend_sma200: "цена по нужную сторону SMA200 (тренд за сделку)",
  trend_adx20: "ADX(14) > 20 — тренд присутствует",
  trend_adx25: "ADX(14) > 25 — тренд выражен",
  mom_rsi_regime: "RSI(14) по нужную сторону 50 — импульс за сделку",
  mom_macd_hist: "гистограмма MACD по нужную сторону нуля",
  mom_roc_sign: "ROC(12) по нужную сторону нуля",
  vol_squeeze: "волатильность сжата (перцентиль < 30) — вход до расширения",
  vol_expansion: "волатильность расширена (перцентиль > 70)",
  vol_trending: "choppiness(14) < 38.2 — рынок в движении, не в пиле",
  volume_above_20: "объём выше своей средней за 20 баров",
  volume_above_50: "объём выше своей средней за 50 баров",
  loc_upper_half: "цена в «своей» половине 20-барного канала",
  loc_room_to_run: "цена НЕ у дальнего края канала Кельтнера — есть куда идти",
};

export interface CardInput {
  candidateId: string;
  spec: CandidateSpec;
  incubation: IncubationRow;
  trades: readonly PaperTradeRow[];
  graduationReason: string;
  clusterKey: string;
  /** ISO-дата выпуска. */
  graduatedAt: string;
}

/** min(1%, ¼ Келли): p и b — из ФОРВАРДНЫХ сделок, не из бэктеста. */
export function quarterKellyPct(netRs: readonly number[]): number {
  const wins = netRs.filter((r) => r > 0);
  const losses = netRs.filter((r) => r <= 0);
  if (wins.length === 0 || losses.length === 0) return 0.25;
  const p = wins.length / netRs.length;
  const avgWin = wins.reduce((a, b) => a + b, 0) / wins.length;
  const avgLossAbs = Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length);
  if (avgLossAbs === 0) return 0.25;
  const b = avgWin / avgLossAbs;
  const kelly = p - (1 - p) / b;
  if (kelly <= 0) return 0.25; // форвард-статистика не даёт Келли — минимальный размер
  return Math.min(1, (kelly / 4) * 100);
}

/** Правила выхода словами — карточку читает человек, а не машина. */
function exitLines(exit: CandidateSpec["exit"]): string {
  if (isLiquidityExit(exit)) {
    return [
      `- **Стоп:** за самым дальним скоплением ликвидности против сделки, плюс запас ${exit.stopBufferAtr} × ATR(14)`,
      `- **Тейк:** у ближайшего скопления ликвидности по ходу сделки, не доходя ${exit.targetPullAtr} × ATR(14)`,
      "- **Если скоплений впереди нет — сделки нет:** цель здесь и есть смысл входа",
    ].join("\n");
  }
  return [
    `- **Стоп:** ${exit.stopAtr} × ATR(14) от цены входа`,
    `- **Тейк:** ${exit.takeR}R (${exit.takeR} × расстояние до стопа)`,
  ].join("\n");
}

export function buildCard(input: CardInput): string {
  const { spec, incubation, trades } = input;
  // NET-цифры: Келли на брутто завысил бы размер позиции — карточка обязана
  // считать так же, как считал SPRT при выпуске.
  const netRs = trades.map(
    (t) =>
      t.rMultiple -
      tradeCostInR({ entryPrice: t.entryPrice, stopPrice: t.stopPrice } as TradeResult),
  );
  const m = moments(netRs);
  const wins = netRs.filter((r) => r > 0).length;
  const sizePct = quarterKellyPct(netRs);
  const filterLines =
    spec.filters.length > 0
      ? spec.filters.map((f) => `  - ${FILTER_RU[f] ?? f}`).join("\n")
      : "  - (без дополнительных фильтров)";
  const setup = SETUPS.find((s) => s.id === spec.setup);

  return `---
tags: [chartlab, strategy-card, ${setup?.family ?? "unknown"}]
candidate: "${input.candidateId}"
cluster: "${input.clusterKey}"
graduated: ${input.graduatedAt.slice(0, 10)}
status: active
---

# Карточка стратегии — ${spec.setup} (${spec.direction}, ${spec.timeframe})

> Выпущена автономным исследователем ${input.graduatedAt.slice(0, 10)}.
> Причина выпуска: ${input.graduationReason}.
> Всё ниже — из форвард-проверки на живом рынке, не из бэктеста.

## Правила (повторяются руками)

- **Направление:** ${spec.direction === "long" ? "покупка (long)" : "продажа (short)"}
- **Таймфрейм:** ${spec.timeframe}, решения ТОЛЬКО по закрытой свече
- **Вход:** ${SETUP_RU[spec.setup] ?? spec.setup}
- **Подтверждения (все обязательны):**
${filterLines}
${exitLines(spec.exit)}
- **Время:** позиция закрывается через ${spec.exit.maxBars} баров, если не вышла раньше
- **Инструменты:** ${incubation.symbols.join(", ")}
- Вход по цене открытия СЛЕДУЮЩЕГО бара после сигнального. Один инструмент —
  одна позиция; новые сигналы при открытой позиции пропускаются.

## Доказательства (форвард, живой рынок)

- Сделок в инкубации: **${trades.length}** за ${Math.round((Date.parse(input.graduatedAt) / 1000 - incubation.frozenAt) / 86_400)} дней
- Winrate: **${trades.length > 0 ? ((100 * wins) / trades.length).toFixed(0) : "0"}%**, средний результат: **${m.mean.toFixed(2)}R**
- SPRT принял гипотезу «край настоящий» против скептичной планки μ₁=${incubation.mu1.toFixed(2)}R
  (половина бэктест-оценки — поправка Бентера на самообман)

## Риск-блок (не обсуждается)

- **Размер позиции: ${sizePct.toFixed(2)}% счёта** на сделку — min(1%, ¼ Келли по форвард-статистике)
- Одновременный суммарный риск всех позиций ≤ **5%** счёта
- Не более **2** стратегий из одного кластера (${input.clusterKey}) одновременно
- День закрылся на −2R и хуже → **до завтра не торговать**
- Просадка счёта −10% → размер позиций **пополам**; −15% → **стоп, разбор**

## Стоп-кран (решён заранее, ${input.graduatedAt.slice(0, 10)})

Надзор CUSUM (k=${CUSUM_K}, h=${CUSUM_H}) на каждой закрытой сделке против
эталона инкубации. Тревога (деградация ~1σ ловится за ~10 сделок) → статус
DECAYING, торговлю остановить. Реабилитация — одна за жизнь, только если SPRT
заново докажет край; вторая тревога или отказ SPRT → пенсия навсегда.
Уговаривать стратегию в просадке запрещено этой карточкой.

## Журнал событий

- ${input.graduatedAt.slice(0, 10)} — выпуск (GRADUATED)
`;
}

/** id содержит | и + — в имя файла им нельзя. */
export function cardFileName(candidateId: string): string {
  return `${candidateId.replace(/[^a-zA-Z0-9_.-]/g, "_")}.md`;
}

export function writeCard(dir: string, candidateId: string, content: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, cardFileName(candidateId));
  writeFileSync(path, content, "utf-8");
  return path;
}

/** Событие надзора дописывается в журнал карточки (файл append-only по духу). */
export function appendCardEvent(dir: string, candidateId: string, line: string): void {
  const path = join(dir, cardFileName(candidateId));
  try {
    appendFileSync(path, `- ${line}\n`, "utf-8");
  } catch {
    // карточки нет (выпуск был до появления карточек) — событие живёт в журнале БД
  }
}
