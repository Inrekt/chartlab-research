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
  test("размер ровно такой, как записано в пре-регистрации: 216", () => {
    // 3 порога растянутости × 3 порога плотности × 2 окна × 3 запаса стопа
    // × 2 направления × 2 ТФ. Число зафиксировано ДО прогона: раздувать
    // комбинаторику задним числом — та же подгонка, только медленная.
    const specs = familySpecs();
    const tfs = new Set(specs.map((s) => s.timeframe));
    // enumerateAll перечисляет все три ТФ; ночь гоняет два, поэтому
    // сравниваем на «размер в пересчёте на два ТФ»
    expect(specs.length / tfs.size * 2).toBe(216);
    expect(LIQUIDITY_EXITS).toHaveLength(3);
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
      (s) => s.setup.includes("x2.5") && s.setup.includes("w2") && isLiquidityExit(s.exit) && s.exit.stopBufferAtr === 0.5,
    )!;
    for (const n of neighborSpecs(spec)) {
      expect(setupFamily(n.setup)).toBe("liquidity_magnet");
      const setupChanged = n.setup !== spec.setup;
      const exitChanged =
        isLiquidityExit(n.exit) &&
        isLiquidityExit(spec.exit) &&
        n.exit.stopBufferAtr !== spec.exit.stopBufferAtr;
      expect(setupChanged !== exitChanged).toBe(true); // ровно одно из двух
    }
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
