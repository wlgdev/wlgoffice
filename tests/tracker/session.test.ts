import { describe, expect, test } from "bun:test";

import { tl } from "@mtcute/bun";

import { DB } from "../../src/services/db";
import { LiveSession, type LiveSessionDeps, type LiveSessionOptions } from "../../src/tracker/session";
import { TrackerStore } from "../../src/tracker/store";
import { createTranscriberFactory, FakeTelegram, FakeTwitch, waitFor } from "./helpers";

function settle(ms = 30): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createHarness(depsOverrides: Partial<LiveSessionDeps> = {}, options: Partial<LiveSessionOptions> = {}) {
  const db = new DB(":memory:");
  const store = new TrackerStore(db);
  const telegram = new FakeTelegram();
  const twitch = new FakeTwitch();
  const { factory, created } = createTranscriberFactory();

  const deps: LiveSessionDeps = {
    twitch,
    telegram,
    store,
    createTranscriber: factory,
    geminiApiKey: "test-key",
    dedupeWindowSec: 30,
    staleTimeoutMs: 120_000,
    reconnectBackoffSec: [0, 0, 0],
    apiRetryAttempts: 3,
    apiRetryDelaySec: 0,
    sleep: async () => {},
    minEditDelayMs: 0,
    ...depsOverrides,
  };

  const session = new LiveSession(deps, {
    channel: "welovegames",
    broadcastId: "broadcast-1",
    streamTitle: "Стрим",
    startTimeMs: 0,
    chatId: -100,
    aliases: { ggsel: ["ggsel"] },
    ...options,
  });

  return { deps, store, telegram, twitch, created, session, db };
}

