import { describe, expect, test } from "bun:test";

import { applyCommand, splitCommand } from "../../src/telegram/handlers/tracker.handler";
import { TrackerSettingsError } from "../../src/tracker/settings";
import type { TrackerSettings } from "../../src/tracker/types";

const EMPTY: TrackerSettings = { channels: {} };

function run(line: string): TrackerSettings {
  const { command, args, tokens } = splitCommand(line.replace(/^!tracker\s*/, ""));
  return applyCommand(EMPTY, command, args, tokens);
}

function withChannel(line: string): TrackerSettings {
  const channel = run("channel welovegames");
  const { command, args, tokens } = splitCommand(line.replace(/^!tracker\s*/, ""));
  return applyCommand(channel, command, args, tokens);
}

describe("tracker commands", () => {
  test("разбор команды и остатка строки", () => {
    const parsed = splitCommand("alias welovegames ggsel джи джи сел,ggsel,джиджисел");

    expect(parsed.command).toBe("alias");
    expect(parsed.tokens[0]).toBe("welovegames");
    expect(parsed.tokens[1]).toBe("ggsel");
    expect(parsed.args).toBe("welovegames ggsel джи джи сел,ggsel,джиджисел");
  });

  test("алиас задаётся списком паттернов через запятую", () => {
    const settings = withChannel("alias welovegames ggsel джи джи сел,ggsel,джиджисел");

    expect(settings.channels.welovegames?.aliases.ggsel).toEqual(["джи джи сел", "ggsel", "джиджисел"]);
  });

  test("алиас без паттернов удаляется", () => {
    const withAlias = withChannel("alias welovegames ggsel ggsel");
    expect(withAlias.channels.welovegames?.aliases.ggsel).toEqual(["ggsel"]);

    const withoutAlias = applyCommand(withAlias, "alias", "welovegames ggsel", ["welovegames", "ggsel"]);
    expect(withoutAlias.channels.welovegames?.aliases.ggsel).toBeUndefined();
  });

  test("канал создаётся, включается и выключается", () => {
    const created = run("channel welovegames");
    expect(created.channels.welovegames?.enabled).toBe(true);

    const disabled = applyCommand(created, "disable", "welovegames", ["welovegames"]);
    expect(disabled.channels.welovegames?.enabled).toBe(false);

    const enabled = applyCommand(disabled, "enable", "welovegames", ["welovegames"]);
    expect(enabled.channels.welovegames?.enabled).toBe(true);
  });

  test("чат канала меняется и сбрасывается", () => {
    const created = run("channel welovegames -100123");
    expect(created.channels.welovegames?.chatId).toBe(-100123);

    const reset = applyCommand(created, "chat", "welovegames default", ["welovegames", "default"]);
    expect(reset.channels.welovegames?.chatId).toBeUndefined();
  });

  test("канал удаляется", () => {
    const created = run("channel welovegames");
    const removed = applyCommand(created, "rm", "welovegames", ["welovegames"]);

    expect(removed.channels.welovegames).toBeUndefined();
  });

  test("словарь алиасов включается и выключается", () => {
    const off = run("vocab off");
    expect(off.vocabularyEnabled).toBe(false);

    const on = applyCommand(off, "vocab", "on", ["on"]);
    expect(on.vocabularyEnabled).toBe(true);
  });

  test("словарь алиасов: неизвестный режим даёт ошибку", () => {
    expect(() => run("vocab maybe")).toThrow(TrackerSettingsError);
    expect(() => run("vocab")).toThrow(TrackerSettingsError);
  });

  test("неизвестная команда и неизвестный канал дают ошибку", () => {
    expect(() => run("что-то")).toThrow(TrackerSettingsError);
    expect(() => withChannel("alias unknownchannel ggsel ggsel")).toThrow(TrackerSettingsError);
    expect(() => run("channel")).toThrow(TrackerSettingsError);
  });
});
