import { TelegramClient, InputMedia, html } from "@mtcute/bun";
import { Dispatcher, type MessageContext } from "@mtcute/dispatcher";
import { parseVodMessage, parseVodMode, type VodMode } from "./utils";
import { getVodHlsStream, QualityNotFoundError, type AudioPick, type HlsStreamResult, type MuteStats } from "./hls";
import { getVkHlsStream } from "./vk";
import { ChannelOfflineError, DEFAULT_CHANNEL, resolveLiveVod } from "./twitch";
import { remuxHlsStream, type FfmpegRunResult } from "./ffmpeg";
import {
  EmptyTranscriptError,
  RateLimitError,
  formatRetryAfter,
  polishTranscript,
  transcribeAudio,
  FALLBACK_STT_MODEL,
  GROQ_MAX_FILE_BYTES,
  MAX_TRANSCRIPT_SECONDS,
  POLISH_MODEL,
  PRIMARY_STT_MODEL,
  type PolishResult,
  type SttResult,
} from "./transcribe";
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
const MAX_DURATION_SECONDS = 60 * 60; // 60 минут
const MAX_FILE_SIZE_BYTES = 3.5 * 1024 * 1024 * 1024; // 3.5 ГБ

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

async function safeDeleteStatus(chatId: number | string, messageId: number) {
  try {
    await tg.deleteMessagesById(chatId, [messageId]);
  } catch (e: any) {
    const errorStr = String(e?.message || e);
    if (!errorStr.includes("MESSAGE_ID_INVALID") && !errorStr.includes("MESSAGE_DELETE_FORBIDDEN")) {
      logger.warn("[Telegram Delete Error]:", errorStr);
    }
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
  vodUrl: string;
  index: number;
  total: number;
  mode: VodMode;
}): string {
  const { range, hls, muteStats, remux, vodId, vodUrl, index, total, mode } = params;

  // Нумерацию «i/N» показываем в мультизадачах (>1 клипа), одиночный клип — без неё
  const icon = mode === "audio" ? "🎵" : "🎬";
  const label = mode === "audio" ? "Аудио" : "Клип";
  const clipTitle =
    total > 1 ? `${icon} <b>${label} ${index}/${total} [${range.rawStart} - ${range.rawEnd}]</b>` : `${icon} <b>${label} [${range.rawStart} - ${range.rawEnd}]</b>`;

  let muteLine = "";
  if (muteStats.mutedFound > 0) {
    const isFullUnmute = muteStats.unmutedSuccess === muteStats.mutedFound;
    const icon = isFullUnmute ? "✅" : "⚠️";
    muteLine = `\n🔊 <b>Звук:</b> размьючено ${muteStats.unmutedSuccess}/${muteStats.mutedFound} ${icon}`;
  } else {
    muteLine = "\n🔊 <b>Звук:</b> чистый (без мьютов) ✅";
  }

  const qualityLine =
    mode === "audio"
      ? `🎵 <b>Формат:</b> AAC (${remux.bitrateKbps} kbps)\n`
      : `📺 <b>Качество:</b> ${hls.variant.quality} (${hls.variant.width}x${hls.variant.height} @ ${hls.variant.framerate}fps)\n`;

  return (
    `${clipTitle} (длительность: ${remux.duration}с)\n` +
    qualityLine +
    `📦 <b>Размер:</b> ${remux.sizeMB} MB${muteLine}\n` +
    `⚡ <b>Время обработки:</b> ${(remux.elapsedMs / 1000).toFixed(1)}с\n` +
    `🔗 <b>VOD:</b> <a href="${vodUrl}">${vodId}</a>`
  );
}

const STT_MODEL_LABELS: Record<string, string> = {
  [PRIMARY_STT_MODEL]: "Whisper Large V3",
  [FALLBACK_STT_MODEL]: "Whisper Large V3 Turbo",
};

/**
 * Подпись к файлу транскрипта. Показывает всё, что мог пойти не так:
 * какая модель распознавала, был ли fallback и удалось ли причесать текст.
 */
