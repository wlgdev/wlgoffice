import { existsSync } from "node:fs";

import { BotKeyboard, html, InputMedia, TelegramClient } from "@mtcute/bun";
import { Dispatcher, type MessageContext } from "@mtcute/dispatcher";

import config from "./config";
import { type FfmpegRunResult, remuxHlsStream } from "./ffmpeg";
import { type AudioPick, getVodHlsStream, type HlsStreamResult, type MuteStats, QualityNotFoundError } from "./hls";
import { type InteropPayload, parseInteropPayload, stripInteropPayload } from "./interop";
import logger from "./logger";
import {
  EmptyTranscriptError,
  FALLBACK_STT_MODEL,
  formatRetryAfter,
  GROQ_MAX_FILE_BYTES,
  MAX_TRANSCRIPT_SECONDS,
  POLISH_MODEL,
  type PolishResult,
  polishTranscript,
  PRIMARY_STT_MODEL,
  RateLimitError,
  type SttResult,
  transcribeAudio,
} from "./transcribe";
import { ChannelOfflineError, DEFAULT_CHANNEL, resolveLiveVod } from "./twitch";
import { parseVodMessage, parseVodMode, type VodMode } from "./utils";
import { getVkHlsStream } from "./vk";

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

dp.onCallbackQuery(async (q) => {
  if (q.dataStr !== DELETE_CALLBACK_DATA) return;

  const chatId = q.chat.id;
  const allowed = config.telegram.chatIds.includes(Number(chatId)) || config.interop.chatIds.includes(Number(chatId));
  if (!allowed) {
    await q.answer({ text: "🚫 Этот чат не разрешён", alert: true });
    return;
  }

  try {
    await tg.deleteMessagesById(chatId, [q.messageId]);
    logger.info(
      `[Delete] ${q.user.id} (@${q.user.username ?? "no-username"}) удалил пост ${q.messageId} в чате ${chatId}`,
    );
    await q.answer({ text: "🗑 Удалено" });
  } catch (e: any) {
    const errorStr = String(e?.message || e);
    if (!errorStr.includes("MESSAGE_ID_INVALID")) {
      logger.warn("[Callback Delete Error]:", errorStr);
    }
    await q.answer({ text: "❌ Не удалось удалить", alert: true }).catch(() => {});
  }
});

// ─── Хелперы ─────────────────────────────────────────────────

function toTelegramHtml(text: string) {
  return html(text.replace(/\r?\n/g, "<br>"));
}

function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Строка «откуда инициирован запрос и кто его отправил» — для статуса и подписи клипа.
 */
function buildRequesterLine(interop: InteropPayload | null): string {
  if (!interop) {
    return "";
  }
  const username = interop.username ? ` · <b>username:</b> ${escapeHtml(interop.username)}` : "";
  return `🔗 <b>Инициировано из:</b> <b>${escapeHtml(interop.from)}</b>${username}`;
}

/**
 * Проверяет интероп-запрос: откуда пришёл, куда можно слать.
 * Возвращает текст ошибки или null, если запрос корректен.
 */
