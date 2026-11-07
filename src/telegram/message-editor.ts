import type { InputRichMessageMedia } from "@mtcute/bun";

import logger from "../logger";

export type MessageEditError = "message_not_modified" | "message_id_invalid" | "chat_write_forbidden" | "unknown";

export interface TelegramMessagePortOptions {
  disableWebPreview?: boolean;
  threadId?: number;
  replyTo?: number;
  attachments?: Record<string, InputRichMessageMedia>;
}

export interface RichMessageResult {
  id: number;
  mediaFileIds: string[];
}

export interface TelegramMessagePort {
  sendText(chatId: number | string, htmlText: string, options?: TelegramMessagePortOptions): Promise<{ id: number }>;
  sendRich(
    chatId: number | string,
    htmlText: string,
    options?: TelegramMessagePortOptions,
  ): Promise<RichMessageResult>;
  editMessage(
    chatId: number | string,
    messageId: number,
    htmlText: string,
    options?: TelegramMessagePortOptions,
  ): Promise<void>;
  editRich(
    chatId: number | string,
    messageId: number,
    htmlText: string,
    options?: TelegramMessagePortOptions,
  ): Promise<RichMessageResult>;
  deleteMessage(chatId: number | string, messageId: number): Promise<void>;
  pinMessage(chatId: number | string, messageId: number): Promise<void>;
  unpinMessage(chatId: number | string, messageId: number): Promise<void>;
}

export function classifyTelegramError(err: unknown): MessageEditError {
  const text = String((err as { message?: unknown })?.message || err);
  if (text.includes("MESSAGE_NOT_MODIFIED")) {
    return "message_not_modified";
  }
  if (text.includes("MESSAGE_ID_INVALID")) {
    return "message_id_invalid";
  }
  if (text.includes("CHAT_WRITE_FORBIDDEN") || text.includes("CHAT_ADMIN_REQUIRED")) {
    return "chat_write_forbidden";
  }
  return "unknown";
}

/**
 * Базовый редактор Telegram-сообщений: троттлинг правок, ленивое создание и коды ошибок.
 */
export abstract class MessageEditor {
  public messageId: number | undefined;
  protected disableLinkPreview = false;
  private lastEditAt = 0;
  private lastEditText = "";
  private pendingText: string | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    protected readonly port: TelegramMessagePort,
    public readonly chatId: number | string,
    messageId?: number,
    private readonly minEditDelayMs = 1500,
  ) {
    this.messageId = messageId;
  }

  protected abstract renderText(): string;

  protected async createMessage(text: string): Promise<number> {
    throw new Error("Создание сообщений не поддерживается");
  }

  protected async editMessage(text: string): Promise<void> {
    await this.port.editMessage(this.chatId, this.messageId!, text, {
      disableWebPreview: this.disableLinkPreview,
    });
  }

  protected onMessageCreated(_messageId: number): void {}

  protected handleEditError(_code: MessageEditError, _text: string): void {}

  refresh(): void {
    this.schedule(this.renderText());
  }

  refreshExisting(): void {
    if (this.messageId === undefined) {
      return;
    }
    this.schedule(this.renderText());
  }

  schedule(text: string): void {
    if (text === this.lastEditText || text === this.pendingText) {
      return;
    }
    this.pendingText = text;

    const wait = this.minEditDelayMs - (Date.now() - this.lastEditAt);
    if (wait <= 0) {
      void this.applyPending();
    } else if (!this.pendingTimer) {
      this.pendingTimer = setTimeout(() => {
        this.pendingTimer = null;
        void this.applyPending();
      }, wait);
    }
  }

  async flush(text?: string): Promise<MessageEditError | null> {
    this.clearTimer();
    const finalText = text ?? this.renderText();
    if (finalText === this.lastEditText && this.pendingText === null) {
      return null;
    }
    return await this.applyStatus(finalText);
  }

  async flushExisting(text?: string): Promise<MessageEditError | null> {
    if (this.messageId === undefined) {
      return null;
    }
    return await this.flush(text);
  }

  dropPending(): void {
    this.clearTimer();
    this.pendingText = null;
  }

  async delete(): Promise<void> {
    this.dropPending();
    if (this.messageId === undefined) {
      return;
    }
    try {
      await this.port.deleteMessage(this.chatId, this.messageId);
    } catch (err) {
      const text = String(err);
      if (!text.includes("MESSAGE_ID_INVALID") && !text.includes("MESSAGE_DELETE_FORBIDDEN")) {
        logger.warn("[Telegram Delete Error]:", text);
      }
    }
  }

  protected clearTimer(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
  }

  private async applyPending(): Promise<void> {
    if (this.pendingText === null) {
      return;
    }
    const text = this.pendingText;
    const code = await this.applyStatus(text);
    if (code) {
      this.handleEditError(code, text);
    }
  }

  protected applyStatus(text: string): Promise<MessageEditError | null> {
    const result = this.queue.then(() => this.applyStatusNow(text));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async applyStatusNow(text: string): Promise<MessageEditError | null> {
    this.pendingText = null;

    if (this.messageId !== undefined && text === this.lastEditText) {
      return null;
    }

    if (this.messageId === undefined) {
      try {
        const messageId = await this.createMessage(text);
        this.messageId = messageId;
        this.lastEditText = text;
        this.lastEditAt = Date.now();
        this.onMessageCreated(messageId);
        return null;
      } catch (err) {
        const code = classifyTelegramError(err);
        if (code === "unknown") {
          logger.warn("[Telegram Send Error]:", String(err));
        }
        return code;
      }
    }

    try {
      await this.editMessage(text);
      this.lastEditText = text;
      this.lastEditAt = Date.now();
      return null;
    } catch (err) {
      const code = classifyTelegramError(err);
      if (code === "message_not_modified") {
        this.lastEditText = text;
        return null;
      }
      if (code === "unknown") {
        logger.warn("[Telegram Edit Error]:", String(err));
      }
      return code;
    }
  }
}
