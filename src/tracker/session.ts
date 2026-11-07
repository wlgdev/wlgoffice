import logger from "../logger";
import { pickVariant } from "../services/hls";
import type { TelegramMessagePort } from "../telegram/message-editor";
import { TrackerMatcher } from "./matcher";
import { buildTrackerMessage, formatClockTimestamp, TrackerStatusMessage } from "./message";
import type { TrackerStore } from "./store";
import type {
  TrackerHit,
  TrackerSessionState,
  TrackerTranscriber,
  TrackerTranscriberChunk,
  TrackerTranscriberFactory,
  TwitchTrackerPort,
} from "./types";

export type TrackerSessionEnd = "ended" | "stopped" | "superseded" | "unknown";

const MAX_STORED_HITS = 500;
const VOD_LOOKUP_INTERVAL_MS = 60_000;

export interface LiveSessionDeps {
  twitch: TwitchTrackerPort;
  telegram: TelegramMessagePort;
  store: TrackerStore;
  createTranscriber: TrackerTranscriberFactory;
  geminiApiKey: string;
  dedupeWindowSec: number;
  staleTimeoutMs: number;
  reconnectBackoffSec: number[];
  apiRetryAttempts: number;
  apiRetryDelaySec: number;
  sleep: (ms: number) => Promise<void>;
  minEditDelayMs?: number;
  debugTranscript?: boolean;
  timeOffsetSec?: number;
  vodLookupIntervalMs?: number;
}

export interface LiveSessionOptions {
  channel: string;
  broadcastId: string;
  streamTitle: string;
  startTimeMs: number;
  chatId: number | string;
  threadId?: number;
  aliases: Record<string, string[]>;
  messageId?: number;
  vodId?: string;
  vodTitle?: string;
  hits?: TrackerHit[];
  counts?: Record<string, number>;
  sentBytes?: number;
  receivedChars?: number;
  startedAt?: number;
}

/**
 * Сессия live-трекинга одного эфира: транскрибация, матчер, статусное сообщение,
 * переподключение при обрыве и корректное завершение.
 */
export class LiveSession {
  private readonly matcher: TrackerMatcher;
  private readonly message: TrackerStatusMessage;
  private hits: TrackerHit[];
  private counts: Record<string, number>;
  private messageId?: number;
  private vodId?: string;
  private vodTitle: string;
  private status: "active" | "closed" = "active";
  private stopped = false;
  private closed = false;
  private discarded = false;
  private lastAcceptedTimeSec = -1;
  private lastVodLookupAt = 0;
  private vodLookupRunning = false;
  private vodTimer?: ReturnType<typeof setInterval>;
  private transcriber?: TrackerTranscriber;
  private readonly startedAt: number;
  private sentBytes: number;
  private receivedChars: number;
  private pinnedMessageId?: number;

  constructor(
    private readonly deps: LiveSessionDeps,
    private readonly opts: LiveSessionOptions,
  ) {
    this.matcher = new TrackerMatcher(opts.aliases, { dedupeWindowSec: deps.dedupeWindowSec });
    this.hits = opts.hits ?? [];
    this.counts = { ...(opts.counts ?? {}) };
    this.sentBytes = opts.sentBytes ?? 0;
    this.receivedChars = opts.receivedChars ?? 0;
    this.messageId = opts.messageId;
    this.vodId = opts.vodId;
    this.vodTitle = opts.vodTitle?.trim() || opts.streamTitle;
    this.startedAt = opts.startedAt ?? Date.now();
    this.message = new TrackerStatusMessage(
      deps.telegram,
      opts.chatId,
      this.messageId,
      (rich) => buildTrackerMessage(this.state(), rich),
      (messageId) => {
        this.messageId = messageId;
        void this.pin();
        this.persist();
      },
      this.deps.minEditDelayMs,
      opts.threadId,
    );
  }

  updateAliases(aliases: Record<string, string[]>): void {
    this.matcher.setAliases(aliases);
  }

  stop(): void {
    this.stopped = true;
    this.transcriber?.stop();
  }

  /**
   * Останавливает сессию без сохранения состояния — канал удалён из настроек.
   */
  discard(): void {
    this.discarded = true;
    this.stop();
  }

