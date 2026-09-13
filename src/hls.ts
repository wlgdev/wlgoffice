import { Twitch, type TwitchOptions, type TwtichHLSSourceFormat } from "@shevernitskiy/scraperator";
import logger from "./logger";
import config from "./config";

// ─── Types ───────────────────────────────────────────────────

export interface HlsClipOptions {
  channel: string;
  vodId: string;
  start: number; // в секундах
  end: number; // в секундах
  quality?: string | string[];
  concurrency?: number;
  proxy?: string;
  oauth?: string;
}

/**
 * Ошибка "запрошенное качество отсутствует в манифесте".
 * Ничего не качаем — вызывающий код должен сообщить юзеру и пропустить клип.
 */
export class QualityNotFoundError extends Error {
  readonly requested: string[];
  readonly available: string[];

  constructor(requested: string[], available: string[]) {
    const what = requested.length === 1 ? `качество ${requested[0]}` : `качества ${requested.join(", ")}`;
    super(`Запрошенное ${what} не найдено в манифесте (доступно: ${available.join(", ") || "—"})`);
    this.name = "QualityNotFoundError";
    this.requested = requested;
    this.available = available;
  }
}

export interface HlsSegment {
  url: string;
  duration: number;
  startTime: number;
}

export interface ParsedPlaylist {
  initUrl?: string; // URL init-сегмента для fMP4
  segments: HlsSegment[];
}

export interface VariantInfo {
  quality: string; // e.g. "1080p59"
  resolution: string; // e.g. "1920x1080"
  width: number; // 1920
  height: number; // 1080
  framerate: number; // 59.588
  bandwidth: number; // в bps (9720293)
  bandwidthMbps: number; // 9.72
  codecs: string; // "avc1.4D0028,mp4a.40.2"
  videoCodec?: string; // "avc1.4D0028"
  audioCodec?: string; // "mp4a.40.2"
  url: string;
}

export interface MuteStats {
  totalSegments: number;
  mutedFound: number;
  unmutedSuccess: number;
  remainedMuted: number;
}

export interface HlsStreamResult {
  stream: ReadableStream<Uint8Array>;
  variant: VariantInfo;
  rawVariant: TwtichHLSSourceFormat;
  trimStart: number;
  trimDuration: number;
  totalSegments: number;
  segmentTimeRange: {
    start: number;
    end: number;
  };
  muteStats: Promise<MuteStats>; // Промис, который зарезолвится по завершению скачивания потока
}

interface SegmentDownloadResult {
  data: Uint8Array;
  wasMuted: boolean;
  unmutedSuccess: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────

export function parseVariantInfo(v: TwtichHLSSourceFormat): VariantInfo {
  const [wStr, hStr] = (v.resolution || "").split("x");
  const [vCodec, aCodec] = (v.codecs || "").split(",");

  return {
    quality: v.video || v.resolution || "unknown",
    resolution: v.resolution || "unknown",
    width: wStr ? parseInt(wStr, 10) : 0,
    height: hStr ? parseInt(hStr, 10) : 0,
    framerate: v.framerate ? parseFloat(v.framerate) : 0,
    bandwidth: v.bandwidth,
    bandwidthMbps: +(v.bandwidth / 1e6).toFixed(2),
    codecs: v.codecs,
    videoCodec: vCodec ? vCodec.trim() : undefined,
    audioCodec: aCodec ? aCodec.trim() : undefined,
    url: v.url,
  };
}

/**
 * Проверяет, соответствует ли вариант манифеста запрошенному качеству.
 * "720p" матчится на "720p", "720p60" (высота + fps), либо на resolution "1280x720".
 */
export function variantMatchesQuality(v: TwtichHLSSourceFormat, quality: string): boolean {
  const q = quality.toLowerCase();

  const video = v.video?.toLowerCase() ?? "";
  if (video === q) {
    return true;
  }
  if (video.startsWith(q)) {
    const rest = video.slice(q.length);
    if (rest === "" || /^\d+$/.test(rest)) {
      return true;
    }
  }

  const height = v.resolution?.split("x")[1];
  if (height && `${height}p` === q) {
    return true;
  }

  return false;
}

export function pickVariant(variants: TwtichHLSSourceFormat[], quality?: string | string[]): TwtichHLSSourceFormat {
  const sorted = [...variants].sort((a, b) => b.bandwidth - a.bandwidth);
  const bestVariant = sorted[0];

  if (!bestVariant) {
    throw new Error("No variants found in HLS manifest");
  }

  const requested = (Array.isArray(quality) ? quality : quality ? [quality] : [])
    .map((q) => q.toLowerCase())
    .filter(Boolean);

  // Целевое качество не задано — качаем максимальное, как раньше
  if (requested.length === 0) return bestVariant;

  // Несколько качеств из сообщения проверяем по очереди, берём первое совпавшее
  for (const q of requested) {
    const found = sorted.find((v) => variantMatchesQuality(v, q));
    if (found) {
      return found;
    }
  }

  const available = sorted.map((v) => v.video || v.resolution);
  logger.warn(`Requested qualities "${requested.join(", ")}" not found. Available: ${available.join(", ")}`);
  throw new QualityNotFoundError(requested, available);
}

export function parseMediaPlaylist(playlistText: string, baseUrl: string): ParsedPlaylist {
  const lines = playlistText.split(/\r?\n/);
  const segments: HlsSegment[] = [];
  let initUrl: string | undefined;

  let currentDuration = 0;
  let currentTime = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Парсим тег #EXT-X-MAP для fMP4 (содержит ссылку на init.mp4)
    if (line.startsWith("#EXT-X-MAP:")) {
      const match = line.match(/URI=["']?([^"',]+)["']?/i);
      if (match && match[1]) {
        initUrl = new URL(match[1], baseUrl).href;
      }
      continue;
    }

    if (line.startsWith("#EXTINF:")) {
      currentDuration = parseFloat(line.slice(8));
    } else if (line && !line.startsWith("#")) {
      segments.push({
        url: new URL(line, baseUrl).href,
        duration: currentDuration,
        startTime: currentTime,
      });
      currentTime += currentDuration;
    }
  }

