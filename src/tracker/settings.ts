import { parseChatTarget } from "../core/chat-target";
import { buildListBlock, escapeHtml } from "../telegram/formatters";
import type { TrackerChannelSettings, TrackerSettings } from "./types";

export const TRACKER_SETTINGS_KEY = "tracker:settings";

const LOGIN_PATTERN = /^[a-z0-9_]{3,25}$/;
const MAX_ALIAS_LENGTH = 64;
const MAX_PATTERNS = 50;
const MAX_PATTERN_LENGTH = 100;

export class TrackerSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrackerSettingsError";
  }
}

export function emptyTrackerSettings(): TrackerSettings {
  return { channels: {}, vocabularyEnabled: false };
}

export function normalizeChatTarget(value: unknown): { chatId?: number | string; threadId?: number } {
  if (typeof value === "number" && Number.isFinite(value)) {
    return { chatId: value };
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return {};
    }
    const target = parseChatTarget(trimmed);
    if (target) {
      return { chatId: target.chatId, threadId: target.threadId };
    }
    const numeric = Number(trimmed);
    return { chatId: Number.isFinite(numeric) ? numeric : trimmed };
  }
  return {};
}

export function normalizeLogin(login: string): string {
  const value = login.trim().toLowerCase();
  if (!LOGIN_PATTERN.test(value)) {
    throw new TrackerSettingsError(`Некорректный логин Twitch: "${login}"`);
  }
  return value;
}

export function normalizeAlias(alias: string): string {
  const value = alias.trim();
  if (!value) {
    throw new TrackerSettingsError("Алиас не может быть пустым");
  }
  if (value.length > MAX_ALIAS_LENGTH) {
    throw new TrackerSettingsError(`Алиас длиннее ${MAX_ALIAS_LENGTH} символов`);
  }
  if (value.includes(",")) {
    throw new TrackerSettingsError("Алиас не может содержать запятую");
  }
  return value;
}

/**
 * Разбирает список паттернов алиаса: запятая — разделитель, внутри паттерна запятых быть не может.
 */
export function parsePatternList(raw: string): string[] {
  return raw
    .split(",")
    .map((item) =>
      item
        .trim()
        .replace(/^"(.*)"$/s, "$1")
        .trim(),
    )
    .filter(Boolean);
}

export function normalizePatterns(patterns: string[]): string[] {
  const result: string[] = [];

  for (const raw of patterns) {
    const pattern = raw.trim();
    if (!pattern) {
      continue;
    }
    if (pattern.length > MAX_PATTERN_LENGTH) {
      throw new TrackerSettingsError(`Паттерн длиннее ${MAX_PATTERN_LENGTH} символов: "${pattern}"`);
    }
    if (!result.includes(pattern)) {
      result.push(pattern);
    }
  }

  if (result.length > MAX_PATTERNS) {
    throw new TrackerSettingsError(`Слишком много паттернов (максимум ${MAX_PATTERNS})`);
  }

  return result;
}

function normalizeChannel(login: string, raw: unknown): TrackerChannelSettings | null {
  if (!LOGIN_PATTERN.test(login)) {
    return null;
  }

  const value = (raw ?? {}) as Partial<TrackerChannelSettings>;
  const aliases: Record<string, string[]> = {};

  if (value.aliases && typeof value.aliases === "object") {
    for (const [alias, list] of Object.entries(value.aliases)) {
      const name = alias.trim();
      if (!name || name.length > MAX_ALIAS_LENGTH) {
        continue;
      }
      const patterns = Array.isArray(list) ? list.map((p) => String(p).trim()).filter(Boolean) : [];
      if (patterns.length) {
        aliases[name] = patterns;
      }
    }
  }

  const target = normalizeChatTarget(value.chatId);
  const threadId =
    target.threadId ??
    (typeof value.threadId === "number" && Number.isFinite(value.threadId) ? value.threadId : undefined);

  return {
    enabled: Boolean(value.enabled),
    chatId: target.chatId,
    threadId,
    aliases,
  };
}

export function normalizeTrackerSettings(raw: unknown): TrackerSettings {
  const settings = emptyTrackerSettings();
  if (!raw || typeof raw !== "object") {
    return settings;
  }

  const source = raw as { channels?: unknown; vocabularyEnabled?: unknown };
  settings.vocabularyEnabled = source.vocabularyEnabled === true;

  const channels = source.channels;
  if (!channels || typeof channels !== "object") {
    return settings;
  }

  for (const [login, value] of Object.entries(channels as Record<string, unknown>)) {
    const channel = normalizeChannel(login.trim().toLowerCase(), value);
    if (channel) {
      settings.channels[login.trim().toLowerCase()] = channel;
    }
  }

  return settings;
}

