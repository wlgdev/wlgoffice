import logger from "../logger";
import { buildTrackerMessage } from "./message";
import { LiveSession, type LiveSessionDeps } from "./session";
import type { TrackerStore } from "./store";
import type { TrackerChannelSettings, TrackerSessionState, TrackerSettings, TrackerStreamInfo } from "./types";

export interface TrackerServiceDeps extends LiveSessionDeps {
  defaultChatId: number | string;
  defaultThreadId?: number;
  pollIntervalSec: number;
}

/**
 * Сервис трекера: по крону сверяет настройки с состоянием эфиров и поднимает сессии.
 */
export class TrackerService {
  private readonly sessions = new Map<string, LiveSession>();
  private cronJob?: { stop(): void };
  private ticking = false;

  constructor(private readonly deps: TrackerServiceDeps) {}

  getSettings(): TrackerSettings {
    return this.deps.store.getSettings();
  }

  saveSettings(settings: TrackerSettings): void {
    this.deps.store.saveSettings(settings);
  }

  start(): void {
    if (this.cronJob) {
      return;
    }

    const minutes = Math.max(1, Math.round(this.deps.pollIntervalSec / 60));
    this.cronJob = Bun.cron(`*/${minutes} * * * *`, () => {
      void this.tick();
    });
    logger.info(`[Tracker] Крон запущен (каждые ${this.deps.pollIntervalSec}с)`);
    void this.tick();
  }

  stop(): void {
    this.cronJob?.stop();
    this.cronJob = undefined;
    for (const session of this.sessions.values()) {
      session.stop();
    }
    this.sessions.clear();
  }

  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      await this.reconcile();
    } catch (err) {
      logger.error("[Tracker] Ошибка сверки состояния:", err);
    } finally {
      this.ticking = false;
    }
  }

  private async reconcile(): Promise<void> {
    const settings = this.deps.store.getSettings();

    for (const [channel, channelSettings] of Object.entries(settings.channels)) {
      if (!channelSettings.enabled) {
        this.stopSession(channel);
        continue;
      }

      const session = this.sessions.get(channel);
      if (session) {
        session.updateAliases(channelSettings.aliases);
        continue;
      }

      await this.startSession(channel, channelSettings);
    }

    for (const channel of [...this.sessions.keys()]) {
      if (!settings.channels[channel]) {
        this.discardSession(channel);
      }
    }

    for (const channel of this.deps.store.listSessionChannels()) {
      if (!settings.channels[channel]) {
        this.deps.store.removeSession(channel);
      }
    }
  }

  private async startSession(channel: string, channelSettings: TrackerChannelSettings): Promise<void> {
    let info: TrackerStreamInfo;
    try {
      info = await this.deps.twitch.streamInfo(channel);
    } catch (err) {
      logger.warn(`[Tracker] Не удалось проверить канал ${channel}:`, err);
      return;
    }

    const stored = this.deps.store.getSession(channel);

    if (!info.online) {
      if (stored && stored.status === "active") {
        await this.closeStoredSession(stored);
      }
      return;
    }

    const broadcastId = String(info.id);
    let resume: TrackerSessionState | undefined;

    if (stored && stored.status === "active") {
      if (stored.broadcastId === broadcastId) {
        resume = stored;
      } else {
        await this.closeStoredSession(stored);
      }
    }

    const session = new LiveSession(this.deps, {
      channel,
      broadcastId,
      streamTitle: info.title,
      startTimeMs: resume?.startTimeMs ?? info.start_time,
      chatId: resume?.chatId ?? channelSettings.chatId ?? this.deps.defaultChatId,
      threadId: resume?.threadId ?? channelSettings.threadId ?? this.deps.defaultThreadId,
      aliases: channelSettings.aliases,
      messageId: resume?.messageId,
      vodId: resume?.vodId,
      vodTitle: resume?.vodTitle ?? info.title,
      hits: resume?.hits,
      counts: resume?.counts,
      startedAt: resume?.startedAt,
    });

    this.sessions.set(channel, session);
    logger.info(`[Tracker] Сессия ${channel} запущена (эфир ${broadcastId})`);

    void session
      .run()
      .then((result) => {
        if (this.sessions.get(channel) === session) {
          this.sessions.delete(channel);
        }
        logger.info(`[Tracker] Сессия ${channel} завершилась: ${result}`);
      })
      .catch((err) => {
        logger.error(`[Tracker] Сессия ${channel} упала:`, err);
      });
  }

  private stopSession(channel: string): void {
    const session = this.sessions.get(channel);
    if (!session) {
      return;
    }
    this.sessions.delete(channel);
    session.stop();
  }

  private discardSession(channel: string): void {
    const session = this.sessions.get(channel);
    if (session) {
      this.sessions.delete(channel);
      session.discard();
    }
    this.deps.store.removeSession(channel);
  }

  private async closeStoredSession(state: TrackerSessionState): Promise<void> {
    const closed: TrackerSessionState = { ...state, status: "closed", updatedAt: Date.now() };
    this.deps.store.saveSession(closed);

    if (!closed.messageId) {
      return;
    }

    try {
      await this.deps.telegram.editMessage(closed.chatId, closed.messageId, buildTrackerMessage(closed), {
        disableWebPreview: true,
      });
    } catch (err) {
      logger.warn(`[Tracker] Не удалось закрыть статус ${closed.channel}:`, err);
    }
  }
}
