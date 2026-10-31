import { describe, expect, test } from "bun:test";

import type { MessageContext } from "@mtcute/dispatcher";

import config from "../../src/config";
import type { InteropPayload } from "../../src/interop";
import { validateInterop } from "../../src/telegram";

describe("telegram interop guard", () => {
  const allowedChatId = config.interop.chatIds[0]!;

  test("rejects interop requests originating from groups or channels", () => {
    const groupMsg = { chat: { type: "chat" } } as unknown as MessageContext;
    const payload: InteropPayload = {
      from: "twitch",
      to: allowedChatId,
      username: "user1",
      channel: null,
    };

    const err = validateInterop(groupMsg, payload);
    expect(err).toContain("Интероп-запросы принимаются только в личке бота");
  });

  test("rejects payload without a valid to chat id", () => {
    const dmMsg = { chat: { type: "user" } } as unknown as MessageContext;
    const payload: InteropPayload = {
      from: "twitch",
      to: null,
      username: "user1",
      channel: null,
    };

    const err = validateInterop(dmMsg, payload);
    expect(err).toContain("не указан корректный <code>to</code>");
  });

  test("rejects payload when destination chat id is not allowed", () => {
    const dmMsg = { chat: { type: "user" } } as unknown as MessageContext;
    const payload: InteropPayload = {
      from: "twitch",
      to: 999999999999,
      username: "user1",
      channel: null,
    };

    const err = validateInterop(dmMsg, payload);
    expect(err).toContain("не разрешён для клипов");
  });

  test("accepts valid interop payload in DM for allowed destination chat", () => {
    const dmMsg = { chat: { type: "user" } } as unknown as MessageContext;
    const payload: InteropPayload = {
      from: "twitch",
      to: allowedChatId,
      username: "user1",
      channel: null,
    };

    const err = validateInterop(dmMsg, payload);
    expect(err).toBeNull();
  });
});
