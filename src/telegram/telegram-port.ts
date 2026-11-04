import type { TelegramClient } from "@mtcute/bun";

import { toTelegramHtml } from "./formatters";
import type { TelegramMessagePort } from "./message-editor";

export function createTelegramPort(tg: TelegramClient): TelegramMessagePort {
  return {
    async sendText(chatId, htmlText, options) {
      const message = await tg.sendText(chatId, toTelegramHtml(htmlText), {
        disableWebPreview: options?.disableWebPreview,
        threadId: options?.threadId,
      });
      return { id: message.id };
    },
    async editMessage(chatId, messageId, htmlText, options) {
      await tg.editMessage({
        chatId,
        message: messageId,
        text: toTelegramHtml(htmlText),
        disableWebPreview: options?.disableWebPreview,
      });
    },
    async deleteMessage(chatId, messageId) {
      await tg.deleteMessagesById(chatId, [messageId]);
    },
  };
}
