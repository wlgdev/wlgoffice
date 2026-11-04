import { buildStatusMessage } from "./formatters";
import { type MessageEditError, MessageEditor, type TelegramMessagePort } from "./message-editor";

export class StatusTracker extends MessageEditor {
  constructor(
    port: TelegramMessagePort,
    chatId: number | string,
    messageId: number,
    public readonly vodId: string,
    public readonly lines: string[],
    private readonly subtitle?: string,
  ) {
    super(port, chatId, messageId);
  }

  setLine(index: number, text: string): void {
    this.lines[index] = text;
    this.schedule(this.formatMessage());
  }

  formatMessage(header?: string): string {
    return buildStatusMessage(this.vodId, this.lines, header, this.subtitle);
  }

  protected renderText(): string {
    return this.formatMessage();
  }

  override async flush(header?: string): Promise<MessageEditError | null> {
    return await super.flush(header === undefined ? undefined : this.formatMessage(header));
  }

  async recordFatal(fatalText: string): Promise<void> {
    this.dropPending();
    const finalLines = [...this.lines, fatalText];
    const text = buildStatusMessage(this.vodId, finalLines, "💥 <b>Обработка прервана</b>", this.subtitle);
    await this.applyStatus(text);
  }
}
