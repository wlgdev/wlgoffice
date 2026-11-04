import { InputMedia, type TelegramClient } from "@mtcute/bun";
import type { Dispatcher, MessageContext } from "@mtcute/dispatcher";
import { PropagationAction } from "@mtcute/dispatcher";

import config from "../../config";
import { resolveChatAccess } from "../../core/chat-target";
import { parseInteropPayload, stripInteropPayload } from "../../core/interop";
import type { AudioPick, InteropPayload } from "../../core/types";
import { parseVodMessage, parseVodMode, safeDeleteFile } from "../../core/utils";
import logger from "../../logger";
import { processClip } from "../../pipeline/clip.processor";
import { processTranscript } from "../../pipeline/transcript.processor";
import { DurationLimitError, FileSizeLimitError, GroqFileSizeLimitError } from "../../pipeline/types";
import { getVodHlsStream, QualityNotFoundError } from "../../services/hls";
import { EmptyTranscriptError, FALLBACK_STT_MODEL, RateLimitError } from "../../services/transcribe";
import { ChannelOfflineError, DEFAULT_CHANNEL, resolveLiveVod } from "../../services/twitch";
import { getVkHlsStream } from "../../services/vk";
import {
  buildCaption,
  buildDeleteKeyboard,
  buildQualityNotFoundStatus,
  buildRequesterLine,
  buildTranscriptCaption,
  escapeHtml,
  formatMuteBadge,
  toTelegramHtml,
  transcriptBadge,
} from "../formatters";
import { validateInterop } from "../interop-guard";
import { StatusTracker } from "../status-tracker";
import { createTelegramPort } from "../telegram-port";
import { getMessageThreadId } from "../topic";

function isChannelChat(msg: MessageContext): boolean {
  return "chatType" in msg.chat && msg.chat.chatType === "channel";
}

function answerText(
  tg: TelegramClient,
  msg: MessageContext,
  text: ReturnType<typeof toTelegramHtml>,
  threadId?: number,
) {
  if (isChannelChat(msg)) {
    return tg.sendText(msg.chat.id, text);
  }
  return msg.replyText(text, { threadId });
}

