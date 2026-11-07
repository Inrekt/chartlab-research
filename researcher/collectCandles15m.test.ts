import { describe, expect, test } from "vitest";
import { klineLine } from "./collect-candles-15m.ts";

describe("klineLine", () => {
  test("мс и микросекунды дают одно время; takerBuy берётся из поля [9]", () => {
    const ms = "1578182400000,1,2,0.5,1.5,10,x,x,x,4,x,x";
    const us = "1578182400000000,1,2,0.5,1.5,10,x,x,x,4,x,x";
    expect(klineLine(ms)).toBe("2020-01-05T00:00:00.000Z,1,2,0.5,1.5,10,4");
    expect(klineLine(us)).toBe(klineLine(ms));
  });
  test("заголовок и пустая цена отбрасываются", () => {
    expect(klineLine("open_time,open,high,low,close,volume,a,b,c,d,e,f")).toBeNull();
    expect(klineLine("1578182400000,,2,0.5,1.5,10,x,x,x,4,x,x")).toBeNull();
  });
});
