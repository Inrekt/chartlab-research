import { describe, expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrialLedger } from "./ledger.ts";
import { FAIL_AFTER_HOURS, WARN_AFTER_HOURS, nightSilenceVerdict } from "./watchdog.ts";

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
