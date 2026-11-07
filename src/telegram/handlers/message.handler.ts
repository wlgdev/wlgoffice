import type { TelegramClient } from "@mtcute/bun";
import type { Dispatcher, MessageContext } from "@mtcute/dispatcher";
import { PropagationAction } from "@mtcute/dispatcher";

import config from "../../config";
import { resolveChatAccess } from "../../core/chat-target";
import { parseInteropPayload, stripInteropPayload } from "../../core/interop";
import type { AudioPick, InteropPayload } from "../../core/types";
import { formatTwitchTime, parseVodMessage, parseVodMode, safeDeleteFile } from "../../core/utils";
import logger from "../../logger";
import { processClip } from "../../pipeline/clip.processor";
import { processTranscript } from "../../pipeline/transcript.processor";
import { DurationLimitError, FileSizeLimitError, GroqFileSizeLimitError } from "../../pipeline/types";
import type { DB } from "../../services/db";
import { getVodHlsStream, QualityNotFoundError } from "../../services/hls";
import { EmptyTranscriptError, FALLBACK_STT_MODEL, RateLimitError } from "../../services/transcribe";
import { ChannelOfflineError, DEFAULT_CHANNEL, resolveLiveVod } from "../../services/twitch";
import { getVkHlsStream } from "../../services/vk";
import { buildMediaResultBlock, buildRequesterLine, buildStageLine, escapeHtml, toTelegramHtml } from "../formatters";
import { validateInterop } from "../interop-guard";
import { MediaJobMessage } from "../media-job";
import { createTelegramPort } from "../telegram-port";
import { getMessageThreadId } from "../topic";

const STAGE_FETCH = "получение HLS";
const STAGE_FETCH_AUDIO = "получение аудио";
const STAGE_REMUX_MP4 = "ремуксинг MP4";
const STAGE_REMUX_M4A = "ремуксинг M4A";
const STAGE_UPLOAD = "загрузка в Telegram";
const STAGE_STT = "распознавание речи";
const STAGE_POLISH = "причесывание текста";
const STAGE_RANGE = "разбор интервала";

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

function describeItemError(err: unknown): string {
  if (err instanceof RateLimitError) {
    return err.detail;
  }
  const message = (err as { message?: unknown })?.message;
  const text = typeof message === "string" && message ? message : String(err);
  return text.slice(0, 200);
}

function buildVodLink(vodUrl: string, startSec: number, isVk: boolean): string {
  if (!Number.isFinite(startSec)) {
    return vodUrl;
  }
  const separator = vodUrl.includes("?") ? "&" : "?";
  const stamp = isVk ? String(Math.max(0, Math.floor(startSec))) : formatTwitchTime(startSec);
  return `${vodUrl}${separator}t=${stamp}`;
}

