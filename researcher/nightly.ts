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
import { pathToFileURL } from "node:url";
import type { SignalTf } from "./grammar.ts";
import { runIncubation, type IncubationSummary } from "./incubate.ts";
import { DB_PATH, DEFAULT_VAULT_DIR } from "./paths.ts";
import { assertDataSources } from "./preflight.ts";
import { runScreen, type ScreenSummary } from "./screen.ts";
import { writeStatus } from "./statusFile.ts";
import { runSupervision, type SupervisionSummary } from "./supervise.ts";
import { TrialLedger, STATES } from "./ledger.ts";
import { DatabaseSync } from "node:sqlite";
import { calibrateGates } from "./gate-calibration.ts";

const VAULT_DIR = DEFAULT_VAULT_DIR;
const DIGEST_PATH = join(VAULT_DIR, "Исследователь — дайджест.md");
const HISTORY_KEEP = 14;

/**
 * Калибровка ворот для дайджеста. Никогда не бросает: дайджест обязан
 * писаться и тогда, когда прибор сломан — иначе исчезнет и отчёт, и причина.
 */
function gateCalibration(
  dbPath: string,
): { gate: string; actual: number; nominal: number | null; inflation: number | null }[] {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return calibrateGates(db).map(({ gate, actual, nominal, inflation }) => ({
        gate,
        actual,
        nominal,
        inflation,
      }));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

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

  // Малая партия разрешена (пространство бывает честно исчерпано), поэтому она
  // ОБЯЗАНА быть видна в отчёте. Иначе ночь на трёх кандидатах читается как
  // обычная работа — ровно та тихая поломка, от которой ставился страж.
  // Отсутствие поля не должно ронять дайджест: падение здесь стоит отчёта обо
  // ВСЕЙ ночи, а не одной строки. Но и молчать нельзя — молчание тут неотличимо
  // от «партия в порядке».
  const s = screen.sampling;
  if (!s) {
    return `### ${screen.tf} — партия ${screen.stages.halving_16?.evaluated ?? 0} (сид ${screen.seed})

- ⚠️ диагностика набора партии отсутствует — размер партии проверить нечем
- Халвинг 16 → ${screen.stages.halving_16?.passed ?? 0} · халвинг 128 → ${screen.stages.halving_128?.passed ?? 0} · **валидировано ${screen.validated.length}**
- Причины отказов:
${gates || "  - (пусто)"}
${diag}`;
  }
  const batch = s.starved
    ? `\n- ⚠️ **ПАРТИЯ НЕДОБРАНА: ${s.picked} из ${s.requested} запрошенных.** Пространство ` +
      `финансируемых семейств на ${screen.tf} — ${s.space} комбинаций, ` +
      `холостых бросков ${s.wastedAttempts}${s.attemptsExhausted ? ", лимит ИСЧЕРПАН" : ""}. ` +
      `Проверено всё, что осталось свободного; расширить пространство законно ` +
      `может только новая пре-регистрация с полем «кто платит».`
    : "";

  return `### ${screen.tf} — партия ${screen.stages.halving_16?.evaluated ?? 0} (сид ${screen.seed})
${batch}
- Халвинг 16 → ${screen.stages.halving_16?.passed ?? 0} · халвинг 128 → ${screen.stages.halving_128?.passed ?? 0} · **валидировано ${screen.validated.length}**
- Причины отказов:
${gates || "  - (пусто)"}
${diag}`;
}

/**
 * Заявленный уровень ворот против фактического.
 *
 * ⚠️ Читать с оговоркой, и она в блоке напечатана: номинал относится к НУЛЕВОЙ
 * популяции, а до поздних ворот доходят только кандидаты, отобранные
 * предыдущими. Высокая доля прохождения у них — следствие отбора, а не
 * доказательство мягкости. Проверять калибровку надо неотобранными
 * кандидатами (`oot-bench --window in`).
 */
