import { describe, expect, test } from "bun:test";

import { DB } from "../../src/services/db";
import { TrackerService } from "../../src/tracker/service";
import { setAlias, setChannel, setEnabled } from "../../src/tracker/settings";
import { TrackerStore } from "../../src/tracker/store";
import type { TrackerSessionState } from "../../src/tracker/types";
import { createTranscriberFactory, FakeTelegram, FakeTwitch, waitFor } from "./helpers";

function createHarness() {
  const db = new DB(":memory:");
  const store = new TrackerStore(db);
  const telegram = new FakeTelegram();
  const twitch = new FakeTwitch();
  const { factory, created } = createTranscriberFactory();

  const service = new TrackerService({
    store,
    twitch,
    telegram,
    createTranscriber: factory,
    geminiApiKey: "test-key",
    defaultChatId: -100,
    pollIntervalSec: 60,
    dedupeWindowSec: 30,
    staleTimeoutMs: 120_000,
    reconnectBackoffSec: [0, 0, 0],
    apiRetryAttempts: 3,
    apiRetryDelaySec: 0,
    sleep: async () => {},
    minEditDelayMs: 0,
  });

  const enable = () => {
    store.saveSettings(setAlias(setChannel({ channels: {} }, "welovegames"), "welovegames", "ggsel", ["ggsel"]));
  };

  return { db, store, telegram, twitch, created, service, enable };
}

function storedSession(overrides: Partial<TrackerSessionState> = {}): TrackerSessionState {
  return {
    channel: "welovegames",
    broadcastId: "broadcast-1",
    chatId: -100,
    messageId: 555,
    vodId: "vod-1",
    vodTitle: "VOD",
    hits: [{ alias: "ggsel", text: "ggsel", timeSec: 100 }],
    counts: { ggsel: 1 },
    sentBytes: 0,
    receivedChars: 0,
    startedAt: 0,
    updatedAt: 0,
    status: "active",
    ...overrides,
  };
}

describe("tracker service", () => {
  test("выключенный канал не поднимает сессию", async () => {
    const { service, store, created } = createHarness();
    store.saveSettings(setEnabled(setChannel({ channels: {} }, "welovegames"), "welovegames", false));

    await service.tick();

    expect(created).toHaveLength(0);
  });

  test("оффлайн: сессия не поднимается, сохранённый эфир закрывается", async () => {
    const { service, store, twitch, telegram, created } = createHarness();
    store.saveSettings(setAlias(setChannel({ channels: {} }, "welovegames"), "welovegames", "ggsel", ["ggsel"]));
    store.saveSession(storedSession());
    twitch.online = false;

    await service.tick();

    expect(created).toHaveLength(0);
    expect(telegram.edits.at(-1)!.messageId).toBe(555);
    expect(telegram.edits.at(-1)!.text).toContain("Эфир завершён");
    expect(telegram.unpinned).toEqual([{ chatId: -100, messageId: 555 }]);
    expect(store.getSession("welovegames")?.status).toBe("closed");
  });

  test("онлайн: сессия поднимается, сообщения нет до первого совпадения", async () => {
    const { service, enable, telegram, created } = createHarness();
    enable();

    await service.tick();
    await waitFor(() => created.length === 1);

    expect(telegram.sent).toHaveLength(0);
  });

  test("повторный тик не создаёт вторую сессию", async () => {
    const { service, enable, created } = createHarness();
    enable();

    await service.tick();
    await waitFor(() => created.length === 1);
    await service.tick();

    expect(created).toHaveLength(1);
  });

  test("рестарт бота: тот же эфир продолжает то же сообщение", async () => {
    const { service, store, enable, telegram, created } = createHarness();
    enable();
    store.saveSession(storedSession());

    await service.tick();
    await waitFor(() => created.length === 1);

    expect(telegram.sent).toHaveLength(0);

    created[0]!.emit("и снова ggsel", 300);
    await waitFor(() => telegram.edits.length >= 1);

    expect(telegram.edits[0]!.messageId).toBe(555);
    expect(telegram.edits[0]!.text).toContain("0:01:40");
    expect(telegram.edits[0]!.text).toContain("0:05:00");
  });

  test("рестарт бота: другой эфир закрывает старый и поднимает новый", async () => {
    const { service, store, enable, twitch, telegram, created } = createHarness();
    enable();
    store.saveSession(storedSession({ broadcastId: "old-broadcast" }));
    twitch.broadcastId = "broadcast-1";

    await service.tick();
    await waitFor(() => created.length === 1);

    expect(telegram.edits.at(-1)!.messageId).toBe(555);
    expect(telegram.edits.at(-1)!.text).toContain("Эфир завершён");
    expect(store.getSession("welovegames")?.broadcastId).toBe("broadcast-1");
  });

  test("удаление канала из настроек чистит сессию в БД", async () => {
    const { service, store, enable, created } = createHarness();
    enable();
    store.saveSession(storedSession());

    await service.tick();
    await waitFor(() => created.length === 1);
    expect(store.getSession("welovegames")).not.toBeNull();

    store.saveSettings({ channels: {} });
    await service.tick();

    expect(store.getSession("welovegames")).toBeNull();
    expect(store.listSessionChannels()).toEqual([]);
  });

  test("удаление канала чистит и сохранённую сессию без активной", async () => {
    const { service, store } = createHarness();
    store.saveSession(storedSession({ status: "closed" }));

    await service.tick();

    expect(store.getSession("welovegames")).toBeNull();
    expect(store.listSessionChannels()).toEqual([]);
  });

  test("настройки применяются между тиками: выключение останавливает сессию", async () => {
    const { service, store, enable, telegram, created } = createHarness();
    enable();

    await service.tick();
    await waitFor(() => created.length === 1);

    created[0]!.emit("ggsel", 100);
    await waitFor(() => telegram.sent.length === 1);

    store.saveSettings(setEnabled(store.getSettings(), "welovegames", false));
    await service.tick();
    await waitFor(() => telegram.edits.some((edit) => edit.text.includes("Эфир завершён")));
  });

  test("активные сессии отдаются списком", async () => {
    const { service, enable, created } = createHarness();
    enable();

    await service.tick();
    await waitFor(() => created.length === 1);

    const sessions = service.listActiveSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.channel).toBe("welovegames");
    expect(sessions[0]!.broadcastId).toBe("broadcast-1");
    expect(sessions[0]!.status).toBe("active");
  });
});
