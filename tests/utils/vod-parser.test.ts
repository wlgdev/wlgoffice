import { describe, expect, test } from "bun:test";

import {
  parseAllVodIds,
  parseChannelAlias,
  parseQualities,
  parseVkUrl,
  parseVkVideoId,
  parseVodId,
  parseVodMessage,
  parseVodMode,
  parseVodUrl,
} from "../../src/utils";

describe("vod parser utils", () => {
  describe("Twitch VOD parser", () => {
    test("parseVodId extracts VOD id from desktop, mobile and plain links", () => {
      expect(parseVodId("!клип https://www.twitch.tv/videos/123456 10:00 - 12:30")).toBe("123456");
      expect(parseVodId("!клип http://m.twitch.tv/videos/789012 10:00")).toBe("789012");
      expect(parseVodId("!клип twitch.tv/videos/345678")).toBe("345678");
      expect(parseVodId("без ссылки")).toBeNull();
    });

    test("parseAllVodIds finds multiple links", () => {
      const text = "Сравни https://twitch.tv/videos/111 и https://twitch.tv/videos/222";
      expect(parseAllVodIds(text)).toEqual(["111", "222"]);
      expect(parseAllVodIds("нет ссылок")).toEqual([]);
    });

    test("parseVodUrl normalizes protocol to https", () => {
      expect(parseVodUrl("!клип https://www.twitch.tv/videos/123456 10:00")).toBe(
        "https://www.twitch.tv/videos/123456",
      );
      expect(parseVodUrl("!клип http://m.twitch.tv/videos/123456 10:00")).toBe("https://m.twitch.tv/videos/123456");
      expect(parseVodUrl("!клип twitch.tv/videos/123456 10:00")).toBe("https://twitch.tv/videos/123456");
      expect(parseVodUrl("без ссылки")).toBeNull();
    });
  });

  describe("VK Video parser", () => {
    test("parseVkVideoId extracts video id and normalizes owner prefix with minus", () => {
      expect(parseVkVideoId("!клип https://vkvideo.ru/video-46211765_456252477 10:00")).toBe("-46211765_456252477");
      expect(parseVkVideoId("!клип https://vkvideo.ru/live-46211765_456252477 10:00")).toBe("-46211765_456252477");
      expect(parseVkVideoId("!клип https://vk.com/clip-46211765_456252477 10:00")).toBe("-46211765_456252477");
      expect(parseVkVideoId("https://vkvideo.ru/video46211765_456252477")).toBe("-46211765_456252477");
      expect(parseVkVideoId("!клип https://www.twitch.tv/videos/123456 10:00")).toBeNull();
    });

    test("parseVkUrl extracts and normalizes URL", () => {
      expect(parseVkUrl("https://vkvideo.ru/video-46211765_456252477")).toBe(
        "https://vkvideo.ru/video-46211765_456252477",
      );
      expect(parseVkUrl("vkvideo.ru/video-46211765_456252477")).toBe("https://vkvideo.ru/video-46211765_456252477");
      expect(parseVkUrl("просто текст")).toBeNull();
    });
  });

  describe("parseQualities", () => {
    test("extracts single quality pattern", () => {
      expect(parseQualities("!клип https://twitch.tv/videos/123 10:00 - 11:00 720p")).toEqual(["720p"]);
    });

    test("preserves order, deduplicates and normalizes case", () => {
      expect(parseQualities("1080p бла 720P бла 1080P 480p")).toEqual(["1080p", "720p", "480p"]);
    });

    test("returns empty array when quality pattern is absent", () => {
      expect(parseQualities("!клип https://twitch.tv/videos/123 10:00 - 11:00")).toEqual([]);
    });
  });

  describe("parseVodMode", () => {
    test("detects video mode by default", () => {
      expect(parseVodMode("!клип https://twitch.tv/videos/123 10:00 - 11:00")).toBe("video");
      expect(parseVodMode("!клип")).toBe("video");
    });

    test("detects audio mode and aliases", () => {
      expect(parseVodMode("!аудио https://twitch.tv/videos/123 10:00 - 11:00")).toBe("audio");
      expect(parseVodMode("!audio https://twitch.tv/videos/123 10:00 - 11:00")).toBe("audio");
      expect(parseVodMode("!аудио")).toBe("audio");
      expect(parseVodMode("!аудиочки шумим")).toBe("video");
    });

    test("detects transcript mode and aliases", () => {
      expect(parseVodMode("!транскрипт https://twitch.tv/videos/123 10:00 - 11:00")).toBe("transcript");
      expect(parseVodMode("!транскрипция https://twitch.tv/videos/123")).toBe("transcript");
      expect(parseVodMode("!транс https://twitch.tv/videos/123")).toBe("transcript");
      expect(parseVodMode("!transcript https://twitch.tv/videos/123")).toBe("transcript");
      expect(parseVodMode("!ТРАНСКРИПТ https://twitch.tv/videos/123")).toBe("transcript");
      expect(parseVodMode("!транскрипты шумим")).toBe("video");
      expect(parseVodMode("!клип https://twitch.tv/videos/123 транскрипт")).toBe("video");
    });
  });

  describe("parseChannelAlias", () => {
    const aliases = {
      влг: "welovegames",
      wlg: "welovegames",
      табула: "tabula",
      tabula: "tabula",
    };

    test("matches channel alias in command", () => {
      expect(parseChannelAlias("!клип влг 10:00 - 12:30", aliases)).toBe("welovegames");
      expect(parseChannelAlias("!клип wlg 10:00 - 12:30", aliases)).toBe("welovegames");
      expect(parseChannelAlias("!клип табула 10:00 - 12:30", aliases)).toBe("tabula");
      expect(parseChannelAlias("!клип tabula 10:00 - 12:30", aliases)).toBe("tabula");
    });

    test("case insensitive matching", () => {
      expect(parseChannelAlias("!клип WLG 10:00", aliases)).toBe("welovegames");
      expect(parseChannelAlias("!клип ТАБУЛА 10:00", aliases)).toBe("tabula");
    });

    test("strict word boundaries prevent substring matching", () => {
      expect(parseChannelAlias("!клип wlgx 10:00", aliases)).toBeNull();
      expect(parseChannelAlias("!клип влгоп 10:00", aliases)).toBeNull();
      expect(parseChannelAlias("!клип xwlg 10:00", aliases)).toBeNull();
      expect(parseChannelAlias("!клип tabula2 10:00", aliases)).toBeNull();
    });
  });

  describe("parseVodMessage", () => {
    const aliases = { влг: "welovegames" };

    test("parses VK message with ranges and quality", () => {
      const vk = parseVodMessage("!клип https://vkvideo.ru/video-46211765_456252477 10:00 - 12:30 720p", aliases);
      expect(vk.platform).toBe("vk");
      expect(vk.vodId).toBe("-46211765_456252477");
      expect(vk.vodUrl).toBe("https://vkvideo.ru/video-46211765_456252477");
      expect(vk.channel).toBeNull();
      expect(vk.ranges).toHaveLength(1);
      expect(vk.qualities).toEqual(["720p"]);
    });

    test("parses Twitch message with URL", () => {
      const twitch = parseVodMessage("!клип https://twitch.tv/videos/123 10:00 - 12:30", aliases);
      expect(twitch.platform).toBe("twitch");
      expect(twitch.vodId).toBe("123");
      expect(twitch.vodUrl).toBe("https://twitch.tv/videos/123");
      expect(twitch.ranges).toHaveLength(1);
    });

    test("parses Twitch message with alias instead of link", () => {
      const twitch = parseVodMessage("!клип влг 10:00 - 12:30", aliases);
      expect(twitch.platform).toBe("twitch");
      expect(twitch.vodId).toBeNull();
      expect(twitch.vodUrl).toBeNull();
      expect(twitch.channel).toBe("welovegames");
      expect(twitch.ranges).toHaveLength(1);
    });

    test("link takes precedence over alias", () => {
      const parsed = parseVodMessage("!клип https://twitch.tv/videos/123 влг 10:00 - 12:30", aliases);
      expect(parsed.vodId).toBe("123");
      expect(parsed.channel).toBe("welovegames");
    });

    test("returns null platform when neither URL nor alias matches", () => {
      const parsed = parseVodMessage("!клип просто текст", aliases);
      expect(parsed.platform).toBeNull();
      expect(parsed.channel).toBeNull();
    });
  });
});
