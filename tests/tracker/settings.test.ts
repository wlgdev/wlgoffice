import { describe, expect, test } from "bun:test";

import {
  describeSettings,
  normalizeTrackerSettings,
  parsePatternList,
  removeChannel,
  setAlias,
  setChannel,
  setChat,
  setEnabled,
  TrackerSettingsError,
} from "../../src/tracker/settings";
import type { TrackerSettings } from "../../src/tracker/types";

function baseSettings(): TrackerSettings {
  return setChannel({ channels: {} }, "welovegames");
}

describe("tracker settings", () => {
  test("список паттернов разбирается по запятой", () => {
    expect(parsePatternList("джи джи сел,ggsel,джиджисел")).toEqual(["джи джи сел", "ggsel", "джиджисел"]);
    expect(parsePatternList("  ggsel , , джиджисел ")).toEqual(["ggsel", "джиджисел"]);
    expect(parsePatternList("")).toEqual([]);
  });

  test("алиас задаётся списком паттернов", () => {
    const settings = setAlias(baseSettings(), "welovegames", "ggsel", ["ggsel", "джи джи сел"]);

    expect(settings.channels.welovegames?.aliases).toEqual({ ggsel: ["ggsel", "джи джи сел"] });
  });

  test("пустой список паттернов удаляет алиас", () => {
    const withAlias = setAlias(baseSettings(), "welovegames", "ggsel", ["ggsel"]);
    const withoutAlias = setAlias(withAlias, "welovegames", "ggsel", []);

    expect(withoutAlias.channels.welovegames?.aliases).toEqual({});
  });

  test("неизвестный канал не меняет настройки", () => {
    const settings = baseSettings();

    expect(() => setAlias(settings, "unknown", "ggsel", ["ggsel"])).toThrow(TrackerSettingsError);
    expect(() => setEnabled(settings, "unknown", true)).toThrow(TrackerSettingsError);
    expect(() => removeChannel(settings, "unknown")).toThrow(TrackerSettingsError);
    expect(settings.channels.welovegames?.aliases).toEqual({});
  });

  test("некорректный логин отклоняется", () => {
    expect(() => setChannel({ channels: {} }, "A")).toThrow(TrackerSettingsError);
    expect(() => setChannel({ channels: {} }, "ab")).toThrow(TrackerSettingsError);
  });

  test("включение, выключение и смена чата", () => {
    let settings = setChannel({ channels: {} }, "welovegames", -100123);
    expect(settings.channels.welovegames?.enabled).toBe(true);
    expect(settings.channels.welovegames?.chatId).toBe(-100123);

    settings = setEnabled(settings, "welovegames", false);
    expect(settings.channels.welovegames?.enabled).toBe(false);

    settings = setChat(settings, "welovegames", -100999);
    expect(settings.channels.welovegames?.chatId).toBe(-100999);

    settings = setChat(settings, "welovegames", undefined);
    expect(settings.channels.welovegames?.chatId).toBeUndefined();
  });

  test("чат с тредом разбирается из формата chatId_тред", () => {
    const settings = setChat(setChannel({ channels: {} }, "welovegames"), "welovegames", "-1004483313375_564");

    expect(settings.channels.welovegames?.chatId).toBe(-1004483313375);
    expect(settings.channels.welovegames?.threadId).toBe(564);
    expect(describeSettings(settings)).toContain("-1004483313375_564");
  });

  test("удаление канала", () => {
    const settings = removeChannel(baseSettings(), "welovegames");
    expect(settings.channels.welovegames).toBeUndefined();
  });

  test("битые настройки из БД нормализуются", () => {
    const settings = normalizeTrackerSettings({
      channels: {
        WELOVEGAMES: { enabled: true, chatId: "-100", aliases: { ggsel: ["ggsel"], broken: [] } },
        A: { enabled: true },
        tabula: { enabled: false, aliases: { x: "не массив" } },
      },
    });

    expect(Object.keys(settings.channels)).toEqual(["welovegames", "tabula"]);
    expect(settings.channels.welovegames?.chatId).toBe(-100);
    expect(settings.channels.welovegames?.aliases).toEqual({ ggsel: ["ggsel"] });
    expect(settings.channels.tabula?.aliases).toEqual({});
  });

  test("описание настроек содержит каналы и алиасы", () => {
    const settings = setAlias(setChannel({ channels: {} }, "welovegames"), "welovegames", "ggsel", ["ggsel"]);
    const description = describeSettings(settings);

    expect(description).toContain("welovegames");
    expect(description).toContain("ggsel");
  });

  test("описание настроек: средние тире, паттерны алиаса списком", () => {
    const settings = setAlias(setChannel({ channels: {} }, "welovegames", -100123), "welovegames", "ggsel", [
      "ggsel",
      "джи джи сел",
    ]);
    const description = describeSettings(settings);

    expect(description).toContain("<b>welovegames</b> – ✅ включён · чат <code>-100123</code>");
    expect(description).toContain("• <b>ggsel</b> (2) – ggsel, джи джи сел");
    expect(description).not.toContain("—");
  });
});
