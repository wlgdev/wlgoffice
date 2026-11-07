import type { TelegramClient } from "@mtcute/bun";
import type { Dispatcher } from "@mtcute/dispatcher";

import config from "../../config";
import logger from "../../logger";
import type { DB } from "../../services/db";
import { parseDeleteMediaData } from "../formatters";
import { removeMediaJobItem } from "../media-job";
import { createTelegramPort } from "../telegram-port";

export function setupCallbackHandler(dp: Dispatcher, tg: TelegramClient, db: DB): void {
  dp.onCallbackQuery(async (q) => {
    const itemId = parseDeleteMediaData(q.dataStr ?? "");
    if (itemId === null) {
      return;
    }

    const chatId = q.chat.id;
    const allowed = config.telegram.chatIds.includes(Number(chatId)) || config.interop.chatIds.includes(Number(chatId));

    if (!allowed) {
      await q.answer({ text: "🚫 Этот чат не разрешён", alert: true });
      return;
    }

    try {
      const result = await removeMediaJobItem({
        port: createTelegramPort(tg),
        db,
        chatId,
        messageId: q.messageId,
        itemId,
      });

      if (result === "missing") {
        await q.answer({ text: "⚠️ Результат не найден" });
        return;
      }
      if (result === "unchanged") {
        await q.answer({ text: "🗑 Уже удалено" });
        return;
      }
      if (result === "failed") {
        await q.answer({ text: "❌ Не удалось удалить", alert: true });
        return;
      }
      if (result === "empty") {
        await q.answer({ text: "🗑 Удалено, сообщение удалено" });
        logger.info(`[Delete] ${q.user.id} удалил последний блок сообщения ${q.messageId} в чате ${chatId}`);
        return;
      }

      await q.answer({ text: "🗑 Удалено" });
      logger.info(
        `[Delete] ${q.user.id} (@${q.user.username ?? "no-username"}) удалил блок ${itemId} в сообщении ${q.messageId} (чат ${chatId})`,
      );
    } catch (e: any) {
      const errorStr = String(e?.message || e);
      if (!errorStr.includes("MESSAGE_ID_INVALID")) {
        logger.warn("[Callback Delete Error]:", errorStr);
      }
      await q.answer({ text: "❌ Не удалось удалить", alert: true }).catch(() => {});
    }
  });
}
