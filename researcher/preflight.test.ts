import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertDataSources, dataSourceHealth } from "./preflight.ts";

const original = process.env.COLLECT_DIR;

afterEach(() => {
  if (original === undefined) delete process.env.COLLECT_DIR;
  else process.env.COLLECT_DIR = original;
});

/** Каталог с N фиктивными CSV на источник. */
function fakeRoot(counts: Record<string, number>): string {
  const root = mkdtempSync(join(tmpdir(), "preflight-"));
  for (const [sub, n] of Object.entries(counts)) {
    mkdirSync(join(root, sub), { recursive: true });
    for (let i = 0; i < n; i++) {
      writeFileSync(join(root, sub, `SYM${i}.csv`), "time,rate\n");
    }
  }
  return root;
}

describe("предполётная проверка источников", () => {
  it("ловит РОВНО ту аварию, что случилась: каталога фандинга нет", () => {
    // Воспроизводит блокер: COLLECT_DIR указывает в пустоту, как на раннере,
    // где не был смонтирован приватный data-репо.
    const root = mkdtempSync(join(tmpdir(), "preflight-empty-"));
    process.env.COLLECT_DIR = root;

    expect(() => assertDataSources()).toThrow(/КАТАЛОГА НЕТ/);
    expect(() => assertDataSources()).toThrow(/funding/);
    rmSync(root, { recursive: true, force: true });
  });

  it("сообщение объясняет, что это поломка окружения, а не вывод о рынке", () => {
    const root = mkdtempSync(join(tmpdir(), "preflight-msg-"));
    process.env.COLLECT_DIR = root;

    // Смысл теста — не текст, а гарантия: тот, кто увидит падение, не примет
    // его за исследовательский результат и найдёт, где чинить.
    expect(() => assertDataSources()).toThrow(/COLLECT_DIR/);
    expect(() => assertDataSources()).toThrow(/вывод о рынке|поломк/i);
    rmSync(root, { recursive: true, force: true });
  });

  it("каталог есть, но почти пустой — тоже падение", () => {
    const root = fakeRoot({ funding: 3, "metrics-1h": 3 });
    process.env.COLLECT_DIR = root;

    expect(() => assertDataSources()).toThrow(/CSV 3 < 50/);
    rmSync(root, { recursive: true, force: true });
  });

  it("полный комплект источников проходит молча", () => {
    const root = fakeRoot({ funding: 60, "metrics-1h": 60 });
    process.env.COLLECT_DIR = root;

    expect(() => assertDataSources()).not.toThrow();
    const health = dataSourceHealth();
    expect(health.every((h) => h.ok)).toBe(true);
    expect(health.map((h) => h.name).sort()).toEqual(["funding", "metrics-1h"]);
    rmSync(root, { recursive: true, force: true });
  });

  it("здоровье источников доступно числами — для статуса и панели экрана", () => {
    const root = fakeRoot({ funding: 60, "metrics-1h": 7 });
    process.env.COLLECT_DIR = root;

    const health = dataSourceHealth();
    const byName = Object.fromEntries(health.map((h) => [h.name, h]));
    expect(byName.funding.ok).toBe(true);
    expect(byName.funding.files).toBe(60);
    expect(byName["metrics-1h"].ok).toBe(false);
    expect(byName["metrics-1h"].files).toBe(7);
    rmSync(root, { recursive: true, force: true });
  });
});
