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
 * Эфир должен быть онлайн, а broadcast id одного из последних архивов — совпадать со stream id.
 */
export function pickLiveVod(vods: TwitchVodInfo[], info: TwitchStreamInfo): LiveVod | null {
  if (!info.online) {
    return null;
  }

  const match = vods.find((vod) => String(vod.broadcast_id) === String(info.id));

  if (!match) {
    return null;
  }

  return {
    vodId: match.id,
    vodUrl: `https://www.twitch.tv/videos/${match.id}`,
    title: match.title,
  };
}

/**
 * Находит VOD текущего эфира канала: последние 10 архивов + состояние стрима.
 * Эфир может быть онлайн, но архив ещё не опубликован — поэтому до трёх попыток с паузой.
 */
export async function resolveLiveVod(channel: string, options: { proxy?: string; oauth?: string }): Promise<LiveVod> {
  const twitch = new Twitch(channel, {
    proxy: options.proxy,
    OAuthToken: options.oauth,
  });

  for (let attempt = 1; attempt <= 3; attempt++) {
    const [vods, info] = await Promise.all([
      twitch.vods("TIME", 10, "ARCHIVE").catch((err) => {
        logger.warn(`[Twitch] Не удалось получить список VOD для "${channel}":`, err);
        return [] as TwitchVodInfo[];
      }),
      twitch.streamInfo(),
    ]);

    const live = pickLiveVod(vods ?? [], info);

    if (live) {
      logger.info(`[Twitch] ${channel} в эфире, VOD ${live.vodId} ("${live.title}")`);
      return live;
    }

    if (!info.online) {
      throw new ChannelOfflineError(channel);
    }

    const last = vods?.[0];

    if (attempt < 3) {
      logger.warn(
        `[Twitch] Архив текущего эфира "${channel}" ещё не найден (попытка ${attempt}/3, ` +
          `stream id ${info.id}, последний архив ${last ? `${last.id} (broadcast ${last.broadcast_id})` : "отсутствует"})`,
      );
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  throw new LiveVodNotFoundError(channel);
}
