import { describe, expect, test } from "vitest";
import { buildDigest } from "./nightly.ts";
import type { ScreenSummary } from "./screen.ts";

const emptyIncubation = {
  seeded: 0,
  rejectedAtEntry: 0,
  checked: 0,
  newTrades: 0,
  graduated: [],
  killed: [],
};
const emptySupervision = {
  supervised: 0,
  newTrades: 0,
  decayed: [],
  requalified: [],
  retired: [],
};
const screen = {
  tf: "1h",
  seed: 1,
  validated: [],
  stages: { halving_16: { evaluated: 100, passed: 5 } },
  rejectedByGate: {},
  ledgerCounts: { trials: 10, clusters: 5 },
  diagnostics: null,
} as unknown as ScreenSummary;

const digest = (calibration?: Parameters<typeof buildDigest>[6]) =>
  buildDigest("2026-08-09", [screen], emptyIncubation, emptySupervision, {}, [], calibration);

describe("калибровка ворот в ночном дайджесте", () => {
  test("цифры попадают в отчёт — их больше не надо помнить отдельной командой", () => {
    // Раньше это была отдельная команда, а значит её надо было ВСПОМНИТЬ.
    // Цифры воронки не значат ничего, если породившие их ворота мягче или
    // строже собственной вывески — и это выяснилось только тогда, когда я
    // специально пошёл смотреть.
    const text = digest([
      { gate: "gate_null", actual: 0.24, nominal: 0.0047, inflation: 51 },
      { gate: "gate_dsr", actual: 0, nominal: 0.05, inflation: 0 },
    ]);
    expect(text).toContain("## Калибровка ворот");
    expect(text).toContain("gate_null: факт 24.0%, номинал 0.47%, отношение 51×");
    expect(text).toContain("gate_dsr: факт 0.0%");
  });

  test("оговорка про отбор печатается рядом с числами, а не в чужом файле", () => {
    // Без неё «мягче в 51 раз» читается как приговор воротам, хотя до поздних
    // ворот доходят уже отобранные кандидаты. Я на этом ошибся однажды —
    // оговорка обязана стоять там же, где цифра.
    const text = digest([{ gate: "gate_null", actual: 0.24, nominal: 0.0047, inflation: 51 }]);
    expect(text).toContain("НУЛЕВОЙ популяции");
    expect(text).toContain("отобранные кандидаты");
  });

  test("нет данных — блок честно пуст, дайджест всё равно пишется", () => {
    // Дайджест обязан писаться и когда прибор сломан: иначе исчезнет и отчёт,
    // и причина его отсутствия.
    const text = digest();
    expect(text).toContain("## Калибровка ворот");
    expect(text).toContain("нет данных");
    expect(text).toContain("## История ночей");
  });
});
