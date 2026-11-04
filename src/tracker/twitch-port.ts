import { Twitch } from "@shevernitskiy/scraperator";

import config from "../config";
import { fromTwitchVariant } from "../services/hls";
import { findLiveVod } from "../services/twitch";
import type { TwitchTrackerPort } from "./types";

export function createTwitchTrackerPort(): TwitchTrackerPort {
  const createClient = (channel: string) =>
    new Twitch(channel, {
      proxy: config.proxy,
      OAuthToken: config.twitch.oauth,
    });

  return {
    async streamInfo(channel) {
      const info = await createClient(channel).streamInfo();
      return {
        online: info.online,
        id: String(info.id),
        title: info.title,
        start_time: info.start_time,
      };
    },

    async liveVariants(channel) {
      const variants = await createClient(channel).liveHLSMetadata();
      return variants.map(fromTwitchVariant);
    },

    async findLiveVod(channel, broadcastId) {
      const live = await findLiveVod(channel, broadcastId, {
        proxy: config.proxy,
        oauth: config.twitch.oauth,
      });
      return live ? { vodId: live.vodId, title: live.title } : null;
    },
  };
}
