/**
 * Сторож молчания: ночь пропущена — и об этом кто-то обязан закричать.
 *
 * Зачем вообще. GitHub роняет расписания молча: 06.08 ночь не состоялась
 * вовсе, 07.08 опоздала на 3.5 часа, и узнали мы об этом только потому, что
 * специально пошли смотреть `gh run list`. Машина, которая не работала сутки,
 * выглядит в точности как машина, которой нечего было делать.
 *
 * Почему сторожем назначен ЧАСОВОЙ ТИК, а не внешний сервис. Внешний
 * dead-man switch (healthchecks.io) правильнее, но требует аккаунта владельца.
 * При этом у нас уже есть надёжный процесс с другим расписанием — часовой
 * тик, — и он падает независимо от ночи. Сторож, живущий в нём, ловит
 * пропущенную ночь без единого внешнего сервиса; слепым он становится только
 * если умрут ОБА расписания сразу, а это заметно куда быстрее.
 *
 * Почему НЕ сделан keep-alive коммит. Он в этом репозитории — карго-культ:
 * GitHub отключает расписания за отсутствие АКТИВНОСТИ, а тик публикует
 * статус в репозиторий каждый час, то есть активность есть и так. А если
 * встанут все воркфлоу — встанет и сам keep-alive, спасти себя он не может.
 *
 * Контур на маке (с 2026-08-19). Облачных расписаний больше нет, а ночь
 * зависит от питания: на батарее она пропускается. Поэтому сторож не только
 * считает часы, но и называет причину — по отметкам, которые оставляет
 * ночной скрипт мака (`ops/mac/bin/nightly.sh`, каталог ~/.chartlab/state).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Куда смотреть, когда ночь молчит. */
const NIGHT_LOG = "~/.chartlab/logs/nightly.log";

/** Что ночной скрипт мака успел сделать — по его отметкам. */
export interface NightAttempts {
  /** Последний старт ночи (на питании, под замком). */
  lastStartIso: string | null;
  /** Последнее завершение скрипта и код перебора. */
  lastEnd: { iso: string; code: number } | null;
  /** Последний пропуск из-за батареи. */
  lastBatterySkipIso: string | null;
}

const NO_ATTEMPTS: NightAttempts = { lastStartIso: null, lastEnd: null, lastBatterySkipIso: null };

/** Последнее слово строки-отметки — ISO; пустой/битый файл ⇒ null. */
function readStamp(path: string): string[] | null {
  if (!existsSync(path)) return null;
  const parts = readFileSync(path, "utf-8").trim().split(/\s+/);
  return parts.length > 0 && parts[0] !== "" ? parts : null;
}

/**
 * Отметки ночного скрипта. Форматы (по строке, поля через пробел):
 * night-started `ДАТА ЭПОХА ISO`, night-ended `ISO КОД`,
 * night-battery-skip `ДАТА ISO`.
 */
export function readNightAttempts(dir: string): NightAttempts {
  try {
    const started = readStamp(join(dir, "night-started"));
    const ended = readStamp(join(dir, "night-ended"));
    const battery = readStamp(join(dir, "night-battery-skip"));
    const code = ended && ended.length >= 2 ? Number(ended[1]) : NaN;
    return {
      lastStartIso: started ? started[started.length - 1]! : null,
      lastEnd: ended && Number.isFinite(code) ? { iso: ended[0]!, code } : null,
      lastBatterySkipIso: battery ? battery[battery.length - 1]! : null,
    };
  } catch {
    return NO_ATTEMPTS;
  }
}

const after = (iso: string | null, ref: number): boolean =>
  iso !== null && Number.isFinite(Date.parse(iso)) && Date.parse(iso) > ref;

