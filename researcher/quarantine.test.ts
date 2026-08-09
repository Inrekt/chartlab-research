import { describe, expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrialLedger, normalizeWindow } from "./ledger.ts";
import { sampleCandidates } from "./grammar.ts";

/*
 * Карантин — единственная НЕОБРАТИМАЯ операция, которую владелец запускает
 * руками, и до этого файла она не была покрыта ничем.
 *
 * Найденный дефект стоит описать целиком, потому что он тихий вдвойне.
 * `created_at` хранится полным ISO, сравнение в SQLite строковое, и граница
 * `to = "2026-08-09"` отсекала ВЕСЬ день 9 августа: у равного префикса более
 * длинная строка больше. Проверено на боевом журнале — все 432 испытания
 * свипа созданы 9 августа, то есть команда карантина этих семейств поймала бы
 * НОЛЬ, отчиталась об успехе, и владелец считал бы комбинации освобождёнными.
 */
const freshDb = () => join(mkdtempSync(join(tmpdir(), "qr-")), "t.sqlite");

/** Журнал с испытаниями, созданными в заданный момент. */
function ledgerAt(iso: string, n = 5): { ledger: TrialLedger; family: string } {
  const ledger = new TrialLedger(freshDb(), { now: () => iso });
  const specs = sampleCandidates(7, n, undefined, { tf: "4h" });
  ledger.registerCandidates(specs);
  const family = ledger.byState("CANDIDATE").length > 0 ? "" : "";
  return { ledger, family };
}

describe("границы окна карантина", () => {
  test("голая дата означает ВЕСЬ день — иначе последний день молча выпадает", () => {
    expect(normalizeWindow("2026-08-04", "2026-08-08")).toEqual([
      "2026-08-04T00:00:00.000Z",
      "2026-08-08T23:59:59.999Z",
    ]);
  });

  test("полный ISO не трогается: явная граница остаётся явной", () => {
    // Если кто-то указал время до миллисекунды, он знает, что делает, и
    // «дополнять» его границу значило бы менять смысл команды.
    expect(normalizeWindow("2026-08-04T12:00:00.000Z", "2026-08-08T18:30:00.000Z")).toEqual([
      "2026-08-04T12:00:00.000Z",
      "2026-08-08T18:30:00.000Z",
    ]);
  });

  test("однодневное окно ловит испытания этого дня", () => {
    // Ровно тот случай, который был сломан: все 432 испытания свипа созданы в
    // один день, и старая граница не ловила ни одного.
    const { ledger } = ledgerAt("2026-08-09T21:37:00.000Z", 4);
    const rows = ledger.byState("CANDIDATE");
    const family = ledger.getTrial(rows[0]!.candidateId)!.setupFamily;
    const preview = ledger.quarantinePreview(family, "2026-08-09", "2026-08-09");
    expect(preview.affected).toBeGreaterThan(0);
    ledger.close();
  });
});

describe("предпросмотр карантина", () => {
  test("показывает ПОСЛЕДСТВИЯ, а не текущее состояние журнала", () => {
    // Сухой прогон печатал «сколько сейчас в журнале» — то есть не отвечал на
    // единственный вопрос, ради которого нужен, и необратимая операция
    // запускалась вслепую.
    const { ledger } = ledgerAt("2026-08-09T21:37:00.000Z", 6);
    const rows = ledger.byState("CANDIDATE");
    const family = ledger.getTrial(rows[0]!.candidateId)!.setupFamily;
    // Испытание закрывает комбинацию только ПОСЛЕ оценки — без неё оно и так
    // свободно, и освобождать карантину нечего (см. соседний тест).
    for (const r of rows) ledger.recordEval(r.candidateId, "halving_16", { trades: 12 });
    const inFamily = rows.filter(
      (r) => ledger.getTrial(r.candidateId)!.setupFamily === family,
    ).length;

    const preview = ledger.quarantinePreview(family, "2026-08-09", "2026-08-09");
    expect(preview.affected).toBe(inFamily);
    expect(preview.freed).toBe(inFamily); // все ещё закрывают комбинации
    expect(preview.alreadyFree).toBe(0);
    ledger.close();
  });

  test("НЕИЗМЕРЕННЫМ испытаниям карантин не нужен — они уже свободны", () => {
    // Взаимодействие двух механизмов, которое легко прочитать наоборот.
    // Испытание без единой оценки не закрывает комбинацию (упавшая ночь не
    // сжигает партию), поэтому карантин такого окна освобождает НОЛЬ — и это
    // не промах по датам, а отсутствие работы. Различать эти два нуля
    // обязательно: первый означает опечатку, второй — что чинить нечего.
    const { ledger } = ledgerAt("2026-08-09T21:37:00.000Z", 5);
    const family = ledger.getTrial(ledger.byState("CANDIDATE")[0]!.candidateId)!.setupFamily;
    const preview = ledger.quarantinePreview(family, "2026-08-09", "2026-08-09");
    expect(preview.affected).toBeGreaterThan(0); // испытания под окно попали
    expect(preview.freed).toBe(0); // но освобождать нечего
    expect(preview.alreadyFree).toBe(preview.affected);
    ledger.close();
  });

  test("предпросмотр НИЧЕГО не пишет", () => {
    // Это его единственное обещание: посмотреть до того, как решиться.
    const { ledger } = ledgerAt("2026-08-09T21:37:00.000Z", 3);
    const family = ledger.getTrial(ledger.byState("CANDIDATE")[0]!.candidateId)!.setupFamily;
    const before = ledger.quarantines().length;
    ledger.quarantinePreview(family, "2026-08-09", "2026-08-09");
    expect(ledger.quarantines()).toHaveLength(before);
    ledger.close();
  });

  test("промах по датам виден как НОЛЬ, а не как успех", () => {
    // Пустой карантин почти всегда опечатка. Раньше он записывался молча и
    // выглядел выполненным.
    const { ledger } = ledgerAt("2026-08-09T21:37:00.000Z", 3);
    const family = ledger.getTrial(ledger.byState("CANDIDATE")[0]!.candidateId)!.setupFamily;
    expect(ledger.quarantinePreview(family, "2026-01-01", "2026-01-31").affected).toBe(0);
    expect(ledger.quarantinePreview("нет_такого_семейства", "2026-08-09", "2026-08-09").affected)
      .toBe(0);
    ledger.close();
  });

  test("после применения предпросмотр показывает «уже свободны»", () => {
    // Повторный карантин того же окна не должен выглядеть как новая работа.
    const { ledger } = ledgerAt("2026-08-09T21:37:00.000Z", 4);
    const family = ledger.getTrial(ledger.byState("CANDIDATE")[0]!.candidateId)!.setupFamily;
    ledger.quarantineEpoch(family, "2026-08-09", "2026-08-09", "тест");
    const after = ledger.quarantinePreview(family, "2026-08-09", "2026-08-09");
    expect(after.freed).toBe(0);
    expect(after.alreadyFree).toBe(after.affected);
    ledger.close();
  });
});