function requireChannel(settings: TrackerSettings, login: string): TrackerChannelSettings {
  const key = normalizeLogin(login);
  const channel = settings.channels[key];
  if (!channel) {
    throw new TrackerSettingsError(`Канал "${key}" не настроен. Сначала: !tracker channel ${key}`);
  }
  return channel;
}

export function setChannel(settings: TrackerSettings, login: string, chatId?: number | string): TrackerSettings {
  const key = normalizeLogin(login);
  const next: TrackerSettings = { ...settings, channels: { ...settings.channels } };
  const existing = next.channels[key];
  const target = chatId === undefined ? {} : normalizeChatTarget(chatId);

  next.channels[key] = {
    enabled: true,
    chatId: chatId === undefined ? existing?.chatId : target.chatId,
    threadId: chatId === undefined ? existing?.threadId : target.threadId,
    aliases: existing?.aliases ?? {},
  };

  return next;
}

export function setEnabled(settings: TrackerSettings, login: string, enabled: boolean): TrackerSettings {
  const key = normalizeLogin(login);
  const channel = requireChannel(settings, key);
  return { ...settings, channels: { ...settings.channels, [key]: { ...channel, enabled } } };
}

export function setChat(settings: TrackerSettings, login: string, chatId?: number | string): TrackerSettings {
  const key = normalizeLogin(login);
  const channel = requireChannel(settings, key);
  const target = normalizeChatTarget(chatId);
  return {
    ...settings,
    channels: { ...settings.channels, [key]: { ...channel, chatId: target.chatId, threadId: target.threadId } },
  };
}

export function removeChannel(settings: TrackerSettings, login: string): TrackerSettings {
  const key = normalizeLogin(login);
  requireChannel(settings, key);
  const channels = { ...settings.channels };
  delete channels[key];
  return { ...settings, channels };
}

/**
 * Включает или выключает отправку имён алиасов в Gemini как custom vocabulary.
 */
export function setVocabulary(settings: TrackerSettings, enabled: boolean): TrackerSettings {
  return { ...settings, vocabularyEnabled: enabled };
}

/**
 * Заменяет список паттернов алиаса. Пустой список паттернов удаляет алиас.
 */
export function setAlias(settings: TrackerSettings, login: string, alias: string, patterns: string[]): TrackerSettings {
  const key = normalizeLogin(login);
  const channel = requireChannel(settings, key);
  const name = normalizeAlias(alias);
  const list = normalizePatterns(patterns);

  const aliases = { ...channel.aliases };
  if (!list.length) {
    delete aliases[name];
  } else {
    aliases[name] = list;
  }

  return { ...settings, channels: { ...settings.channels, [key]: { ...channel, aliases } } };
}

function describeChannel(login: string, channel: TrackerChannelSettings, open: boolean): string {
  const icon = channel.enabled ? "✅" : "⏸️";
  const target =
    channel.chatId === undefined
      ? "чат по умолчанию"
      : channel.threadId === undefined
        ? `чат <code>${escapeHtml(String(channel.chatId))}</code>`
        : `чат <code>${escapeHtml(`${channel.chatId}_${channel.threadId}`)}</code>`;

  const aliases = Object.entries(channel.aliases);
  const body = aliases.length
    ? buildListBlock(
        aliases.map(
          ([alias, patterns]) =>
            `<b>${escapeHtml(alias)}</b> (${patterns.length}) · ${patterns.map(escapeHtml).join(", ")}`,
        ),
      )
    : "<p>Алиасов нет</p>";

  return `<details${open ? " open" : ""}><summary>${icon} <b>${escapeHtml(login)}</b> · ${target}</summary>${body}</details>`;
}

/**
 * Описывает настройки трекера: сводка, карточка на канал и футер с общим словарём.
 */
export function describeSettings(settings: TrackerSettings): string {
  const channels = Object.entries(settings.channels);
  const vocabulary = settings.vocabularyEnabled === true ? "включён" : "выключен";
  const footer = `<footer>Словарь алиасов для Gemini: <b>${vocabulary}</b></footer>`;

  if (!channels.length) {
    return `<p>Настроенных каналов нет. Добавь: <code>!tracker channel welovegames</code></p>${footer}`;
  }

  const enabled = channels.filter(([, channel]) => channel.enabled).length;
  const aliases = channels.reduce((sum, [, channel]) => sum + Object.keys(channel.aliases).length, 0);
  const summary = `<p>Каналов: <b>${channels.length}</b> · включено: <b>${enabled}</b> · алиасов: <b>${aliases}</b></p>`;
  const cards = channels.map(([login, channel], index) => describeChannel(login, channel, index === 0));

  return [summary, "<p><br></p>", ...cards, footer].join("");
}
