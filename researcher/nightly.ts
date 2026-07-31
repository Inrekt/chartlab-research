/**
 * Ночной оркестратор — то, что launchd запускает в 02:37.
 *
 * Порядок: жернова по каждой вселенной (по умолчанию 1h и 4h — один корпус
 * из 170 крипто-пар, 4h вчетверо дешевле по барам) → инкубатор (посев
 * выживших + догонка живых баров) → надзор за выпускниками → человеческий
 * дайджест в Obsidian. Ни одного LLM: дайджест — числа из журнала,
 * разложенные по шаблону.
 *
 * Переменные окружения: RESEARCHER_NIGHT_N (размер партии НА вселенную,
 * по умолчанию 2000), RESEARCHER_TFS ("1h,4h"), RESEARCHER_VAULT_DIR.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SignalTf } from "./grammar.ts";
import { runIncubation, type IncubationSummary } from "./incubate.ts";
import { DB_PATH, DEFAULT_VAULT_DIR } from "./paths.ts";
import { runScreen, type ScreenSummary } from "./screen.ts";
import { writeStatus } from "./statusFile.ts";
import { runSupervision, type SupervisionSummary } from "./supervise.ts";
import { TrialLedger, STATES } from "./ledger.ts";

const VAULT_DIR = DEFAULT_VAULT_DIR;
const DIGEST_PATH = join(VAULT_DIR, "Исследователь — дайджест.md");
const HISTORY_KEEP = 14;

function stateCensus(dbPath: string): Record<string, number> {
  const ledger = new TrialLedger(dbPath);
  const census: Record<string, number> = {};
  for (const state of STATES) {
    const n = ledger.byState(state).length;
    if (n > 0) census[state] = n;
  }
  ledger.close();
  return census;
}

/** Старая история ночей из существующего дайджеста — последние N строк. */
function previousHistory(): string[] {
  if (!existsSync(DIGEST_PATH)) return [];
  const text = readFileSync(DIGEST_PATH, "utf-8");
  const section = text.split("## История ночей")[1] ?? "";
  return section
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .slice(0, HISTORY_KEEP - 1);
}

function funnelBlock(screen: ScreenSummary): string {
  const gates = Object.entries(screen.rejectedByGate)
    .sort((a, b) => b[1] - a[1])
    .map(([gate, n]) => `  - ${gate}: ${n}`)
    .join("\n");
  const diag = screen.diagnostics
    ? `- Reality Check: p = **${screen.diagnostics.realityCheck.pValue.toFixed(3)}** — ${
        screen.diagnostics.realityCheck.pValue < 0.05
          ? "ночь нашла нечто реальное сверх шума перебора"
          : "лучший результат объясним самим перебором (норма для большинства ночей)"
      }
- PBO (${screen.diagnostics.pbo?.combinations ?? 0} разбиений): **${
        screen.diagnostics.pbo ? screen.diagnostics.pbo.pbo.toFixed(2) : "н/д"
      }** — ${
        !screen.diagnostics.pbo
          ? "мало данных"
          : screen.diagnostics.pbo.pbo > 0.5
            ? "⚠️ БРАК НОЧИ: отбор выбирает шум"
            : screen.diagnostics.pbo.pbo > 0.25
              ? "⚠️ тревога: переподгонка процесса выше нормы"
              : "норма"
      }`
    : "- диагностика: партия слишком мала или коротка";

  return `### ${screen.tf} — партия ${screen.stages.halving_16?.evaluated ?? 0} (сид ${screen.seed})

- Халвинг 16 → ${screen.stages.halving_16?.passed ?? 0} · халвинг 128 → ${screen.stages.halving_128?.passed ?? 0} · **валидировано ${screen.validated.length}**
- Причины отказов:
${gates || "  - (пусто)"}
${diag}`;
}

export function buildDigest(
  date: string,
  screens: ScreenSummary[],
  incubation: IncubationSummary,
  supervision: SupervisionSummary,
  census: Record<string, number>,
  history: string[],
): string {
  const censusLines = Object.entries(census)
    .map(([s, n]) => `  - ${s}: ${n}`)
    .join("\n");
  const totalEvaluated = screens.reduce((a, s) => a + (s.stages.halving_16?.evaluated ?? 0), 0);
  const totalValidated = screens.reduce((a, s) => a + s.validated.length, 0);
  const ledger = screens.at(-1)?.ledgerCounts ?? { trials: 0, clusters: 0 };

  const historyLine =
    `- ${date} — партия ${totalEvaluated} (${screens.map((s) => s.tf).join("+")}), ` +
    `валидировано ${totalValidated}, в инкубаторе +${incubation.seeded}, ` +
    `выпущено ${incubation.graduated.length}, убито ${incubation.killed.length}`;

  return `---
tags: [chartlab, researcher, digest]
updated: ${date}
---

# Исследователь — дайджест (обновляется автоматически)

Последняя ночь: **${date}**. Журнал: **${ledger.trials}** испытаний за всю
жизнь — планка дефляции DSR растёт вместе с этим числом.

## Ночная воронка

${screens.map(funnelBlock).join("\n\n")}

## Инкубатор и надзор

- Посеяно в инкубатор: ${incubation.seeded} (отклонено входным порогом δ≥0.18: ${incubation.rejectedAtEntry})
- Живых проверок: ${incubation.checked}, новых форвард-сделок: ${incubation.newTrades + supervision.newTrades}
- **Выпущено: ${incubation.graduated.length}**${incubation.graduated.length > 0 ? ` → карточки в папке «Карточки»` : ""}
- Убито инкубатором: ${incubation.killed.length}
- Под надзором (выпускники): ${supervision.supervised}; деградации: ${supervision.decayed.length}; пенсии: ${supervision.retired.length}

## Население журнала

${censusLines || "  - пусто"}

## История ночей

${[historyLine, ...history].join("\n")}
`;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const n = Number(process.env.RESEARCHER_NIGHT_N ?? 2000);
  const tfs = (process.env.RESEARCHER_TFS ?? "1h,4h")
    .split(",")
    .map((t) => t.trim()) as SignalTf[];
  const baseSeed = Math.floor(Date.now() / 1000);
  const cardsDir = join(VAULT_DIR, "Карточки");
  const log = (m: string) => console.error(m);

  const screens: ScreenSummary[] = [];
  for (let i = 0; i < tfs.length; i++) {
    log(`Ночь ${new Date().toISOString()}: вселенная ${tfs[i]}, партия ${n}, сид ${baseSeed + i}.`);
    screens.push(runScreen({ tf: tfs[i], n, seed: baseSeed + i, dbPath: DB_PATH, log }));
  }
  const incubation = await runIncubation({ dbPath: DB_PATH, vaultCardsDir: cardsDir, log });
  const supervision = await runSupervision({ dbPath: DB_PATH, vaultCardsDir: cardsDir, log });

  const date = new Date().toISOString().slice(0, 10);
  // Повторный прогон за ту же дату заменяет свою строку истории, не дублирует.
  const history = previousHistory().filter((line) => !line.startsWith(`- ${date}`));
  mkdirSync(dirname(DIGEST_PATH), { recursive: true });
  writeFileSync(
    DIGEST_PATH,
    buildDigest(date, screens, incubation, supervision, stateCensus(DB_PATH), history),
    "utf-8",
  );
  writeStatus({
    screens,
    incubation,
    supervision,
    durationMin: Math.round((Date.now() - startedAt) / 60_000),
  });
  console.log(JSON.stringify({ screens, incubation, supervision }, null, 2));
}

await main();
