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

describe("карантин снимает ОБА исключения, а не одно", () => {
  test("после карантина правило проходит и поведенческий дедуп", async () => {
    /*
     * Исключений два и они независимы: по id и по ПОВЕДЕНИЮ (правило × корпус).
     * Карантин был реализован только в первом — и этого достаточно, чтобы вся
     * операция стала бесполезной: сэмплер отсеял бы те же правила вторым, а
     * предпросмотр при этом обещал бы освобождение, которого не произойдёт.
     * Необратимая операция отчиталась бы об успехе, не сделав ничего.
     *
     * Прецедент дословно тот же был с неизмеренными испытаниями: первая правка
     * учла только id, семейство владельца осталось заблокированным, и это
     * выяснилось лишь следующим прогоном.
     */
    const { behavioralExclusionFor, markEpoch } = await import("./epochs.ts");
    const { behavioralId } = await import("./grammar.ts");
    const dbPath = freshDb();
    const ledger = new TrialLedger(dbPath, { now: () => "2026-08-09T21:37:00.000Z" });
    const specs = sampleCandidates(11, 4, undefined, { tf: "4h" });
    ledger.registerCandidates(specs);
    const rows = ledger.byState("CANDIDATE");
    for (const r of rows) ledger.recordEval(r.candidateId, "halving_16", { trades: 9 });
    const family = ledger.getTrial(rows[0]!.candidateId)!.setupFamily;
    ledger.close();
    // Как в бою: без отметки эпохи-2 записи читаются как эпоха-1, и ТФ
    // восстанавливается по порядку партий, а не по метке спека.
    markEpoch(dbPath, () => "2026-08-09T00:00:00.000Z");

    const blockedBefore = behavioralExclusionFor(dbPath, "4h");
    const someSpec = specs.find((sp) => blockedBefore.has(behavioralId(sp)));
    expect(someSpec, "хоть одно правило должно быть заблокировано до карантина").toBeDefined();

    const l2 = new TrialLedger(dbPath, { now: () => "2026-08-09T22:00:00.000Z" });
    l2.quarantineEpoch(family, "2026-08-09", "2026-08-09", "прибор был сломан");
    l2.close();

    const blockedAfter = behavioralExclusionFor(dbPath, "4h");
    // Правила семейства под карантином больше не блокируют повтор.
    const stillBlocked = specs.filter(
      (sp) => blockedAfter.has(behavioralId(sp)) && !blockedBefore.has(behavioralId(sp)),
    );
    expect(stillBlocked).toHaveLength(0);
    expect(blockedAfter.size).toBeLessThan(blockedBefore.size);
  });
});

describe("возврат состояния (дефект боевой ночи 2026-08-18)", () => {
  /*
   * Карантин снимал испытания с исключений сэмплера, но НЕ возвращал их
   * состояние. Сэмплер честно выдавал их снова, скрин доходил до вердикта и
   * падал на «запрещённый переход REJECTED → REJECTED»: REJECTED терминален.
   * Ночь уходила красной, комбинации оставались непроверенными — карантин
   * освобождал их только наполовину. Поймано первой же настоящей ночью после
   * первого в истории применения карантина.
   */
  const rejectedLedger = () => {
    const ledger = new TrialLedger(freshDb(), { now: () => "2026-08-09T21:37:00.000Z" });
    ledger.registerCandidates(sampleCandidates(7, 5, undefined, { tf: "4h" }));
    const rows = ledger.byState("CANDIDATE");
    const family = ledger.getTrial(rows[0]!.candidateId)!.setupFamily;
    const mine = rows.filter((r) => ledger.getTrial(r.candidateId)!.setupFamily === family);
    for (const r of mine) {
      ledger.recordEval(r.candidateId, "halving_16", { trades: 0 });
      ledger.transition(r.candidateId, "REJECTED", "нуль сделок");
    }
    return { ledger, family, mine };
  };

  test("после карантина испытание снова CANDIDATE и его можно прогнать заново", () => {
    const { ledger, family, mine } = rejectedLedger();
    ledger.quarantineEpoch(family, "2026-08-09", "2026-08-09", "источник данных отсутствовал");

    for (const r of mine) {
      expect(ledger.getTrial(r.candidateId)!.state, r.candidateId).toBe("CANDIDATE");
    }
    // Главное: повторный вердикт больше не падает.
    expect(() => ledger.transition(mine[0]!.candidateId, "REJECTED", "перемер")).not.toThrow();
    ledger.close();
  });

  test("возврат записан переходом с причиной — история не теряется", () => {
    const { ledger, family, mine } = rejectedLedger();
    ledger.quarantineEpoch(family, "2026-08-09", "2026-08-09", "источник данных отсутствовал");
    const back = ledger
      .transitionsFor(mine[0]!.candidateId)
      .filter((t) => t.toState === "CANDIDATE");
    expect(back).toHaveLength(1);
    expect(back[0].fromState).toBe("REJECTED");
    expect(back[0].reason).toMatch(/карантин/);
    // Прежний вердикт остаётся на месте: журнал append-only.
    expect(ledger.transitionsFor(mine[0]!.candidateId).some((t) => t.toState === "REJECTED")).toBe(true);
    ledger.close();
  });

  test("испытания вне окна карантина состояние НЕ меняют", () => {
    const { ledger, family, mine } = rejectedLedger();
    ledger.quarantineEpoch(family, "2026-08-01", "2026-08-02", "чужое окно");
    for (const r of mine) {
      expect(ledger.getTrial(r.candidateId)!.state).toBe("REJECTED");
    }
    ledger.close();
  });
});
