import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { parseChatTargets } from "./core/chat-target";

export function parseFlag(raw?: string): boolean {
  const value = raw?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function parseChatIds(raw?: string): number[] {
  return parseChatTargets(raw).map((target) => Number(target.chatId));
}

/**
 * Алиасы Twitch-каналов по умолчанию: алиас → канонический логин канала.
 */
export const DEFAULT_CHANNEL_ALIASES: Record<string, string> = {
  влг: "welovegames",
  wlg: "welovegames",
  welovegames: "welovegames",
  табула: "tabula",
  tabula: "tabula",
};

/**
 * Парсит env-переменную TWITCH_CHANNELS в карту алиас → логин канала.
 * Формат: "логин:алиас1,алиас2;логин2:алиас3".
 * Канонический логин добавляется в алиасы автоматически.
 * Значения из env перекрывают дефолты.
 */
export function parseChannelAliases(raw?: string): Record<string, string> {
  const aliases: Record<string, string> = { ...DEFAULT_CHANNEL_ALIASES };

  for (const group of (raw ?? "").split(";")) {
    const [loginPart, aliasPart] = group.split(":");
    const login = loginPart?.trim().toLowerCase();

    if (!login) {
      continue;
    }

    for (const alias of (aliasPart ?? "")
      .split(",")
      .map((a) => a.trim().toLowerCase())
      .filter(Boolean)) {
      aliases[alias] = login;
    }

    aliases[login] = login;
  }

  return aliases;
}

for (const arg of process.argv.slice(2)) {
  if (arg.startsWith("--")) {
    const [key, value] = arg.slice(2).split("=");

    switch (key) {
      case "api-id":
        process.env.API_ID = value;
        break;
      case "api-hash":
        process.env.API_HASH = value;
        break;
      case "bot-token":
        process.env.BOT_TOKEN = value;
        break;
      case "chat-id":
        process.env.CHAT_ID = value;
        break;
      case "proxy":
        process.env.PROXY = "yes";
        break;
      case "oauth":
        process.env.OAUTH = value;
        break;
      case "interop-chat-id":
        process.env.INTEROP_CHAT_IDS = value;
        break;
      case "interop-twitch-channel":
        process.env.INTEROP_TWITCH_CHANNEL = value;
        break;
    }
  }
}

try {
  if (!process.env.API_ID || !Number(process.env.API_ID)) {
    throw new Error("API_ID is not defined");
  }
  if (!process.env.API_HASH) {
    throw new Error("API_HASH is not defined");
  }
  if (!process.env.BOT_TOKEN) {
    throw new Error("BOT_TOKEN is not defined");
  }
  parseChatTargets(process.env.CHAT_ID);
} catch (error) {
  console.error(error);
  process.exit(1);
}
const storagePath = process.env.STORAGE || "db/session.sqlite";
const storageDir = dirname(storagePath);
if (storageDir && storageDir !== ".") {
  mkdirSync(storageDir, { recursive: true });
}

const dbPath = process.env.DB_PATH || "db/db.sqlite";
const tmpDir = process.env.TMP_DIR || "tmp";
mkdirSync(tmpDir, { recursive: true });

// Чаты, куда бот вправе отправлять клипы по интероп-запросам от внешних ботов.
// По умолчанию — те же чаты, что и для обычных команд. Треды в интеропе не используются.
const chatTargets = parseChatTargets(process.env.CHAT_ID);
const interopRaw = process.env.INTEROP_CHAT_IDS?.trim() ? process.env.INTEROP_CHAT_IDS : undefined;
const interopChatIds = [
  ...new Set(
    (interopRaw ? parseChatTargets(interopRaw, "INTEROP_CHAT_IDS") : chatTargets).map((target) =>
      Number(target.chatId),
    ),
  ),
];

export default {
  telegram: {
    appId: Number(process.env.API_ID),
    apiHash: process.env.API_HASH,
    storage: storagePath,
    botToken: process.env.BOT_TOKEN,
    chatIds: [...new Set(chatTargets.map((target) => Number(target.chatId)))],
    targets: chatTargets,
  },
  interop: {
    chatIds: interopChatIds,
    twitchChannel: process.env.INTEROP_TWITCH_CHANNEL?.trim() || undefined,
  },
  db: {
    path: dbPath,
  },
  proxy: process.env.PROXY ? "https://boostyflare.mahahuha5816.workers.dev/" : undefined,
  twitch: {
    oauth: process.env.OAUTH || undefined,
    channels: parseChannelAliases(process.env.TWITCH_CHANNELS),
  },
  groq: {
    apiKey: process.env.GROQ_APIKEY,
  },
  gemini: {
    apiKey: process.env.GEMINI_APIKEY,
  },
  tracker: {
    pollIntervalSec: Number(process.env.TRACKER_POLL_SEC) || 60,
    dedupeWindowSec: Number(process.env.TRACKER_DEDUPE_SEC) || 30,
    staleTimeoutMs: Number(process.env.TRACKER_STALE_TIMEOUT_MS) || 120000,
    timeOffsetSec: Number(process.env.TRACKER_TIME_OFFSET_SEC) || 0,
    debugTranscript: parseFlag(process.env.TRACKER_DEBUG_TRANSCRIPT),
  },
  tmpDir,
};
