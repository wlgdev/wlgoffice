import type { InteropPayload, MuteStats, VodMode } from "../core/types";
import { FALLBACK_STT_MODEL, PRIMARY_STT_MODEL } from "../services/transcribe";

export const DELETE_MEDIA_PREFIX = "del:media:";

const STT_MODEL_LABELS: Record<string, string> = {
  [PRIMARY_STT_MODEL]: "Whisper Large V3",
  [FALLBACK_STT_MODEL]: "Whisper Large V3 Turbo",
};

export function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildListBlock(items: string[]): string {
  return `<ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>`;
}

export function buildNoticeBlock(params: { icon: string; title: string; body: string; note?: string }): string {
  const parts = [`<h3>${params.icon} ${params.title}</h3>`, `<p>${params.body}</p>`];
  if (params.note) {
    parts.push(`<p>› ${params.note}</p>`);
  }
  return parts.join("");
}

export function buildTable(title: string, rows: string[][]): string {
  const body = rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("");
  return `<table compact striped><caption>${title}</caption>${body}</table>`;
}

export function buildRequesterLine(interop: InteropPayload | null): string {
  if (!interop) {
    return "";
  }
  const username = interop.username ? ` · <b>username:</b> ${escapeHtml(interop.username)}` : "";
  return `🔗 <b>Инициировано из:</b> <b>${escapeHtml(interop.from)}</b>${username}`;
}

export function buildDeleteMediaData(itemId: number): string {
  return `${DELETE_MEDIA_PREFIX}${itemId}`;
}

export function parseDeleteMediaData(data: string): number | null {
  if (!data.startsWith(DELETE_MEDIA_PREFIX)) {
    return null;
  }
  const itemId = Number(data.slice(DELETE_MEDIA_PREFIX.length));
  return Number.isInteger(itemId) && itemId > 0 ? itemId : null;
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) {
    return `${total}с`;
  }
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function formatCount(value: number): string {
  return value.toLocaleString("ru-RU");
}

export function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return one;
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) {
    return few;
  }
  return many;
}

export function formatMuteLine(stats: MuteStats | null): string {
  if (!stats) {
    return "";
  }
  if (stats.mutedFound === 0) {
    return "🔊 Звук: чистый ✓";
  }
  if (stats.unmutedSuccess === stats.mutedFound) {
    return `🔊 Звук: размьючено ${stats.unmutedSuccess}/${stats.mutedFound} ✓`;
  }
  return `⚠️ Звук: размьючено ${stats.unmutedSuccess}/${stats.mutedFound} (${stats.remainedMuted} без звука)`;
}

export function buildMediaButtons(vodUrl: string, vodLabel: string, itemId: number): string {
  return (
    `<tg-button-row align="center">` +
    `<tg-button type="url" url="${vodUrl}">🔗 ${vodLabel}</tg-button>` +
    `<tg-button type="callback_data" style="danger" data="${buildDeleteMediaData(itemId)}">🗑 Удалить</tg-button>` +
    `</tg-button-row>`
  );
}

export interface MediaBlockParams {
  itemId: number;
  range: string;
  vodUrl: string;
  vodLabel: string;
}

export function buildMediaResultBlock(
  params: MediaBlockParams & {
    mode: VodMode;
    durationSec: number;
    sizeMB: number;
    elapsedSec: number;
    quality?: string;
    bitrateKbps?: number;
    muteStats?: MuteStats | null;
    sttModel?: string;
    polished?: boolean;
    chars?: number;
  },
): string {
  const { mode, itemId, range, vodUrl, vodLabel, durationSec, sizeMB, elapsedSec } = params;
  const lines: string[] = [];

  if (mode === "transcript") {
    const chars = params.chars ?? 0;
    lines.push(
      `🎙 ${range} · ${formatDuration(durationSec)} · ${formatCount(chars)} ${plural(chars, "символ", "символа", "символов")}`,
    );
    const model = STT_MODEL_LABELS[params.sttModel ?? ""] ?? params.sttModel ?? "—";
    lines.push(`🎤 ${model} · ${params.polished ? "✨ причесан" : "⚠️ сырой"}`);
  } else if (mode === "audio") {
    lines.push(
      `🎵 ${range} · ${formatDuration(durationSec)} · ${sizeMB.toFixed(2)} МБ · AAC ${params.bitrateKbps ?? 0}k`,
    );
    lines.push(formatMuteLine(params.muteStats ?? null));
  } else {
    lines.push(`🎬 ${range} · ${formatDuration(durationSec)} · ${sizeMB.toFixed(2)} МБ · ${params.quality ?? "—"}`);
    lines.push(formatMuteLine(params.muteStats ?? null));
  }
  lines.push(`⚡ Обработка: ${Math.round(elapsedSec)}с`);

  return `<ul>${lines.map((line) => `<li>${line}</li>`).join("")}</ul>` + buildMediaButtons(vodUrl, vodLabel, itemId);
}

export function buildMediaErrorBlock(
  params: MediaBlockParams & {
    stage: string;
    detail: string;
    elapsedSec: number;
  },
): string {
  const lines = [
    `❌ ${params.range} · ${params.stage} — ошибка`,
    `⚠️ <i>${escapeHtml(params.detail)}</i>`,
    `⚡ Обработка: ${Math.round(params.elapsedSec)}с`,
  ];
  return (
    `<ul>${lines.map((line) => `<li>${line}</li>`).join("")}</ul>` +
    buildMediaButtons(params.vodUrl, params.vodLabel, params.itemId)
  );
}

export function buildMediaSkippedBlock(params: MediaBlockParams & { reason: string }): string {
  const lines = [`⏭ ${params.range} · пропущен (${escapeHtml(params.reason)})`];
  return (
    `<ul>${lines.map((line) => `<li>${line}</li>`).join("")}</ul>` +
    buildMediaButtons(params.vodUrl, params.vodLabel, params.itemId)
  );
}

export function buildStageLine(params: {
  icon: string;
  index: number;
  total: number;
  range: string;
  text: string;
}): string {
  return `${params.icon} [${params.index}/${params.total}] ${escapeHtml(params.range)} — ${params.text}`;
}
