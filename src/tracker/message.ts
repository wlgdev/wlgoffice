import { humanizeDuration } from "../core/utils";
import { escapeHtml } from "../telegram/formatters";
import { type MessageEditError, MessageEditor, type TelegramMessagePort } from "../telegram/message-editor";
import type { TrackerHit, TrackerSessionState } from "./types";

const VOD_BASE_URL = "https://www.twitch.tv/videos/";
const CHANNEL_BASE_URL = "https://www.twitch.tv/";
const MAX_MESSAGE_LENGTH = 4096;
const MAX_LINKS = 90;
const BYTE_UNITS = ["Б", "КБ", "МБ", "ГБ"];

export function formatTimestamp(totalSec: number): string {
  const seconds = Math.max(0, Math.floor(totalSec));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

export function formatClockTimestamp(totalSec: number): string {
  const seconds = Math.max(0, Math.floor(totalSec));
  const hours = String(Math.floor(seconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const rest = String(seconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${rest}`;
}

export function formatTwitchTime(totalSec: number): string {
  const seconds = Math.max(0, Math.floor(totalSec));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return `${hours}h${minutes}m${rest}s`;
}

export function formatDate(epochMs: number): string {
  const date = new Date(epochMs);
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${day}.${month}.${date.getFullYear()}`;
}

export function formatTime(epochMs: number): string {
  const date = new Date(epochMs);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = unit === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${rounded} ${BYTE_UNITS[unit]}`;
}

export function formatCharCount(chars: number): string {
  if (chars < 1000) {
    return String(chars);
  }
  return `${(chars / 1000).toFixed(1)} тыс.`;
}

function renderTimestamp(timeSec: number, count: number, vodId?: string): string {
  const label = formatTimestamp(timeSec);
  const base = vodId ? `<a href="${VOD_BASE_URL}${vodId}?t=${formatTwitchTime(timeSec)}">${label}</a>` : label;
  return count > 1 ? `${base} (${count})` : base;
}

interface TimestampEntry {
  alias: string;
  timeSec: number;
  count: number;
}

/**
 * Группирует совпадения: одинаковый таймкод внутри одного алиаса схлопывается в один
 * таймкод с количеством вхождений.
 */
function groupHits(hits: TrackerHit[]): { order: string[]; entries: TimestampEntry[] } {
  const byAlias = new Map<string, Map<string, TimestampEntry>>();

  for (const hit of hits) {
    const label = formatTimestamp(hit.timeSec);
    const byTime = byAlias.get(hit.alias) ?? new Map<string, TimestampEntry>();
    const existing = byTime.get(label);
    if (existing) {
      existing.count++;
    } else {
      byTime.set(label, { alias: hit.alias, timeSec: hit.timeSec, count: 1 });
    }
    byAlias.set(hit.alias, byTime);
  }

  const entries: TimestampEntry[] = [];
  for (const byTime of byAlias.values()) {
    entries.push(...byTime.values());
  }
  entries.sort((a, b) => a.timeSec - b.timeSec);

  return { order: [...byAlias.keys()], entries };
}

/**
 * Собирает статусное сообщение трекера: заголовок с VOD, таймстемпы по алиасам, футер завершения.
 */
export function buildTrackerMessage(state: TrackerSessionState): string {
  const title = escapeHtml((state.vodTitle?.trim() || state.channel).slice(0, 200));
  const channelUrl = `${CHANNEL_BASE_URL}${state.channel}`;
  const date = formatDate(state.startTimeMs ?? state.startedAt);

  const header = [
    "🔎 <b>Трекер ключевых слов</b>\n",
    `› ${date} • <a href="${channelUrl}">@${state.channel}</a>${state.vodId ? ` • <a href="${VOD_BASE_URL}${state.vodId}">${state.vodId}</a>` : ""}`,
    `› ${title}`,
  ]
    .filter(Boolean)
    .join("\n");

  const counts = Object.entries(state.counts)
    .filter(([, count]) => count > 0)
    .slice(0, 20);
  const footer =
    state.status === "closed"
      ? `\n\n🏁 <b>Эфир завершён</b>${
          counts.length
            ? `\n📊 <b>Итого:</b> ${counts.map(([alias, count]) => `${escapeHtml(alias)} – ${count}`).join(", ")}`
            : ""
        }`
      : "";

  const hits = [...state.hits].sort((a, b) => a.timeSec - b.timeSec);
  const { order, entries } = groupHits(hits);
  const aliasCount = new Set(entries.map((entry) => entry.alias)).size;
  const budget = MAX_MESSAGE_LENGTH - header.length - footer.length - aliasCount * 40 - 32;

  const selected: (TimestampEntry & { text: string })[] = [];
  let used = 0;
  let hidden = 0;

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    const text = renderTimestamp(entry.timeSec, entry.count, state.vodId);
    if (selected.length >= MAX_LINKS || used + text.length + 2 > budget) {
      hidden++;
      continue;
    }
    used += text.length + 2;
    selected.push({ ...entry, text });
  }
  selected.reverse();

  const grouped = new Map<string, string[]>();
  for (const alias of order) {
    const list = selected.filter((item) => item.alias === alias).map((item) => item.text);
    if (list.length) {
      grouped.set(alias, list);
    }
  }

  const lines = [...grouped.entries()].map(([alias, list]) => `• <b>${escapeHtml(alias)}:</b> ${list.join(", ")}`);
  if (hidden > 0) {
    lines.push(`…ещё ${hidden}`);
  }

  const body = lines.length ? `\n\n${lines.join("\n")}` : "";
  return `${header}${body}${footer}`;
}

export function buildSessionsMessage(states: TrackerSessionState[]): string {
  if (!states.length) {
    return "";
  }

  const lines = states.map((state) => {
    const streamStart = state.startTimeMs ?? state.startedAt;
    const uptime = humanizeDuration(Date.now() - state.startedAt);
    return [
      `• <b>@${escapeHtml(state.channel)}</b> — эфир <code>${escapeHtml(state.broadcastId)}</code>`,
      `  эфир с ${formatDate(streamStart)} ${formatTime(streamStart)} · сессия ${uptime} (с ${formatTime(state.startedAt)}) · в Gemini: ${formatBytes(state.sentBytes)} · символов: ${formatCharCount(state.receivedChars)}`,
    ].join("\n");
  });

  return `🔎 <b>Активные сессии</b>\n\n${lines.join("\n")}`;
}

/**
 * Статусное сообщение трекера: создаётся лениво (по первому совпадению) и пересоздаётся,
 * если пользователь удалил исходный пост.
 */
export class TrackerStatusMessage extends MessageEditor {
  constructor(
    port: TelegramMessagePort,
    chatId: number | string,
    messageId: number | undefined,
    private readonly render: () => string,
    private readonly onMessageId?: (messageId: number) => void,
    minEditDelayMs = 1500,
    private readonly threadId?: number,
  ) {
    super(port, chatId, messageId, minEditDelayMs);
    this.disableLinkPreview = true;
  }

  protected override renderText(): string {
    return this.render();
  }

  protected override async createMessage(text: string): Promise<number> {
    const message = await this.port.sendText(this.chatId, text, {
      disableWebPreview: true,
      threadId: this.threadId,
    });
    return message.id;
  }

  protected override onMessageCreated(messageId: number): void {
    this.onMessageId?.(messageId);
  }

  protected override handleEditError(code: MessageEditError, text: string): void {
    if (code !== "message_id_invalid") {
      return;
    }
    void this.recreate(text);
  }

  private async recreate(text: string): Promise<void> {
    try {
      const message = await this.port.sendText(this.chatId, text, {
        disableWebPreview: true,
        threadId: this.threadId,
      });
      this.messageId = message.id;
      this.onMessageId?.(message.id);
    } catch {
      return;
    }
  }
}
