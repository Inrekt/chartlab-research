import { describe, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { calibrateGates, nullSymmetry } from "./gate-calibration.ts";

function seeded(rows: { stage: string; pass: boolean }[], reasons: string[] = []): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE evals (candidate_id TEXT, stage TEXT, metrics_json TEXT, created_at TEXT);
    CREATE TABLE transitions (candidate_id TEXT, to_state TEXT, reason TEXT, created_at TEXT);
  `);
  const ins = db.prepare("INSERT INTO evals VALUES(?,?,?,?)");
  rows.forEach((r, i) =>
    ins.run(`c${i}`, r.stage, JSON.stringify({ pass: r.pass }), "2026-01-01"),
  );
  const tr = db.prepare("INSERT INTO transitions VALUES(?,?,?,?)");
  reasons.forEach((reason, i) => tr.run(`c${i}`, "REJECTED", reason, "2026-01-01"));
  return db;
}

describe("калибровка ворот по журналу", () => {
  test("считает фактический уровень и во сколько раз ворота мягче заявленного", () => {
    // Ворота нуль-модели объявляют t ≥ 2.6, то есть 0.47% под нулём. Если
    // фактически проходит четверть — заявленный уровень к реальности
    // отношения не имеет, и «произведение девяти разумных порогов» тоже.
    const db = seeded([
      ...Array.from({ length: 24 }, () => ({ stage: "gate_null", pass: true })),
      ...Array.from({ length: 76 }, () => ({ stage: "gate_null", pass: false })),
    ]);
    const [g] = calibrateGates(db);
    expect(g.reached).toBe(100);
    expect(g.actual).toBeCloseTo(0.24, 3);
    expect(g.inflation).toBeGreaterThan(45);
    db.close();
  });

  test("воротам без вероятностной интерпретации инфляция не считается", () => {
    // «Прибыльна на ≥60% символов» — не уровень значимости. Делить долю
    // прохождения на выдуманный номинал значило бы изобрести число.
    const db = seeded([{ stage: "gate_breadth", pass: true }]);
    const [g] = calibrateGates(db);
    expect(g.nominal).toBeNull();
    expect(g.inflation).toBeNull();
    db.close();
  });

  test("проверка симметрии ловит односторонний разностный тест", () => {
    // Главная проверка модуля: она не требует знать, есть ли у кандидатов
    // край, и потому не зависит от допущений о рынке. Разностный тест
    // «кандидат минус базлайн» под нулём обязан давать отрицательный t
    // примерно в половине случаев.
    const skewed = Array.from({ length: 200 }, (_, i) => `нуль-модель: t=${(0.2 + i * 0.01).toFixed(2)} < 2.6`);
    const db = seeded([], skewed);
    const sym = nullSymmetry(db);
    expect(sym.sampled).toBe(200);
    expect(sym.negativeShare).toBe(0);
    expect(sym.min).toBeGreaterThan(0);
    db.close();
  });

  test("на честном симметричном тесте тревога не срабатывает", () => {
    // Обратная сторона: прибор обязан молчать, когда всё в порядке, иначе
    // его перестанут читать.
    const fair = Array.from({ length: 200 }, (_, i) =>
      `нуль-модель: t=${(i - 100) / 50} < 2.6`,
    );
    const db = seeded([], fair);
    const sym = nullSymmetry(db);
    expect(sym.negativeShare).toBeGreaterThan(0.4);
    expect(sym.negativeShare).toBeLessThan(0.6);
    db.close();
  });

  test("отрицательные t распознаются, а не теряются разбором строки", () => {
    const db = seeded([], ["нуль-модель: t=-1.25 < 2.6", "нуль-модель: t=0.80 < 2.6"]);
    const sym = nullSymmetry(db);
    expect(sym.sampled).toBe(2);
    expect(sym.min).toBeCloseTo(-1.25, 3);
    expect(sym.negativeShare).toBeCloseTo(0.5, 3);
    db.close();
  });
});
