import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertDataSources, dataSourceHealth } from "./preflight.ts";

const original = process.env.COLLECT_DIR;
const originalHistory = process.env.RESEARCHER_HISTORY_DIR;

afterEach(() => {
  if (original === undefined) delete process.env.COLLECT_DIR;
  else process.env.COLLECT_DIR = original;
  if (originalHistory === undefined) delete process.env.RESEARCHER_HISTORY_DIR;
  else process.env.RESEARCHER_HISTORY_DIR = originalHistory;
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

/**
 * Каталог корпуса с N файлами свечей. Тесты обязаны задавать его явно: иначе
 * они мерили бы рабочую копию разработчика и падали бы у того, кто корпус ещё
 * не скачал.
 */
function fakeCorpus(n: number): string {
  const dir = mkdtempSync(join(tmpdir(), "preflight-corpus-"));
  for (let i = 0; i < n; i++) writeFileSync(join(dir, `SYM${i}_1h.json.gz`), "");
  process.env.RESEARCHER_HISTORY_DIR = dir;
  return dir;
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

    expect(() => assertDataSources()).toThrow(/файлов 3 < 50/);
    rmSync(root, { recursive: true, force: true });
  });

  it("полный комплект источников проходит молча", () => {
    const root = fakeRoot({ funding: 60, "metrics-1h": 60 });
    process.env.COLLECT_DIR = root;
    const corpus = fakeCorpus(120);

    expect(() => assertDataSources()).not.toThrow();
    const health = dataSourceHealth();
    expect(health.every((h) => h.ok)).toBe(true);
    expect(health.map((h) => h.name).sort()).toEqual([
      "funding",
      "metrics-1h",
      "корпус свечей",
    ]);
    rmSync(root, { recursive: true, force: true });
    rmSync(corpus, { recursive: true, force: true });
  });

  it("пустой кэш корпуса роняет прогон — это ровно та авария, что молчала две недели", () => {
    // В облаке корпус живёт в кэше раннера, а не в git. Промах ключа кэша или
    // упавшая дозакачка дают ПУСТОЙ каталог — и ночь честно прогоняет тысячи
    // испытаний, каждое с нулём сделок, записывая это в журнал как вывод о
    // рынке. Проверка обязана отличать «кэша нет» от «рынок молчит».
    const root = fakeRoot({ funding: 60, "metrics-1h": 60 });
    process.env.COLLECT_DIR = root;
    const corpus = fakeCorpus(0);

    expect(() => assertDataSources()).toThrow(/корпус свечей/);
    expect(() => assertDataSources()).toThrow(/RESEARCHER_HISTORY_DIR/);
    rmSync(root, { recursive: true, force: true });
    rmSync(corpus, { recursive: true, force: true });
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
