/**
 * Калибровка ворот по журналу: заявленный уровень против фактического.
 *
 * Все девять ворот объявляют пороги, но НИКТО никогда не спрашивал, какой
 * уровень они дают на самом деле. Между «порог t ≥ 2.6» и «через эти ворота
 * проходит 0.47%» лежит предположение о том, что тестовая статистика
 * распределена так, как думает автор порога. Это предположение проверяемо, и
 * данные для проверки уже лежат в журнале — 56 374 испытания.
 *
 * Отдельно и важнее всего — ПРОВЕРКА СИММЕТРИИ для ворот нуль-модели. Она не
 * требует знать, есть ли у кандидатов край, и потому не зависит ни от каких
 * допущений о рынке: разностный тест «кандидат минус базлайн с тем же
 * расписанием» под нулевой гипотезой обязан давать отрицательный t примерно в
 * половине случаев. Если отрицательных нет вовсе — базлайн систематически
 * слабее кандидата, и ворота меряют не то, что написано на вывеске.
 *
 * Запуск: npx tsx researcher/gate-calibration.ts
 */
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { DB_PATH } from "./paths.ts";

/**
 * Номинальный уровень ворот: какая доля прошла бы ПОД НУЛЕВОЙ ГИПОТЕЗОЙ.
 * `null` — у ворот нет вероятностной интерпретации (они про достаточность
 * данных, а не про значимость), и сравнивать их долю не с чем.
 */
const NOMINAL: Record<string, { level: number | null; why: string }> = {
  gate_activity: { level: null, why: "порог достаточности данных, не значимость" },
  gate_breadth: { level: null, why: "доля прибыльных символов, порог не вероятностный" },
  gate_cost_stress: { level: null, why: "выживание при удвоенных издержках" },
  gate_plateau: { level: null, why: "устойчивость по соседям, не значимость" },
  gate_null: { level: 0.0047, why: "t ≥ 2.6 односторонний при t ~ N(0,1)" },
  gate_fdr: { level: 0.1, why: "BH при q = 0.10" },
  gate_temporal: { level: null, why: "счётный критерий по годам" },
  gate_dsr: { level: 0.05, why: "DSR ≥ 0.95" },
  gate_wilson: { level: null, why: "нижняя граница интервала выше безубытка" },
  gate_oot: { level: 0.0047, why: "тот же разностный тест на отложенном годе" },
};

export interface GateCalibration {
  gate: string;
  reached: number;
  passed: number;
  actual: number;
  nominal: number | null;
  /** Во сколько раз ворота мягче заявленного. `null` — сравнивать не с чем. */
  inflation: number | null;
  note: string;
}

export function calibrateGates(db: DatabaseSync): GateCalibration[] {
  const rows = db
    .prepare(
      `SELECT stage,
              COUNT(*) AS reached,
              SUM(CASE WHEN json_extract(metrics_json,'$.pass') = 1 THEN 1 ELSE 0 END) AS passed
         FROM evals WHERE stage LIKE 'gate_%' GROUP BY stage`,
    )
    .all() as { stage: string; reached: number; passed: number }[];

  return rows
    .map((r) => {
      const spec = NOMINAL[r.stage] ?? { level: null, why: "неизвестные ворота" };
      const actual = r.reached > 0 ? r.passed / r.reached : NaN;
      return {
        gate: r.stage,
        reached: r.reached,
        passed: r.passed,
        actual,
        nominal: spec.level,
        inflation: spec.level && spec.level > 0 ? actual / spec.level : null,
        note: spec.why,
      };
    })
    .sort((a, b) => b.reached - a.reached);
}

export interface SymmetryCheck {
  /** Сколько значений t удалось восстановить. */
  sampled: number;
  negativeShare: number;
  min: number;
  median: number;
  /** Почему выборка усечена и в какую сторону это смещает вывод. */
  truncation: string;
}

/**
 * Проверка симметрии разностного теста нуль-модели.
 *
 * ⚠️ Значения `t` восстанавливаются из ТЕКСТА причины отказа, потому что в
 * метрики они не пишутся. Значит выборка — только ОТВЕРГНУТЫЕ, то есть хвост
 * t < 2.6. Смещение от этого идёт В ПОЛЬЗУ отрицательных: если где-то и есть
 * кандидаты хуже своего базлайна, они обязаны быть именно здесь. Отсутствие
 * отрицательных в НИЖНЕМ хвосте опровергнуть усечением нельзя.
 */
export function nullSymmetry(db: DatabaseSync): SymmetryCheck {
  const rows = db
    .prepare(
      "SELECT reason FROM transitions WHERE to_state = 'REJECTED' AND reason LIKE 'нуль-модель: t=%'",
    )
    .all() as { reason: string }[];

  const ts: number[] = [];
  for (const { reason } of rows) {
    const m = /t=(-?[0-9.]+)/.exec(reason);
    if (m) ts.push(Number(m[1]));
  }
  ts.sort((a, b) => a - b);
  const n = ts.length;
  return {
    sampled: n,
    negativeShare: n > 0 ? ts.filter((t) => t < 0).length / n : NaN,
    min: ts[0] ?? NaN,
    median: ts[Math.floor(n / 2)] ?? NaN,
    truncation:
      "только отвергнутые (t < 2.6); усечение сверху, то есть В ПОЛЬЗУ отрицательных",
  };
}

async function main(): Promise<void> {
  const db = new DatabaseSync(process.env.RESEARCHER_DB_PATH ?? DB_PATH, { readOnly: true });
  try {
    const gates = calibrateGates(db);
    console.error("ворота                дошло   прошло   факт     номинал  мягче в");
    for (const g of gates) {
      console.error(
        [
          g.gate.padEnd(20),
          String(g.reached).padStart(6),
          String(g.passed).padStart(8),
          `${(g.actual * 100).toFixed(1)}%`.padStart(8),
          (g.nominal === null ? "—" : `${(g.nominal * 100).toFixed(2)}%`).padStart(9),
          (g.inflation === null ? "—" : `${g.inflation.toFixed(0)}×`).padStart(8),
        ].join(""),
      );
    }

    const sym = nullSymmetry(db);
    console.error("\n── проверка симметрии нуль-модели (не зависит от наличия края) ──");
    console.error(
      `восстановлено t: ${sym.sampled}, min ${sym.min.toFixed(2)}, медиана ${sym.median.toFixed(2)}`,
    );
    console.error(
      `доля t < 0: ${(sym.negativeShare * 100).toFixed(1)}%  ` +
        `(корректный разностный тест дал бы ≈50%)`,
    );
    console.error(`выборка: ${sym.truncation}`);
    if (sym.sampled > 100 && sym.negativeShare < 0.1) {
      console.error(
        "\n🚨 Базлайн систематически слабее кандидата. Ворота меряют не «бьёт ли\n" +
          "правило случайные входы», а что-то со сдвигом. Доля прохождения выше\n" +
          "номинала следует отсюда, а не из наличия края.",
      );
    }

    console.log(JSON.stringify({ gates, nullSymmetry: sym }, null, 2));
  } finally {
    db.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
