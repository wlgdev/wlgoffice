import { describe, expect, test } from "bun:test";

import {
  formatChatTarget,
  parseChatTarget,
  parseChatTargets,
  resolveChatAccess,
} from "../../src/core/chat-target";

describe("chat target", () => {
  test("парсит чат с тредом и просто чат", () => {
    expect(parseChatTarget("-1004483313375_564")).toEqual({ chatId: -1004483313375, threadId: 564 });
    expect(parseChatTarget("187038")).toEqual({ chatId: 187038 });
  });

  test("отклоняет некорректный формат", () => {
    expect(parseChatTarget("abc")).toBeNull();
    expect(parseChatTarget("123_")).toBeNull();
    expect(parseChatTarget("123_abc")).toBeNull();
    expect(parseChatTarget("123_0")).toBeNull();
    expect(parseChatTarget("123_4_5")).toBeNull();
  });

  test("список целей разбирается через запятую", () => {
    expect(parseChatTargets("187038, -1004483313375_564")).toEqual([
      { chatId: 187038 },
      { chatId: -1004483313375, threadId: 564 },
    ]);
    expect(() => parseChatTargets("")).toThrow();
    expect(() => parseChatTargets("123,abc")).toThrow();
  });

  test("форматирование цели", () => {
    expect(formatChatTarget({ chatId: -1004483313375, threadId: 564 })).toBe("-1004483313375_564");
    expect(formatChatTarget({ chatId: 187038 })).toBe("187038");
  });

  test("чат без треда доступен целиком, тред сохраняется", () => {
    const targets = [{ chatId: -1004483313375 }];

    expect(resolveChatAccess(targets, -1004483313375)).toEqual({ chatId: -1004483313375, threadId: undefined });
    expect(resolveChatAccess(targets, -1004483313375, 564)).toEqual({ chatId: -1004483313375, threadId: 564 });
    expect(resolveChatAccess(targets, 42)).toBeNull();
  });

  test("чат с тредом доступен только в этом треде", () => {
    const targets = [{ chatId: -1004483313375, threadId: 564 }];

    expect(resolveChatAccess(targets, -1004483313375, 564)).toEqual({ chatId: -1004483313375, threadId: 564 });
    expect(resolveChatAccess(targets, -1004483313375, 565)).toBeNull();
    expect(resolveChatAccess(targets, -1004483313375)).toBeNull();
  });
});