/** Почему молчит: по попыткам ПОСЛЕ последней удачной ночи. */
function silenceCause(a: NightAttempts, lastOk: number): string {
  if (a.lastEnd && a.lastEnd.code !== 0 && after(a.lastEnd.iso, lastOk)) {
    return `Причина: ночь упала (код ${a.lastEnd.code}, ${a.lastEnd.iso}). Причина — в ${NIGHT_LOG}.`;
  }
  const endMs = a.lastEnd ? Date.parse(a.lastEnd.iso) : -Infinity;
  if (after(a.lastStartIso, lastOk) && !(endMs >= Date.parse(a.lastStartIso!))) {
    return (
      `Ночь началась (${a.lastStartIso}) и оборвалась, не дойдя до конца — ` +
      `сон, выключение или убитый процесс. Смотреть ${NIGHT_LOG}.`
    );
  }
  if (after(a.lastBatterySkipIso, lastOk)) {
    return (
      `Мак не был на зарядке: ночь пропускалась на батарее (последний раз ` +
      `${a.lastBatterySkipIso}). Подключи питание — ночь стартует в течение часа.`
    );
  }
  return (
    "Попыток запуска не видно вовсе: проверить `launchctl list | grep chartlab` " +
    `и ${NIGHT_LOG}.`
  );
}

/** Ночь по расписанию — 21:37 UTC, то есть раз в 24 часа. */
const NIGHT_PERIOD_HOURS = 24;
/** Запас на опоздание раннера: 07.08 ночь стартовала на 3.5 часа позже. */
const LATE_GRACE_HOURS = 2;

/**
 * Порог тревоги. Одна пропущенная ночь — предупреждение: бывает разовая
 * икота GitHub, и красить 24 тика подряд из-за неё значит приучить владельца
 * не смотреть на красное. Две подряд — это уже не икота, а мёртвое
 * расписание, и тик обязан упасть.
 */
export const WARN_AFTER_HOURS = NIGHT_PERIOD_HOURS + LATE_GRACE_HOURS;
export const FAIL_AFTER_HOURS = 2 * NIGHT_PERIOD_HOURS + LATE_GRACE_HOURS;

export interface SilenceVerdict {
  level: "ok" | "warn" | "fail";
  /** Часов с последней ЗАВЕРШЁННОЙ ночи; null — отметки ещё нет. */
  hoursSince: number | null;
  lastNightIso: string | null;
  message: string;
}

/**
 * Сколько машина молчит и пора ли кричать.
 *
 * `lastNightIso` — отметка, которую ночь ставит ТОЛЬКО дойдя до конца.
 * Упавшая на середине отметки не оставляет, поэтому «ночь запускалась» и
 * «ночь отработала» здесь не путаются.
 */
export function nightSilenceVerdict(
  lastNightIso: string | null,
  now: Date = new Date(),
  attempts: NightAttempts = NO_ATTEMPTS,
): SilenceVerdict {
  if (!lastNightIso) {
    // Отметки нет: либо журнал новый, либо сторож включён между ночами.
    // Молчать нельзя (иначе сторож никогда не сработает), но и падать не за
    // что — фактов о пропуске у нас нет. Разрешится первой же ночью.
    return {
      level: "warn",
      hoursSince: null,
      lastNightIso: null,
      message:
        "Сторож ещё не вооружён: отметки о завершённой ночи в журнале нет. " +
        "Появится после первого полного прогона; если не появилась за сутки — " +
        "ночь не доходит до конца.",
    };
  }
  const last = Date.parse(lastNightIso);
  if (!Number.isFinite(last)) {
    return {
      level: "fail",
      hoursSince: null,
      lastNightIso,
      message: `Отметка о последней ночи нечитаема: ${lastNightIso}. Журнал повреждён.`,
    };
  }
  const hoursSince = (now.getTime() - last) / 3_600_000;
  if (hoursSince < WARN_AFTER_HOURS) {
    return {
      level: "ok",
      hoursSince,
      lastNightIso,
      message: `Последняя ночь ${hoursSince.toFixed(1)} ч назад — расписание живо.`,
    };
  }
  const missed = Math.floor(hoursSince / NIGHT_PERIOD_HOURS);
  const level = hoursSince >= FAIL_AFTER_HOURS ? "fail" : "warn";
  return {
    level,
    hoursSince,
    lastNightIso,
    message:
      (level === "fail" ? "🚨 НОЧЬ НЕ ЗАПУСКАЛАСЬ" : "⚠️ ночь пропущена") +
      `: ${hoursSince.toFixed(1)} ч с последнего полного прогона ` +
      `(пропущено ночей: ${missed}, последняя ${lastNightIso}).` +
      "\n" +
      silenceCause(attempts, last),
  };
}