  async run(): Promise<TrackerSessionEnd> {
    this.persist();
    this.startVodLookup();
    await this.pin();

    try {
      while (!this.stopped) {
        await this.runTranscriber();
        if (this.stopped) {
          break;
        }

        const decision = await this.classify();
        if (decision === "ended") {
          await this.close();
          return "ended";
        }
        if (decision === "new") {
          await this.close();
          return "superseded";
        }
        if (decision === "unknown") {
          return await this.abort();
        }

        const retry = await this.reconnect();
        if (retry === "ended") {
          await this.close();
          return "ended";
        }
        if (retry === "new") {
          await this.close();
          return "superseded";
        }
        if (retry === "unknown") {
          return await this.abort();
        }
      }

      await this.close();
      return "stopped";
    } catch (err) {
      logger.error(`[Tracker] Сессия канала ${this.opts.channel} аварийно завершилась:`, err);
      return "unknown";
    } finally {
      this.stopVodLookup();
    }
  }

  private startVodLookup(): void {
    if (this.vodId) {
      return;
    }
    void this.lookupVod(true);
    this.vodTimer = setInterval(() => {
      void this.lookupVod(true);
    }, this.deps.vodLookupIntervalMs ?? VOD_LOOKUP_INTERVAL_MS);
  }

  private stopVodLookup(): void {
    if (this.vodTimer) {
      clearInterval(this.vodTimer);
      this.vodTimer = undefined;
    }
  }

  private async abort(): Promise<TrackerSessionEnd> {
    if (!this.stopped) {
      return "unknown";
    }
    await this.close();
    return "stopped";
  }

  private async runTranscriber(): Promise<void> {
    let transcriber;
    try {
      const variants = await this.deps.twitch.liveVariants(this.opts.channel);
      const variant = pickVariant(variants, undefined, "cheapest");
      transcriber = this.deps.createTranscriber({
        hlsUrl: variant.url,
        geminiApiKey: this.deps.geminiApiKey,
        streamStartEpochMs: this.opts.startTimeMs,
        staleTimeoutMs: this.deps.staleTimeoutMs,
        onAudioSent: (bytes) => {
          this.sentBytes += bytes;
        },
      });
    } catch (err) {
      logger.warn(`[Tracker] Не удалось подключиться к аудио ${this.opts.channel}:`, err);
      return;
    }

    const unsubscribe = transcriber.onText((chunk) => {
      this.receivedChars += chunk.text.length;
      const adjusted = this.applyTimeOffset(chunk);
      this.logTranscript(adjusted);
      this.onText(adjusted);
    });
    this.transcriber = transcriber;

    try {
      await transcriber.start();
    } catch (err) {
      logger.warn(`[Tracker] Транскрайбер ${this.opts.channel} завершился с ошибкой:`, err);
    } finally {
      unsubscribe();
      this.transcriber = undefined;
    }
  }

  private applyTimeOffset(chunk: TrackerTranscriberChunk): TrackerTranscriberChunk {
    const offset = this.deps.timeOffsetSec ?? 0;
    if (!offset) {
      return chunk;
    }
    return { text: chunk.text, timeSec: chunk.timeSec + offset };
  }

  private logTranscript(chunk: TrackerTranscriberChunk): void {
    if (!this.deps.debugTranscript) {
      return;
    }
    const text = chunk.text.trim();
    if (!text) {
      return;
    }
    logger.info(`[${this.opts.channel}|${formatClockTimestamp(chunk.timeSec)}] ${text}`);
  }

  private onText(chunk: TrackerTranscriberChunk): void {
    if (this.stopped) {
      return;
    }
    if (chunk.timeSec < this.lastAcceptedTimeSec) {
      return;
    }
    this.lastAcceptedTimeSec = chunk.timeSec;

    void this.lookupVod();

    const hits = this.matcher.push(chunk);
    if (!hits.length) {
      return;
    }

    for (const hit of hits) {
      this.hits.push(hit);
      this.counts[hit.alias] = (this.counts[hit.alias] ?? 0) + 1;
    }
    if (this.hits.length > MAX_STORED_HITS) {
      this.hits = this.hits.slice(-MAX_STORED_HITS);
    }

    this.persist();
    this.message.refresh();
  }

