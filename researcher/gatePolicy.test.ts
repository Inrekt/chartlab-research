import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  classifyDeath,
  depthScore,
  isLearnable,
  LEARNABLE_GATES,
  UNTOUCHABLE_GATES,
} from "./gatePolicy.ts";

describe("файрвол ворот", () => {
  it("каждые ворота воронки классифицированы ровно одним списком", () => {
    // Страховка от дрейфа: новые ворота в screen.ts обязаны попасть в один из
    // списков политики. Иначе анализ почти-прошедших молча увидел бы то, что
    // видеть не должен, — и файрвол кончился бы, не сломав ни одного теста.
    const source = readFileSync(new URL("./screen.ts", import.meta.url), "utf8");
    const used = new Set(
      [...source.matchAll(/(?:reject\(id, "|applyGate\("|reject\(f\.id, ")([a-z_0-9]+)"/g)].map(
        (m) => m[1],
      ),
    );
    const classified = new Set<string>([...LEARNABLE_GATES, ...UNTOUCHABLE_GATES]);
    for (const gate of used) {
      expect(classified.has(gate), `ворота "${gate}" не классифицированы`).toBe(true);
    }
    // и ни одни ворота не сидят в обоих списках
    expect(LEARNABLE_GATES.filter((g) => (UNTOUCHABLE_GATES as readonly string[]).includes(g))).toEqual([]);
  });

  it("широта — неприкасаемая: она считается на скрытых монетах", () => {
    expect(isLearnable("gate_breadth")).toBe(false);
  });
});

describe("depth-score", () => {
  it("растёт по воронке и равен 1 к моменту неприкасаемых ворот в конце", () => {
    expect(depthScore("halving_16")).toBe(0);
    expect(depthScore("halving_128")).toBeCloseTo(1 / 5, 9);
    expect(depthScore("gate_activity")).toBeCloseTo(2 / 5, 9);
    // смерть на широте: пройдены h16, h128, активность — 3 из 5 обучаемых
    expect(depthScore("gate_breadth")).toBeCloseTo(3 / 5, 9);
    expect(depthScore("gate_plateau")).toBeCloseTo(4 / 5, 9);
    // дошёл до нуль-модели — все обучаемые пройдены
    expect(depthScore("gate_null")).toBe(1);
    expect(depthScore("gate_oot")).toBe(1);
  });

  it("неизвестные ворота дают 0, а не бросают", () => {
    expect(depthScore("нет_таких")).toBe(0);
  });
});

describe("таксономия смерти", () => {
  it("халвинг: сигнал есть, экономика съела", () => {
    expect(
      classifyDeath("halving_16", { grossExpectancy: 0.05, netExpectancy: -0.01 }),
    ).toBe("economics_only");
  });

  it("халвинг: сигнала нет и не было", () => {
    expect(
      classifyDeath("halving_16", { grossExpectancy: -0.1, netExpectancy: -0.15 }),
    ).toBe("no_signal");
  });

  it("халвинг: сделок мало — активность, а не сигнал", () => {
    expect(classifyDeath("halving_128", { trades: 12, minTrades: 40 })).toBe("too_few_trades");
  });

  it("неприкасаемые ворота дают закрытый класс без подробностей", () => {
    expect(classifyDeath("gate_null")).toBe("untouchable");
    expect(classifyDeath("gate_dsr")).toBe("untouchable");
  });
});
