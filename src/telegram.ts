import { TelegramClient, InputMedia, html } from "@mtcute/bun";
import { Dispatcher, type MessageContext } from "@mtcute/dispatcher";
import { parseVodMessage } from "./utils";
import { getVodHlsStream, QualityNotFoundError, type HlsStreamResult, type MuteStats } from "./hls";
import { remuxHlsStream, type FfmpegRunResult } from "./ffmpeg";
import { existsSync } from "node:fs";
import config from "./config";
import logger from "./logger";

// ─── 1. Глобальная защита от падений процесса ─────────────────

process.on("unhandledRejection", (reason) => {
  logger.error("⚠️ [Global] Unhandled Promise Rejection:", reason);
});

process.on("uncaughtException", (err) => {
  logger.error("💥 [Global] Uncaught Exception:", err);
});

// Лимиты
const MAX_DURATION_SECONDS = 30 * 60; // 30 минут
const MAX_FILE_SIZE_BYTES = 4 * 1024 * 1024 * 1024; // 4 ГБ

const tg = new TelegramClient({
  apiId: config.telegram.appId,
  apiHash: config.telegram.apiHash,
  storage: config.telegram.storage,
});

const dp = Dispatcher.for(tg);

dp.onError((err, update) => {
  logger.error("⚠️ [Dispatcher Error]:", err, "Update:", update);
  return true;
});

// ─── Хелперы ─────────────────────────────────────────────────

function toTelegramHtml(text: string) {
  return html(text.replace(/\r?\n/g, "<br>"));
}

/**
 * В каналах нельзя отвечать реплаем на пост — шлём обычным сообщением.
 */
function isChannelChat(msg: MessageContext): boolean {
  return "chatType" in msg.chat && msg.chat.chatType === "channel";
}

function answerText(msg: MessageContext, text: ReturnType<typeof toTelegramHtml>) {
  if (isChannelChat(msg)) return tg.sendText(msg.chat.id, text);
  return msg.replyText(text);
}

async function safeDeleteFile(filePath: string) {
  try {
    if (filePath && existsSync(filePath)) {
      await Bun.file(filePath).unlink();
    }
  } catch (err) {
    logger.warn(`[Cleanup] Failed to delete file "${filePath}":`, err);
  }
}

async function safeUpdateStatus(chatId: number | string, messageId: number, rawText: string) {
  try {
    await tg.editMessage({
      chatId,
      message: messageId,
      text: toTelegramHtml(rawText),
    });
  } catch (e: any) {
    const errorStr = String(e?.message || e);
    if (
      !errorStr.includes("MESSAGE_NOT_MODIFIED") &&
      !errorStr.includes("MESSAGE_ID_INVALID") &&
      !errorStr.includes("CHAT_WRITE_FORBIDDEN")
    ) {
      logger.warn("[Telegram Edit Error]:", errorStr);
    }
  }
}

/**
 * Бейдж статистики звука для строки клипа
 */
function formatMuteBadge(stats: MuteStats): string {
  if (stats.mutedFound === 0) {
    return "🔊 чистый звук";
  }
  if (stats.unmutedSuccess === stats.mutedFound) {
    return `🔊 ${stats.unmutedSuccess}/${stats.mutedFound} размьючено ✓`;
  }
  return `⚠️ ${stats.unmutedSuccess}/${stats.mutedFound} размьючено (${stats.remainedMuted} без звука)`;
}

/**
 * Подпись к видеофайлу
 */
function buildCaption(params: {
  range: { rawStart: string; rawEnd: string };
  hls: HlsStreamResult;
  muteStats: MuteStats;
  remux: FfmpegRunResult;
  vodId: string;
}): string {
  const { range, hls, muteStats, remux, vodId } = params;

  let muteLine = "";
  if (muteStats.mutedFound > 0) {
    const isFullUnmute = muteStats.unmutedSuccess === muteStats.mutedFound;
    const icon = isFullUnmute ? "✓" : "⚠️";
    muteLine = `\n🔊 <b>Звук:</b> размьючено ${muteStats.unmutedSuccess}/${muteStats.mutedFound} ${icon}`;
  } else {
    muteLine = "\n🔊 <b>Звук:</b> чистый (без мьютов) ✓";
  }

  return (
    `🎬 <b>Клип [${range.rawStart} - ${range.rawEnd}]</b> (длительность: ${remux.duration}с)\n` +
    `📺 <b>Качество:</b> ${hls.variant.quality} (${hls.variant.width}x${hls.variant.height} @ ${hls.variant.framerate}fps)\n` +
    `📦 <b>Размер:</b> ${remux.sizeMB} MB (~${remux.bitrateKbps} kbps)${muteLine}\n` +
    `⚡ <b>Время обработки:</b> ${(remux.elapsedMs / 1000).toFixed(1)}с\n` +
    `🔗 <b>VOD:</b> <code>${vodId}</code>`
  );
}