  return { initUrl, segments };
}

export function filterSegmentsByRange(segments: HlsSegment[], start: number, end: number): HlsSegment[] {
  return segments.filter((s) => s.startTime + s.duration > start && s.startTime < end);
}

function getUnmutedUrl(urlStr: string): string | null {
  try {
    const url = new URL(urlStr);
    const fileName = url.pathname.split("/").pop() ?? "";
    if (!fileName.includes("-muted")) return null;

    const unmutedName = fileName.replace(/-muted(?=\.|$)/i, "");
    url.pathname = url.pathname.replace(fileName, unmutedName);
    return url.href;
  } catch {
    return null;
  }
}

async function fetchSegment(url: string): Promise<SegmentDownloadResult> {
  const unmuted = getUnmutedUrl(url);

  if (unmuted) {
    try {
      const res = await fetch(`${unmuted}`);
      if (res.ok) {
        return {
          data: new Uint8Array(await res.arrayBuffer()),
          wasMuted: true,
          unmutedSuccess: true,
        };
      }
    } catch {
      // Игнорируем и пробуем оригинальный
    }

    const fallbackRes = await fetch(`${url}`);
    if (!fallbackRes.ok) throw new Error(`HTTP ${fallbackRes.status} for ${url}`);
    return {
      data: new Uint8Array(await fallbackRes.arrayBuffer()),
      wasMuted: true,
      unmutedSuccess: false,
    };
  }

  const res = await fetch(`${url}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return {
    data: new Uint8Array(await res.arrayBuffer()),
    wasMuted: false,
    unmutedSuccess: false,
  };
}

/**
 * Создаёт генератор и одновременно резолвит промис со статистикой mute
 */
async function* createSegmentGenerator(
  segments: HlsSegment[],
  concurrency: number,
  initUrl: string | undefined,
  onFinish: (stats: MuteStats) => void,
): AsyncGenerator<Uint8Array, void, unknown> {
  // Если у VOD есть init-сегмент (fMP4), отправляем его первым в поток
  if (initUrl) {
    const initRes = await fetch(`${initUrl}`);
    if (!initRes.ok) {
      throw new Error(`Failed to fetch init segment (${initRes.status}) from: ${initUrl}`);
    }
    const initBuffer = await initRes.arrayBuffer();
    yield new Uint8Array(initBuffer);
  }

  let cursor = 0;
  let unmutedCount = 0;
  let mutedFailedCount = 0;

  const inFlight = new Map<number, Promise<SegmentDownloadResult>>();

  function refill() {
    while (inFlight.size < concurrency && cursor < segments.length) {
      const index = cursor++;
      const seg = segments[index];
      if (seg) {
        inFlight.set(index, fetchSegment(seg.url));
      }
    }
  }

  for (let i = 0; i < segments.length; i++) {
    refill();
    const task = inFlight.get(i);
    if (!task) continue;

    const { data, wasMuted, unmutedSuccess } = await task;
    inFlight.delete(i);

    if (wasMuted) {
      if (unmutedSuccess) unmutedCount++;
      else mutedFailedCount++;
    }

    yield data;
  }

  const stats: MuteStats = {
    totalSegments: segments.length,
    mutedFound: unmutedCount + mutedFailedCount,
    unmutedSuccess: unmutedCount,
    remainedMuted: mutedFailedCount,
  };

  onFinish(stats);
}

function createOrderedSegmentStream(
  segments: HlsSegment[],
  concurrency: number,
  initUrl: string | undefined,
  onFinish: (stats: MuteStats) => void,
  onError: (err: any) => void,
): ReadableStream<Uint8Array> {
  const iterator = createSegmentGenerator(segments, concurrency, initUrl, onFinish);

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (err) {
        onError(err);
        controller.error(err);
      }
    },
  });
}

// ─── Main Export ─────────────────────────────────────────────

export async function getVodHlsStream(options: HlsClipOptions): Promise<HlsStreamResult> {
  const { channel, vodId, start, end, quality, concurrency = 6 } = options;

  if (start < 0 || end <= start) {
    throw new Error(`Invalid range: start=${start}, end=${end}`);
  }

  logger.info(`Fetching VOD metadata for channel "${channel}", vodId "${vodId}"...`);

  const twitch = new Twitch(channel, {
    proxy: options.proxy,
    OAuthToken: options.oauth,
  });

  const rawVariants = await twitch.vodHLSMetadata(vodId);

  const selectedRawVariant = pickVariant(rawVariants, quality);
  const variant = parseVariantInfo(selectedRawVariant);

  logger.info(
    `Selected: ${variant.quality} (${variant.width}x${variant.height} @ ${variant.framerate}fps, ${variant.bandwidthMbps} Mbps, codecs: ${variant.codecs})`,
  );

  const mediaPlaylistRes = await fetch(`${variant.url}`);
  if (!mediaPlaylistRes.ok) {
    throw new Error(`Failed to fetch media playlist: HTTP ${mediaPlaylistRes.status}`);
  }
  const mediaPlaylistText = await mediaPlaylistRes.text();

  const { initUrl, segments: allSegments } = parseMediaPlaylist(mediaPlaylistText, variant.url);
  const targetSegments = filterSegmentsByRange(allSegments, start, end);

  const firstSeg = targetSegments[0];
  const lastSeg = targetSegments[targetSegments.length - 1];

  if (!firstSeg || !lastSeg) {
    throw new Error(`No segments found in range [${start}s - ${end}s]`);
  }

  const trimStart = Math.max(0, start - firstSeg.startTime);
  const trimDuration = end - start;
  const rangeEnd = lastSeg.startTime + lastSeg.duration;

  logger.info(
    `Prepared ${targetSegments.length} segments (${firstSeg.startTime.toFixed(1)}s -> ${rangeEnd.toFixed(1)}s)${
      initUrl ? " [fMP4 mode with init segment]" : " [TS mode]"
    }`,
  );

  // Создаем промис для сбора статистики по мьютам.
  // reject обязателен: при ошибке скачивания сегмента Promise.all в обработчике иначе висит вечно.
  let resolveStats!: (stats: MuteStats) => void;
  let rejectStats!: (err: any) => void;
  const muteStats = new Promise<MuteStats>((res, rej) => {
    resolveStats = res;
    rejectStats = rej;
  });

  const stream = createOrderedSegmentStream(
    targetSegments,
    concurrency,
    initUrl,
    (stats) => {
      resolveStats(stats);
    },
    (err) => {
      logger.error("[HLS] Ошибка скачивания сегментов:", err);
      rejectStats(err);
    },
  );

  return {
    stream,
    variant,
    rawVariant: selectedRawVariant,
    trimStart,
    trimDuration,
    totalSegments: targetSegments.length,
    segmentTimeRange: {
      start: firstSeg.startTime,
      end: rangeEnd,
    },
    muteStats,
  };
}
