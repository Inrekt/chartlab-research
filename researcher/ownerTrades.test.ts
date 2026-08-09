import { describe, expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrialLedger } from "./ledger.ts";

/*
 * Сделки владельца — самая ценная запись в журнале и единственная, которую
 * нельзя восстановить: правило формализовали трижды и трижды не то, а его
 * фактические входы существуют только там, где он их записал.
 *
 * Отсюда требования, которые тут и проверяются: запись неизменна после
 * внесения (иначе это не свидетельство, а черновик) и не подвергается
 * «исправлению» данных, которые выглядят странно.
 */
const freshDb = () => join(mkdtempSync(join(tmpdir(), "ot-")), "t.sqlite");

const sample = {
  symbol: "SOLUSDT",
  direction: "short" as const,
  entryIso: "2026-03-14T12:00:00.000Z",
  entryPrice: 187.8,
  stopPrice: 189.6,
  targetPrice: 182,
  note: "свипнул хай, вернулся",
  source: "manual",
};

describe("журнал сделок владельца", () => {
  test("записывается и читается вместе со снимком контекста", () => {
    const ledger = new TrialLedger(freshDb());
    const id = ledger.addOwnerTrade({ ...sample, context: { "4h": { atr: 3.1 } } });
    const rows = ledger.ownerTrades();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].symbol).toBe("SOLUSDT");
    expect(rows[0].direction).toBe("short");
    expect(rows[0].entryPrice).toBeCloseTo(187.8, 10);
    expect((rows[0].context as Record<string, { atr: number }>)["4h"].atr).toBeCloseTo(3.1, 10);
    ledger.close();
  });

  test("append-only: переписать и удалить нельзя", () => {
    // Сделка, «уточнённая» задним числом, перестаёт быть свидетельством — а
    // именно как свидетельство она здесь и нужна.
    const dbPath = freshDb();
    const ledger = new TrialLedger(dbPath);
    const id = ledger.addOwnerTrade({ ...sample, context: null });
    const db = (ledger as unknown as { db: { exec: (s: string) => void } }).db;
    expect(() => db.exec(`UPDATE owner_trades SET entry_price = 999 WHERE id = ${id}`)).toThrow();
    expect(() => db.exec(`DELETE FROM owner_trades WHERE id = ${id}`)).toThrow();
    expect(ledger.ownerTrades()[0].entryPrice).toBeCloseTo(187.8, 10);
    ledger.close();
  });

  test("странные данные записываются КАК ЕСТЬ, а не чинятся молча", () => {
    // Стоп ниже входа у шорта — либо владелец так и торговал, либо ошибся при
    // записи. И то и другое надо увидеть, а не «исправить»: молчаливая
    // нормализация подделывает источник, по которому потом восстанавливают
    // правило.
    const ledger = new TrialLedger(freshDb());
    ledger.addOwnerTrade({ ...sample, stopPrice: 150, context: null });
    expect(ledger.ownerTrades()[0].stopPrice).toBeCloseTo(150, 10);
    ledger.close();
  });

  test("необязательные поля остаются пустыми, а не нулевыми", () => {
    // Ноль вместо «не знаю» — тот же класс тихих ошибок, что вырожденный стоп
    // и обнулённые издержки: он не отличим от настоящего значения.
    const ledger = new TrialLedger(freshDb());
    ledger.addOwnerTrade({
      symbol: "BTCUSDT",
      direction: "long",
      entryIso: "2026-04-01T00:00:00.000Z",
      entryPrice: 60000,
      source: "manual",
    });
    const row = ledger.ownerTrades()[0];
    expect(row.stopPrice).toBeNull();
    expect(row.targetPrice).toBeNull();
    expect(row.exitPrice).toBeNull();
    expect(row.context).toBeNull();
    ledger.close();
  });

  test("порядок — по времени входа, а не по времени записи", () => {
    // Владелец вносит сделки задним числом и вразнобой; восстановление правила
    // требует хронологии рынка, а не хронологии ввода.
    const ledger = new TrialLedger(freshDb());
    ledger.addOwnerTrade({ ...sample, entryIso: "2026-05-01T00:00:00.000Z", context: null });
    ledger.addOwnerTrade({ ...sample, entryIso: "2026-01-01T00:00:00.000Z", context: null });
    expect(ledger.ownerTrades().map((r) => r.entryIso)).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2026-05-01T00:00:00.000Z",
    ]);
    ledger.close();
  });
});
