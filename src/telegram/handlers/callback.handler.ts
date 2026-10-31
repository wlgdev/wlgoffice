import type { TelegramClient } from "@mtcute/bun";
import type { Dispatcher } from "@mtcute/dispatcher";

import config from "../../config";
import logger from "../../logger";
import { DELETE_CALLBACK_DATA } from "../formatters";

export function setupCallbackHandler(dp: Dispatcher, tg: TelegramClient): void {
  dp.onCallbackQuery(async (q) => {
    if (q.dataStr !== DELETE_CALLBACK_DATA) {
      return;
    }

    const chatId = q.chat.id;
    const allowed = config.telegram.chatIds.includes(Number(chatId)) || config.interop.chatIds.includes(Number(chatId));

    if (!allowed) {
      await q.answer({ text: "🚫 Этот чат не разрешён", alert: true });
      return;
    }

    try {
      await tg.deleteMessagesById(chatId, [q.messageId]);
      logger.info(
        `[Delete] ${q.user.id} (@${q.user.username ?? "no-username"}) удалил пост ${q.messageId} в чате ${chatId}`,
      );
      await q.answer({ text: "🗑 Удалено" });
    } catch (e: any) {
      const errorStr = String(e?.message || e);
      if (!errorStr.includes("MESSAGE_ID_INVALID")) {
        logger.warn("[Callback Delete Error]:", errorStr);
      }
      await q.answer({ text: "❌ Не удалось удалить", alert: true }).catch(() => {});
    }
  });
}
