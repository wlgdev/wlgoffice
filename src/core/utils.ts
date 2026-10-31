import { existsSync } from "node:fs";

import type { ParsedTimeRange, ParsedVodMessage, VodMode, VodPlatform } from "./types";

export type { ParsedTimeRange, ParsedVodMessage, VodMode, VodPlatform };

export function humanizeDuration(durationMs: number): string {
  if (durationMs <= 0) {
    return "0с";
  }

  const msPerSecond = 1000;
  const msPerMinute = 60 * msPerSecond;
  const msPerHour = 60 * msPerMinute;
  const msPerDay = 24 * msPerHour;
  const msPerYear = 365 * msPerDay;

  let remainingMs = durationMs;
  const parts: string[] = [];

  const years = Math.floor(remainingMs / msPerYear);
  if (years > 0) {
    parts.push(`${years}г`);
    remainingMs %= msPerYear;
  }

  const days = Math.floor(remainingMs / msPerDay);
  if (days > 0) {
    parts.push(`${days}д`);
    remainingMs %= msPerDay;
  }

  const hours = Math.floor(remainingMs / msPerHour);
  if (hours > 0) {
    parts.push(`${hours}ч`);
    remainingMs %= msPerHour;
  }

  const minutes = Math.floor(remainingMs / msPerMinute);
  if (minutes > 0) {
    parts.push(`${minutes}м`);
    remainingMs %= msPerMinute;
  }

  const seconds = Math.floor(remainingMs / msPerSecond);
  if (seconds > 0) {
    parts.push(`${seconds}с`);
  }

  if (parts.length === 0) {
    return "0с";
  }

  return parts.join(" ");
}

export function timeStringFromTs(ms: number, offsetMs = 0): string {
  ms += offsetMs;
  const secondsTotal = (ms / 1000) | 0;
  const h = ((secondsTotal / 3600) % 24) | 0;
  const m = ((secondsTotal / 60) % 60) | 0;
  const s = secondsTotal % 60;
  return (h < 10 ? "0" + h : h) + ":" + (m < 10 ? "0" + m : m) + ":" + (s < 10 ? "0" + s : s);
}

export function timeToSeconds(timeStr: string): number | null {
  const parts = timeStr.split(":");
  const numbers: number[] = [];

  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null;
    }
    const num = Number(part);
    if (!Number.isFinite(num) || num < 0) {
      return null;
    }
    numbers.push(num);
  }

  if (numbers.length === 3) {
    const h = numbers[0];
    const m = numbers[1];
    const s = numbers[2];

    if (h === undefined || m === undefined || s === undefined) {
      return null;
    }
    if (m > 59 || s > 59) {
      return null;
    }

    return h * 3600 + m * 60 + s;
  }

  if (numbers.length === 2) {
    const m = numbers[0];
    const s = numbers[1];

    if (m === undefined || s === undefined) {
      return null;
    }
    if (s > 59) {
      return null;
    }

    return m * 60 + s;
  }

  if (numbers.length === 1) {
    const s = numbers[0];

    if (s === undefined) {
      return null;
    }

    return s;
  }

  return null;
}

export function parseTimeRanges(text: string): ParsedTimeRange[] {
  const timeRangeRegex = /\b(\d{1,2}(?::\d{1,2}){1,2}|\d{1,5})\s*[-‐‑‒–—―−~]\s*(\d{1,2}(?::\d{1,2}){1,2}|\d{1,5})\b/g;

  const results: ParsedTimeRange[] = [];
  let match: RegExpExecArray | null;

  while ((match = timeRangeRegex.exec(text)) !== null) {
    const rawStart = match[1];
    const rawEnd = match[2];

    if (rawStart === undefined || rawEnd === undefined) {
      continue;
    }

    const startSeconds = timeToSeconds(rawStart);
    const endSeconds = timeToSeconds(rawEnd);

    if (startSeconds !== null && endSeconds !== null) {
      results.push({
        startSeconds,
        endSeconds,
        rawStart,
        rawEnd,
      });
    }
  }

  return results;
}

