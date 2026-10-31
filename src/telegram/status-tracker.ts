import type { TelegramClient } from "@mtcute/bun";

import logger from "../logger";
import { buildStatusMessage, toTelegramHtml } from "./formatters";

export class StatusTracker {
  private readonly minEditDelayMs = 1500;
  private lastEditAt = 0;
  private lastEditText = "";
  private pendingText: string | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly tg: TelegramClient,
    public readonly chatId: number | string,
    public readonly messageId: number,
    public readonly vodId: string,
    public readonly lines: string[],
    private readonly subtitle?: string,
  ) {}

  setLine(index: number, text: string): void {
    this.lines[index] = text;
    this.schedule(this.formatMessage());
  }

  formatMessage(header?: string): string {
    return buildStatusMessage(this.vodId, this.lines, header, this.subtitle);
  }

  schedule(rawText: string): void {
    if (rawText === this.lastEditText || rawText === this.pendingText) {
      return;
    }
    this.pendingText = rawText;

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

  async flush(header?: string): Promise<void> {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    const text = this.formatMessage(header);
    if (text === this.lastEditText && this.pendingText === null) {
      return;
    }
    await this.applyStatus(text);
  }

  dropPending(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    this.pendingText = null;
  }

  async delete(): Promise<void> {
    this.dropPending();
    try {
      await this.tg.deleteMessagesById(this.chatId, [this.messageId]);
    } catch (e: any) {
      const errorStr = String(e?.message || e);
      if (!errorStr.includes("MESSAGE_ID_INVALID") && !errorStr.includes("MESSAGE_DELETE_FORBIDDEN")) {
        logger.warn("[Telegram Delete Error]:", errorStr);
      }
    }
  }

  async recordFatal(fatalText: string): Promise<void> {
    this.dropPending();
    const finalLines = [...this.lines, fatalText];
    const text = buildStatusMessage(this.vodId, finalLines, "💥 <b>Обработка прервана</b>", this.subtitle);
    await this.applyStatus(text);
  }

  private async applyPending(): Promise<void> {
    if (this.pendingText === null) {
      return;
    }
    await this.applyStatus(this.pendingText);
  }

  private async applyStatus(rawText: string): Promise<void> {
    this.pendingText = null;
    this.lastEditText = rawText;
    this.lastEditAt = Date.now();

    try {
      await this.tg.editMessage({
        chatId: this.chatId,
        message: this.messageId,
        text: toTelegramHtml(rawText),
      });
    } catch (e: any) {
      const errorStr = String(e?.message || e);
      if (
        !errorStr.includes("MESSAGE_NOT_MODIFIED") &&
        !errorStr.includes("MESSAGE_ID_INVALID") &&
        !errorStr.includes("CHAT_WRITE_FORBIDDEN")
      ) {
        logger.warn("[Telegram Edit Error]:", errorStr);
      }
    }
  }
}
