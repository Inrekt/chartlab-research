/**
 * Ежечасный тик — догонка инкубатора и надзора на свежих закрытых барах.
 * Дёшев (секунды сети + движка); если Mac спал — следующий тик догонит,
 * честность обеспечена заморозкой правил, а не непрерывностью работы.
 */
import { join } from "node:path";
import { runIncubation } from "./incubate.ts";
import { writeStatus } from "./statusFile.ts";
import { DB_PATH, DEFAULT_VAULT_DIR } from "./paths.ts";
import { assertDataSources } from "./preflight.ts";
import { runSupervision } from "./supervise.ts";

// Инкубатор гоняет тот же движок, что и ночь. Без источников кандидат набирал
// бы ноль форвард-сделок и умер бы «по календарю» через 365 дней — с виду
// честная смерть, на деле потерянный год.
assertDataSources();

const cardsDir = join(DEFAULT_VAULT_DIR, "Карточки");
const log = (m: string) => console.error(m);
const incubation = await runIncubation({ dbPath: DB_PATH, vaultCardsDir: cardsDir, log });
const supervision = await runSupervision({ dbPath: DB_PATH, vaultCardsDir: cardsDir, log });
// screens: [] ⇒ воронка последней ночи переносится из предыдущего статуса.
writeStatus({ screens: [], incubation, supervision });
console.log(JSON.stringify({ at: new Date().toISOString(), incubation, supervision }));
