import type { StreamVariant } from "../../src/core/types";
import type {
  RichMessageResult,
  TelegramMessagePort,
  TelegramMessagePortOptions,
} from "../../src/telegram/message-editor";
import type {
  TrackerStreamInfo,
  TrackerTranscriber,
  TrackerTranscriberChunk,
  TrackerTranscriberOptions,
  TrackerVodInfo,
  TwitchTrackerPort,
} from "../../src/tracker/types";

export class FakeTelegram implements TelegramMessagePort {
  sent: { chatId: number | string; text: string; disableWebPreview?: boolean; threadId?: number; rich?: boolean }[] =
    [];
  edits: { chatId: number | string; messageId: number; text: string; disableWebPreview?: boolean; rich?: boolean }[] =
    [];
  deleted: { chatId: number | string; messageId: number }[] = [];
  pinned: { chatId: number | string; messageId: number }[] = [];
  unpinned: { chatId: number | string; messageId: number }[] = [];
  editError?: Error;
  sendError?: Error;
  richError?: Error;
  private nextId = 1000;

  async sendText(
    chatId: number | string,
    htmlText: string,
    options?: TelegramMessagePortOptions,
  ): Promise<{ id: number }> {
    if (this.sendError) {
      throw this.sendError;
    }
    this.sent.push({
      chatId,
      text: htmlText,
      disableWebPreview: options?.disableWebPreview,
      threadId: options?.threadId,
    });
    return { id: this.nextId++ };
  }

  async sendRich(
    chatId: number | string,
    htmlText: string,
    options?: TelegramMessagePortOptions,
  ): Promise<RichMessageResult> {
    if (this.richError) {
      throw this.richError;
    }
    if (this.sendError) {
      throw this.sendError;
    }
    this.sent.push({
      chatId,
      text: htmlText,
      disableWebPreview: options?.disableWebPreview,
      threadId: options?.threadId,
      rich: true,
    });
    return { id: this.nextId++, mediaFileIds: [] };
  }

  async editMessage(
    chatId: number | string,
    messageId: number,
    htmlText: string,
    options?: TelegramMessagePortOptions,
  ): Promise<void> {
    if (this.editError) {
      throw this.editError;
    }
    this.edits.push({ chatId, messageId, text: htmlText, disableWebPreview: options?.disableWebPreview });
  }

  async editRich(
    chatId: number | string,
    messageId: number,
    htmlText: string,
    options?: TelegramMessagePortOptions,
  ): Promise<RichMessageResult> {
    if (this.richError) {
      throw this.richError;
    }
    if (this.editError) {
      throw this.editError;
    }
    this.edits.push({
      chatId,
      messageId,
      text: htmlText,
      disableWebPreview: options?.disableWebPreview,
      rich: true,
    });
    return { id: messageId, mediaFileIds: [] };
  }

  async deleteMessage(chatId: number | string, messageId: number): Promise<void> {
    this.deleted.push({ chatId, messageId });
  }

  async pinMessage(chatId: number | string, messageId: number): Promise<void> {
    this.pinned.push({ chatId, messageId });
  }

  async unpinMessage(chatId: number | string, messageId: number): Promise<void> {
    this.unpinned.push({ chatId, messageId });
  }
}

export class FakeTwitch implements TwitchTrackerPort {
  online = true;
  broadcastId = "broadcast-1";
  title = "Стрим";
  startTime = 1_700_000_000_000;
  vod: TrackerVodInfo | null = { vodId: "vod-1", title: "VOD" };
  streamInfoError?: Error;
  variantsError?: Error;
  variants: StreamVariant[] = [
    {
      bandwidth: 160_000,
      resolution: "",
      video: "",
      framerate: "",
      codecs: "mp4a.40.2",
      url: "https://example.com/audio.m3u8",
    },
  ];
  streamInfoCalls = 0;

  async streamInfo(): Promise<TrackerStreamInfo> {
    this.streamInfoCalls++;
    if (this.streamInfoError) {
      throw this.streamInfoError;
    }
    return {
      online: this.online,
      id: this.broadcastId,
      title: this.title,
      start_time: this.startTime,
    };
  }

  async liveVariants(): Promise<StreamVariant[]> {
    if (this.variantsError) {
      throw this.variantsError;
    }
    return this.variants;
  }

  async findLiveVod(): Promise<TrackerVodInfo | null> {
    return this.vod;
  }
}

export class FakeTranscriber implements TrackerTranscriber {
  private handlers = new Set<(chunk: TrackerTranscriberChunk) => void>();
  private release?: () => void;
  stopped = false;
  started = false;

  constructor(public readonly options: TrackerTranscriberOptions) {}

  async start(): Promise<void> {
    this.started = true;
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  stop(): void {
    this.stopped = true;
    this.release?.();
  }

  onText(handler: (chunk: TrackerTranscriberChunk) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(text: string, timeSec: number): void {
    for (const handler of [...this.handlers]) {
      handler({ text, timeSec });
    }
  }

  sendAudio(bytes: number): void {
    this.options.onAudioSent?.(bytes);
  }
}

export function createTranscriberFactory(): {
  factory: (options: TrackerTranscriberOptions) => TrackerTranscriber;
  created: FakeTranscriber[];
} {
  const created: FakeTranscriber[] = [];
  return {
    created,
    factory: (options) => {
      const transcriber = new FakeTranscriber(options);
      created.push(transcriber);
      return transcriber;
    },
  };
}

export async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("waitFor: условие не выполнилось");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
