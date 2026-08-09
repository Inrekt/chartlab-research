/**
 * Объявление отравленной эпохи — разово, с показом последствий до записи.
 *
 * Карантин возвращает комбинации в поиск, поэтому он ВЛИЯЕТ на то, что машина
 * будет проверять дальше. Такое не делают одной строкой в чужом скрипте:
 * сначала печатается, сколько испытаний попадёт под запись и сколько
 * комбинаций освободится, и только с `--apply` запись происходит.
 *
 * Запуск:
 *   npx tsx researcher/quarantine.ts --family funding_pressure \
 *     --from 2026-08-04 --to 2026-08-08 --reason "..." [--apply]
 *   npx tsx researcher/quarantine.ts --list
 */
import { pathToFileURL } from "node:url";
import { TrialLedger } from "./ledger.ts";
import { DB_PATH } from "./paths.ts";

function arg(name: string, fallback = ""): string {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

async function main(): Promise<void> {
  const ledger = new TrialLedger(process.env.RESEARCHER_DB_PATH ?? DB_PATH);
  try {
    if (process.argv.includes("--list")) {
      const rows = ledger.quarantines();
      if (rows.length === 0) console.error("карантинов нет");
      for (const q of rows) {
        console.error(`${q.setupFamily}  ${q.fromIso}..${q.toIso}  — ${q.reason}`);
      }
      console.log(JSON.stringify(rows, null, 2));
      return;
    }

    const family = arg("family");
    const from = arg("from");
    const to = arg("to");
    const reason = arg("reason");
    if (!family || !from || !to || !reason) {
      console.error("нужны --family --from --to --reason (или --list)");
      process.exit(2);
    }

    const before = ledger.resamplableExclusions().size;
    const total = ledger.allCandidateIds().size;
    if (!process.argv.includes("--apply")) {
      console.error(
        [
          "СУХОЙ ПРОГОН — ничего не записано.",
          `семейство: ${family}`,
          `окно:      ${from} .. ${to}`,
          `причина:   ${reason}`,
          `сейчас в журнале ${total} испытаний, из них закрывают комбинации ${before}.`,
          "",
          "Повторить с --apply, чтобы записать. Запись append-only и необратима.",
        ].join("\n"),
      );
      return;
    }

    ledger.quarantineEpoch(family, from, to, reason);
    const after = ledger.resamplableExclusions().size;
    console.error(
      `записано. освобождено комбинаций: ${before - after} ` +
        `(журнал не изменился: ${ledger.allCandidateIds().size} испытаний)`,
    );
    console.log(JSON.stringify({ family, from, to, reason, freed: before - after }, null, 2));
  } finally {
    ledger.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