describe("tracker session", () => {
  test("статусное сообщение публикуется в тред", async () => {
    const { session, telegram, created } = createHarness({}, { threadId: 564 });
    const run = session.run();

    await waitFor(() => created.length === 1);
    created[0]!.emit("ggsel", 100);
    await waitFor(() => telegram.sent.length === 1);

    expect(telegram.sent[0]!.chatId).toBe(-100);
    expect(telegram.sent[0]!.threadId).toBe(564);

    session.stop();
    await run;
  });

  test("сообщение не создаётся до первого совпадения", async () => {
    const { session, telegram, created } = createHarness();
    const run = session.run();

    await waitFor(() => created.length === 1);
    created[0]!.emit("обычная речь без совпадений", 10);
    await settle();

    expect(telegram.sent).toHaveLength(0);
    expect(telegram.edits).toHaveLength(0);

    session.stop();
    await run;
  });

  test("первое совпадение создаёт сообщение, второе редактирует то же", async () => {
    const { session, telegram, created } = createHarness();
    const run = session.run();

    await waitFor(() => created.length === 1);

    created[0]!.emit("ggsel", 100);
    await waitFor(() => telegram.sent.length === 1);
    const sentCount = telegram.sent.length;

    created[0]!.emit("и снова ggsel", 200);
    await waitFor(() => telegram.edits.length >= 1);
    await settle();

    expect(telegram.sent).toHaveLength(sentCount);
    expect(telegram.edits[0]!.messageId).toBe(1000);
    expect(telegram.edits[0]!.text).toContain("0:01:40");
    expect(telegram.edits[0]!.text).toContain("0:03:20");

    session.stop();
    await run;
  });

  test("rich недоступен: статус не создаётся, ошибка не роняет сессию", async () => {
    const { session, telegram, created } = createHarness();
    telegram.sendError = new Error("MESSAGE_TOO_LONG");
    const run = session.run();

    await waitFor(() => created.length === 1);
    created[0]!.emit("ggsel", 100);
    await settle(50);

    expect(telegram.sent).toHaveLength(0);

    session.stop();
    await run;
  });

  test("обрыв при офлайне: реконнекта нет, эфир закрывается", async () => {
    const { session, telegram, twitch, created } = createHarness();
    const run = session.run();

    await waitFor(() => created.length === 1);
    created[0]!.emit("ggsel", 100);
    await waitFor(() => telegram.sent.length === 1);

    twitch.online = false;
    created[0]!.stop();

    expect(await run).toBe("ended");
    expect(created).toHaveLength(1);
    expect(telegram.edits.at(-1)!.text).toContain("Эфир завершён");
  });

  test("обрыв при том же эфире: переподключение с сохранением находок", async () => {
    const { session, telegram, created } = createHarness();
    const run = session.run();

    await waitFor(() => created.length === 1);
    created[0]!.emit("ggsel", 100);
    await waitFor(() => telegram.sent.length === 1);

    created[0]!.stop();
    await waitFor(() => created.length === 2);

    expect(telegram.sent).toHaveLength(1);
    expect(telegram.sent[0]!.text).toContain("ggsel");

    created[1]!.emit("и снова ggsel", 300);
    await waitFor(() => telegram.edits.length >= 1);

    expect(telegram.edits[0]!.messageId).toBe(1000);
    expect(telegram.edits[0]!.text).toContain("0:01:40");
    expect(telegram.edits[0]!.text).toContain("0:05:00");

    session.stop();
    await run;
  });

  test("новый эфир: старая сессия закрывается", async () => {
    const { session, telegram, twitch, created } = createHarness();
    const run = session.run();

    await waitFor(() => created.length === 1);
    created[0]!.emit("ggsel", 100);
    await waitFor(() => telegram.sent.length === 1);

    twitch.broadcastId = "broadcast-2";
    created[0]!.stop();

    expect(await run).toBe("superseded");
    expect(telegram.edits.at(-1)!.text).toContain("Эфир завершён");
  });

  test("ошибка Twitch API: сессия подвешена без падения", async () => {
    const { session, twitch, created } = createHarness();
    const run = session.run();

    await waitFor(() => created.length === 1);
    twitch.streamInfoError = new Error("twitch down");
    created[0]!.stop();

    expect(await run).toBe("unknown");
    expect(twitch.streamInfoCalls).toBeGreaterThanOrEqual(3);
  });

  test("удалённый юзером пост пересоздаётся", async () => {
    const { session, telegram, created } = createHarness();
    const run = session.run();

    await waitFor(() => created.length === 1);
    created[0]!.emit("ggsel", 100);
    await waitFor(() => telegram.sent.length === 1);

    telegram.editError = new Error("MESSAGE_ID_INVALID");
    created[0]!.emit("и снова ggsel", 200);
    await waitFor(() => telegram.sent.length === 2);
    telegram.editError = undefined;

    expect(telegram.sent[1]!.text).toContain("ggsel");
    expect(telegram.sent[1]!.chatId).toBe(-100);

    session.stop();
    await run;
  });

  test("транскрайбер не пересоздается, пока жив (ротации нет)", async () => {
    const { session, telegram, created } = createHarness();
    const run = session.run();

    await waitFor(() => created.length === 1);
    created[0]!.emit("ggsel", 100);
    await waitFor(() => telegram.sent.length === 1);
    await settle(100);

    expect(created).toHaveLength(1);
    expect(telegram.sent).toHaveLength(1);

    session.stop();
    await run;
  });

  test("переигранное аудио после реконнекта отбрасывается", async () => {
    const { session, telegram, created } = createHarness();
    const run = session.run();

    await waitFor(() => created.length === 1);
    created[0]!.emit("ggsel", 500);
    await waitFor(() => telegram.sent.length === 1);

    created[0]!.emit("ggsel", 100);
    await settle();

    expect(telegram.edits.filter((edit) => edit.text.includes("0:01:40"))).toHaveLength(0);

    session.stop();
    await run;
  });

  test("выключение канала закрывает статус с футером", async () => {
    const { session, telegram, created } = createHarness();
    const run = session.run();

    await waitFor(() => created.length === 1);
    created[0]!.emit("ggsel", 100);
    await waitFor(() => telegram.sent.length === 1);

    session.stop();
    expect(await run).toBe("stopped");
    expect(telegram.edits.at(-1)!.text).toContain("Эфир завершён");
  });

  test("VOD появляется позже: статус обновляется, таймстемпы становятся ссылками", async () => {
    const { session, telegram, twitch, created } = createHarness({ vodLookupIntervalMs: 20 });
    twitch.vod = null;

    const run = session.run();
    await waitFor(() => created.length === 1);

    created[0]!.emit("ggsel", 100);
    await waitFor(() => telegram.sent.length === 1);

    expect(telegram.sent[0]!.text).not.toContain("?t=");

    twitch.vod = { vodId: "vod-42", title: "VOD" };
    await waitFor(() => telegram.edits.some((edit) => edit.text.includes("vod-42")));

    const edit = telegram.edits.at(-1)!;
    expect(edit.text).toContain("?t=0h1m40s");

    session.stop();
    await run;
  });

  test("повтор паттерна в окне дедупа: один таймкод с количеством", async () => {
    const { session, telegram, created } = createHarness();
    const run = session.run();

    await waitFor(() => created.length === 1);
    created[0]!.emit("ggsel", 100);
    await waitFor(() => telegram.sent.length === 1);

    created[0]!.emit("и снова ggsel", 120);
    await waitFor(() => telegram.edits.length >= 1);

    expect(telegram.edits.at(-1)!.text).toContain("0:01:40</a> (2)");

    session.stop();
    await run;
  });

  test("смещение времени применяется к таймкодам", async () => {
    const { session, telegram, created } = createHarness({ timeOffsetSec: -3 });
    const run = session.run();

    await waitFor(() => created.length === 1);
    created[0]!.emit("ggsel", 100);
    await waitFor(() => telegram.sent.length === 1);

    expect(telegram.sent[0]!.text).toContain("0:01:37");

    session.stop();
    await run;
  });

  test("дебаг-лог транскрипции: [channel|hh:mm:ss] текст", async () => {
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    try {
      const { session, created } = createHarness({ debugTranscript: true });
      const run = session.run();

      await waitFor(() => created.length === 1);
      created[0]!.emit(" привет, это ggsel ", 3725);
      await waitFor(() => logs.some((line) => line.includes("[welovegames|")));

      expect(logs.some((line) => line.includes("[welovegames|01:02:05] привет, это ggsel"))).toBe(true);

      session.stop();
      await run;
    } finally {
      console.log = original;
    }
  });

  test("дебаг-лог транскрипции выключен по умолчанию", async () => {
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    try {
      const { session, created } = createHarness();
      const run = session.run();

      await waitFor(() => created.length === 1);
      created[0]!.emit("привет, это ggsel", 3725);
      await settle(50);

      expect(logs.some((line) => line.includes("[welovegames|"))).toBe(false);

      session.stop();
      await run;
    } finally {
      console.log = original;
    }
  });

  test("счётчики: байты в Gemini и полученные символы", async () => {
    const { session, created } = createHarness();
    const run = session.run();

    await waitFor(() => created.length === 1);
    created[0]!.sendAudio(6400);
    created[0]!.emit("привет", 10);

    expect(session.state().sentBytes).toBe(6400);
    expect(session.state().receivedChars).toBe(6);

    session.stop();
    await run;
  });

  test("в Gemini уходят языки и словарь из имён алиасов", async () => {
    const { session, created } = createHarness(
      {},
      { aliases: { ggsel: ["ggsel"], gg: ["гг"] }, vocabularyEnabled: true },
    );
    const run = session.run();

    await waitFor(() => created.length === 1);

    expect(created[0]!.options.languageCodes).toEqual(["ru-RU", "en-US"]);
    expect(created[0]!.options.customVocabulary).toEqual(["ggsel", "gg"]);
    expect(session.state().languageCodes).toEqual(["ru-RU", "en-US"]);
    expect(session.state().customVocabulary).toEqual(["ggsel", "gg"]);

    session.stop();
    await run;
  });

  test("по умолчанию словарь в Gemini не отправляется", async () => {
    const { session, created } = createHarness();
    const run = session.run();

    await waitFor(() => created.length === 1);

    expect(created[0]!.options.customVocabulary).toBeUndefined();
    expect(session.state().vocabularyEnabled).toBe(false);
    expect(session.state().customVocabulary).toEqual([]);

    session.stop();
    await run;
  });

  test("выключенный словарь не уходит в Gemini", async () => {
    const { session, created } = createHarness({}, { vocabularyEnabled: false });
    const run = session.run();

    await waitFor(() => created.length === 1);

    expect(created[0]!.options.customVocabulary).toBeUndefined();
    expect(session.state().vocabularyEnabled).toBe(false);
    expect(session.state().customVocabulary).toEqual([]);

    session.stop();
    await run;
  });

  test("переключение словаря переподключает Gemini", async () => {
    const { session, created } = createHarness({}, { vocabularyEnabled: true });
    const run = session.run();

    await waitFor(() => created.length === 1);
    expect(created[0]!.options.customVocabulary).toEqual(["ggsel"]);

    session.updateVocabulary(false);
    await waitFor(() => created.length === 2);

    expect(created[1]!.options.customVocabulary).toBeUndefined();

    session.stop();
    await run;
  });

  test("статус закрепляется при первом совпадении и открепляется по окончании эфира", async () => {
    const { session, telegram, twitch, created } = createHarness();
    const run = session.run();

    await waitFor(() => created.length === 1);
    created[0]!.emit("ggsel", 100);
    await waitFor(() => telegram.pinned.length === 1);

    expect(telegram.pinned[0]).toEqual({ chatId: -100, messageId: 1000 });

    twitch.online = false;
    created[0]!.stop();

    expect(await run).toBe("ended");
    expect(telegram.unpinned).toEqual([{ chatId: -100, messageId: 1000 }]);
  });

  test("реконнект: статус остаётся закреплённым", async () => {
    const { session, telegram, created } = createHarness();
    const run = session.run();

    await waitFor(() => created.length === 1);
    created[0]!.emit("ggsel", 100);
    await waitFor(() => telegram.pinned.length === 1);

    created[0]!.stop();
    await waitFor(() => created.length === 2);

    expect(telegram.pinned).toHaveLength(1);
    expect(telegram.unpinned).toHaveLength(0);

    session.stop();
    await run;
  });
});
