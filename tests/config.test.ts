import { describe, expect, test } from "bun:test";

import { DEFAULT_CHANNEL_ALIASES, parseChannelAliases, parseChatIds } from "../src/config";

describe("config", () => {
  describe("parseChatIds", () => {
    test("single positive chat id", () => {
      expect(parseChatIds("123123")).toEqual([123123]);
    });

    test("list with spaces, positives and negative channel ids", () => {
      expect(parseChatIds("123123, 15125,-543856141")).toEqual([123123, 15125, -543856141]);
    });

    test("throws when input is empty or invalid", () => {
      expect(() => parseChatIds("")).toThrow();
      expect(() => parseChatIds("   ")).toThrow();
      expect(() => parseChatIds("123,abc")).toThrow();
      expect(() => parseChatIds("NaN")).toThrow();
    });
  });

  describe("parseChannelAliases", () => {
    test("loads default aliases when no env value passed", () => {
      const aliases = parseChannelAliases();
      expect(aliases["влг"]).toBe("welovegames");
      expect(aliases["wlg"]).toBe("welovegames");
      expect(aliases["welovegames"]).toBe("welovegames");
      expect(aliases["табула"]).toBe("tabula");
      expect(aliases["tabula"]).toBe("tabula");
      expect(DEFAULT_CHANNEL_ALIASES["влг"]).toBe("welovegames");
    });

    test("custom env string extends alias map", () => {
      const custom = parseChannelAliases("mychan:мк,мойканал;tabula:табула");
      expect(custom["мк"]).toBe("mychan");
      expect(custom["мойканал"]).toBe("mychan");
      expect(custom["mychan"]).toBe("mychan");
      expect(custom["табула"]).toBe("tabula");
      expect(custom["влг"]).toBe("welovegames");
    });

    test("handles extra semicolons and empty sections", () => {
      const parsed = parseChannelAliases(";;test:t1,;;");
      expect(parsed["t1"]).toBe("test");
      expect(parsed["test"]).toBe("test");
    });
  });
});
