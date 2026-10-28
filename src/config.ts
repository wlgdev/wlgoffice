import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function parseChatIds(raw?: string): number[] {
  const ids = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  if (!ids.length || ids.some((n) => !Number.isFinite(n))) {
    throw new Error("CHAT_ID is not defined");
  }
  return ids;
}

/**
 * Алиасы Twitch-каналов по умолчанию: алиас → канонический логин канала.
 */
export const DEFAULT_CHANNEL_ALIASES: Record<string, string> = {
  "влг": "welovegames",
  "wlg": "welovegames",
  "welovegames": "welovegames",
  "табула": "tabula",
  "tabula": "tabula",
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

    for (const alias of (aliasPart ?? "").split(",").map((a) => a.trim().toLowerCase()).filter(Boolean)) {
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
  parseChatIds(process.env.CHAT_ID);
} catch (error) {
  console.error(error);
  process.exit(1);
}

const storagePath = process.env.STORAGE || "db/session.sqlite";
const storageDir = dirname(storagePath);
if (storageDir && storageDir !== ".") {
  mkdirSync(storageDir, { recursive: true });
}

const tmpDir = process.env.TMP_DIR || "tmp";
mkdirSync(tmpDir, { recursive: true });

// Чаты, куда бот вправе отправлять клипы по интероп-запросам от внешних ботов.
// По умолчанию — те же чаты, что и для обычных команд.
const interopChatIdsRaw = process.env.INTEROP_CHAT_IDS?.trim()
  ? process.env.INTEROP_CHAT_IDS
  : process.env.CHAT_ID;

export default {
  telegram: {
    appId: Number(process.env.API_ID),
    apiHash: process.env.API_HASH,
    storage: storagePath,
    botToken: process.env.BOT_TOKEN,
    chatIds: parseChatIds(process.env.CHAT_ID),
  },
  interop: {
    chatIds: parseChatIds(interopChatIdsRaw),
    twitchChannel: process.env.INTEROP_TWITCH_CHANNEL?.trim() || undefined,
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
  tmpDir,
};