  private async lookupVod(force = false): Promise<void> {
    if (this.vodId || this.vodLookupRunning) {
      return;
    }
    const now = Date.now();
    if (!force && now - this.lastVodLookupAt < VOD_LOOKUP_INTERVAL_MS) {
      return;
    }
    this.lastVodLookupAt = now;
    this.vodLookupRunning = true;

    try {
      const vod = await this.deps.twitch.findLiveVod(this.opts.channel, this.opts.broadcastId);
      if (vod) {
        this.vodId = vod.vodId;
        this.vodTitle = vod.title?.trim() || this.vodTitle;
        this.persist();
        this.stopVodLookup();
        this.message.refreshExisting();
      }
    } catch (err) {
      logger.warn(`[Tracker] Не удалось найти VOD для ${this.opts.channel}:`, err);
    } finally {
      this.vodLookupRunning = false;
    }
  }

  private async classify(): Promise<"same" | "ended" | "new" | "unknown"> {
    for (let attempt = 1; attempt <= this.deps.apiRetryAttempts; attempt++) {
      try {
        const info = await this.deps.twitch.streamInfo(this.opts.channel);
        if (!info.online) {
          return "ended";
        }
        if (String(info.id) !== String(this.opts.broadcastId)) {
          return "new";
        }
        return "same";
      } catch (err) {
        logger.warn(
          `[Tracker] Не удалось уточнить статус ${this.opts.channel} (попытка ${attempt}/${this.deps.apiRetryAttempts}):`,
          err,
        );
        if (attempt < this.deps.apiRetryAttempts) {
          await this.deps.sleep(this.deps.apiRetryDelaySec * 1000);
        }
      }
    }
    return "unknown";
  }

  private async reconnect(): Promise<"same" | "ended" | "new" | "unknown"> {
    for (const delay of this.deps.reconnectBackoffSec) {
      if (this.stopped) {
        return "unknown";
      }
      await this.deps.sleep(delay * 1000);
      const decision = await this.classify();
      if (decision !== "unknown") {
        return decision;
      }
    }
    return "unknown";
  }

  private async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.status = "closed";
    await this.resolveVodOnClose();
    await this.message.flushExisting();
    await this.unpin();
    this.persist();
  }

  private async pin(): Promise<void> {
    const messageId = this.messageId;
    if (!messageId || this.pinnedMessageId === messageId) {
      return;
    }
    try {
      await this.deps.telegram.pinMessage(this.opts.chatId, messageId);
      this.pinnedMessageId = messageId;
    } catch (err) {
      logger.warn(`[Tracker] Не удалось закрепить статус ${this.opts.channel}:`, err);
    }
  }

  private async unpin(): Promise<void> {
    const messageId = this.pinnedMessageId;
    if (!messageId) {
      return;
    }
    this.pinnedMessageId = undefined;
    try {
      await this.deps.telegram.unpinMessage(this.opts.chatId, messageId);
    } catch (err) {
      logger.warn(`[Tracker] Не удалось открепить статус ${this.opts.channel}:`, err);
    }
  }

  private async resolveVodOnClose(): Promise<void> {
    for (let attempt = 1; attempt <= 3 && !this.vodId; attempt++) {
      await this.lookupVod(true);
      if (this.vodId) {
        return;
      }
      if (attempt < 3) {
        await this.deps.sleep(5000);
      }
    }
  }

  state(): TrackerSessionState {
    return {
      channel: this.opts.channel,
      broadcastId: this.opts.broadcastId,
      chatId: this.opts.chatId,
      threadId: this.opts.threadId,
      messageId: this.messageId,
      vodId: this.vodId,
      vodTitle: this.vodTitle,
      hits: this.hits,
      counts: this.counts,
      sentBytes: this.sentBytes,
      receivedChars: this.receivedChars,
      startedAt: this.startedAt,
      startTimeMs: this.opts.startTimeMs,
      updatedAt: Date.now(),
      status: this.status,
    };
  }

  private persist(): void {
    if (this.discarded) {
      return;
    }
    this.deps.store.saveSession(this.state());
  }
}
