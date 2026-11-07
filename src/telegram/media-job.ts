import { InputMedia, type InputRichMessageMedia } from "@mtcute/bun";

import logger from "../logger";
import type { DB } from "../services/db";
import { buildMediaErrorBlock, buildMediaSkippedBlock, escapeHtml } from "./formatters";
import { MessageEditor, type TelegramMessagePort } from "./message-editor";

export type MediaJobMediaType = "video" | "audio" | "document";

export interface MediaJobMedia {
  type: MediaJobMediaType;
  fileId: string | null;
  localPath: string | null;
  width: number;
  height: number;
  duration: number;
}

export interface MediaJobItem {
  id: number;
  range: string;
  vodUrl: string;
  vodLabel: string;
  stage: string | null;
  block: string | null;
  media: MediaJobMedia | null;
}

export interface MediaJobSnapshot {
  title: string;
  source: string;
  notes: string[];
  items: MediaJobItem[];
}

export type RemoveItemResult = "removed" | "empty" | "missing" | "unchanged" | "failed";

const liveJobs = new Map<string, MediaJobMessage>();

function liveKey(chatId: number | string, messageId: number): string {
  return `${chatId}:${messageId}`;
}

function snapshotKey(chatId: number | string, messageId: number): string {
  return `mediajob:${chatId}:${messageId}`;
}

function describeError(err: unknown): string {
  const message = (err as { message?: unknown })?.message;
  const text = typeof message === "string" && message ? message : String(err);
  return text.slice(0, 200);
}

function mediaTag(type: MediaJobMediaType, key: string): string {
  if (type === "video") {
    return `<video src="tg://video?id=${key}"></video>`;
  }
  if (type === "audio") {
    return `<audio src="tg://audio?id=${key}"></audio>`;
  }
  return `<tg-document src="tg://document?id=${key}"></tg-document>`;
}

function mediaAttachment(media: MediaJobMedia): InputRichMessageMedia | null {
  if (media.fileId) {
    return media.fileId;
  }
  if (!media.localPath) {
    return null;
  }
  if (media.type === "video") {
    return InputMedia.video(`file:${media.localPath}`, {
      duration: media.duration,
      width: media.width,
      height: media.height,
      supportsStreaming: true,
    });
  }
  if (media.type === "audio") {
    return InputMedia.audio(`file:${media.localPath}`, { duration: media.duration });
  }
  return InputMedia.document(`file:${media.localPath}`);
}

/**
 * Собирает rich-сообщение медиа-задачи: карточка статуса (пока есть незавершённые
 * интервалы) и готовые блоки результатов с кнопками.
 */
export function renderMediaJob(snapshot: MediaJobSnapshot): {
  html: string;
  attachments: Record<string, InputRichMessageMedia>;
} {
  const attachments: Record<string, InputRichMessageMedia> = {};
  const parts: string[] = [];
  const pending = snapshot.items.filter((item) => !item.block);

  if (pending.length) {
    parts.push(`<h3>${snapshot.title}</h3>`);
    parts.push(
      `<p>${snapshot.source} · обработано ${snapshot.items.length - pending.length} из ${snapshot.items.length}</p>`,
    );
    for (const note of snapshot.notes) {
      parts.push(`<p>${note}</p>`);
    }
    parts.push(
      `<ul>${pending
        .map((item) => {
          const stage = item.stage ?? `⏳ [${item.id}/${snapshot.items.length}] ${escapeHtml(item.range)} - ожидание…`;
          return `<li>${stage}</li>`;
        })
        .join("")}</ul>`,
    );
  }

  let key = 0;
  for (const item of snapshot.items) {
    if (!item.block) {
      continue;
    }
    const attachment = item.media ? mediaAttachment(item.media) : null;
    if (attachment && item.media) {
      key += 1;
      attachments[String(key)] = attachment;
      parts.push(mediaTag(item.media.type, String(key)));
    }
    parts.push(item.block);
  }

  return { html: parts.join(""), attachments };
}

/**
 * Сообщение медиа-задачи: один rich-сообщение на всю задачу, в котором сначала
 * виден статус, а затем вместо него — блоки результатов с кнопками удаления.
 */
export class MediaJobMessage extends MessageEditor {
  private snapshot: MediaJobSnapshot;
  private lastError: string | null = null;
  private lastSentHtml: string | null = null;

  constructor(
    port: TelegramMessagePort,
    chatId: number | string,
    messageId: number | undefined,
    snapshot: MediaJobSnapshot,
    private readonly db: DB,
    private readonly threadId?: number,
    private readonly replyTo?: number,
  ) {
    super(port, chatId, messageId);
    this.snapshot = snapshot;
  }

  protected override renderText(): string {
    return renderMediaJob(this.snapshot).html;
  }

  protected override async createMessage(text: string): Promise<number> {
    const { html, attachments } = renderMediaJob(this.snapshot);
    try {
      const result = await this.port.sendRich(this.chatId, html, {
        attachments,
        threadId: this.threadId,
        replyTo: this.replyTo,
      });
      this.lastSentHtml = html;
      this.captureMedia(result.mediaFileIds);
      return result.id;
    } catch (err) {
      this.lastError = describeError(err);
      throw err;
    }
  }

  protected override async editMessage(text: string): Promise<void> {
    const { html, attachments } = renderMediaJob(this.snapshot);
    if (html === this.lastSentHtml) {
      return;
    }
    try {
      const result = await this.port.editRich(this.chatId, this.messageId!, html, {
        attachments,
        threadId: this.threadId,
      });
      this.lastSentHtml = html;
      this.captureMedia(result.mediaFileIds);
    } catch (err) {
      this.lastError = describeError(err);
      throw err;
    }
  }