function validateInterop(msg: MessageContext, payload: InteropPayload): string | null {
  // Peer в личке — это User (type: "user"), в группах и каналах — Chat (type: "chat").
  if (msg.chat.type !== "user") {
    return "❌ <b>Интероп-запросы принимаются только в личке бота.</b>";
  }

  if (payload.to === null) {
    return "❌ <b>Интероп-запрос:</b> не указан корректный <code>to</code> (chat id получателя).";
  }

  if (!config.interop.chatIds.includes(payload.to)) {
    return `❌ <b>Интероп-запрос:</b> чат <code>${payload.to}</code> не разрешён для клипов.`;
  }

  return null;
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

const DELETE_CALLBACK_DATA = "del:media";

/**
 * Кнопка «Удалить» для итоговых постов (видео/аудио/транскрипт).
 * Нажать её может любой участник разрешённого чата.
 */
function buildDeleteKeyboard() {
  return BotKeyboard.inline([[BotKeyboard.callback("🗑 Удалить", DELETE_CALLBACK_DATA)]]);
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
  interop?: InteropPayload | null;
}): string {
  const { range, hls, muteStats, remux, vodId, vodUrl, index, total, mode, interop } = params;

  // Нумерацию «i/N» показываем в мультизадачах (>1 клипа), одиночный клип — без неё
  const icon = mode === "audio" ? "🎵" : "🎬";
  const label = mode === "audio" ? "Аудио" : "Клип";
  const clipTitle =
    total > 1
      ? `${icon} <b>${label} ${index}/${total} [${range.rawStart} - ${range.rawEnd}]</b>`
      : `${icon} <b>${label} [${range.rawStart} - ${range.rawEnd}]</b>`;

  const requesterLine = interop ? `${buildRequesterLine(interop)}\n` : "";

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
    requesterLine +
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

function buildStatusMessage(vodId: string, statuses: string[], header?: string, subtitle?: string): string {
  const title = header ?? `📥 <b>Обработка VOD <code>${vodId}</code></b>`;
  const sub = subtitle ? `${subtitle}\n` : "";
  return `${title}\n${sub}\n${statuses.join("\n")}`;
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
  let flushStatusForRequest: ((rawText: string) => Promise<void>) | undefined;
  let interop: InteropPayload | null = null;
  let targetChatId: number | string = msg.chat.id;
  try {
    const text = msg.text;

    if (text === "!ping") {
      await answerText(msg, toTelegramHtml("pong"));
      return;
    }

    // Интероп-запрос от внешнего бота: !клип {from:"twitch";to:"182834";username:"..."} 05:00 - 10:00 480p
    interop = text ? parseInteropPayload(text) : null;
    const cmdText = interop && text ? stripInteropPayload(text) : text;

    const mode = cmdText ? parseVodMode(cmdText) : "video";

    if (!cmdText || (!cmdText.trim().startsWith("!клип") && mode === "video")) return;

    if (interop) {
      const problem = validateInterop(msg, interop);
      if (problem) {
        await answerText(msg, toTelegramHtml(problem));
        return;
      }
      targetChatId = interop.to!;
    } else if (!config.telegram.chatIds.includes(msg.chat.id)) {
      return;
    }

    // По интероп-запросу статус и клипы уходят в целевой чат, а не в чат отправителя.
    const sendStatus = async (statusText: ReturnType<typeof toTelegramHtml>) =>
      interop ? tg.sendText(targetChatId, statusText) : answerText(msg, statusText);

    // Ошибка в целевом чате тоже должна показывать, откуда и от кого пришёл запрос.
    const errorStatus = (body: string) => (interop ? `${body}\n${buildRequesterLine(interop)}` : body);

    const isAudio = mode === "audio";
    const isTranscript = mode === "transcript";

    // 1. Парсинг команды
    let parsedVod;
    try {
      parsedVod = parseVodMessage(cmdText, config.twitch.channels);
    } catch (e: any) {
      await sendStatus(
        toTelegramHtml(errorStatus(`❌ <b>Ошибка парсинга команды:</b> <code>${e?.message || e}</code>`)),
      );
      return;
    }

    if (interop) {
      const from = interop.from;

      if (from !== "twitch" && from !== "vk") {
        await sendStatus(
          toTelegramHtml(
            errorStatus(`❌ <b>Интероп:</b> источник <code>${escapeHtml(from)}</code> не поддерживается.`),
          ),
        );
        return;
      }

      if (from === "vk" && parsedVod.platform !== "vk") {
        await sendStatus(
          toTelegramHtml(errorStatus("❌ <b>Интероп:</b> для источника <code>vk</code> нужна ссылка на видео.")),
        );
        return;
      }

      if (from === "twitch") {
        if (parsedVod.platform === "vk") {
          await sendStatus(
            toTelegramHtml(
              errorStatus("❌ <b>Интероп:</b> источник <code>twitch</code>, но в команде ссылка на VK Видео."),
            ),
          );
          return;
        }

        const channel = interop.channel ?? config.interop.twitchChannel ?? DEFAULT_CHANNEL;
        parsedVod = {
          ...parsedVod,
          platform: "twitch",
          channel: parsedVod.channel ?? channel,
        };
      }
    } else if (!parsedVod.platform) {
      await sendStatus(
        toTelegramHtml(
          errorStatus(
            "❌ <b>Ошибка:</b> не удалось распознать ссылку (Twitch VOD или VK Видео) " +
              "или канал (<code>влг</code>/<code>wlg</code>, <code>табула</code>/<code>tabula</code>).",
          ),
        ),
      );
      return;
    }

    if (!parsedVod.ranges.length) {
      await sendStatus(
        toTelegramHtml(
          errorStatus("❌ <b>Ошибка:</b> не найдены временные интервалы (например: <code>10:00 - 12:30</code>)."),
        ),
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
        await sendStatus(toTelegramHtml(errorStatus(`❌ <b>Ошибка:</b> ${reason}`)));
        return;
      }

      vodId = live.vodId;
      parsedVod = { ...parsedVod, vodId: live.vodId, vodUrl: live.vodUrl };
    }

    const totalRanges = parsedVod.ranges.length;
    // Оригинальная ссылка из поста юзера, фолбэк — канонический URL по ID
    const vodUrl =
      parsedVod.vodUrl ?? (isVk ? `https://vkvideo.ru/video${vodId}` : `https://www.twitch.tv/videos/${vodId}`);
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

    const requesterLine = interop ? `${buildRequesterLine(interop)}\n` : "";

    const initialText =
      `📥 <b>Запрос принят!</b>\n` +
      requesterLine +
      sourceLine +
      qualityLine +
      `⏱ ${isTranscript ? "Фрагментов" : "Клипов"} в очереди: <b>${totalRanges}</b>\n\n` +
      parsedVod.ranges
        .map((r, i) => `⏳ [${i + 1}/${totalRanges}] <code>${r.rawStart} - ${r.rawEnd}</code> — ожидание...`)
        .join("\n");

    let statusMsg;
    try {
      statusMsg = await sendStatus(toTelegramHtml(initialText));
    } catch (e) {
      if (String(e).includes("CHAT_ADMIN_REQUIRED")) {
        logger.error(
          "❌ Нет прав на отправку в этот чат: дай боту админку с правом «Публикация сообщений» " +
            "(и проверь, что в канал добавлен именно этот бот, а не другой с похожим именем).",
        );
      }
      logger.error("Не удалось отправить стартовое сообщение в чат:", e);
      if (interop) {
        try {
          await answerText(
            msg,
            toTelegramHtml(`❌ <b>Не удалось отправить статус в чат <code>${targetChatId}</code>.</b>`),
          );
        } catch {}
      }
      return;
    }

    const chatId = statusMsg.chat.id;
    const statusMsgId = statusMsg.id;

    // Telegram режет слишком частые правки одного сообщения (flood wait на editMessage),
    // поэтому одинаковые правки пропускаем, а разные — не чаще раза в MIN_STATUS_EDIT_MS.
    const MIN_STATUS_EDIT_MS = 1500;
    let lastEditAt = 0;
    let lastEditText = "";
    let pendingText: string | null = null;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;

    const applyStatus = async (rawText: string) => {
      pendingText = null;
      lastEditText = rawText;
      lastEditAt = Date.now();
      await safeUpdateStatus(chatId, statusMsgId, rawText);
    };

    const applyPending = async () => {
      if (pendingText === null) return;
      await applyStatus(pendingText);
    };

    const scheduleStatus = (rawText: string) => {
      if (rawText === lastEditText || rawText === pendingText) return;
      pendingText = rawText;

      const wait = MIN_STATUS_EDIT_MS - (Date.now() - lastEditAt);
      if (wait <= 0) {
        void applyPending();
      } else if (!pendingTimer) {
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          void applyPending();
        }, wait);
      }
    };

    /** Правка «здесь и сейчас» — для финального статуса, его нельзя откладывать. */
    const flushStatus = async (rawText: string) => {
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      if (rawText === lastEditText && pendingText === null) return;
      await applyStatus(rawText);
    };

    const dropPendingStatus = () => {
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      pendingText = null;
    };

    flushStatusForRequest = flushStatus;

    const statuses: string[] = parsedVod.ranges.map((r) => `<code>${r.rawStart} - ${r.rawEnd}</code>`);
    statusCtx = { chatId, msgId: statusMsgId, vodId, lines: statuses };
    let successCount = 0;

    // Статус-пост перезаписывается на каждом шаге, поэтому строку «инициировано из …»
    // надо возвращать в каждую редакцию, а не только в первое сообщение.
    const requesterSubtitle = interop ? buildRequesterLine(interop) : undefined;
    const statusMessage = (lines: string[], header?: string) =>
      buildStatusMessage(vodId, lines, header, requesterSubtitle);

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
        scheduleStatus(statusMessage(statuses));
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
        scheduleStatus(statusMessage(statuses));
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
          scheduleStatus(statusMessage(statuses));

          const hlsStream = await fetchStream(range.startSeconds, range.endSeconds);

          statuses[i] = `⚙️ ${tag} — ремуксинг M4A...`;
          scheduleStatus(statusMessage(statuses));

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
          scheduleStatus(statusMessage(statuses));

          const stt = await transcribeAudio(Bun.file(audioPath), remuxResult.duration, preferTurbo);
          if (stt.model === FALLBACK_STT_MODEL) {
            transcriptTurboCount++;
            preferTurbo = true;
          }

          statuses[i] = `✨ ${tag} — причесывание текста...`;
          scheduleStatus(statusMessage(statuses));

          const polish = await polishTranscript(stt.text);
          if (polish.polished) transcriptPolishedCount++;

          await Bun.write(txtPath, `${polish.text}\n`);

          statuses[i] = `⬆️ ${tag} — отправка (${polish.text.length} символов)...`;
          scheduleStatus(statusMessage(statuses));

          try {
            await tg.sendTyping(targetChatId, "upload_document");
          } catch {}

          await tg.sendMedia(
            targetChatId,
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
            { replyMarkup: buildDeleteKeyboard(), replyTo: interop || isChannelChat(msg) ? undefined : msg.id },
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
          scheduleStatus(statusMessage(statuses));
        }
        continue;
      }

      const outPath = `${config.tmpDir}/${isAudio ? "audio" : "clip"}_${vodId}_${range.startSeconds}_${range.endSeconds}.${isAudio ? "m4a" : "mp4"}`;

      try {
        // Этап 1: Получение HLS потока
        statuses[i] =
          `🔄 [${currentIndex}/${totalRanges}] <code>${range.rawStart} - ${range.rawEnd}</code> — получение HLS...`;
        scheduleStatus(statusMessage(statuses));

        const hlsStream = await fetchStream(range.startSeconds, range.endSeconds);

        // Этап 2: Ремуксинг
        statuses[i] =
          `⚙️ [${currentIndex}/${totalRanges}] <code>${range.rawStart} - ${range.rawEnd}</code> — ремуксинг ${isAudio ? "M4A" : `MP4 (${hlsStream.variant.quality})`}...`;
        scheduleStatus(statusMessage(statuses));

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
          scheduleStatus(statusMessage(statuses));
          continue;
        }

        // Этап 3: Отправка в Telegram
        statuses[i] =
          `⬆️ [${currentIndex}/${totalRanges}] <code>${range.rawStart} - ${range.rawEnd}</code> — загрузка в Telegram (${remuxResult.sizeMB} MB)...`;
        scheduleStatus(statusMessage(statuses));

        try {
          await tg.sendTyping(targetChatId, isAudio ? "upload_voice" : "upload_video");
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
          interop,
        });

        await tg.sendMedia(
          targetChatId,
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
          {
            replyMarkup: buildDeleteKeyboard(),
            replyTo: interop || isChannelChat(msg) ? undefined : msg.id,
          },
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
        scheduleStatus(statusMessage(statuses));
      }
    }

    // 4. Финал: всё ок — статусный пост удаляем, чтобы не мусорить в канале.
    // Оставляем его только если есть ошибки — там вся диагностика.
    if (successCount === totalRanges) {
      dropPendingStatus();
      await safeDeleteStatus(chatId, statusMsgId);
      if (interop) {
        await answerText(
          msg,
          toTelegramHtml(`✅ <b>Готово:</b> ${successCount} из ${totalRanges} в чат <code>${targetChatId}</code>.`),
        );
      }
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

    await flushStatus(statusMessage(statuses, finalHeader));

    if (interop) {
      await answerText(
        msg,
        toTelegramHtml(
          `⚠️ <b>Готово частично:</b> ${successCount} из ${totalRanges} в чат <code>${targetChatId}</code>. Подробности — в статусе.`,
        ),
      );
    }
  } catch (fatalError: any) {
    logger.error("💥 [Fatal Handler Error]:", fatalError);
    const fatalText = `❌ <b>Критическая ошибка:</b> <code>${fatalError?.message || fatalError}</code>`;
    if (statusCtx) {
      // Статус уже создан — дописываем ошибку в него, а не оставляем висеть на промежуточном этапе
      const fatalStatus = buildStatusMessage(
        statusCtx.vodId,
        [...statusCtx.lines, fatalText],
        `💥 <b>Обработка прервана</b>`,
        interop ? buildRequesterLine(interop) : undefined,
      );
      if (flushStatusForRequest) {
        await flushStatusForRequest(fatalStatus);
      } else {
        await safeUpdateStatus(statusCtx.chatId, statusCtx.msgId, fatalStatus);
      }
    } else {
      try {
        await answerText(msg, toTelegramHtml(fatalText));
      } catch {}
    }

    if (interop) {
      try {
        await answerText(
          msg,
          toTelegramHtml(`💥 <b>Обработка прервана.</b> Подробности — в статусе в чате <code>${targetChatId}</code>.`),
        );
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
