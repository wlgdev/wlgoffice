import { Twitch, type TwitchStreamInfo, type TwitchVodInfo } from "@shevernitskiy/scraperator";
import logger from "./logger";

/** Канал по умолчанию, если в команде нет ни ссылки, ни алиаса. */
export const DEFAULT_CHANNEL = "welovegames";

export interface LiveVod {
  vodId: string;
  vodUrl: string;
  title: string;
}

/** Канал не в эфире — клипить нечего. */
export class ChannelOfflineError extends Error {
  constructor(channel: string) {
    super(`Канал ${channel} сейчас не в эфире`);
    this.name = "ChannelOfflineError";
  }
}

/** Эфир идёт, но архив текущей трансляции ещё не появился (или не совпал broadcast id). */
export class LiveVodNotFoundError extends Error {
  constructor(channel: string) {
    super(`Не найден архивный VOD текущего эфира канала ${channel}`);
    this.name = "LiveVodNotFoundError";
  }
}

/**
 * Чистая часть: выбирает VOD текущего эфира из ответа Twitch.
 * Эфир должен быть онлайн, а broadcast id последнего архива — совпадать со stream id.
 */
export function pickLiveVod(vods: TwitchVodInfo[], info: TwitchStreamInfo): LiveVod | null {
  if (!info.online) {
    return null;
  }

  const last = vods[0];

  if (!last || String(last.broadcast_id) !== String(info.id)) {
    return null;
  }

  return {
    vodId: last.id,
    vodUrl: `https://www.twitch.tv/videos/${last.id}`,
    title: last.title,
  };
}

/**
 * Находит VOD текущего эфира канала: последний архив + состояние стрима.
 */
export async function resolveLiveVod(
  channel: string,
  options: { proxy?: string; oauth?: string },
): Promise<LiveVod> {
  const twitch = new Twitch(channel, {
    proxy: options.proxy,
    OAuthToken: options.oauth,
  });

  const [vods, info] = await Promise.all([
    twitch.vods("TIME", 1, "ARCHIVE").catch((err) => {
      logger.warn(`[Twitch] Не удалось получить список VOD для "${channel}":`, err);
      return [] as TwitchVodInfo[];
    }),
    twitch.streamInfo(),
  ]);

  const live = pickLiveVod(vods ?? [], info);

  if (!live) {
    throw info.online ? new LiveVodNotFoundError(channel) : new ChannelOfflineError(channel);
  }

  logger.info(`[Twitch] ${channel} в эфире, VOD ${live.vodId} ("${live.title}")`);

  return live;
}
