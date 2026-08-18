import { describe, expect, test } from "vitest";
import {
  exitsFor,
  fundableSpaceSize,
  sampleCandidates,
  SETUPS,
  setupNeighbors,
  type SetupDef,
} from "./grammar.ts";

const sessionSetups = SETUPS.filter((s) => s.id.startsWith("sessionsweep_"));
const atomsOf = (setup: SetupDef, dir: "long" | "short") => setup.build(dir);

describe("семейство «сессионный свип» — состав", () => {
  test("ровно 6 сетапов: 3 значения сжатия × 2 пары сессий", () => {
    expect(sessionSetups.map((s) => s.id)).toEqual([
      "sessionsweep_asia_k06",
      "sessionsweep_asia_k08",
      "sessionsweep_asia_k10",
      "sessionsweep_london_k06",
      "sessionsweep_london_k08",
      "sessionsweep_london_k10",
    ]);
  });

  test("у каждого назван плательщик — без этого семейство не имеет права на бюджет", () => {
    for (const s of sessionSetups) {
      expect(s.whoPays, s.id).toMatch(/стоп/);
      expect(s.whoPays, s.id).toMatch(/family-session-sweep/);
    }
  });

  test("бюджет ровно 108 испытаний и только на 1ч — как записано в пре-регистрации", () => {
    // 6 сетапов × 9 выходов × 2 направления = 108. Разница между ТФ и есть
    // вклад семейства: на 4ч его нет вообще.
    expect(fundableSpaceSize("1h") - fundableSpaceSize("4h")).toBe(108);
    expect(exitsFor(sessionSetups[0].id)).toHaveLength(9);
  });
});

describe("ограничение таймфрейма", () => {
  test("сэмплер НИ РАЗУ не выдаёт сессионное правило на 4ч", () => {
    // На 4ч бар пересекает границу сессии, и уровень становится фикцией.
    const picked = sampleCandidates(7, 400, undefined, { tf: "4h" });
    expect(picked.length).toBeGreaterThan(0);
    expect(picked.some((c) => c.setup.startsWith("sessionsweep_"))).toBe(false);
  });

  test("на 1ч выдаёт — иначе семейство было бы мёртвым кодом", () => {
    const picked = sampleCandidates(7, 800, undefined, { tf: "1h" });
    expect(picked.some((c) => c.setup.startsWith("sessionsweep_"))).toBe(true);
  });

  test("при жребии ТФ (старый путь, без опции) сессионные правила на 4ч тоже не проходят", () => {
    const picked = sampleCandidates(11, 800);
    const wrongTf = picked.filter((c) => c.setup.startsWith("sessionsweep_") && c.timeframe !== "1h");
    expect(wrongTf).toEqual([]);
  });
});

describe("правило", () => {
  test("шорт: вынос ВВЕРХ за максимум тихой сессии, цель — ликвидность СНИЗУ", () => {
    const atoms = atomsOf(sessionSetups[0], "short");
    expect(atoms).toHaveLength(4);
    const breakout = atoms[1] as { op: string; right: { line: string; sessionFromUtc: number } };
    expect(breakout.op).toBe(">");
    expect(breakout.right.line).toBe("upper");
    expect(breakout.right.sessionFromUtc).toBe(0);
    const target = atoms[3] as { kind: string; side: string };
    expect(target).toMatchObject({ kind: "liquidity", side: "below" });
  });

  test("лонг — зеркало шорта, а не отдельное правило", () => {
    const atoms = atomsOf(sessionSetups[0], "long");
    const breakout = atoms[1] as { op: string; right: { line: string } };
    expect(breakout.op).toBe("<");
    expect(breakout.right.line).toBe("lower");
    expect(atoms[3]).toMatchObject({ side: "above" });
  });

  test("вход разрешён только в громком окне, и оно НЕ пересекается с тихим", () => {
    for (const setup of sessionSetups) {
      const atoms = atomsOf(setup, "short");
      const time = atoms[2] as { kind: string; hourRangeUtc: [number, number] };
      const level = atoms[1] as { right: { sessionFromUtc: number; sessionToUtc: number } };
      expect(time.kind).toBe("time");
      // Громкое окно начинается ровно там, где кончилось тихое: механизм — это
      // приход участников на смене сессии, а не произвольный час.
      expect(time.hourRangeUtc[0]).toBe(level.right.sessionToUtc);
      expect(time.hourRangeUtc[0]).toBeGreaterThanOrEqual(level.right.sessionFromUtc);
    }
  });

  test("сжатие — единственная варьируемая величина, пороги ровно 0.6/0.8/1.0", () => {
    const asia = sessionSetups.filter((s) => s.id.startsWith("sessionsweep_asia"));
    const thresholds = asia.map((s) => (atomsOf(s, "short")[0] as { right: number }).right);
    expect(thresholds).toEqual([0.6, 0.8, 1.0]);
    // Границы сессий у всей пары одинаковы: варьируется ТОЛЬКО сжатие.
    const windows = asia.map((s) => {
      const a = atomsOf(s, "short")[1] as { right: { sessionFromUtc: number; sessionToUtc: number } };
      return [a.right.sessionFromUtc, a.right.sessionToUtc];
    });
    expect(windows).toEqual([[0, 7], [0, 7], [0, 7]]);
  });
});

describe("соседи для ворот плато", () => {
  test("соседи только внутри своей пары сессий", () => {
    // Плато меряет устойчивость ПРАВИЛА; азиатский и лондонский — разные
    // механизмы, и прыжок между ними плато мерить не должно.
    expect(setupNeighbors("sessionsweep_asia_k08")).toEqual([
      "sessionsweep_asia_k06",
      "sessionsweep_asia_k10",
    ]);
    expect(setupNeighbors("sessionsweep_london_k06")).toEqual(["sessionsweep_london_k08"]);
  });
});