export function setupMessageHandler(dp: Dispatcher, tg: TelegramClient): void {
  dp.onNewMessage(async (msg) => {
    let tracker: StatusTracker | undefined;
    let interop: InteropPayload | null = null;
    let targetChatId: number | string = msg.chat.id;
    let targetThreadId: number | undefined;

    try {
      const text = msg.text;

      if (text === "!ping") {
        await answerText(tg, msg, toTelegramHtml("pong"), getMessageThreadId(msg));
        return PropagationAction.Continue;
      }

      interop = text ? parseInteropPayload(text) : null;
      const cmdText = interop && text ? stripInteropPayload(text) : text;
      const mode = cmdText ? parseVodMode(cmdText) : "video";

      if (!cmdText || (!cmdText.trim().startsWith("!клип") && mode === "video")) {
        return PropagationAction.Continue;
      }

      if (interop) {
        const problem = validateInterop(msg, interop);
        if (problem) {
          await answerText(tg, msg, toTelegramHtml(problem));
          return PropagationAction.Continue;
        }
        targetChatId = interop.to!;
      } else {
        const access = resolveChatAccess(config.telegram.targets, msg.chat.id, getMessageThreadId(msg));
        if (!access) {
          return PropagationAction.Continue;
        }
        targetThreadId = access.threadId;
      }

      const sendStatus = async (statusText: ReturnType<typeof toTelegramHtml>) =>
        interop ? tg.sendText(targetChatId, statusText) : answerText(tg, msg, statusText, targetThreadId);

      const errorStatus = (body: string) => (interop ? `${body}\n${buildRequesterLine(interop)}` : body);

      const isAudio = mode === "audio";
      const isTranscript = mode === "transcript";

      let parsedVod;
      try {
        parsedVod = parseVodMessage(cmdText, config.twitch.channels);
      } catch (e: any) {
        await sendStatus(
          toTelegramHtml(errorStatus(`❌ <b>Ошибка парсинга команды:</b> <code>${e?.message || e}</code>`)),
        );
        return PropagationAction.Continue;
      }

      if (interop) {
        const from = interop.from;

        if (from !== "twitch" && from !== "vk") {
          await sendStatus(
            toTelegramHtml(
              errorStatus(`❌ <b>Интероп:</b> источник <code>${escapeHtml(from)}</code> не поддерживается.`),
            ),
          );
          return PropagationAction.Continue;
        }

        if (from === "vk" && parsedVod.platform !== "vk") {
          await sendStatus(
            toTelegramHtml(errorStatus("❌ <b>Интероп:</b> для источника <code>vk</code> нужна ссылка на видео.")),
          );
          return PropagationAction.Continue;
        }

        if (from === "twitch") {
          if (parsedVod.platform === "vk") {
            await sendStatus(
              toTelegramHtml(
                errorStatus("❌ <b>Интероп:</b> источник <code>twitch</code>, но в команде ссылка на VK Видео."),
              ),
            );
            return PropagationAction.Continue;
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
        return PropagationAction.Continue;
      }

      if (!parsedVod.ranges.length) {
        await sendStatus(
          toTelegramHtml(
            errorStatus("❌ <b>Ошибка:</b> не найдены временные интервалы (например: <code>10:00 - 12:30</code>)."),
          ),
        );
        return PropagationAction.Continue;
      }

      const isVk = parsedVod.platform === "vk";
      const channelName = parsedVod.channel ?? DEFAULT_CHANNEL;
      let vodId = parsedVod.vodId;

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
          return PropagationAction.Continue;
        }

        vodId = live.vodId;
        parsedVod = { ...parsedVod, vodId: live.vodId, vodUrl: live.vodUrl };
      }

      const totalRanges = parsedVod.ranges.length;
      const vodUrl =
        parsedVod.vodUrl ?? (isVk ? `https://vkvideo.ru/video${vodId}` : `https://www.twitch.tv/videos/${vodId}`);
      const requestedQualities = parsedVod.qualities;
      const audioPick: AudioPick = isTranscript ? "cheapest" : isAudio ? "best" : "none";
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
              tg,
              msg,
              toTelegramHtml(`❌ <b>Не удалось отправить статус в чат <code>${targetChatId}</code>.</b>`),
            );
          } catch {}
        }
        return PropagationAction.Continue;
      }

      const initialLines = parsedVod.ranges.map((r) => `<code>${r.rawStart} - ${r.rawEnd}</code>`);
      tracker = new StatusTracker(
        createTelegramPort(tg),
        statusMsg.chat.id,
        statusMsg.id,
        vodId,
        initialLines,
        interop ? buildRequesterLine(interop) : undefined,
      );

      let successCount = 0;
      let totalDurationSec = 0;
      let totalSizeMB = 0;
      let totalMutedSegments = 0;
      let totalUnmutedSegments = 0;
      let totalFailedUnmutedSegments = 0;
      let transcriptTurboCount = 0;
      let transcriptPolishedCount = 0;
      let preferTurbo = false;

      for (let i = 0; i < parsedVod.ranges.length; i++) {
        const range = parsedVod.ranges[i]!;
        const currentIndex = i + 1;
        const rawRange = `${range.rawStart} - ${range.rawEnd}`;
        const tag = `[${currentIndex}/${totalRanges}] <code>${rawRange}</code>`;

        if (
          !Number.isFinite(range.startSeconds) ||
          !Number.isFinite(range.endSeconds) ||
          range.startSeconds >= range.endSeconds
        ) {
          tracker.setLine(i, `❌ ${tag} — некорректный интервал`);
          continue;
        }

        if (isTranscript) {
          let txtPath: string | undefined;
          try {
            tracker.setLine(i, `🔄 ${tag} — получение аудио...`);

            const result = await processTranscript({
              range,
              vodId,
              fetchStream,
              preferTurbo,
              onProgress: (stage) => {
                if (stage === "remux") {
                  tracker!.setLine(i, `⚙️ ${tag} — ремуксинг M4A...`);
                } else if (stage === "stt") {
                  tracker!.setLine(i, `📝 ${tag} — распознавание речи (${preferTurbo ? "Turbo" : "V3"})...`);
                } else if (stage === "polish") {
                  tracker!.setLine(i, `✨ ${tag} — причесывание текста...`);
                }
              },
            });

            txtPath = result.txtPath;

            if (result.stt.model === FALLBACK_STT_MODEL) {
              transcriptTurboCount++;
              preferTurbo = true;
            }
            if (result.polish.polished) {
              transcriptPolishedCount++;
            }

            tracker.setLine(i, `⬆️ ${tag} — отправка (${result.polish.text.length} символов)...`);

            try {
              await tg.sendTyping(targetChatId, "upload_document", { threadId: targetThreadId });
            } catch {}

            await tg.sendMedia(
              targetChatId,
              InputMedia.document(`file:${txtPath}`, {
                caption: toTelegramHtml(
                  buildTranscriptCaption({
                    range,
                    stt: result.stt,
                    polish: result.polish,
                    durationSec: Math.round(result.remux.duration),
                    vodId,
                    vodUrl,
                  }),
                ),
              }),
              {
                replyMarkup: buildDeleteKeyboard(),
                replyTo: interop || isChannelChat(msg) ? undefined : msg.id,
                threadId: targetThreadId,
              },
            );

            totalDurationSec += result.remux.duration;
            tracker.setLine(
              i,
              `✅ ${tag} (${Math.round(result.remux.duration)}с · ${transcriptBadge(result.stt, result.polish)})`,
            );
            successCount++;
          } catch (e: any) {
            if (e instanceof RateLimitError) {
              logger.warn(`[Groq Limit ${currentIndex}/${totalRanges}]:`, e.detail);
              tracker.setLine(i, `❌ ${tag} — ${e.detail}`);
              for (let j = i + 1; j < parsedVod.ranges.length; j++) {
                const pending = parsedVod.ranges[j]!;
                tracker.setLine(
                  j,
                  `⏭ [${j + 1}/${totalRanges}] <code>${pending.rawStart} - ${pending.rawEnd}</code> — пропущен (лимит Groq)`,
                );
              }
              break;
            }
            if (e instanceof EmptyTranscriptError) {
              tracker.setLine(i, `⚠️ ${tag} — в этом фрагменте не распознано речи`);
            } else if (e instanceof DurationLimitError || e instanceof GroqFileSizeLimitError) {
              tracker.setLine(i, `❌ ${tag} — ${e.message}`);
            } else {
              logger.error(`[Error Transcript ${currentIndex}/${totalRanges}]:`, e);
              const errDescription = e?.message ? e.message.slice(0, 200) : String(e);
              tracker.setLine(i, `❌ ${tag} — ошибка: ${errDescription}`);
            }
          } finally {
            if (txtPath) {
              await safeDeleteFile(txtPath);
            }
          }
          continue;
        }

        let outPath: string | undefined;
        try {
          tracker.setLine(i, `🔄 ${tag} — получение HLS...`);

          const result = await processClip({
            range,
            vodId,
            isAudio,
            fetchStream,
            onProgress: (stage) => {
              if (stage === "remux") {
                tracker!.setLine(i, `⚙️ ${tag} — ремуксинг ${isAudio ? "M4A" : "MP4"}...`);
              }
            },
          });

          outPath = result.outPath;

          tracker.setLine(i, `⬆️ ${tag} — загрузка в Telegram (${result.remux.sizeMB} MB)...`);

          try {
            await tg.sendTyping(targetChatId, isAudio ? "upload_voice" : "upload_video", {
              threadId: targetThreadId,
            });
          } catch {}

          const caption = buildCaption({
            range,
            hls: result.hls,
            muteStats: result.muteStats,
            remux: result.remux,
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
                  duration: Math.round(result.remux.duration),
                })
              : InputMedia.video(`file:${outPath}`, {
                  caption: toTelegramHtml(caption),
                  width: result.hls.variant.width,
                  height: result.hls.variant.height,
                  supportsStreaming: true,
                }),
            {
              replyMarkup: buildDeleteKeyboard(),
              replyTo: interop || isChannelChat(msg) ? undefined : msg.id,
              threadId: targetThreadId,
            },
          );

          const muteBadge = formatMuteBadge(result.muteStats);
          tracker.setLine(i, `✅ ${tag} (${result.remux.duration}с · ${result.remux.sizeMB} MB · ${muteBadge})`);

          successCount++;
          totalDurationSec += result.remux.duration;
          totalSizeMB += result.remux.sizeMB;
          totalMutedSegments += result.muteStats.mutedFound;
          totalUnmutedSegments += result.muteStats.unmutedSuccess;
          totalFailedUnmutedSegments += result.muteStats.remainedMuted;
        } catch (e: any) {
          if (e instanceof QualityNotFoundError) {
            logger.warn(`[Quality ${currentIndex}/${totalRanges}]:`, e.message);
            tracker.setLine(i, buildQualityNotFoundStatus(currentIndex, totalRanges, rawRange, e));
            for (let j = i + 1; j < parsedVod.ranges.length; j++) {
              const pending = parsedVod.ranges[j]!;
              tracker.setLine(
                j,
                `⏭ [${j + 1}/${totalRanges}] <code>${pending.rawStart} - ${pending.rawEnd}</code> — пропущен (качество не найдено)`,
              );
            }
            break;
          }
          if (e instanceof DurationLimitError || e instanceof FileSizeLimitError) {
            tracker.setLine(i, `❌ ${tag} — ${e.message}`);
          } else {
            logger.error(`[Error Clip ${currentIndex}/${totalRanges}]:`, e);
            const errDescription = e?.message ? e.message.slice(0, 200) : String(e);
            tracker.setLine(i, `❌ ${tag} — ошибка: ${errDescription}`);
          }
        } finally {
          if (outPath) {
            await safeDeleteFile(outPath);
          }
        }
      }

      if (successCount === totalRanges) {
        await tracker.delete();
        if (interop) {
          await answerText(
            tg,
            msg,
            toTelegramHtml(`✅ <b>Готово:</b> ${successCount} из ${totalRanges} в чат <code>${targetChatId}</code>.`),
          );
        }
        return PropagationAction.Continue;
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

      await tracker.flush(finalHeader);

      if (interop) {
        await answerText(
          tg,
          msg,
          toTelegramHtml(
            `⚠️ <b>Готово частично:</b> ${successCount} из ${totalRanges} в чат <code>${targetChatId}</code>. Подробности — в статусе.`,
          ),
        );
      }
    } catch (fatalError: any) {
      logger.error("💥 [Fatal Handler Error]:", fatalError);
      const fatalText = `❌ <b>Критическая ошибка:</b> <code>${fatalError?.message || fatalError}</code>`;
      if (tracker) {
        await tracker.recordFatal(fatalText);
      } else {
        try {
          await answerText(tg, msg, toTelegramHtml(fatalText));
        } catch {}
      }

      if (interop) {
        try {
          await answerText(
            tg,
            msg,
            toTelegramHtml(
              `💥 <b>Обработка прервана.</b> Подробности — в статусе в чате <code>${targetChatId}</code>.`,
            ),
          );
        } catch {}
      }
    }

    return PropagationAction.Continue;
  });
}