function buildTranscriptCaption(params: {
  range: { rawStart: string; rawEnd: string };
  stt: SttResult;
  polish: PolishResult;
  durationSec: number;
  vodId: string;
  vodUrl: string;
}): string {
  const { range, stt, polish, durationSec, vodId, vodUrl } = params;

  const modelLine = `🎤 <b>Распознавание:</b> ${STT_MODEL_LABELS[stt.model] ?? stt.model}`;
  const fallbackLine = stt.fallbackReason ? `\n   ↳ <i>fallback: ${stt.fallbackReason}</i>` : "";
  const polishLine = polish.polished
    ? `✨ <b>Обработка:</b> причесан ${POLISH_MODEL} (thinking: low)`
    : `⚠️ <b>Обработка:</b> сырой текст без причесывания\n   ↳ <i>${POLISH_MODEL}: ${polish.failureReason ?? "неизвестная ошибка"}</i>`;

  return (
    `🎙 <b>Транскрипт [${range.rawStart} - ${range.rawEnd}]</b>\n` +
    `⏱ <b>Длительность:</b> ${durationSec}с\n` +
    `📝 <b>Символов:</b> ${polish.text.length}\n\n` +
    `${modelLine}${fallbackLine}\n` +
    `${polishLine}\n\n` +
    `🔗 <b>VOD:</b> <a href="${vodUrl}">${vodId}</a>`
  );
}

