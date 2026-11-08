import { describe, expect, test } from "bun:test";

import { PropagationAction } from "@mtcute/dispatcher";

import config from "../../src/config";
import { handleSystemMessage } from "../../src/telegram/handlers/system.handler";
import type { TrackerService } from "../../src/tracker/service";

class FakeTg {
  sent: { chatId: number | string; text: string; threadId?: number }[] = [];

  async sendRichMessage(chatId: number | string, params: any): Promise<any> {
    this.sent.push({
      chatId,
      text: params?.content?.content ?? "",
      threadId: params?.threadId,
    });
    return { id: 1 };
  }
}

function createService(): TrackerService {
  return {
    getSettings: () => ({ channels: {} }),
    listActiveSessions: () => [],
  } as unknown as TrackerService;
}

describe("system handler", () => {
  test("чужие сообщения не прерывают цепочку хэндлеров", async () => {
    const tg = new FakeTg();

    const result = await handleSystemMessage({ text: "!ping", chat: { id: 1 } }, tg, createService());

    expect(result).toBe(PropagationAction.Continue);
    expect(tg.sent).toHaveLength(0);
  });

  test("чужой чат игнорируется", async () => {
    const tg = new FakeTg();

    const result = await handleSystemMessage({ text: "!system", chat: { id: -999999 } }, tg, createService());

    expect(result).toBe(PropagationAction.Continue);
    expect(tg.sent).toHaveLength(0);
  });

  test("!system отвечает в разрешённом чате", async () => {
    const tg = new FakeTg();
    const chatId = config.telegram.chatIds[0]!;

    await handleSystemMessage({ text: "!system", chat: { id: chatId } }, tg, createService());

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0]!.chatId).toBe(chatId);
    expect(tg.sent[0]!.text).toContain("<h3>🛠 System</h3>");
    expect(tg.sent[0]!.text).toContain("<table compact striped>");
  });
});
