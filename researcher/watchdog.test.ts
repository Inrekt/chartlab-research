import { describe, expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrialLedger } from "./ledger.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  FAIL_AFTER_HOURS,
  WARN_AFTER_HOURS,
  nightSilenceVerdict,
  readNightAttempts,
} from "./watchdog.ts";

const at = (hoursAgo: number, now = Date.parse("2026-08-10T12:00:00.000Z")) =>
  new Date(now - hoursAgo * 3_600_000).toISOString();
const NOW = new Date("2026-08-10T12:00:00.000Z");

describe("сторож молчания", () => {
  test("ночь была вчера — тишины нет", () => {
    const v = nightSilenceVerdict(at(14), NOW);
    expect(v.level).toBe("ok");
    expect(v.hoursSince).toBeCloseTo(14, 1);
  });

  test("одна пропущенная ночь — предупреждение, но НЕ падение", () => {
    // Разовая икота GitHub бывает. Красить 24 тика подряд из-за неё значит
    // приучить владельца не смотреть на красное — и тогда сторож бесполезен
    // ровно в тот раз, когда он нужен.
    const v = nightSilenceVerdict(at(WARN_AFTER_HOURS + 1), NOW);
    expect(v.level).toBe("warn");
    expect(v.message).toContain("пропущена");
  });

  test("две ночи подряд — падение: это уже мёртвое расписание", () => {
    const v = nightSilenceVerdict(at(FAIL_AFTER_HOURS + 1), NOW);
    expect(v.level).toBe("fail");
    expect(v.message).toContain("НЕ ЗАПУСКАЛАСЬ");
  });

  test("опоздание раннера на 3.5 часа тревогой не считается", () => {
    // 07.08 ночь стартовала на 3.5 часа позже расписания и отработала. Если
    // сторож считает это пропуском, он кричит на здоровую машину.
    const v = nightSilenceVerdict(at(24 + 1.5), NOW);
    expect(v.level).toBe("ok");
  });

  test("отметки нет — предупреждение, а не тишина и не падение", () => {
    // Сторож не имеет фактов о пропуске, но и молчать не должен: иначе на
    // журнале без отметки он не сработает никогда.
    const v = nightSilenceVerdict(null, NOW);
    expect(v.level).toBe("warn");
    expect(v.hoursSince).toBeNull();
  });

  test("нечитаемая отметка — падение, а не молчаливый ноль", () => {
    expect(nightSilenceVerdict("не дата", NOW).level).toBe("fail");
  });
});

describe("отметка о завершённой ночи", () => {
  const freshDb = () => join(mkdtempSync(join(tmpdir(), "wd-")), "t.sqlite");

  test("ставится и читается; пустой журнал молчит", () => {
    const dbPath = freshDb();
    const a = new TrialLedger(dbPath);
    expect(a.lastNightCompleted()).toBeNull();
    a.markNightCompleted("2026-08-09T21:40:00.000Z");
    a.close();

    // Переживает закрытие: сторож читает её из ДРУГОГО процесса (часовой тик),
    // чем тот, что писал (ночь).
    const b = new TrialLedger(dbPath);
    expect(b.lastNightCompleted()).toBe("2026-08-09T21:40:00.000Z");
    b.markNightCompleted("2026-08-10T21:40:00.000Z");
    expect(b.lastNightCompleted()).toBe("2026-08-10T21:40:00.000Z");
    b.close();
  });
});

describe("сторож называет ПРИЧИНУ тишины (контур на маке, 2026-11)", () => {
  /*
   * С 2026-08-20 ночь 66 раз пропускалась на батарее и 13 раз падала, а
   * тревога в обоих случаях звучала одинаково и посылала в `gh run list`,
   * хотя облачных расписаний давно нет. Владельцу нужно разное: в одном
   * случае — подключить питание, в другом — читать лог.
   */
  const lastOk = at(FAIL_AFTER_HOURS + 30);

  test("на батарее — просит питание и не шлёт в GitHub", () => {
    const v = nightSilenceVerdict(lastOk, NOW, {
      lastStartIso: null,
      lastEnd: null,
      lastBatterySkipIso: at(1),
    });
    expect(v.level).toBe("fail");
    expect(v.message).toMatch(/батаре/);
    expect(v.message).toMatch(/питани/);
    expect(v.message).not.toMatch(/gh run/);
  });

  test("ночь упала — показывает код и локальный лог", () => {
    const v = nightSilenceVerdict(lastOk, NOW, {
      lastStartIso: at(3),
      lastEnd: { iso: at(2), code: 1 },
      lastBatterySkipIso: at(30),
    });
    expect(v.message).toMatch(/упала/);
    expect(v.message).toMatch(/код 1/);
    expect(v.message).toContain("nightly.log");
    expect(v.message).not.toMatch(/батаре/);
  });

  test("ночь началась и не закончилась — оборвалась, а не «не запускалась»", () => {
    const v = nightSilenceVerdict(lastOk, NOW, {
      lastStartIso: at(3),
      lastEnd: { iso: at(50), code: 0 },
      lastBatterySkipIso: null,
    });
    expect(v.message).toMatch(/оборвал/);
    expect(v.message).toContain("nightly.log");
  });

  test("попыток не было вовсе — проверить launchd, а не GitHub", () => {
    const v = nightSilenceVerdict(lastOk, NOW, {
      lastStartIso: null,
      lastEnd: null,
      lastBatterySkipIso: null,
    });
    expect(v.message).toMatch(/launchctl/);
    expect(v.message).not.toMatch(/gh run/);
  });

  test("старые попытки ДО последней удачной ночи причиной не считаются", () => {
    const v = nightSilenceVerdict(at(WARN_AFTER_HOURS + 1), NOW, {
      lastStartIso: at(WARN_AFTER_HOURS + 2),
      lastEnd: { iso: at(WARN_AFTER_HOURS + 1.5), code: 1 },
      lastBatterySkipIso: null,
    });
    expect(v.level).toBe("warn");
    expect(v.message).not.toMatch(/упала/);
  });

  test("отметки ночного скрипта читаются из каталога состояния", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "wd-state-")), "state");
    mkdirSync(dir);
    writeFileSync(join(dir, "night-started"), "2026-08-10 1786348800 2026-08-10T08:00:00Z\n");
    writeFileSync(join(dir, "night-ended"), "2026-08-10T09:00:00Z 1\n");
    writeFileSync(join(dir, "night-battery-skip"), "2026-08-09 2026-08-09T07:00:00Z\n");
    expect(readNightAttempts(dir)).toEqual({
      lastStartIso: "2026-08-10T08:00:00Z",
      lastEnd: { iso: "2026-08-10T09:00:00Z", code: 1 },
      lastBatterySkipIso: "2026-08-09T07:00:00Z",
    });
  });

  test("каталога состояния нет — пустые попытки, а не исключение", () => {
    expect(readNightAttempts(join(tmpdir(), "нет-такого-каталога-wd"))).toEqual({
      lastStartIso: null,
      lastEnd: null,
      lastBatterySkipIso: null,
    });
  });
});
