/**
 * Предполётная проверка источников данных.
 *
 * Существует из-за конкретной аварии: `COLLECT_DIR` был задан только в
 * collect.yml, а в nightly.yml и hourly.yml забыт. На раннере каталога с
 * фандингом не оказалось, `readFundingCsv` честно возвращал `null` на каждый
 * символ, атом `funding` честно давал `false` на каждом баре — и семейство
 * funding_pressure получило 212 испытаний со 100% нуля сделок. В журнал это
 * записалось как «правило не даёт сделок», то есть как ВЫВОД О РЫНКЕ.
 *
 * Ошибка инфраструктуры, замаскированная под результат исследования, — худший
 * вид поломки: она не роняет тесты, не пишет в лог ничего тревожного и молча
 * поднимает планку дефляции всем остальным семействам. Поэтому здесь ровно
 * одно правило: отсутствие ИСТОЧНИКА (каталога) — это падение прогона, а не
 * отсутствие данных у символа.
 *
 * Разница принципиальная:
 *   нет файла у одного символа  → у символа нет истории, сделок не будет, ок;
 *   нет каталога / он пуст      → мы не измеряем то, что думаем, что измеряем.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Корень собранных данных — тот же дефолт, что у читателей CSV. */
export function collectRoot(): string {
  return process.env.COLLECT_DIR ?? join(process.env.HOME ?? "", ".chartlab", "data-repo", "market");
}

export interface SourceHealth {
  name: string;
  dir: string;
  exists: boolean;
  /** Число CSV-файлов; 0 при отсутствующем каталоге. */
  files: number;
  /** Сколько файлов делает источник пригодным. */
  required: number;
  ok: boolean;
}

/**
 * Источники, от которых зависят условия сетапов. Пороги умышленно низкие:
 * задача — отличить «источника нет» от «источник есть», а не сторожить
 * полноту (полнота — забота канарейки свежести).
 */
const SOURCES: ReadonlyArray<{ name: string; sub: string; required: number }> = [
  { name: "funding", sub: "funding", required: 50 },
  { name: "metrics-1h", sub: "metrics-1h", required: 50 },
];

function countCsv(dir: string): number {
  if (!existsSync(dir)) return 0;
  try {
    // .csv.gz — то, что лежит в репозитории; .csv — то, что оставляет бэкфилл
    // локально. Считаем оба, иначе предохранитель заругался бы на здоровое
    // окружение просто из-за формата хранения.
    return readdirSync(dir).filter((f) => f.endsWith(".csv") || f.endsWith(".csv.gz")).length;
  } catch {
    return 0;
  }
}

/** Состояние всех источников — для отчёта, статуса и панели экрана. */
export function dataSourceHealth(): SourceHealth[] {
  const root = collectRoot();
  return SOURCES.map(({ name, sub, required }) => {
    const dir = join(root, sub);
    const files = countCsv(dir);
    return { name, dir, exists: existsSync(dir), files, required, ok: files >= required };
  });
}

/**
 * Падает, если хоть один источник недоступен. Вызывать в НАЧАЛЕ прогона:
 * секунда проверки против ночи испытаний, записанных в журнал как выводы.
 *
 * `process.exit` здесь неуместен — бросаем, чтобы вызывающий мог решить
 * (тесты и разовые утилиты имеют право работать без собранных данных).
 */
export function assertDataSources(): void {
  const health = dataSourceHealth();
  const broken = health.filter((h) => !h.ok);
  if (broken.length === 0) return;

  const lines = broken.map(
    (h) =>
      `  ${h.name}: ${h.exists ? `каталог есть, но CSV ${h.files} < ${h.required}` : "КАТАЛОГА НЕТ"} — ${h.dir}`,
  );
  throw new Error(
    [
      "Предполётная проверка: источники данных недоступны.",
      ...lines,
      "",
      `COLLECT_DIR = ${process.env.COLLECT_DIR ?? "(не задан, взят дефолт ~/.chartlab/data-repo/market)"}`,
      "",
      "Прогон ОСТАНОВЛЕН намеренно. Испытания без источника дали бы ноль сделок,",
      "и это записалось бы в журнал как вывод о рынке, а не как поломка окружения.",
      "Проверь COLLECT_DIR в воркфлоу и что приватный data-репо смонтирован.",
    ].join("\n"),
  );
}
