/**
 * Журнал испытаний в git — текстовым дампом, а не бинарником.
 *
 * ПОЧЕМУ. `trials.sqlite` дорос до 97.0 МиБ при ЖЁСТКОМ лимите GitHub на
 * файл в 100 МиБ. Запас — 3 МиБ ≈ 1700 испытаний, а одна продуктивная ночь
 * регистрирует до 4000. То есть push сломался бы на первой же ночи, когда
 * машина реально заработает: `if: always()` спас бы коммит, но не push,
 * испытания ночи умерли бы вместе с раннером, дедуп бы их не увидел, и
 * следующая ночь честно прогнала бы те же спеки заново. Снаружи — «машина
 * работает», по факту — вечный круг.
 *
 * ЧТО ИЗМЕРЕНО (2026-08-09, на копии боевого журнала):
 *   исходник            97.0 МиБ
 *   VACUUM              94.1 МиБ  ← почти не помогает, 3% возврата
 *   VACUUM + gzip       15.3 МиБ
 *   ТЕКСТОВЫЙ ДАМП .gz  10.5 МиБ  ← в 9 раз меньше исходника
 *
 * Дамп выигрывает у сжатого бинарника вдвое, потому что SQL-текст regular и
 * жмётся лучше страниц базы. Плюс он восстановим на любой версии SQLite и
 * читаем глазами — бинарник ни то, ни другое.
 *
 * ⚠️ Дамп в git — временная мера до переезда на свой сервер, где база живёт
 * на диске и лимита не существует вовсе. После переезда этот скрипт остаётся
 * как БЭКАП (раз в неделю), а не как способ хранения.
 *
 * Запуск:
 *   npx tsx researcher/journal-sync.ts dump      — база → дамп (перед коммитом)
 *   npx tsx researcher/journal-sync.ts restore   — дамп → база (после checkout)
 *   npx tsx researcher/journal-sync.ts check     — только проверить размеры
 */
import { execFileSync } from "node:child_process";
import { existsSync, statSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DB_PATH } from "./paths.ts";

/** Дамп лежит рядом с базой; в git попадает он, база — в .gitignore. */
const DUMP_PATH = join(dirname(DB_PATH), "trials.sql.gz");

/**
 * Порог тревоги по размеру. Ниже жёсткого лимита GitHub (100 МиБ) с запасом:
 * между превышением порога и реальной поломкой должно остаться время на
 * реакцию, иначе предупреждение бесполезно.
 */
const WARN_MIB = 80;

const mib = (bytes: number) => bytes / 1024 / 1024;
const sizeOf = (path: string) => (existsSync(path) ? statSync(path).size : 0);

/** `sqlite3 db .dump | gzip -9 > dump` через шелл — потоком, без буфера в память. */
function dump(): void {
  if (!existsSync(DB_PATH)) throw new Error(`базы нет: ${DB_PATH}`);
  mkdirSync(dirname(DUMP_PATH), { recursive: true });
  execFileSync("/bin/sh", ["-c", `sqlite3 "${DB_PATH}" .dump | gzip -9 > "${DUMP_PATH}"`]);

  const db = sizeOf(DB_PATH);
  const dp = sizeOf(DUMP_PATH);
  if (dp === 0) throw new Error("дамп пустой — база не прочиталась");
  console.error(
    `дамп: ${mib(db).toFixed(1)} МиБ базы → ${mib(dp).toFixed(1)} МиБ дампа ` +
      `(в ${(db / dp).toFixed(1)} раза меньше)`,
  );
  guard(dp);
}

/** Восстановление на свежем checkout: дамп → база. */
function restore(): void {
  if (!existsSync(DUMP_PATH)) {
    console.error(`дампа нет (${DUMP_PATH}) — считаем, что журнал пуст, это законно для нового окружения`);
    return;
  }
  if (existsSync(DB_PATH)) {
    console.error(`база уже на месте (${mib(sizeOf(DB_PATH)).toFixed(1)} МиБ) — восстановление пропущено`);
    return;
  }
  mkdirSync(dirname(DB_PATH), { recursive: true });
  execFileSync("/bin/sh", ["-c", `gunzip -c "${DUMP_PATH}" | sqlite3 "${DB_PATH}"`]);
  console.error(`восстановлено: ${mib(sizeOf(DB_PATH)).toFixed(1)} МиБ из дампа`);
}

/**
 * Страж размера. Превышение — ошибка ИНФРАСТРУКТУРЫ, а не научный результат:
 * прогон должен упасть громко, а не тихо потерять ночь на push.
 */
function guard(dumpBytes: number): void {
  const m = mib(dumpBytes);
  if (m < WARN_MIB) return;
  throw new Error(
    [
      `Дамп журнала вырос до ${m.toFixed(1)} МиБ при пороге ${WARN_MIB} и жёстком лимите GitHub 100 МиБ.`,
      "",
      "Это НЕ повод удалять данные — журнал append-only, и его отрицательное",
      "знание (где копать бесполезно) стоит дороже места.",
      "Правильные действия по порядку:",
      "  1. перенести журнал на свой сервер, где лимита нет вовсе;",
      "  2. либо разбить по месяцам (trials-YYYY-MM) и коммитить только текущий;",
      "  3. либо хранить дамп вне git (object storage) и держать в репо только ссылку.",
    ].join("\n"),
  );
}

function check(): void {
  const db = sizeOf(DB_PATH);
  const dp = sizeOf(DUMP_PATH);
  console.log(
    JSON.stringify({
      dbMiB: Number(mib(db).toFixed(2)),
      dumpMiB: Number(mib(dp).toFixed(2)),
      warnMiB: WARN_MIB,
      hardLimitMiB: 100,
      ok: mib(dp) < WARN_MIB,
    }),
  );
}

const mode = process.argv[2];
if (mode === "dump") dump();
else if (mode === "restore") restore();
else if (mode === "check") check();
else {
  console.error("режимы: dump | restore | check");
  process.exit(1);
}
