/**
 * Наводка владельца → гипотеза в очередь.
 *
 *   npx tsx researcher/hint.ts "шорт перед разлоками на дневках"
 *   npx tsx researcher/hint.ts "толпа против китов на 4h" --new-hypothesis "почему платят иначе…"
 *   … --save — записать предложение в журнал (по умолчанию только показ)
 *
 * Без нейросети: текст сопоставляется с каталогом механизмов по ключевым
 * словам, таймфрейм — по упоминанию (4h/1d/1h, «дневк», «часов»). Наводка
 * проходит те же проверки, что и идеи генератора, и в прогон уходит только по
 * тому же правилу авто-одобрения и лимиту за ночь (brain.ts → promote).
 * Опровергнутый механизм без --new-hypothesis не записывается: иначе наводка
 * стала бы чёрным ходом для перебора уже проигравшего.
 *
 * Локальная Qwen (Ollama) здесь пока не подключена; если подключать — только
 * как подсказчик механизма, вердикт за проверками и воротами.
 */
import { pathToFileURL } from "node:url";
import { defaultContext, evaluateDraft, formatEvaluated, toNewHypothesis, type BrainContext, type Evaluated } from "./brain.ts";
import type { SignalTf } from "./grammar.ts";
import { MECHANISMS, type Mechanism } from "./mechanisms.ts";

export interface ParsedHint {
  text: string;
  mechanisms: Mechanism[];
  timeframes: SignalTf[];
}

const TF_PATTERNS: readonly [SignalTf, RegExp][] = [
  ["4h", /\b4\s?h\b|4\s?ч|четыр[её]хчас/i],
  ["1d", /\b1\s?d\b|днев|сутк|дейли|daily/i],
  ["1h", /\b1\s?h\b|1\s?ч\b|часов(ик|ой|ые|ых)|hourly/i],
];

/** Механизмы по числу совпавших ключевых слов (больше — раньше), ТФ из текста. */
export function parseHint(text: string, mechanisms: readonly Mechanism[] = MECHANISMS): ParsedHint {
  const lower = text.toLowerCase();
  const scored = mechanisms
    .map((m) => ({ m, score: m.keywords.filter((k) => lower.includes(k)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const best = scored.length ? scored[0].score : 0;
  return {
    text,
    mechanisms: scored.filter((x) => x.score === best).map((x) => x.m),
    timeframes: TF_PATTERNS.filter(([, re]) => re.test(text)).map(([tf]) => tf),
  };
}

/** Наводка → оценённые черновики (все наборы кубиков × подходящие ТФ). */
export function hintToHypotheses(
  text: string,
  ctx: BrainContext,
  opts?: { newHypothesis?: string; mechanisms?: readonly Mechanism[] },
): { parsed: ParsedHint; evaluated: Evaluated[] } {
  const parsed = parseHint(text, opts?.mechanisms);
  const evaluated: Evaluated[] = [];
  for (const m of parsed.mechanisms) {
    const tfs = parsed.timeframes.length ? m.tfs.filter((tf) => parsed.timeframes.includes(tf)) : m.tfs;
    for (const cubes of m.cubeSets) {
      for (const tf of tfs) {
        evaluated.push(
          evaluateDraft(
            { mechanism: m, cubes, timeframe: tf, source: "hint", hintText: text, newHypothesis: opts?.newHypothesis },
            ctx,
          ),
        );
      }
    }
  }
  return { parsed, evaluated };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const save = args.includes("--save");
  const nhIdx = args.indexOf("--new-hypothesis");
  const newHypothesis = nhIdx >= 0 ? args[nhIdx + 1] : undefined;
  const text = args.filter((a, i) => !a.startsWith("--") && (nhIdx < 0 || i !== nhIdx + 1))[0];
  if (!text) throw new Error('использование: hint.ts "текст наводки" [--new-hypothesis "…"] [--save]');

  const { TrialLedger } = await import("./ledger.ts");
  const { DB_PATH } = await import("./paths.ts");
  const ledger = save ? new TrialLedger(DB_PATH) : undefined;
  try {
    const { parsed, evaluated } = hintToHypotheses(text, defaultContext(ledger), { newHypothesis });
    if (parsed.mechanisms.length === 0) {
      console.log("Механизм не распознан. Опиши, КТО и ПОЧЕМУ платит, — или добавь механизм в mechanisms.ts.");
      return;
    }
    console.log(`Механизмы: ${parsed.mechanisms.map((m) => m.id).join(", ")}; ТФ: ${parsed.timeframes.join(", ") || "все допустимые"}`);
    for (const ev of evaluated) console.log("  " + formatEvaluated(ev));
    if (!ledger) {
      console.log("\n(показ без записи; --save — записать прошедшие проверки как предложения)");
      return;
    }
    const now = new Date().toISOString();
    let added = 0;
    for (const ev of evaluated) {
      if (ev.adequacy.passed && ledger.proposeHypothesis(toNewHypothesis(ev, now))) added += 1;
    }
    console.log(`\nЗаписано предложений: ${added}. В прогон — только через brain.ts --queue (лимит за ночь).`);
  } finally {
    ledger?.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
