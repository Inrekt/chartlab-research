import { describe, expect, test, vi } from "vitest";
import { runScreensResilient } from "./nightly.ts";
import { SpaceExhaustedError } from "./screen.ts";
import type { ScreenSummary } from "./screen.ts";
import type { SignalTf } from "./grammar.ts";

/*
 * Регрессия против бага «исчерпание одной вселенной убивает всю ночь».
 *
 * Раньше цикл по таймфреймам звал runScreen напрямую, и первый же
 * SpaceExhaustedError (несемплированных кандидатов не осталось) ронял main()
 * ЦЕЛИКОМ: не запускались ни вторая вселенная — со своим независимым
 * пространством, — ни инкубатор с надзором, которым новая партия не нужна
 * вовсе. Форвард-тест уже отобранных стратегий связывался с генератором новых
 * гипотез одним нехваченным исключением.
 *
 * runScreensResilient обязан ловить ИМЕННО исчерпание и продолжать; любую
 * другую ошибку — пробрасывать, иначе баг кода утонет молча.
 */
const fakeSummary = (tf: SignalTf): ScreenSummary =>
  ({ tf, validated: [], stages: {} }) as unknown as ScreenSummary;

describe("устойчивость ночи к исчерпанию вселенной", () => {
  test("исчерпание ПЕРВОЙ вселенной не мешает второй отработать", () => {
    const log = vi.fn();
    const { screens, exhaustedTfs } = runScreensResilient(
      ["1h", "4h"] as SignalTf[],
      (tf) => {
        if (tf === "1h") throw new SpaceExhaustedError("нет несемплированных кандидатов");
        return fakeSummary(tf);
      },
      log,
    );
    // Вторая вселенная обязана быть отработана, первая — помечена исчерпанной.
    expect(screens.map((s) => s.tf)).toEqual(["4h"]);
    expect(exhaustedTfs).toEqual(["1h"]);
  });

  test("обе исчерпаны — не бросок, а пустой результат (ночь состоится дальше)", () => {
    const { screens, exhaustedTfs } = runScreensResilient(
      ["1h", "4h"] as SignalTf[],
      () => {
        throw new SpaceExhaustedError("исчерпано");
      },
      vi.fn(),
    );
    // Пустой screens — сигнал main() показать баннер и всё равно запустить
    // инкубатор/надзор. Бросок здесь означал бы ту самую регрессию.
    expect(screens).toEqual([]);
    expect(exhaustedTfs).toEqual(["1h", "4h"]);
  });

  test("ЛЮБАЯ другая ошибка пробрасывается — баг кода не глотается", () => {
    // Исчерпание — штатное состояние; TypeError, битые данные, ошибка БД —
    // это поломка, которую обязан увидеть внешний обработчик, а не тишина.
    expect(() =>
      runScreensResilient(
        ["1h"] as SignalTf[],
        () => {
          throw new TypeError("настоящий баг");
        },
        vi.fn(),
      ),
    ).toThrow(TypeError);
  });

  test("ни одна не исчерпана — обе в результате, помеченных нет", () => {
    const { screens, exhaustedTfs } = runScreensResilient(
      ["1h", "4h"] as SignalTf[],
      (tf) => fakeSummary(tf),
      vi.fn(),
    );
    expect(screens.map((s) => s.tf)).toEqual(["1h", "4h"]);
    expect(exhaustedTfs).toEqual([]);
  });
});
