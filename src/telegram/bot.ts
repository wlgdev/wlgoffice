import { TelegramClient } from "@mtcute/bun";
import { Dispatcher } from "@mtcute/dispatcher";

import config from "../config";
import { formatChatTarget } from "../core/chat-target";
import logger from "../logger";
import { DB } from "../services/db";
import { TrackerService } from "../tracker/service";
import { TrackerStore } from "../tracker/store";
import { createLiveTranscriberFactory } from "../tracker/transcriber";
import { createTwitchTrackerPort } from "../tracker/twitch-port";
import { setupCallbackHandler } from "./handlers/callback.handler";
import { setupMessageHandler } from "./handlers/message.handler";
import { setupTrackerHandler } from "./handlers/tracker.handler";
import { createTelegramPort } from "./telegram-port";

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

export const trackerService = new TrackerService({
  store: new TrackerStore(db),
  twitch: createTwitchTrackerPort(),
  telegram: createTelegramPort(tg),
  createTranscriber: createLiveTranscriberFactory(),
  geminiApiKey: config.gemini.apiKey ?? "",
  defaultChatId: config.telegram.targets[0]!.chatId,
  defaultThreadId: config.telegram.targets[0]!.threadId,
  pollIntervalSec: config.tracker.pollIntervalSec,
  dedupeWindowSec: config.tracker.dedupeWindowSec,
  staleTimeoutMs: config.tracker.staleTimeoutMs,
  timeOffsetSec: config.tracker.timeOffsetSec,
  debugTranscript: config.tracker.debugTranscript,
  reconnectBackoffSec: [5, 10, 20, 40, 60],
  apiRetryAttempts: 3,
  apiRetryDelaySec: 5,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

dp.onError((err, update) => {
  logger.error("⚠️ [Dispatcher Error]:", err, "Update:", update);
  return true;
});

setupCallbackHandler(dp, tg);
setupTrackerHandler(dp, tg, trackerService);
setupMessageHandler(dp, tg);

export async function startBot(): Promise<void> {
  try {
    const self = await tg.start({
      botToken: config.telegram.botToken,
    });
    logger.log(`🤖 Connected as: @${self.username || self.displayName}`);
    logger.log(`🤖 Chat-IDs: ${config.telegram.targets.map(formatChatTarget).join(", ")}`);
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

    if (config.gemini.apiKey) {
      trackerService.start();
    } else {
      logger.warn("⚠️ [Tracker] GEMINI_APIKEY не задан — трекер ключевых слов отключён");
    }
  } catch (err) {
    logger.error("❌ Не удалось запустить бота:", err);
    logger.log("Повторная попытка через 5 секунд...");
    setTimeout(startBot, 5000);
  }
}