  protected override onMessageCreated(messageId: number): void {
    liveJobs.set(liveKey(this.chatId, messageId), this);
  }

  get error(): string | null {
    return this.lastError;
  }

  setStage(itemId: number, stage: string): void {
    const item = this.findItem(itemId);
    if (!item) {
      return;
    }
    item.stage = stage;
    this.persist();
    this.refresh();
  }

  /**
   * Прикрепляет медиа к блоку результата и перерисовывает сообщение.
   * Возвращает false, если загрузка в Telegram не удалась — тогда блок
   * заменяется на блок с ошибкой.
   */
  async complete(
    itemId: number,
    params: { media: MediaJobMedia; block: string; stage: string; elapsedSec: number },
  ): Promise<boolean> {
    const item = this.findItem(itemId);
    if (!item) {
      return false;
    }

    const stageCode = await this.flush();
    if (stageCode) {
      logger.warn(`[MediaJob] Не удалось отрисовать стадию «${params.stage}» (${stageCode})`);
    }

    item.stage = null;
    item.media = params.media;
    item.block = params.block;
    this.persist();

    const code = await this.flush();
    if (!code) {
      return true;
    }

    const detail = this.lastError ?? "неизвестная ошибка";
    this.lastError = null;
    this.setErrorBlock(itemId, params.stage, detail, params.elapsedSec);
    const errorCode = await this.flush();
    if (errorCode) {
      logger.warn(`[MediaJob] Не удалось отрисовать блок ошибки (${errorCode}):`, this.lastError);
    }
    return false;
  }

  fail(itemId: number, params: { stage: string; detail: string; elapsedSec: number }): void {
    this.setErrorBlock(itemId, params.stage, params.detail, params.elapsedSec);
    this.persist();
    this.refresh();
  }

  skip(itemId: number, reason: string): void {
    const item = this.findItem(itemId);
    if (!item) {
      return;
    }
    item.stage = null;
    item.media = null;
    item.block = buildMediaSkippedBlock({
      itemId: item.id,
      range: item.range,
      vodUrl: item.vodUrl,
      vodLabel: item.vodLabel,
      reason,
    });
    this.persist();
    this.refresh();
  }

  abort(detail: string): void {
    for (const item of this.snapshot.items) {
      if (item.block) {
        continue;
      }
      this.setErrorBlock(item.id, "обработка", detail, 0);
    }
    this.persist();
    this.refresh();
  }

  async finish(): Promise<void> {
    await this.flush();
    if (this.messageId !== undefined) {
      liveJobs.delete(liveKey(this.chatId, this.messageId));
    }
  }

  async removeItem(itemId: number): Promise<RemoveItemResult> {
    const item = this.findItem(itemId);
    if (!item) {
      return "unchanged";
    }
    const previous = this.snapshot.items;
    this.snapshot.items = previous.filter((entry) => entry.id !== itemId);
    if (!this.snapshot.items.length) {
      await this.delete();
      this.clearPersisted();
      if (this.messageId !== undefined) {
        liveJobs.delete(liveKey(this.chatId, this.messageId));
      }
      return "empty";
    }
    const code = await this.flush();
    if (code) {
      this.snapshot.items = previous;
      this.persist();
      logger.warn(`[MediaJob] Не удалось удалить блок ${itemId} (${code})`);
      return "failed";
    }
    this.persist();
    return "removed";
  }

  private setErrorBlock(itemId: number, stage: string, detail: string, elapsedSec: number): void {
    const item = this.findItem(itemId);
    if (!item) {
      return;
    }
    item.stage = null;
    item.media = null;
    item.block = buildMediaErrorBlock({
      itemId: item.id,
      range: item.range,
      vodUrl: item.vodUrl,
      vodLabel: item.vodLabel,
      stage,
      detail,
      elapsedSec,
    });
  }

  private findItem(itemId: number): MediaJobItem | undefined {
    return this.snapshot.items.find((item) => item.id === itemId);
  }

  private captureMedia(fileIds: string[]): void {
    const withMedia = this.snapshot.items.filter((item) => item.media);
    let changed = false;
    withMedia.forEach((item, index) => {
      const fileId = fileIds[index];
      if (fileId && item.media && item.media.fileId !== fileId) {
        item.media.fileId = fileId;
        changed = true;
      }
    });
    if (changed) {
      this.persist();
    }
  }

  private persist(): void {
    if (this.messageId === undefined) {
      return;
    }
    try {
      this.db.setJson(snapshotKey(this.chatId, this.messageId), this.snapshot);
    } catch (err) {
      logger.warn("[MediaJob] Не удалось сохранить состояние сообщения:", err);
    }
  }

  private clearPersisted(): void {
    if (this.messageId === undefined) {
      return;
    }
    this.db.delete(snapshotKey(this.chatId, this.messageId));
  }
}

/**
 * Удаляет блок результата из сообщения. Если блоков не осталось — удаляется
 * само сообщение. Работает и после перезапуска бота (состояние лежит в БД).
 */
export async function removeMediaJobItem(params: {
  port: TelegramMessagePort;
  db: DB;
  chatId: number | string;
  messageId: number;
  itemId: number;
}): Promise<RemoveItemResult> {
  const live = liveJobs.get(liveKey(params.chatId, params.messageId));
  if (live) {
    return await live.removeItem(params.itemId);
  }

  const snapshot = params.db.getJson<MediaJobSnapshot>(snapshotKey(params.chatId, params.messageId));
  if (!snapshot) {
    return "missing";
  }

  const detached = new MediaJobMessage(params.port, params.chatId, params.messageId, snapshot, params.db);
  return await detached.removeItem(params.itemId);
}
