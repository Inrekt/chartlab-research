import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Модуль с `main()` обязан запускать его ТОЛЬКО как точка входа.
 *
 * Дважды за день это стоило дорого. `collect-candles.ts` при импорте запускал
 * полный сбор корпуса — сеть, минуты, запись в чужой каталог; на этом повис
 * тест. `nightly.ts` при импорте запускал ПОЛНУЮ НОЧЬ, и именно поэтому у
 * дайджеста не было теста: его нельзя было написать, не прогнав ночь.
 *
 * Разовая ревизия такое не удержит — новый скрипт появится и повторит. Здесь
 * правило проверяется само.
 */
const dir = dirname(fileURLToPath(import.meta.url));

const GUARDS = [
  "import.meta.url ===", // сравнение с точкой входа
  "process.argv[1]?.endsWith(", // старая форма, тоже корректна
];

describe("точки входа не запускаются при импорте", () => {
  test("каждый модуль с main() проверяет, что запущен напрямую", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const text = readFileSync(join(dir, file), "utf8");
      const hasMain = /\b(async )?function main\s*\(/.test(text);
      if (!hasMain) continue;
      // Вызов main() должен существовать и быть под защитой.
      const calls = /\bmain\(\)/.test(text);
      if (!calls) continue;
      if (!GUARDS.some((g) => text.includes(g))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test("правило поймало бы оба реальных случая", () => {
    // Проверка самой проверки: без неё тест был бы всегда зелёным и ничего не
    // сторожил. Воспроизводим форму, которая была в nightly.ts до починки.
    const broken = "async function main(): Promise<void> {}\nawait main();\n";
    expect(GUARDS.some((g) => broken.includes(g))).toBe(false);

    const fixed =
      "async function main(): Promise<void> {}\n" +
      'if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) { await main(); }\n';
    expect(GUARDS.some((g) => fixed.includes(g))).toBe(true);
  });
});
