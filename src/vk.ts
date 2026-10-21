import { Vk } from "@shevernitskiy/scraperator";
import { streamFromVariants, type AudioPick, type HlsStreamResult, type StreamVariant } from "./hls";
import logger from "./logger";

export interface VkClipOptions {
  videoId: string; // "-46211765_456252477"
  start: number; // в секундах
  end: number; // в секундах
  quality?: string | string[];
  concurrency?: number;
  proxy?: string;
  accessToken?: string;
  audio?: AudioPick;
}

/**
 * Парсит master-манифест VK в варианты качества.
 * Формат строки: #EXT-X-STREAM-INF:QUALITY=fullhd,BANDWIDTH=5063647,RESOLUTION=1920x1080,FRAME-RATE=60.000,CODECS="..."
 * Порядок и набор параметров менялись между видео, поэтому разбираем параметры по именам,
 * а URL варианта (относительный) склеиваем с базой мастер-плейлиста.
 */
export function parseVkMasterPlaylist(playlistText: string, masterUrl: string): StreamVariant[] {
  const lines = playlistText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const baseUrl = masterUrl.slice(0, masterUrl.lastIndexOf("/") + 1);
  const variants: StreamVariant[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line?.startsWith("#EXT-X-STREAM-INF:")) continue;

    const params = line.slice("#EXT-X-STREAM-INF:".length);
    const readParam = (name: string): string | undefined => {
      const match = params.match(new RegExp(`(?:^|,)${name}=("[^"]*"|[^,]*)`, "i"));
      return match?.[1]?.replace(/^"|"$/g, "");
    };

    const resolution = readParam("RESOLUTION") ?? "";
    const bandwidth = Number(readParam("BANDWIDTH") ?? 0);
    const framerate = readParam("FRAME-RATE") ?? "";
    const codecs = readParam("CODECS") ?? "";

    const shortUrl = lines[i + 1];
    if (!shortUrl || shortUrl.startsWith("#")) continue;

    const height = resolution.split("x")[1];
    const video = height ? `${height}p${parseInt(framerate, 10) || ""}` : (readParam("QUALITY") ?? "");

    variants.push({
      bandwidth,
      resolution,
      video,
      framerate,
      codecs,
      url: shortUrl.startsWith("http") ? shortUrl : baseUrl + shortUrl,
    });
  }

  return variants;
}

export async function getVkHlsStream(options: VkClipOptions): Promise<HlsStreamResult> {
  const { videoId, start, end, quality, concurrency, proxy, accessToken, audio } = options;

  if (start < 0 || end <= start) {
    throw new Error(`Invalid range: start=${start}, end=${end}`);
  }

  logger.info(`Fetching VK video metadata for "${videoId}"...`);

  // Имя канала на запрос метаданных не влияет — используется только анонимный токен.
  const vk = new Vk("vkvideo", { proxy, accessToken });

  const info = await vk.getVideoByID(videoId);

  if (!info.hls) {
    throw new Error(`VK не отдал HLS для ${videoId} — возможно, это идущая трансляция или видео недоступно`);
  }

  const masterRes = await fetch(info.hls);
  if (!masterRes.ok) {
    throw new Error(`Failed to fetch VK master playlist: HTTP ${masterRes.status}`);
  }

  const variants = parseVkMasterPlaylist(await masterRes.text(), info.hls);

  if (!variants.length) {
    throw new Error(`VK master playlist не содержит вариантов качества: ${info.hls}`);
  }

  logger.info(
    `VK "${info.title}" (${info.duration}s), вариантов: ${variants
      .map((v) => v.video || v.resolution)
      .join(", ")}`,
  );

  if (Number.isFinite(info.duration) && end > info.duration) {
    logger.warn(`Requested end ${end}s exceeds VK video duration ${info.duration}s — trimming`);
  }

  return streamFromVariants(variants, {
    start,
    end: Math.min(end, info.duration),
    quality,
    concurrency,
    audio,
  });
}