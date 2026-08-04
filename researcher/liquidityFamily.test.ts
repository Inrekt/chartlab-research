import { describe, expect, test } from "vitest";
import {
  candidateId,
  enumerateAll,
  isLiquidityExit,
  LIQUIDITY_EXITS,
  setupFamily,
  setupNeighbors,
  toStrategyConfig,
  type CandidateSpec,
} from "./grammar.ts";
import { neighborSpecs } from "./screen.ts";

const familySpecs = (): CandidateSpec[] =>
  [...enumerateAll()].filter((s) => setupFamily(s.setup) === "liquidity_magnet");

describe("семейство ликвидити-магнит", () => {
  test("размер ровно такой, как записано в пре-регистрации: 648", () => {
    // 3 порога растянутости × 3 порога плотности × 2 окна × 3 запаса стопа
    // × 3 варианта добора (K=0,1,2) × 2 направления × 2 ТФ. Число зафиксировано
    // ДО прогона: раздувать комбинаторику задним числом — та же подгонка,
    // только медленная. Расширение 216 → 648 записано в
    // docs/family-scale-in-preregistration.md вместе с ценой (планка дефляции).
    const specs = familySpecs();
    const tfs = new Set(specs.map((s) => s.timeframe));
    // enumerateAll перечисляет все три ТФ; ночь гоняет два, поэтому
    // сравниваем на «размер в пересчёте на два ТФ»
    expect(specs.length / tfs.size * 2).toBe(648);
    expect(LIQUIDITY_EXITS).toHaveLength(9);
  });

  test("K=0 остаётся в сетке — без базлайна добор не с чем сравнивать", () => {
    const addCounts = new Set(familySpecs().map((s) => (isLiquidityExit(s.exit) ? s.exit.adds : -1)));
    expect([...addCounts].sort()).toEqual([0, 1, 2]);
  });

  test("id варианта без добора не изменился — журнал ночи 03.08 остаётся сравним", () => {
    // Поведенческая дедупликация узнаёт правило по id. Если бы суффикс добора
    // появился и у K=0, все записи предыдущей ночи перестали бы совпадать, и
    // те же правила пошли бы на второй прогон как «новые».
    const baseline = familySpecs().find((s) => isLiquidityExit(s.exit) && s.exit.adds === 0)!;
    const exit = baseline.exit;
    expect(isLiquidityExit(exit)).toBe(true);
    if (!isLiquidityExit(exit)) return;

    expect(candidateId(baseline)).toMatch(/\|q[\d.]+p[\d.]+b\d+$/);
    const withAdds: CandidateSpec = { ...baseline, exit: { ...exit, adds: 2 } };
    expect(candidateId(withAdds)).toBe(`${candidateId(baseline)}a2`);
  });

  test("у семейства уровневые выходы, у остальных — прежние кратные риску", () => {
    for (const spec of familySpecs()) {
      expect(isLiquidityExit(spec.exit)).toBe(true);
      const config = toStrategyConfig(spec);
      expect(config.exit.stopLoss.type).toBe("liquidity");
      expect(config.exit.takeProfit.type).toBe("liquidity");
    }
    const other = [...enumerateAll()].find((s) => setupFamily(s.setup) !== "liquidity_magnet")!;
    expect(isLiquidityExit(other.exit)).toBe(false);
    expect(toStrategyConfig(other).exit.stopLoss.type).toBe("atr");
  });

  test("вход — растянутость плюс магнит, зеркальные по направлению", () => {
    const spec = familySpecs().find((s) => s.direction === "short")!;
    const atoms = toStrategyConfig(spec).entry.conditions as Array<Record<string, unknown>>;
    const stretch = atoms.find((a) => a.kind === "stretch")!;
    const liq = atoms.find((a) => a.kind === "liquidity")!;
    // шорт: растянуты ВВЕРХ, магнит СНИЗУ
    expect(stretch.direction).toBe("above");
    expect(liq.side).toBe("below");

    const long = { ...spec, direction: "long" as const };
    const longAtoms = toStrategyConfig(long).entry.conditions as Array<Record<string, unknown>>;
    expect(longAtoms.find((a) => a.kind === "stretch")!.direction).toBe("below");
    expect(longAtoms.find((a) => a.kind === "liquidity")!.side).toBe("above");
  });

  test("ворота плато не задушат семейство: соседей хватает", () => {
    // Ключевой риск конструкции: у выхода семейства всего одно измерение,
    // и без соседей по параметрам сетапа кандидат имел бы их меньше трёх —
    // плато отсекало бы всё семейство, ничего не проверив.
    for (const spec of familySpecs()) {
      expect(neighborSpecs(spec).length).toBeGreaterThanOrEqual(3);
    }
  });

  test("соседи отличаются ровно одним параметром и остаются в семействе", () => {
    const spec = familySpecs().find(
      (s) =>
        s.setup.includes("x2.5") &&
        s.setup.includes("w2") &&
        isLiquidityExit(s.exit) &&
        s.exit.stopBufferAtr === 0.5 &&
        s.exit.adds === 1,
    )!;
    const own = spec.exit as { stopBufferAtr: number; adds: number };
    for (const n of neighborSpecs(spec)) {
      expect(setupFamily(n.setup)).toBe("liquidity_magnet");
      expect(isLiquidityExit(n.exit)).toBe(true);
      const near = n.exit as { stopBufferAtr: number; adds: number };
      const changed = [
        n.setup !== spec.setup,
        near.stopBufferAtr !== own.stopBufferAtr,
        near.adds !== own.adds,
      ].filter(Boolean);
      expect(changed).toHaveLength(1); // ровно одно измерение из трёх
    }
  });

  test("у варианта с добором соседями оказываются K=0 и K=2", () => {
    // Иначе плато не могло бы отличить «добор работает» от «сработал ровно
    // один вариант из девяти», а это и есть его работа.
    const spec = familySpecs().find((s) => isLiquidityExit(s.exit) && s.exit.adds === 1)!;
    const addsOfNeighbors = neighborSpecs(spec)
      .filter((n) => n.setup === spec.setup && isLiquidityExit(n.exit))
      .map((n) => (n.exit as { adds: number }).adds);
    expect(addsOfNeighbors).toContain(0);
    expect(addsOfNeighbors).toContain(2);
  });

  test("id кандидата семейства читается однозначно и не путается с rr", () => {
    const spec = familySpecs()[0];
    const id = candidateId(spec);
    expect(id).toContain("liqmag_");
    expect(id).toMatch(/\|q[\d.]+p[\d.]+b\d+$/); // уровневая кодировка выхода
    expect(id).not.toMatch(/\|s[\d.]+t\d+b\d+$/); // не спутается с кратной риску
  });

  test("setupNeighbors пуст для сетапов вне семейства", () => {
    expect(setupNeighbors("trend_cross_50")).toEqual([]);
    expect(setupNeighbors("нет такого")).toEqual([]);
  });
});