export function parseVodId(text: string): string | null {
  const vodRegex = /(?:https?:\/\/)?(?:www\.|m\.)?twitch\.tv\/videos\/(\d+)/i;
  const match = vodRegex.exec(text);

  if (!match) {
    return null;
  }

  const vodId = match[1];
  return vodId !== undefined ? vodId : null;
}

export function parseAllVodIds(text: string): string[] {
  const vodRegex = /(?:https?:\/\/)?(?:www\.|m\.)?twitch\.tv\/videos\/(\d+)/gi;
  const ids: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = vodRegex.exec(text)) !== null) {
    const vodId = match[1];
    if (vodId !== undefined) {
      ids.push(vodId);
    }
  }

  return ids;
}

const VK_LINK_REGEX =
  /(?:https?:\/\/)?(?:www\.|m\.)?(?:vkvideo\.ru|vk\.com|vk\.ru)\/(?:video|live|clips?)?(-?\d+)_(\d+)/i;

export function parseVkVideoId(text: string): string | null {
  const match = VK_LINK_REGEX.exec(text);

  if (!match) {
    return null;
  }

  const ownerId = match[1];
  const videoId = match[2];

  if (!ownerId || !videoId) {
    return null;
  }

  return `${ownerId.startsWith("-") ? ownerId : `-${ownerId}`}_${videoId}`;
}

export function parseVkUrl(text: string): string | null {
  const match = VK_LINK_REGEX.exec(text);
  if (!match) {
    return null;
  }

  const index = match.index;
  const raw = text.slice(index, index + match[0].length);
  return raw.startsWith("http") ? raw : `https://${raw}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseChannelAlias(text: string, aliases: Record<string, string>): string | null {
  const lower = text.toLowerCase();

  for (const [alias, channel] of Object.entries(aliases)) {
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(alias.toLowerCase())}(?![\\p{L}\\p{N}_])`, "u");

    if (pattern.test(lower)) {
      return channel;
    }
  }

  return null;
}

export function parseVodUrl(text: string): string | null {
  const match = /(?:https?:\/\/)?((?:www\.|m\.)?twitch\.tv\/videos\/(\d+))/i.exec(text);
  if (!match || match[1] === undefined) {
    return null;
  }
  return `https://${match[1]}`;
}

export function parseQualities(text: string): string[] {
  const qualityRegex = /\b(\d+p)\b/gi;
  const result: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = qualityRegex.exec(text)) !== null) {
    const raw = match[1];
    if (raw === undefined) {
      continue;
    }
    const normalized = raw.toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }

  return result;
}

export function parseVodMode(text: string): VodMode {
  const trimmed = text.trim();
  if (/^!(?:транскрипт|транскрипция|транс|transcript)(?![а-яёa-z0-9_])/i.test(trimmed)) {
    return "transcript";
  }
  return /^!(?:аудио|audio)(?![а-яёa-z0-9_])/i.test(trimmed) ? "audio" : "video";
}

export function parseVodMessage(text: string, aliases: Record<string, string> = {}): ParsedVodMessage {
  const vkId = parseVkVideoId(text);

  if (vkId) {
    return {
      platform: "vk",
      vodId: vkId,
      vodUrl: parseVkUrl(text),
      channel: null,
      ranges: parseTimeRanges(text),
      qualities: parseQualities(text),
    };
  }

  const twitchId = parseVodId(text);

  if (twitchId) {
    return {
      platform: "twitch",
      vodId: twitchId,
      vodUrl: parseVodUrl(text),
      channel: parseChannelAlias(text, aliases),
      ranges: parseTimeRanges(text),
      qualities: parseQualities(text),
    };
  }

  const channel = parseChannelAlias(text, aliases);

  return {
    platform: channel ? "twitch" : null,
    vodId: null,
    vodUrl: null,
    channel,
    ranges: parseTimeRanges(text),
    qualities: parseQualities(text),
  };
}

export async function safeDeleteFile(filePath: string): Promise<void> {
  try {
    if (filePath && existsSync(filePath)) {
      await Bun.file(filePath).unlink();
    }
  } catch {}
}
