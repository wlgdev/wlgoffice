import { describe, expect, test } from "bun:test";

import { PropagationAction } from "@mtcute/dispatcher";

import config from "../../src/config";
import { DB } from "../../src/services/db";
import { handleTrackerMessage } from "../../src/telegram/handlers/tracker.handler";
import { TrackerService } from "../../src/tracker/service";
import { setAlias, setChannel } from "../../src/tracker/settings";
import { TrackerStore } from "../../src/tracker/store";
import { FakeTelegram } from "./helpers";

class FakeTg {
  sent: { chatId: number | string; text: string }[] = [];

  async sendText(chatId: number | string, text: any): Promise<any> {
    this.sent.push({ chatId, text: typeof text === "string" ? text : (text?.text ?? "") });
    return { id: 1 };
  }
}

function createService(): TrackerService {
  const store = new TrackerStore(new DB(":memory:"));
  store.saveSettings(setAlias(setChannel({ channels: {} }, "welovegames"), "welovegames", "ggsel", ["ggsel"]));

  return new TrackerService({
    store,
    twitch: {
      streamInfo: async () => ({ online: false, id: "0", title: "", start_time: 0 }),
      liveVariants: async () => [],
      findLiveVod: async () => null,
    },
    telegram: new FakeTelegram(),
    createTranscriber: () => {
      throw new Error("не используется");
    },
    geminiApiKey: "",
    defaultChatId: -100,
    pollIntervalSec: 60,
    dedupeWindowSec: 30,
    staleTimeoutMs: 1000,
    reconnectBackoffSec: [],
    apiRetryAttempts: 1,
    apiRetryDelaySec: 0,
    sleep: async () => {},
  });
}

describe("tracker handler", () => {
  test("чужие сообщения не прерывают цепочку хэндлеров", async () => {
    const service = createService();
    const tg = new FakeTg();

    const result = await handleTrackerMessage({ text: "!ping", chat: { id: 1 } }, tg, service);

    expect(result).toBe(PropagationAction.Continue);
    expect(tg.sent).toHaveLength(0);
  });

  test("сообщение без текста не прерывает цепочку", async () => {
    const service = createService();
    const tg = new FakeTg();

    expect(await handleTrackerMessage({ chat: { id: 1 } }, tg, service)).toBe(PropagationAction.Continue);
  });

  test("чужой чат игнорируется", async () => {
    const service = createService();
    const tg = new FakeTg();

    const result = await handleTrackerMessage({ text: "!tracker list", chat: { id: -999999 } }, tg, service);

    expect(result).toBe(PropagationAction.Continue);
    expect(tg.sent).toHaveLength(0);
  });

  test("!tracker list отвечает в разрешённом чате", async () => {
    const service = createService();
    const tg = new FakeTg();
    const chatId = config.telegram.chatIds[0]!;

    await handleTrackerMessage({ text: "!tracker list", chat: { id: chatId } }, tg, service);

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0]!.chatId).toBe(chatId);
    expect(tg.sent[0]!.text).toContain("welovegames");
  });

  test("!tracker без аргументов показывает справку", async () => {
    const service = createService();
    const tg = new FakeTg();
    const chatId = config.telegram.chatIds[0]!;

    await handleTrackerMessage({ text: "!tracker ", chat: { id: chatId } }, tg, service);

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0]!.text).toContain("!tracker list");
  });

  test("неизвестная команда отвечает ошибкой, а не молчит", async () => {
    const service = createService();
    const tg = new FakeTg();
    const chatId = config.telegram.chatIds[0]!;

    await handleTrackerMessage({ text: "!tracker nonsense", chat: { id: chatId } }, tg, service);

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0]!.text).toContain("Ошибка");
  });
});
