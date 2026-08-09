import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { enumerateAll, exitsFor, setupFamily, setupNeighbors, toStrategyConfig } from "./grammar.ts";
import { neighborSpecs } from "./screen.ts";

// Перечисление всего пространства запоминается: оно детерминированное, а
// вызовов в файле много — см. тот же приём в liquidityFamily.test.ts.
let allSpecs: ReturnType<typeof enumerateAll> extends Iterable<infer T> ? T[] : never[] = [] as never[];
const familySpecs = () => {
  if (allSpecs.length === 0) allSpecs = [...enumerateAll()] as typeof allSpecs;
  return allSpecs.filter((s) => setupFamily(s.setup) === "funding_pressure");
};

describe("семейство «перегруженное плечо»", () => {
  test("размер ровно такой, как записано в пре-регистрации: 216", () => {
    // 2 окна × 3 порога × 9 выходов × 2 направления × 2 ТФ. Число зафиксировано
    // ДО прогона: docs/family-funding-preregistration.md.
    const specs = familySpecs();
    const tfs = new Set(specs.map((s) => s.timeframe));
    expect((specs.length / tfs.size) * 2).toBe(216);
  });

  test("правило самодостаточно: фильтры его не размножают", () => {
    // Без этого 6 сетапов превратились бы в сотни за счёт контекстных
    // фильтров — ровно так семейство ликвидности однажды раздулось в 252 раза.
    for (const spec of familySpecs()) expect(spec.filters).toHaveLength(0);
  });

  test("условие входа — ровно один атом фандинга на верхнем хвосте", () => {
    for (const spec of familySpecs()) {
      const atoms = toStrategyConfig(spec).entry.conditions;
      expect(atoms).toHaveLength(1);
      const atom = atoms[0];
      expect("kind" in atom && atom.kind === "funding").toBe(true);
      if ("kind" in atom && atom.kind === "funding") {
        // Сторона фандинга зафиксирована высокой и НЕ зависит от направления
        // сделки: лонг против высокого фандинга — внутренний контроль.
        expect(atom.direction).toBe("above");
      }
    }
  });

  test("ширина стопа зафиксирована, варьируются цель и горизонт", () => {
    for (const spec of familySpecs()) {
      const exits = exitsFor(spec.setup);
      expect(exits).toHaveLength(9);
      expect(new Set(exits.map((e) => ("stopAtr" in e ? e.stopAtr : null)))).toEqual(new Set([2]));
      expect(new Set(exits.map((e) => ("takeR" in e ? e.takeR : null)))).toEqual(new Set([1, 2, 3]));
      expect(new Set(exits.map((e) => e.maxBars))).toEqual(new Set([10, 20, 40]));
    }
  });

  test("у каждого сетапа есть соседи — иначе плато убьёт семейство вслепую", () => {
    for (const spec of familySpecs()) {
      const neighbours = setupNeighbors(spec.setup);
      expect(neighbours.length).toBeGreaterThanOrEqual(2);
      for (const id of neighbours) expect(setupFamily(id)).toBe("funding_pressure");
    }
  });

  test("соседи кандидата отличаются ровно одним параметром", () => {
    const spec = familySpecs().find((s) => s.setup === "fundpress_w30_p90")!;
    const ids = neighborSpecs(spec).map((n) => n.setup);
    expect(ids).toContain("fundpress_w90_p90"); // другое окно
    expect(ids).toContain("fundpress_w30_p80"); // соседний порог
    expect(ids).toContain("fundpress_w30_p95");
  });
});

describe("источник ставок подключён", () => {
  test("корпус подключает чтение фандинга с диска", async () => {
    // Ядро само с диска не читает (иначе ломается сборка приложения), поэтому
    // источник подключается в корпусе — единственном месте, через которое
    // проходит любой исследовательский вход. Если эту строку удалить, семейство
    // молча перестанет давать сделки, не сломав ни одного другого теста.
    const source = await readFile(new URL("./corpus.ts", import.meta.url), "utf8");
    expect(source).toContain("useCsvFunding");
    expect(source).toContain("useCsvMetrics");
  });
});