describe("семейство часов фандинга", () => {
  test("размер ровно как в пре-регистрации: 72 (3 окна × 2 напр. × 6 выходов × 2 ТФ)", () => {
    const specs = [...enumerateAll()].filter((s) => setupFamily(s.setup) === "funding_hours");
    const tfs = new Set(specs.map((s) => s.timeframe));
    expect((specs.length / tfs.size) * 2).toBe(72);
  });

  test("правило БЕЗ индикаторов — только час UTC", () => {
    // Любой фильтр смешал бы эффект расписания с эффектом фильтра, и нельзя
    // было бы сказать, что именно сработало.
    for (const spec of [...enumerateAll()].filter((s) => setupFamily(s.setup) === "funding_hours")) {
      expect(spec.filters).toHaveLength(0);
      const config = toStrategyConfig(spec);
      expect(config.filters).toBeUndefined();
      expect(config.entry.conditions).toHaveLength(1);
      const atom = config.entry.conditions[0] as { kind: string; hourRangeUtc: [number, number] };
      expect(atom.kind).toBe("time");
      expect([0, 8, 16]).toContain(atom.hourRangeUtc[0]);
      expect(atom.hourRangeUtc[1] - atom.hourRangeUtc[0]).toBe(1);
    }
  });

  test("пул выходов урезан: стоп фиксирован, тейков три, потолков два", () => {
    const specs = [...enumerateAll()].filter((s) => setupFamily(s.setup) === "funding_hours");
    const stops = new Set(specs.map((s) => (s.exit as { stopAtr: number }).stopAtr));
    const takes = new Set(specs.map((s) => (s.exit as { takeR: number }).takeR));
    const bars = new Set(specs.map((s) => s.exit.maxBars));
    expect([...stops]).toEqual([2]); // единственный стоп — свободы подбора нет
    expect([...takes].sort()).toEqual([1, 2, 3]);
    expect([...bars].sort()).toEqual([10, 20]);
  });
});
