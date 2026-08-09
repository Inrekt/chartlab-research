import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertDataSources, corpusFreshnessVerdict, dataSourceHealth } from "./preflight.ts";

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
function fakeCorpus(n: number, lastIso?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "preflight-corpus-"));
  for (let i = 0; i < n; i++) writeFileSync(join(dir, `SYM${i}_1h.json.gz`), "");
  if (lastIso) {
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        source: "perp",
        symbols: n,
        coverage: [{ symbol: "BTCUSDT", tf: "1h", firstIso: "2019-09-08T00:00:00.000Z", lastIso }],
      }),
    );
  }
  process.env.RESEARCHER_HISTORY_DIR = dir;
  return dir;
}

/** ISO-время «N суток назад» от фиксированной точки отсчёта тестов. */
const NOW = Date.parse("2026-08-09T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

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
    // С манифестом: явно заданный корпус без него теперь не проходит вовсе —
    // рынок обязан быть установлен, а не предположен.
    const corpus = fakeCorpus(120, daysAgo(1));

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

  it("свежесть меряется по манифесту, а не по mtime файлов", () => {
    // mtime подделывается любым git checkout и восстановлением кэша — то есть
    // врал бы «свежо» ровно в той ситуации, ради которой проверка написана.
    const corpus = fakeCorpus(120, daysAgo(1));
    expect(corpusFreshnessVerdict(NOW).level).toBe("ok");
    rmSync(corpus, { recursive: true, force: true });

    const stale = fakeCorpus(120, daysAgo(5));
    const warn = corpusFreshnessVerdict(NOW);
    expect(warn.level).toBe("warn");
    expect(warn.ageDays).toBeCloseTo(5, 1);
    rmSync(stale, { recursive: true, force: true });

    const dead = fakeCorpus(120, daysAgo(20));
    expect(corpusFreshnessVerdict(NOW).level).toBe("fail");
    rmSync(dead, { recursive: true, force: true });
  });

  it("корпус без манифеста не считается ни свежим, ни просроченным", () => {
    // Честный ответ «не знаю» лучше выдуманного вердикта: счётчик файлов уже
    // отвечает на вопрос «корпус вообще есть», а свежесть без манифеста
    // измерить нечем.
    const corpus = fakeCorpus(120);
    expect(corpusFreshnessVerdict(NOW).level).toBe("unknown");
    rmSync(corpus, { recursive: true, force: true });
  });

  it("двухнедельная просроченность роняет ночь, хотя все файлы на месте", () => {
    // Ровно та авария, которую счётчик файлов не ловит по построению: корпус
    // простоял две недели, файлов столько же, никто не заметил.
    const root = fakeRoot({ funding: 60, "metrics-1h": 60 });
    process.env.COLLECT_DIR = root;
    const corpus = fakeCorpus(120, "2020-01-01T00:00:00.000Z");

    expect(() => assertDataSources()).toThrow(/просрочен/);
    expect(() => assertDataSources()).toThrow(/форвард измерял бы не то, что отбор/);
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

describe("требования различаются по точкам входа", () => {
  it("часовой тик не падает из-за корпуса — он его не читает", () => {
    // Инкубатор и надзор тянут живые бары с биржи. Требовать от тика 100
    // файлов значит на холодном кэше качать корпус впустую внутри
    // 20-минутного джоба, а при просроченном корпусе — вставать без причины.
    const root = fakeRoot({ funding: 60, "metrics-1h": 60 });
    process.env.COLLECT_DIR = root;
    const corpus = fakeCorpus(0, "2020-01-01T00:00:00.000Z");

    expect(() => assertDataSources()).toThrow();
    expect(() => assertDataSources({ requireCorpusFiles: false })).not.toThrow();

    rmSync(root, { recursive: true, force: true });
    rmSync(corpus, { recursive: true, force: true });
  });

  it("явно указанный корпус без манифеста роняет ОБЕ точки входа", () => {
    // Рынок обязан быть установлен, а не предположен: спот и перпы дают разные
    // цены, и молчаливый дефолт развёл бы скрин с инкубатором. Проверка бьёт
    // именно по явно заданному каталогу — легаси-корпус в public/data/history
    // манифеста не имеет законно и доказанно спотовый.
    const root = fakeRoot({ funding: 60, "metrics-1h": 60 });
    process.env.COLLECT_DIR = root;
    const corpus = fakeCorpus(120); // файлы есть, манифеста нет

    expect(() => assertDataSources()).toThrow(/рынок корпуса неизвестен/);
    expect(() => assertDataSources({ requireCorpusFiles: false })).toThrow(
      /рынок корпуса неизвестен/,
    );

    rmSync(root, { recursive: true, force: true });
    rmSync(corpus, { recursive: true, force: true });
  });
});

describe("каталога корпуса нет вовсе — облачный промах кэша", () => {
  it("часовой тик не падает: он корпус не читает", () => {
    // Воспроизводит аварию 2026-08-09T02:23Z. `actions/cache/restore` на
    // промахе кэша каталога НЕ СОЗДАЁТ, и readdirSync бросал ENOENT из
    // запасной ветки corpusVersion — то есть ИЗ БЛОКА catch, который и должен
    // был это ловить. Тик упал из-за корпуса, который ему не нужен.
    const root = fakeRoot({ funding: 60, "metrics-1h": 60 });
    process.env.COLLECT_DIR = root;
    const gone = mkdtempSync(join(tmpdir(), "preflight-gone-"));
    rmSync(gone, { recursive: true, force: true });
    process.env.RESEARCHER_HISTORY_DIR = gone;

    expect(() => assertDataSources({ requireCorpusFiles: false })).not.toThrow();
    // А ночь обязана упасть: она по корпусу СЧИТАЕТ.
    expect(() => assertDataSources()).toThrow(/корпус свечей/);

    rmSync(root, { recursive: true, force: true });
  });

  it("версия корпуса отвечает всегда — «не знаю» это тоже ответ", async () => {
    // Контракт: функция, описывающая происхождение данных, НЕ БРОСАЕТ никогда.
    // Именно исключение отсюда и уронило тик. Конкретная метка вторична —
    // важно, что вызывающий получает ответ и видит ноль символов.
    const gone = mkdtempSync(join(tmpdir(), "corpus-gone-"));
    rmSync(gone, { recursive: true, force: true });
    const { corpusVersion, listUniverse } = await import("./corpus.ts");
    expect(() => corpusVersion(gone)).not.toThrow();
    expect(corpusVersion(gone)).toContain(":0:");
    expect(listUniverse("1h", gone)).toEqual([]);
  });
});