export function setupMessageHandler(dp: Dispatcher, tg: TelegramClient, db: DB): void {
  dp.onNewMessage(async (msg) => {
    let job: MediaJobMessage | undefined;
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

      const vodLabel = `VOD`;
      const notes: string[] = [];
      if (interop) {
        notes.push(buildRequesterLine(interop));
      }
      if (requestedQualities.length > 0) {
        notes.push(`› 🎯 Качество: <b>${requestedQualities.join(", ")}</b>`);
      } else if (!isTranscript) {
        notes.push("› 🎯 Качество: <b>максимальное</b>");
      }

      const mediaJob = new MediaJobMessage(
        createTelegramPort(tg),
        targetChatId,
        undefined,
        {
          title: isTranscript ? "🎙 Транскрипт" : isAudio ? "🎵 Аудио" : totalRanges > 1 ? "🎬 Клипы" : "🎬 Клип",
          source: isVk ? `› 🌐 <a href="${vodUrl}">${vodId}</a>` : `› 📺 <a href="${vodUrl}">${vodId}</a>`,
          notes,
          items: parsedVod.ranges.map((range, index) => ({
            id: index + 1,
            range: `${range.rawStart}–${range.rawEnd}`,
            vodUrl: buildVodLink(vodUrl, range.startSeconds, isVk),
            vodLabel,
            stage: null,
            block: null,
            media: null,
          })),
        },
        db,
        targetThreadId,
        interop || isChannelChat(msg) ? undefined : msg.id,
      );

      job = mediaJob;
      const createCode = await mediaJob.flush();
      if (createCode) {
        const detail = mediaJob.error ?? "неизвестная ошибка";
        if (detail.includes("CHAT_ADMIN_REQUIRED")) {
          logger.error(
            "❌ Нет прав на отправку в этот чат: дай боту админку с правом «Публикация сообщений» " +
              "(и проверь, что в канал добавлен именно этот бот, а не другой с похожим именем).",
          );
        }
        logger.error("Не удалось отправить стартовое сообщение в чат:", detail);
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

      const stageLine = (icon: string, itemId: number, range: string, text: string) =>
        buildStageLine({ icon, index: itemId, total: totalRanges, range, text });

      let successCount = 0;
      let preferTurbo = false;

      for (let i = 0; i < parsedVod.ranges.length; i++) {
        const range = parsedVod.ranges[i]!;
        const itemId = i + 1;
        const rangeLabel = `${range.rawStart}–${range.rawEnd}`;
        const startedAt = Date.now();

        if (
          !Number.isFinite(range.startSeconds) ||
          !Number.isFinite(range.endSeconds) ||
          range.startSeconds >= range.endSeconds
        ) {
          mediaJob.fail(itemId, { stage: STAGE_RANGE, detail: "некорректный интервал", elapsedSec: 0 });
          continue;
        }

        if (isTranscript) {
          let txtPath: string | undefined;
          let stage = STAGE_FETCH_AUDIO;
          try {
            mediaJob.setStage(itemId, stageLine("🔄", itemId, rangeLabel, `${STAGE_FETCH_AUDIO}…`));

            const result = await processTranscript({
              range,
              vodId,
              fetchStream,
              preferTurbo,
              onProgress: (progress) => {
                if (progress === "remux") {
                  stage = STAGE_REMUX_M4A;
                  mediaJob.setStage(itemId, stageLine("⚙️", itemId, rangeLabel, `${STAGE_REMUX_M4A}…`));
                } else if (progress === "stt") {
                  stage = STAGE_STT;
                  mediaJob.setStage(itemId, stageLine("📝", itemId, rangeLabel, `${STAGE_STT}…`));
                } else if (progress === "polish") {
                  stage = STAGE_POLISH;
                  mediaJob.setStage(itemId, stageLine("✨", itemId, rangeLabel, `${STAGE_POLISH}…`));
                }
              },
            });

            txtPath = result.txtPath;

            if (result.stt.model === FALLBACK_STT_MODEL) {
              preferTurbo = true;
            }

            stage = STAGE_UPLOAD;
            mediaJob.setStage(itemId, stageLine("⬆️", itemId, rangeLabel, `${STAGE_UPLOAD}…`));

            const uploaded = await mediaJob.complete(itemId, {
              media: {
                type: "document",
                fileId: null,
                localPath: txtPath,
                width: 0,
                height: 0,
                duration: Math.round(result.remux.duration),
              },
              block: buildMediaResultBlock({
                mode: "transcript",
                itemId,
                range: rangeLabel,
                vodUrl: buildVodLink(vodUrl, range.startSeconds, isVk),
                vodLabel,
                durationSec: result.remux.duration,
                sizeMB: result.remux.sizeMB,
                elapsedSec: (Date.now() - startedAt) / 1000,
                sttModel: result.stt.model,
                polished: result.polish.polished,
                chars: result.polish.text.length,
              }),
              stage: STAGE_UPLOAD,
              elapsedSec: (Date.now() - startedAt) / 1000,
            });

            if (uploaded) {
              successCount++;
            }
          } catch (e: any) {
            if (e instanceof RateLimitError) {
              logger.warn(`[Groq Limit ${itemId}/${totalRanges}]:`, e.detail);
              mediaJob.fail(itemId, {
                stage,
                detail: e.detail,
                elapsedSec: (Date.now() - startedAt) / 1000,
              });
              for (let j = i + 1; j < parsedVod.ranges.length; j++) {
                mediaJob.skip(j + 1, "лимит Groq");
              }
              break;
            }
            if (e instanceof EmptyTranscriptError) {
              mediaJob.fail(itemId, {
                stage,
                detail: "в этом фрагменте не распознано речи",
                elapsedSec: (Date.now() - startedAt) / 1000,
              });
            } else if (e instanceof DurationLimitError || e instanceof GroqFileSizeLimitError) {
              mediaJob.fail(itemId, {
                stage,
                detail: e.message,
                elapsedSec: (Date.now() - startedAt) / 1000,
              });
            } else {
              logger.error(`[Error Transcript ${itemId}/${totalRanges}]:`, e);
              mediaJob.fail(itemId, {
                stage,
                detail: describeItemError(e),
                elapsedSec: (Date.now() - startedAt) / 1000,
              });
            }
          } finally {
            if (txtPath) {
              await safeDeleteFile(txtPath);
            }
          }
          continue;
        }

        let outPath: string | undefined;
        let stage = STAGE_FETCH;
        try {
          mediaJob.setStage(itemId, stageLine("🔄", itemId, rangeLabel, `${STAGE_FETCH}…`));

          const result = await processClip({
            range,
            vodId,
            isAudio,
            fetchStream,
            onProgress: (progress) => {
              if (progress === "remux") {
                stage = isAudio ? STAGE_REMUX_M4A : STAGE_REMUX_MP4;
                mediaJob.setStage(itemId, stageLine("⚙️", itemId, rangeLabel, `${stage}…`));
              }
            },
          });

          outPath = result.outPath;

          stage = STAGE_UPLOAD;
          mediaJob.setStage(itemId, stageLine("⬆️", itemId, rangeLabel, `${STAGE_UPLOAD}…`));

          const uploaded = await mediaJob.complete(itemId, {
            media: {
              type: isAudio ? "audio" : "video",
              fileId: null,
              localPath: outPath,
              width: result.hls.variant.width,
              height: result.hls.variant.height,
              duration: Math.round(result.remux.duration),
            },
            block: buildMediaResultBlock({
              mode: isAudio ? "audio" : "video",
              itemId,
              range: rangeLabel,
              vodUrl: buildVodLink(vodUrl, range.startSeconds, isVk),
              vodLabel,
              durationSec: result.remux.duration,
              sizeMB: result.remux.sizeMB,
              elapsedSec: (Date.now() - startedAt) / 1000,
              quality: result.hls.variant.quality,
              bitrateKbps: result.remux.bitrateKbps,
              muteStats: result.muteStats,
            }),
            stage: STAGE_UPLOAD,
            elapsedSec: (Date.now() - startedAt) / 1000,
          });

          if (uploaded) {
            successCount++;
          }
        } catch (e: any) {
          if (e instanceof QualityNotFoundError) {
            logger.warn(`[Quality ${itemId}/${totalRanges}]:`, e.message);
            mediaJob.fail(itemId, {
              stage,
              detail: e.message,
              elapsedSec: (Date.now() - startedAt) / 1000,
            });
            for (let j = i + 1; j < parsedVod.ranges.length; j++) {
              mediaJob.skip(j + 1, "качество не найдено");
            }
            break;
          }
          if (e instanceof DurationLimitError || e instanceof FileSizeLimitError) {
            mediaJob.fail(itemId, {
              stage,
              detail: e.message,
              elapsedSec: (Date.now() - startedAt) / 1000,
            });
          } else {
            logger.error(`[Error Clip ${itemId}/${totalRanges}]:`, e);
            mediaJob.fail(itemId, {
              stage,
              detail: describeItemError(e),
              elapsedSec: (Date.now() - startedAt) / 1000,
            });
          }
        } finally {
          if (outPath) {
            await safeDeleteFile(outPath);
          }
        }
      }

      await mediaJob.finish();

      if (interop) {
        await answerText(
          tg,
          msg,
          toTelegramHtml(
            successCount === totalRanges
              ? `✅ <b>Готово:</b> ${successCount} из ${totalRanges} в чат ${targetChatId}.`
              : `⚠️ <b>Готово частично:</b> ${successCount} из ${totalRanges} в чат ${targetChatId}. ` +
                  "Подробности — в сообщении с результатами.",
          ),
        );
      }
    } catch (fatalError: any) {
      logger.error("💥 [Fatal Handler Error]:", fatalError);
      const fatalText = `💥 Критическая ошибка: ${fatalError?.message || fatalError}`;
      if (job) {
        job.abort(fatalText);
        await job.finish();
      } else {
        try {
          await answerText(tg, msg, toTelegramHtml(`❌ <b>${escapeHtml(fatalText)}</b>`));
        } catch {}
      }

      if (interop) {
        try {
          await answerText(
            tg,
            msg,
            toTelegramHtml(
              `💥 <b>Обработка прервана.</b> Подробности — в сообщении с результатами в чате <code>${targetChatId}</code>.`,
            ),
          );
        } catch {}
      }
    }

    return PropagationAction.Continue;
  });
}
