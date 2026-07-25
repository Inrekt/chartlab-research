/**
 * Ежечасный тик — догонка инкубатора и надзора на свежих закрытых барах.
 * Дёшев (секунды сети + движка); если Mac спал — следующий тик догонит,
 * честность обеспечена заморозкой правил, а не непрерывностью работы.
 */
import { join } from "node:path";
import { runIncubation } from "./incubate.ts";
import { DB_PATH, DEFAULT_VAULT_DIR } from "./paths.ts";
import { runSupervision } from "./supervise.ts";

const cardsDir = join(DEFAULT_VAULT_DIR, "Карточки");
const log = (m: string) => console.error(m);
const incubation = await runIncubation({ dbPath: DB_PATH, vaultCardsDir: cardsDir, log });
const supervision = await runSupervision({ dbPath: DB_PATH, vaultCardsDir: cardsDir, log });
console.log(JSON.stringify({ at: new Date().toISOString(), incubation, supervision }));
