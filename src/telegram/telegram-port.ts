import { type Message, tl, type TelegramClient } from "@mtcute/bun";

import { toTelegramHtml } from "./formatters";
import type { TelegramMessagePort } from "./message-editor";

type MediaBlockId = Extract<tl.TypePageBlock, { _: "pageBlockVideo" }>["videoId"];

function mediaBlockId(block: tl.TypePageBlock): MediaBlockId | undefined {
  switch (block._) {
    case "pageBlockVideo":
      return block.videoId;
    case "pageBlockAudio":
      return block.audioId;
    case "pageBlockDocument":
      return block.documentId;
    default:
      return undefined;
  }
}

/**
 * Собирает Bot API file_id всех медиа-блоков сообщения — по нему вложения
 * можно переиспользовать без повторной загрузки на сервер Telegram.
 */
function extractMediaFileIds(message: Message): string[] {
  const rich = message.richMessage;
  if (!rich) {
    return [];
  }

  const fileIds: string[] = [];
  for (const block of rich.blocks) {
    const id = mediaBlockId(block);
    if (!id) {
      continue;
    }
    const document = rich.documents.get(id);
    if (document) {
      fileIds.push(document.fileId);
    }
  }
  return fileIds;
}

export function createTelegramPort(tg: TelegramClient): TelegramMessagePort {
  return {
    async sendText(chatId, htmlText, options) {
      const message = await tg.sendText(chatId, toTelegramHtml(htmlText), {
        disableWebPreview: options?.disableWebPreview,
        threadId: options?.threadId,
      });
      return { id: message.id };
    },
    async sendRich(chatId, htmlText, options) {
      const message = await tg.sendRichMessage(chatId, {
        content: { type: "html", content: htmlText, attachments: options?.attachments },
        threadId: options?.threadId,
        replyTo: options?.replyTo,
      });
      return { id: message.id, mediaFileIds: extractMediaFileIds(message) };
    },
    async editMessage(chatId, messageId, htmlText, options) {
      await tg.editMessage({
        chatId,
        message: messageId,
        text: toTelegramHtml(htmlText),
        disableWebPreview: options?.disableWebPreview,
      });
    },
    async editRich(chatId, messageId, htmlText, options) {
      const message = await tg.editMessage({
        chatId,
        message: messageId,
        richMessage: { type: "html", content: htmlText, attachments: options?.attachments },
        disableWebPreview: options?.disableWebPreview,
      });
      return { id: message.id, mediaFileIds: extractMediaFileIds(message) };
    },
    async deleteMessage(chatId, messageId) {
      await tg.deleteMessagesById(chatId, [messageId]);
    },
    async pinMessage(chatId, messageId) {
      await tg.pinMessage({ chatId, message: messageId });
    },
    async unpinMessage(chatId, messageId) {
      await tg.unpinMessage({ chatId, message: messageId });
    },
  };
}
