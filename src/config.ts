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

export default {
  telegram: {
    appId: Number(process.env.API_ID),
    apiHash: process.env.API_HASH,
    storage: storagePath,
    botToken: process.env.BOT_TOKEN,
    chatIds: parseChatIds(process.env.CHAT_ID),
  },
  proxy: process.env.PROXY ? "https://boostyflare.mahahuha5816.workers.dev/" : undefined,
  twitch: {
    oauth: process.env.OAUTH || undefined,
  },
  tmpDir,
};
