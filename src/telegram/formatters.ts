import { BotKeyboard, html } from "@mtcute/bun";

import type { InteropPayload, MuteStats, VodMode } from "../core/types";
import type { FfmpegRunResult } from "../services/ffmpeg";
import { type HlsStreamResult, QualityNotFoundError } from "../services/hls";
import {
  FALLBACK_STT_MODEL,
  POLISH_MODEL,
  type PolishResult,
  PRIMARY_STT_MODEL,
  type SttResult,
} from "../services/transcribe";

export const DELETE_CALLBACK_DATA = "del:media";

const STT_MODEL_LABELS: Record<string, string> = {
  [PRIMARY_STT_MODEL]: "Whisper Large V3",
  [FALLBACK_STT_MODEL]: "Whisper Large V3 Turbo",
};

export function toTelegramHtml(text: string) {
  return html(text.replace(/\r?\n/g, "<br>"));
}

export function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildDeleteKeyboard() {
  return BotKeyboard.inline([[BotKeyboard.callback("🗑 Удалить", DELETE_CALLBACK_DATA)]]);
}

export function buildRequesterLine(interop: InteropPayload | null): string {
  if (!interop) {
    return "";
  }
  const username = interop.username ? ` · <b>username:</b> ${escapeHtml(interop.username)}` : "";
  return `🔗 <b>Инициировано из:</b> <b>${escapeHtml(interop.from)}</b>${username}`;
}

export function formatMuteBadge(stats: MuteStats): string {
  if (stats.mutedFound === 0) {
    return "🔊 чистый звук";
  }
  if (stats.unmutedSuccess === stats.mutedFound) {
    return `🔊 ${stats.unmutedSuccess}/${stats.mutedFound} размьючено ✓`;
  }
  return `⚠️ ${stats.unmutedSuccess}/${stats.mutedFound} размьючено (${stats.remainedMuted} без звука)`;
}

export function buildCaption(params: {
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
    const badgeIcon = isFullUnmute ? "✅" : "⚠️";
    muteLine = `\n🔊 <b>Звук:</b> размьючено ${muteStats.unmutedSuccess}/${muteStats.mutedFound} ${badgeIcon}`;
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

export function buildTranscriptCaption(params: {
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

export function transcriptBadge(stt: SttResult, polish: PolishResult): string {
  const model = stt.model === FALLBACK_STT_MODEL ? "V3 Turbo" : "V3";
  const quality = polish.polished ? "причесан" : "сырой";
  const warn = stt.model === FALLBACK_STT_MODEL ? " ⚠️" : "";
  return `${model}${warn} · ${quality}`;
}

export function buildStatusMessage(vodId: string, statuses: string[], header?: string, subtitle?: string): string {
  const title = header ?? `📥 <b>Обработка VOD <code>${vodId}</code></b>`;
  const sub = subtitle ? `${subtitle}\n` : "";
  return `${title}\n${sub}\n${statuses.join("\n")}`;
}

export function buildQualityNotFoundStatus(
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