function buildStatusMessage(vodId: string, statuses: string[], header?: string): string {
  const title = header ?? `📥 <b>Обработка VOD <code>${vodId}</code></b>`;
  return `${title}\n\n${statuses.join("\n")}`;
}

/**
 * Строка статуса при отсутствии запрошенного качества в манифесте.
 * Ничего не качаем — сообщаем, что именно не найдено и что доступно.
 */
function buildQualityNotFoundStatus(
  currentIndex: number,
  totalRanges: number,
  rawRange: string,
  err: QualityNotFoundError,
): string {
  const available = err.available.length ? err.available.join(", ") : "—";
  if (err.requested.length === 1) {
    return (
      `❌ [${currentIndex}/${totalRanges}] <code>${rawRange}</code> — ` +
      `качество <code>${err.requested[0]}</code> не найдено (доступно: ${available}). Ничего не скачано.`
    );
  }
  return (
    `❌ [${currentIndex}/${totalRanges}] <code>${rawRange}</code> — ` +
    `ни одно из запрошенных качеств (${err.requested.map((q) => `<code>${q}</code>`).join(", ")}) ` +
    `не найдено (доступно: ${available}). Ничего не скачано.`
  );
}

// ─── Основной обработчик ─────────────────────────────────────

dp.onNewMessage(async (msg) => {
  // Контекст для фатального пути: чтобы статус-сообщение не висло на промежуточном этапе.
  let statusCtx: { chatId: number | string; msgId: number; vodId: string; lines: string[] } | undefined;
  try {
    const text = msg.text;

    if (text === "!ping") {
      await answerText(msg, toTelegramHtml("pong"));
      return;
    }

    if (!config.telegram.chatIds.includes(msg.chat.id)) return;

    if (!text || !text.startsWith("!клип")) return;

    // 1. Парсинг команды
    let parsedVod;
    try {
      parsedVod = parseVodMessage(text);
    } catch (e: any) {
      await answerText(msg, toTelegramHtml(`❌ <b>Ошибка парсинга команды:</b> <code>${e?.message || e}</code>`));
      return;
    }

    if (!parsedVod.vodId) {
      await answerText(msg, toTelegramHtml("❌ <b>Ошибка:</b> не удалось извлечь VOD ID из ссылки."));
      return;
    }

    if (!parsedVod.ranges.length) {
      await answerText(
        msg,
        toTelegramHtml("❌ <b>Ошибка:</b> не найдены временные интервалы (например: <code>10:00 - 12:30</code>)."),
      );
      return;
    }

    const totalRanges = parsedVod.ranges.length;
    const channelName = "welovegames";
    const requestedQualities = parsedVod.qualities;
    const qualityLine =
      requestedQualities.length > 0
        ? `🎯 Качество: <b>${requestedQualities.join(", ")}</b>\n`
        : `🎯 Качество: <b>максимальное</b>\n`;

    // 2. Отправка начального статусного сообщения
    const initialText =
      `📥 <b>Запрос принят!</b>\n` +
      `📺 Канал: <b>${channelName}</b> | VOD: <code>${parsedVod.vodId}</code>\n` +
      qualityLine +
      `⏱ Клипов в очереди: <b>${totalRanges}</b>\n\n` +
      parsedVod.ranges
        .map((r, i) => `⏳ [${i + 1}/${totalRanges}] <code>${r.rawStart} - ${r.rawEnd}</code> — ожидание...`)
        .join("\n");

    let statusMsg;
    try {
      statusMsg = await answerText(msg, toTelegramHtml(initialText));
    } catch (e) {
      if (String(e).includes("CHAT_ADMIN_REQUIRED")) {
        logger.error(
          "❌ Нет прав на отправку в этот чат: дай боту админку с правом «Публикация сообщений» " +
            "(и проверь, что в канал добавлен именно этот бот, а не другой с похожим именем).",
        );
      }
      logger.error("Не удалось отправить стартовое сообщение в чат:", e);
      return;
    }

    const chatId = statusMsg.chat.id;
    const statusMsgId = statusMsg.id;

    const statuses: string[] = parsedVod.ranges.map((r) => `<code>${r.rawStart} - ${r.rawEnd}</code>`);
    statusCtx = { chatId, msgId: statusMsgId, vodId: parsedVod.vodId, lines: statuses };
    let successCount = 0;

    // Счётчики для итоговой статистики
    let totalDurationSec = 0;
    let totalSizeMB = 0;
    let totalMutedSegments = 0;
    let totalUnmutedSegments = 0;
    let totalFailedUnmutedSegments = 0;

    // 3. Цикл обработки клипов
    for (let i = 0; i < parsedVod.ranges.length; i++) {
      const range = parsedVod.ranges[i]!;
      const currentIndex = i + 1;

      // 3.1 Валидация таймкодов
      if (
        !Number.isFinite(range.startSeconds) ||
        !Number.isFinite(range.endSeconds) ||
        range.startSeconds >= range.endSeconds
      ) {
        statuses[i] =
          `❌ [${currentIndex}/${totalRanges}] <code>${range.rawStart} - ${range.rawEnd}</code> — некорректный интервал`;
        await safeUpdateStatus(chatId, statusMsgId, buildStatusMessage(parsedVod.vodId, statuses));
        continue;
      }

      // 3.2 Валидация длительности
      const clipDuration = range.endSeconds - range.startSeconds;
      if (clipDuration > MAX_DURATION_SECONDS) {
        const maxMinutes = Math.round(MAX_DURATION_SECONDS / 60);
        const requestedMinutes = (clipDuration / 60).toFixed(1);
        statuses[i] =
          `❌ [${currentIndex}/${totalRanges}] <code>${range.rawStart} - ${range.rawEnd}</code> — превышен лимит длительности (${requestedMinutes} мин > ${maxMinutes} мин)`;
        await safeUpdateStatus(chatId, statusMsgId, buildStatusMessage(parsedVod.vodId, statuses));
        continue;
      }

      const outPath = `${config.tmpDir}/clip_${parsedVod.vodId}_${range.startSeconds}_${range.endSeconds}.mp4`;

      try {
        // Этап 1: Получение HLS потока
        statuses[i] =
          `🔄 [${currentIndex}/${totalRanges}] <code>${range.rawStart} - ${range.rawEnd}</code> — получение HLS...`;
        await safeUpdateStatus(chatId, statusMsgId, buildStatusMessage(parsedVod.vodId, statuses));

        const hlsStream = await getVodHlsStream({
          channel: channelName,
          vodId: parsedVod.vodId,
          start: range.startSeconds,
          end: range.endSeconds,
          quality: requestedQualities.length > 0 ? requestedQualities : undefined,
          oauth: config.twitch.oauth,
          proxy: config.proxy,
        });

        // Этап 2: Ремуксинг
        statuses[i] =
          `⚙️ [${currentIndex}/${totalRanges}] <code>${range.rawStart} - ${range.rawEnd}</code> — ремуксинг MP4 (${hlsStream.variant.quality})...`;
        await safeUpdateStatus(chatId, statusMsgId, buildStatusMessage(parsedVod.vodId, statuses));

        const [remuxResult, muteStats] = await Promise.all([
          remuxHlsStream({
            stream: hlsStream.stream,
            outPath,
            trimStart: hlsStream.trimStart,
            trimDuration: hlsStream.trimDuration,
            verbose: false,
          }),
          hlsStream.muteStats,
        ]);

        // 3.3 Валидация размера файла
        if (remuxResult.sizeBytes > MAX_FILE_SIZE_BYTES) {
          const maxGB = (MAX_FILE_SIZE_BYTES / (1024 * 1024 * 1024)).toFixed(1);
          const actualGB = (remuxResult.sizeBytes / (1024 * 1024 * 1024)).toFixed(2);
          statuses[i] =
            `❌ [${currentIndex}/${totalRanges}] <code>${range.rawStart} - ${range.rawEnd}</code> — превышен лимит размера (${actualGB} GB > ${maxGB} GB)`;
          await safeUpdateStatus(chatId, statusMsgId, buildStatusMessage(parsedVod.vodId, statuses));
          continue;
        }

        // Этап 3: Отправка в Telegram
        statuses[i] =
          `⬆️ [${currentIndex}/${totalRanges}] <code>${range.rawStart} - ${range.rawEnd}</code> — загрузка в Telegram (${remuxResult.sizeMB} MB)...`;
        await safeUpdateStatus(chatId, statusMsgId, buildStatusMessage(parsedVod.vodId, statuses));

        try {
          await tg.sendTyping(msg.chat.id, "upload_video");
        } catch {}

        const caption = buildCaption({
          range,
          hls: hlsStream,
          muteStats,
          remux: remuxResult,
          vodId: parsedVod.vodId,
        });

        await tg.sendMedia(
          msg.chat.id,
          InputMedia.video(`file:${outPath}`, {
            caption: toTelegramHtml(caption),
            width: hlsStream.variant.width,
            height: hlsStream.variant.height,
            // duration: Math.round(remuxResult.duration),
            supportsStreaming: true,
          }),
          { replyTo: isChannelChat(msg) ? undefined : msg.id },
        );

        // Обновляем статистику
        const muteBadge = formatMuteBadge(muteStats);
        statuses[i] =
          `✅ [${currentIndex}/${totalRanges}] <code>${range.rawStart} - ${range.rawEnd}</code> (${remuxResult.duration}с · ${remuxResult.sizeMB} MB · ${muteBadge})`;

        successCount++;
        totalDurationSec += remuxResult.duration;
        totalSizeMB += remuxResult.sizeMB;
        totalMutedSegments += muteStats.mutedFound;
        totalUnmutedSegments += muteStats.unmutedSuccess;
        totalFailedUnmutedSegments += muteStats.remainedMuted;
      } catch (e: any) {
        if (e instanceof QualityNotFoundError) {
          logger.warn(`[Quality ${currentIndex}/${totalRanges}]:`, e.message);
          statuses[i] = buildQualityNotFoundStatus(currentIndex, totalRanges, `${range.rawStart} - ${range.rawEnd}`, e);
          // Манифест один на весь VOD — остальные клипы упадут так же, ничего не качаем
          for (let j = i + 1; j < parsedVod.ranges.length; j++) {
            const pending = parsedVod.ranges[j]!;
            statuses[j] =
              `⏭ [${j + 1}/${totalRanges}] <code>${pending.rawStart} - ${pending.rawEnd}</code> — пропущен (качество не найдено)`;
          }
          // Статус обновится в finally ниже, затем выходим — дальше качать нечего
          break;
        }
        logger.error(`[Error Clip ${currentIndex}/${totalRanges}]:`, e);
        const errDescription = e?.message ? e.message.slice(0, 200) : String(e);
        statuses[i] =
          `❌ [${currentIndex}/${totalRanges}] <code>${range.rawStart} - ${range.rawEnd}</code> — ошибка: ${errDescription}`;
      } finally {
        await safeDeleteFile(outPath);
        await safeUpdateStatus(chatId, statusMsgId, buildStatusMessage(parsedVod.vodId, statuses));
      }
    }

    // 4. Формирование финального отчета
    let finalHeader =
      successCount === totalRanges
        ? `🎉 <b>Все клипы успешно созданы и отправлены!</b> (${successCount}/${totalRanges})`
        : `⚠️ <b>Обработка завершена</b> (Успешно: ${successCount} из ${totalRanges})`;

    if (successCount > 0) {
      finalHeader += `\n📊 <b>Итог:</b> ${totalDurationSec}с видео · ${totalSizeMB.toFixed(2)} MB`;

      if (totalMutedSegments > 0) {
        const percent = Math.round((totalUnmutedSegments / totalMutedSegments) * 100);
        const icon = totalFailedUnmutedSegments === 0 ? "✓" : "⚠️";
        finalHeader += `\n🔊 <b>Восстановление звука:</b> ${totalUnmutedSegments}/${totalMutedSegments} сегментов (${percent}%) ${icon}`;
      } else {
        finalHeader += `\n🔊 <b>Звук:</b> замученных сегментов не обнаружено ✓`;
      }
    }

    await safeUpdateStatus(chatId, statusMsgId, buildStatusMessage(parsedVod.vodId, statuses, finalHeader));
  } catch (fatalError: any) {
    logger.error("💥 [Fatal Handler Error]:", fatalError);
    const fatalText = `❌ <b>Критическая ошибка:</b> <code>${fatalError?.message || fatalError}</code>`;
    if (statusCtx) {
      // Статус уже создан — дописываем ошибку в него, а не оставляем висеть на промежуточном этапе
      await safeUpdateStatus(
        statusCtx.chatId,
        statusCtx.msgId,
        buildStatusMessage(statusCtx.vodId, [...statusCtx.lines, fatalText], `💥 <b>Обработка прервана</b>`),
      );
    } else {
      try {
        await answerText(msg, toTelegramHtml(fatalText));
      } catch {}
    }
  }
});

// ─── Запуск ──────────────────────────────────────────────────

export async function startBot() {
  try {
    const self = await tg.start({
      botToken: config.telegram.botToken,
    });
    logger.log(`🤖 Connected as: @${self.username || self.displayName}`);
    logger.log(`🤖 Chat-IDs: ${config.telegram.chatIds.join(", ")}`);
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