/** Короткий бейдж для строки статуса: какая модель и причесан ли текст. */
function transcriptBadge(stt: SttResult, polish: PolishResult): string {
  const model = stt.model === FALLBACK_STT_MODEL ? "V3 Turbo" : "V3";
  const quality = polish.polished ? "причесан" : "сырой";
  const warn = stt.model === FALLBACK_STT_MODEL ? " ⚠️" : "";
  return `${model}${warn} · ${quality}`;
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

    const mode = text ? parseVodMode(text) : "video";

    if (!text || (!text.startsWith("!клип") && mode === "video")) return;

    const isAudio = mode === "audio";
    const isTranscript = mode === "transcript";

    // 1. Парсинг команды
    let parsedVod;
    try {
      parsedVod = parseVodMessage(text, config.twitch.channels);
    } catch (e: any) {
      await answerText(msg, toTelegramHtml(`❌ <b>Ошибка парсинга команды:</b> <code>${e?.message || e}</code>`));
      return;
    }

    if (!parsedVod.platform) {
      await answerText(
        msg,
        toTelegramHtml(
          "❌ <b>Ошибка:</b> не удалось распознать ссылку (Twitch VOD или VK Видео) " +
            "или канал (<code>влг</code>/<code>wlg</code>, <code>табула</code>/<code>tabula</code>).",
        ),
      );
      return;
    }

    if (!parsedVod.ranges.length) {
      await answerText(
        msg,
        toTelegramHtml("❌ <b>Ошибка:</b> не найдены временные интервалы (например: <code>10:00 - 12:30</code>)."),
      );
      return;
    }

    const isVk = parsedVod.platform === "vk";
    const channelName = parsedVod.channel ?? DEFAULT_CHANNEL;
    let vodId = parsedVod.vodId;

    // Вместо ссылки указан алиас канала — ищем VOD текущего эфира
    if (!vodId) {
      let live;
      try {
        live = await resolveLiveVod(channelName, { proxy: config.proxy, oauth: config.twitch.oauth });
      } catch (e: any) {
        const reason =
          e instanceof ChannelOfflineError
            ? `Канал <code>${channelName}</code> сейчас не в эфире — клипить нечего.`
            : `Не удалось найти VOD текущего эфира канала <code>${channelName}</code>: ${e?.message || e}`;
        await answerText(msg, toTelegramHtml(`❌ <b>Ошибка:</b> ${reason}`));
        return;
      }

      vodId = live.vodId;
      parsedVod = { ...parsedVod, vodId: live.vodId, vodUrl: live.vodUrl };
    }

    const totalRanges = parsedVod.ranges.length;
    // Оригинальная ссылка из поста юзера, фолбэк — канонический URL по ID
    const vodUrl = parsedVod.vodUrl ?? (isVk ? `https://vkvideo.ru/video${vodId}` : `https://www.twitch.tv/videos/${vodId}`);
    const requestedQualities = parsedVod.qualities;
    const audioPick: AudioPick = isTranscript ? "cheapest" : isAudio ? "best" : "none";
    // В режиме транскрипта качество из команды игнорируется: Groq смотрит только на звук,
    // поэтому берём самую лёгкую дорожку, а не лучшую по битрейту.
    const effectiveQualities = isTranscript
      ? undefined
      : requestedQualities.length > 0
        ? requestedQualities
        : undefined;
    const qualityLine = isTranscript
      ? `🎙 Режим: <b>транскрипт речи</b> (Whisper Large V3 → Gemini Flash Lite)\n`
      : isAudio
        ? `🎵 Режим: <b>только звук (AAC)</b>${requestedQualities.length > 0 ? ` (источник: ${requestedQualities.join(", ")})` : ""}\n`
        : requestedQualities.length > 0
          ? `🎯 Качество: <b>${requestedQualities.join(", ")}</b>\n`
          : `🎯 Качество: <b>максимальное</b>\n`;

    const fetchStream = (start: number, end: number) =>
      isVk
        ? getVkHlsStream({
            videoId: vodId,
            start,
            end,
            quality: effectiveQualities,
            proxy: config.proxy,
            audio: audioPick,
          })
        : getVodHlsStream({
            channel: channelName,
            vodId,
            start,
            end,
            quality: effectiveQualities,
            oauth: config.twitch.oauth,
            proxy: config.proxy,
            audio: audioPick,
          });

    // 2. Отправка начального статусного сообщения
    const sourceLine = isVk
      ? `🌐 Источник: <b>VK Видео</b> | Видео: <code>${vodId}</code>\n`
      : `📺 Канал: <b>${channelName}</b> | VOD: <code>${vodId}</code>\n`;

    const initialText =
      `📥 <b>Запрос принят!</b>\n` +
      sourceLine +
      qualityLine +
      `⏱ ${isTranscript ? "Фрагментов" : "Клипов"} в очереди: <b>${totalRanges}</b>\n\n` +
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
    statusCtx = { chatId, msgId: statusMsgId, vodId, lines: statuses };
    let successCount = 0;

    // Счётчики для итоговой статистики
    let totalDurationSec = 0;
    let totalSizeMB = 0;
    let totalMutedSegments = 0;
    let totalUnmutedSegments = 0;
    let totalFailedUnmutedSegments = 0;

    // Счётчики режима транскрипта
    let transcriptTurboCount = 0;
    let transcriptPolishedCount = 0;
    // После 429 на Whisper V3 весь остаток команды идёт на turbo: заведомый 429 не ловим повторно.
    let preferTurbo = false;

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
        await safeUpdateStatus(chatId, statusMsgId, buildStatusMessage(vodId, statuses));
        continue;
      }

      // 3.2 Валидация длительности
      const clipDuration = range.endSeconds - range.startSeconds;
      // Groq free tier не примет файл больше 25 MB (~20 минут AAC 160 kbps)
      const maxDuration = isTranscript ? MAX_TRANSCRIPT_SECONDS : MAX_DURATION_SECONDS;
      if (clipDuration > maxDuration) {
        const maxMinutes = Math.round(maxDuration / 60);
        const requestedMinutes = (clipDuration / 60).toFixed(1);
        statuses[i] =
          `❌ [${currentIndex}/${totalRanges}] <code>${range.rawStart} - ${range.rawEnd}</code> — превышен лимит длительности (${requestedMinutes} мин > ${maxMinutes} мин)`;
        await safeUpdateStatus(chatId, statusMsgId, buildStatusMessage(vodId, statuses));
        continue;
      }

      // Режим транскрипта: собственный конвейер (аудио → Whisper → Gemini → .txt)
      if (isTranscript) {
        const rawRange = `${range.rawStart} - ${range.rawEnd}`;
        const tag = `[${currentIndex}/${totalRanges}] <code>${rawRange}</code>`;
        const stem = `${config.tmpDir}/transcript_${vodId}_${range.startSeconds}_${range.endSeconds}`;
        const audioPath = `${stem}.m4a`;
        const txtPath = `${stem}.txt`;

        try {
          statuses[i] = `🔄 ${tag} — получение аудио...`;
          await safeUpdateStatus(chatId, statusMsgId, buildStatusMessage(vodId, statuses));

          const hlsStream = await fetchStream(range.startSeconds, range.endSeconds);

          statuses[i] = `⚙️ ${tag} — ремуксинг M4A...`;
          await safeUpdateStatus(chatId, statusMsgId, buildStatusMessage(vodId, statuses));

          const remuxResult = await remuxHlsStream({
            stream: hlsStream.stream,
            outPath: audioPath,
            trimStart: hlsStream.trimStart,
            trimDuration: hlsStream.trimDuration,
            verbose: false,
            audioOnly: true,
          });
          // Статистика мьютов транскрипту не нужна, но промис надо потребить, иначе будет unhandled rejection
          await hlsStream.muteStats.catch(() => {});

          if (remuxResult.sizeBytes > GROQ_MAX_FILE_BYTES) {
            statuses[i] =
              `❌ ${tag} — слишком большой фрагмент для Groq (${remuxResult.sizeMB} MB > 25 MB). Разбей интервал пополам.`;
            continue;
          }

          statuses[i] = `📝 ${tag} — распознавание речи (${preferTurbo ? "Turbo" : "V3"})...`;
          await safeUpdateStatus(chatId, statusMsgId, buildStatusMessage(vodId, statuses));

          const stt = await transcribeAudio(Bun.file(audioPath), remuxResult.duration, preferTurbo);
          if (stt.model === FALLBACK_STT_MODEL) {
            transcriptTurboCount++;
            preferTurbo = true;
          }

          statuses[i] = `✨ ${tag} — причесывание текста...`;
          await safeUpdateStatus(chatId, statusMsgId, buildStatusMessage(vodId, statuses));

          const polish = await polishTranscript(stt.text);
          if (polish.polished) transcriptPolishedCount++;

          await Bun.write(txtPath, `${polish.text}\n`);

          statuses[i] = `⬆️ ${tag} — отправка (${polish.text.length} символов)...`;
          await safeUpdateStatus(chatId, statusMsgId, buildStatusMessage(vodId, statuses));

          try {
            await tg.sendTyping(msg.chat.id, "upload_document");
          } catch {}

          await tg.sendMedia(
            msg.chat.id,
            InputMedia.document(`file:${txtPath}`, {
              caption: toTelegramHtml(
                buildTranscriptCaption({
                  range,
                  stt,
                  polish,
                  durationSec: Math.round(remuxResult.duration),
                  vodId,
                  vodUrl,
                }),
              ),
            }),
            { replyTo: isChannelChat(msg) ? undefined : msg.id },
          );

          totalDurationSec += remuxResult.duration;
          statuses[i] = `✅ ${tag} (${Math.round(remuxResult.duration)}с · ${transcriptBadge(stt, polish)})`;
          successCount++;
        } catch (e: any) {
          if (e instanceof RateLimitError) {
            logger.warn(`[Groq Limit ${currentIndex}/${totalRanges}]:`, e.detail);
            statuses[i] = `❌ ${tag} — ${e.detail}`;
            for (let j = i + 1; j < parsedVod.ranges.length; j++) {
              const pending = parsedVod.ranges[j]!;
              statuses[j] =
                `⏭ [${j + 1}/${totalRanges}] <code>${pending.rawStart} - ${pending.rawEnd}</code> — пропущен (лимит Groq)`;
            }
            break;
          }
          if (e instanceof EmptyTranscriptError) {
            statuses[i] = `⚠️ ${tag} — в этом фрагменте не распознано речи`;
          } else {
            logger.error(`[Error Transcript ${currentIndex}/${totalRanges}]:`, e);
            const errDescription = e?.message ? e.message.slice(0, 200) : String(e);
            statuses[i] = `❌ ${tag} — ошибка: ${errDescription}`;
          }
        } finally {
          await safeDeleteFile(audioPath);
          await safeDeleteFile(txtPath);
          await safeUpdateStatus(chatId, statusMsgId, buildStatusMessage(vodId, statuses));
        }
        continue;
      }

      const outPath = `${config.tmpDir}/${isAudio ? "audio" : "clip"}_${vodId}_${range.startSeconds}_${range.endSeconds}.${isAudio ? "m4a" : "mp4"}`;

      try {
        // Этап 1: Получение HLS потока
        statuses[i] =
          `🔄 [${currentIndex}/${totalRanges}] <code>${range.rawStart} - ${range.rawEnd}</code> — получение HLS...`;
        await safeUpdateStatus(chatId, statusMsgId, buildStatusMessage(vodId, statuses));

        const hlsStream = await fetchStream(range.startSeconds, range.endSeconds);

        // Этап 2: Ремуксинг
        statuses[i] =
          `⚙️ [${currentIndex}/${totalRanges}] <code>${range.rawStart} - ${range.rawEnd}</code> — ремуксинг ${isAudio ? "M4A" : `MP4 (${hlsStream.variant.quality})`}...`;
        await safeUpdateStatus(chatId, statusMsgId, buildStatusMessage(vodId, statuses));

        const [remuxResult, muteStats] = await Promise.all([
          remuxHlsStream({
            stream: hlsStream.stream,
            outPath,
            trimStart: hlsStream.trimStart,
            trimDuration: hlsStream.trimDuration,
            verbose: false,
            audioOnly: isAudio,
          }),
          hlsStream.muteStats,
        ]);

        // 3.3 Валидация размера файла
        if (remuxResult.sizeBytes > MAX_FILE_SIZE_BYTES) {
          const maxGB = (MAX_FILE_SIZE_BYTES / (1024 * 1024 * 1024)).toFixed(1);
          const actualGB = (remuxResult.sizeBytes / (1024 * 1024 * 1024)).toFixed(2);
          statuses[i] =
            `❌ [${currentIndex}/${totalRanges}] <code>${range.rawStart} - ${range.rawEnd}</code> — превышен лимит размера (${actualGB} GB > ${maxGB} GB)`;
          await safeUpdateStatus(chatId, statusMsgId, buildStatusMessage(vodId, statuses));
          continue;
        }

        // Этап 3: Отправка в Telegram
        statuses[i] =
          `⬆️ [${currentIndex}/${totalRanges}] <code>${range.rawStart} - ${range.rawEnd}</code> — загрузка в Telegram (${remuxResult.sizeMB} MB)...`;
        await safeUpdateStatus(chatId, statusMsgId, buildStatusMessage(vodId, statuses));

        try {
          await tg.sendTyping(msg.chat.id, isAudio ? "upload_voice" : "upload_video");
        } catch {}

        const caption = buildCaption({
          range,
          hls: hlsStream,
          muteStats,
          remux: remuxResult,
          vodId,
          vodUrl,
          index: currentIndex,
          total: totalRanges,
          mode,
        });

        await tg.sendMedia(
          msg.chat.id,
          isAudio
            ? InputMedia.audio(`file:${outPath}`, {
                caption: toTelegramHtml(caption),
                duration: Math.round(remuxResult.duration),
              })
            : InputMedia.video(`file:${outPath}`, {
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
        await safeUpdateStatus(chatId, statusMsgId, buildStatusMessage(vodId, statuses));
      }
    }

    // 4. Финал: всё ок — статусный пост удаляем, чтобы не мусорить в канале.
    // Оставляем его только если есть ошибки — там вся диагностика.
    if (successCount === totalRanges) {
      await safeDeleteStatus(chatId, statusMsgId);
      return;
    }

    let finalHeader = `⚠️ <b>Обработка завершена</b> (Успешно: ${successCount} из ${totalRanges})`;

    if (successCount > 0) {
      if (isTranscript) {
        finalHeader += `\n🎙 <b>Итог:</b> ${Math.round(totalDurationSec)}с аудио · ${successCount} расшифровок`;
        finalHeader += `\n✨ <b>Причесано:</b> ${transcriptPolishedCount} из ${successCount}`;
        if (transcriptTurboCount > 0) {
          finalHeader += `\n⚠️ <b>Turbo-фолбэк:</b> ${transcriptTurboCount} (лимит Whisper V3 исчерпан)`;
        }
      } else {
        finalHeader += `\n📊 <b>Итог:</b> ${totalDurationSec}с видео · ${totalSizeMB.toFixed(2)} MB`;

        if (totalMutedSegments > 0) {
          const percent = Math.round((totalUnmutedSegments / totalMutedSegments) * 100);
          const icon = totalFailedUnmutedSegments === 0 ? "✅" : "⚠️";
          finalHeader += `\n🔊 <b>Восстановление звука:</b> ${totalUnmutedSegments}/${totalMutedSegments} сегментов (${percent}%) ${icon}`;
        } else {
          finalHeader += `\n🔊 <b>Звук:</b> замьюченных сегментов не обнаружено ✅`;
        }
      }
    }

    await safeUpdateStatus(chatId, statusMsgId, buildStatusMessage(vodId, statuses, finalHeader));
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
