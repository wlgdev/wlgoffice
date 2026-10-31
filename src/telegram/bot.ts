import { TelegramClient } from "@mtcute/bun";
import { Dispatcher } from "@mtcute/dispatcher";

import config from "../config";
import logger from "../logger";
import { DB } from "../services/db";
import { setupCallbackHandler } from "./handlers/callback.handler";
import { setupMessageHandler } from "./handlers/message.handler";

process.on("unhandledRejection", (reason) => {
  logger.error("⚠️ [Global] Unhandled Promise Rejection:", reason);
});

process.on("uncaughtException", (err) => {
  logger.error("💥 [Global] Uncaught Exception:", err);
});

export const tg = new TelegramClient({
  apiId: config.telegram.appId,
  apiHash: config.telegram.apiHash,
  storage: config.telegram.storage,
});

export const dp = Dispatcher.for(tg);

export const db = new DB(config.db.path);

dp.onError((err, update) => {
  logger.error("⚠️ [Dispatcher Error]:", err, "Update:", update);
  return true;
});

setupCallbackHandler(dp, tg);
setupMessageHandler(dp, tg);

export async function startBot(): Promise<void> {
  try {
    const self = await tg.start({
      botToken: config.telegram.botToken,
    });
    logger.log(`🤖 Connected as: @${self.username || self.displayName}`);
    logger.log(`🤖 Chat-IDs: ${config.telegram.chatIds.join(", ")}`);
    logger.log(`🤖 Interop chat-IDs: ${config.interop.chatIds.join(", ")}`);
    if (config.interop.twitchChannel) {
      logger.log(`🤖 Interop Twitch-канал: ${config.interop.twitchChannel}`);
    }
    if (config.twitch.oauth) {
      logger.log(`🤖 OAuth: ${config.twitch.oauth}`);
    }
    if (config.proxy) {
      logger.log(`🤖 Proxy: ${config.proxy}`);
    }
  } catch (err) {
    logger.error("❌ Не удалось запустить бота:", err);
    logger.log("Повторная попытка через 5 секунд...");
    setTimeout(startBot, 5000);
  }
}