function calibrationBlock(
  rows?: { gate: string; actual: number; nominal: number | null; inflation: number | null }[],
): string {
  if (!rows || rows.length === 0) return "  - нет данных";
  const lines = rows.map((r) => {
    const actual = `${(r.actual * 100).toFixed(1)}%`;
    const nominal = r.nominal === null ? "—" : `${(r.nominal * 100).toFixed(2)}%`;
    const infl = r.inflation === null ? "—" : `${r.inflation.toFixed(0)}×`;
    return `  - ${r.gate}: факт ${actual}, номинал ${nominal}, отношение ${infl}`;
  });
  return [
    ...lines,
    "",
    "  Номинал относится к НУЛЕВОЙ популяции; до поздних ворот доходят уже",
    "  отобранные кандидаты, поэтому высокая доля прохождения у них ожидаема.",
  ].join("\n");
}

export function buildDigest(
  date: string,
  screens: ScreenSummary[],
  incubation: IncubationSummary,
  supervision: SupervisionSummary,
  census: Record<string, number>,
  history: string[],
  /**
   * Калибровка ворот по журналу. Не передана — блок опускается.
   *
   * Стоит в дайджесте, а не в отдельной команде, потому что отдельную команду
   * надо помнить. Цифры воронки не значат ничего, если ворота, которые их
   * породили, мягче или строже собственной вывески — а это выяснилось только
   * тогда, когда я специально пошёл смотреть.
   */
  calibration?: { gate: string; actual: number; nominal: number | null; inflation: number | null }[],
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

## Калибровка ворот

${calibrationBlock(calibration)}

## Население журнала

${censusLines || "  - пусто"}

## История ночей

${[historyLine, ...history].join("\n")}
`;
}

async function main(): Promise<void> {
  // Первым делом, до единого испытания: есть ли вообще источники данных.
  // Ночь без них не даёт «ноль находок», она даёт ноль СДЕЛОК, записанный в
  // журнал как вывод о рынке. Так было потеряно 212 испытаний фандинга.
  assertDataSources();

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
    buildDigest(
      date,
      screens,
      incubation,
      supervision,
      stateCensus(DB_PATH),
      history,
      gateCalibration(DB_PATH),
    ),
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

/**
 * Ночь упала — статус обязан СКАЗАТЬ ОБ ЭТОМ, а не остаться вчерашним.
 *
 * `if: always()` в воркфлоу заставляет опубликовать файл при любом исходе, но
 * публиковать было нечего: упавшая ночь до `writeStatus` не доходила, и на
 * экран уезжал ПРЕДЫДУЩИЙ зелёный статус. Снаружи всё хорошо, внутри машина
 * стоит — ровно то состояние, в котором корпус простоял две недели.
 *
 * Здесь чинится содержимое: перед выходом с ненулевым кодом пишется статус с
 * причиной падения. Испытаний в нём нет (их и не было), зато есть правда.
 */
/** Пустые сводки для статуса падения: ничего не отработало, и это правда. */
const EMPTY_INCUBATION: IncubationSummary = {
  seeded: 0,
  rejectedAtEntry: 0,
  checked: 0,
  newTrades: 0,
  graduated: [],
  killed: [],
};
const EMPTY_SUPERVISION: SupervisionSummary = {
  supervised: 0,
  newTrades: 0,
  decayed: [],
  requalified: [],
  retired: [],
};

/**
 * Защита от запуска при ИМПОРТЕ — та же, что у сборщика корпуса.
 *
 * Без неё `import { buildDigest }` запускал полную ночь: сеть, часы работы и
 * запись в журнал. Именно поэтому у дайджеста и не было теста — его нельзя
 * было написать, не прогнав ночь.
 */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main().catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(reason);
    try {
      writeStatus({
        screens: [],
        incubation: EMPTY_INCUBATION,
        supervision: EMPTY_SUPERVISION,
        durationMin: null,
        failure: reason.split("\n")[0],
      });
    } catch (writeError) {
      // Не смогли даже пожаловаться — но исходную причину терять нельзя.
      console.error(`не удалось записать статус падения: ${String(writeError)}`);
    }
    process.exit(1);
  });
}
