import { describe, expect, test } from "bun:test";

import type { TwitchStreamInfo, TwitchVodInfo } from "@shevernitskiy/scraperator";

import { ChannelOfflineError, DEFAULT_CHANNEL, LiveVodNotFoundError, pickLiveVod } from "../../src/services/twitch";

describe("twitch service", () => {
  const vod = (id: string, broadcastId: string, title = "Stream title") =>
    ({ id, broadcast_id: broadcastId, title }) as TwitchVodInfo;
  const streamInfo = (online: boolean, id: string) => ({ online, id }) as TwitchStreamInfo;

  test("default channel is welovegames", () => {
    expect(DEFAULT_CHANNEL).toBe("welovegames");
  });

  test("custom errors have proper names and messages", () => {
    const offlineErr = new ChannelOfflineError("welovegames");
    expect(offlineErr.name).toBe("ChannelOfflineError");
    expect(offlineErr.message).toContain("welovegames");

    const vodNotFoundErr = new LiveVodNotFoundError("welovegames");
    expect(vodNotFoundErr.name).toBe("LiveVodNotFoundError");
    expect(vodNotFoundErr.message).toContain("welovegames");
  });

  describe("pickLiveVod", () => {
    test("channel is online and broadcast id matches -> returns live VOD", () => {
      const live = pickLiveVod([vod("123", "456", "Live episode")], streamInfo(true, "456"));
      expect(live).not.toBeNull();
      expect(live?.vodId).toBe("123");
      expect(live?.vodUrl).toBe("https://www.twitch.tv/videos/123");
      expect(live?.title).toBe("Live episode");
    });

    test("channel is offline -> returns null", () => {
      expect(pickLiveVod([vod("123", "456")], streamInfo(false, "456"))).toBeNull();
    });

    test("broadcast id does not match -> returns null", () => {
      expect(pickLiveVod([vod("123", "456")], streamInfo(true, "789"))).toBeNull();
    });

    test("empty archives list -> returns null", () => {
      expect(pickLiveVod([], streamInfo(true, "456"))).toBeNull();
    });
  });
});
