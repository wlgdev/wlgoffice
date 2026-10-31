import { describe, expect, test } from "bun:test";

import type { TwtichHLSSourceFormat } from "@shevernitskiy/scraperator";

import {
  filterSegmentsByRange,
  fromTwitchVariant,
  isAudioOnlyVariant,
  parseMediaPlaylist,
  parseVariantInfo,
  pickVariant,
  QualityNotFoundError,
  type StreamVariant,
  variantMatchesQuality,
} from "../../src/hls";

describe("hls service", () => {
  const sampleVariants: StreamVariant[] = [
    {
      bandwidth: 9000000,
      codecs: "avc1.4D0028,mp4a.40.2",
      resolution: "1920x1080",
      video: "1080p60",
      framerate: "60",
      url: "u1",
    },
    {
      bandwidth: 5000000,
      codecs: "avc1.4D401F,mp4a.40.2",
      resolution: "1280x720",
      video: "720p60",
      framerate: "60",
      url: "u2",
    },
    {
      bandwidth: 2000000,
      codecs: "avc1.4D401F,mp4a.40.2",
      resolution: "852x480",
      video: "480p30",
      framerate: "30",
      url: "u3",
    },
  ];

  const variantsWithAudio: StreamVariant[] = [
    ...sampleVariants,
    { bandwidth: 160000, codecs: "mp4a.40.2", resolution: "", video: "audio_only", framerate: "", url: "a1" },
  ];

  describe("variant converters and matchers", () => {
    test("fromTwitchVariant converts scraperator format to StreamVariant", () => {
      const twitchFormat: TwtichHLSSourceFormat = {
        bandwidth: 5000,
        resolution: "1280x720",
        video: "720p",
        framerate: "60",
        codecs: "avc",
        url: "https://twitch/720.m3u8",
      };
      const converted = fromTwitchVariant(twitchFormat);
      expect(converted.bandwidth).toBe(5000);
      expect(converted.resolution).toBe("1280x720");
      expect(converted.video).toBe("720p");
      expect(converted.url).toBe("https://twitch/720.m3u8");
    });

    test("parseVariantInfo parses resolution, framerate and bandwidth in Mbps", () => {
      const info = parseVariantInfo(sampleVariants[0]!);
      expect(info.width).toBe(1920);
      expect(info.height).toBe(1080);
      expect(info.framerate).toBe(60);
      expect(info.bandwidthMbps).toBe(9);
      expect(info.videoCodec).toBe("avc1.4D0028");
      expect(info.audioCodec).toBe("mp4a.40.2");
    });

    test("isAudioOnlyVariant distinguishes audio-only track from video", () => {
      expect(isAudioOnlyVariant(variantsWithAudio[3]!)).toBe(true);
      expect(isAudioOnlyVariant(variantsWithAudio[0]!)).toBe(false);
      // Video codec without resolution (e.g. VK audio track that still has video stream)
      expect(
        isAudioOnlyVariant({ bandwidth: 1, codecs: "avc1,mp4a", resolution: "", video: "", framerate: "", url: "" }),
      ).toBe(false);
    });

    test("variantMatchesQuality matches exact, fps prefix, and height resolution", () => {
      const v = sampleVariants[1]!; // 720p60, 1280x720
      expect(variantMatchesQuality(v, "720p")).toBe(true);
      expect(variantMatchesQuality(v, "720p60")).toBe(true);
      expect(variantMatchesQuality(v, "1080p")).toBe(false);

      const resolutionOnly: StreamVariant = {
        bandwidth: 1,
        codecs: "",
        resolution: "1280x720",
        video: "",
        framerate: "",
        url: "",
      };
      expect(variantMatchesQuality(resolutionOnly, "720p")).toBe(true);
    });
  });

  describe("pickVariant (video mode)", () => {
    test("picks maximum bandwidth by default when no quality specified", () => {
      expect(pickVariant(sampleVariants).video).toBe("1080p60");
    });

    test("matches requested quality to variant with fps", () => {
      expect(pickVariant(sampleVariants, "720p").video).toBe("720p60");
    });

    test("picks first matched quality from preference array", () => {
      expect(pickVariant(sampleVariants, ["480p", "720p"]).video).toBe("480p30");
      expect(pickVariant(sampleVariants, ["1440p", "720p"]).video).toBe("720p60");
    });

    test("throws QualityNotFoundError when quality is missing", () => {
      let err: unknown;
      try {
        pickVariant(sampleVariants, "2160p");
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(QualityNotFoundError);
      const qe = err as QualityNotFoundError;
      expect(qe.requested).toEqual(["2160p"]);
      expect(qe.available).toContain("1080p60");
    });

    test("audio_only is not considered in video mode even if bandwidth is high", () => {
      const variantsWithHighAudio: StreamVariant[] = [
        sampleVariants[2]!, // 480p (2Mbps)
        { bandwidth: 50000000, codecs: "mp4a.40.2", resolution: "", video: "audio_only", framerate: "", url: "a1" },
      ];
      expect(pickVariant(variantsWithHighAudio).video).toBe("480p30");
    });
  });

  describe("pickVariant (audio mode)", () => {
    test("audio_only preferred over higher bandwidth video tracks", () => {
      expect(pickVariant(variantsWithAudio, undefined, "best").url).toBe("a1");
    });

    test("falls back to maximum bandwidth when audio_only not present", () => {
      expect(pickVariant(sampleVariants, undefined, "best").url).toBe("u1");
    });

    test("requested quality in audio mode selects audio from specified video track", () => {
      expect(pickVariant(variantsWithAudio, "480p", "best").url).toBe("u3");
      expect(pickVariant(variantsWithAudio, ["1080p", "480p"], "best").url).toBe("u1");
    });

    test("missing requested quality in audio mode falls back to audio_only rather than error", () => {
      expect(pickVariant(variantsWithAudio, "2160p", "best").url).toBe("a1");
    });
  });

  describe("pickVariant (cheapest transcript mode)", () => {
    test("audio_only is preferred first if present", () => {
      expect(pickVariant(variantsWithAudio, undefined, "cheapest").url).toBe("a1");
    });

    test("picks lowest bandwidth variant when audio_only is not present", () => {
      expect(pickVariant(sampleVariants, undefined, "cheapest").url).toBe("u3");
    });
  });

  describe("playlist parser and segment filter", () => {
    test("parseMediaPlaylist parses TS segments and computes start times", () => {
      const text = ["#EXTM3U", "#EXTINF:10.0,", "seg1.ts", "#EXTINF:10.0,", "seg2.ts", "#EXTINF:5.5,", "seg3.ts"].join(
        "\n",
      );

      const { initUrl, segments } = parseMediaPlaylist(text, "https://example.com/vod/");
      expect(initUrl).toBeUndefined();
      expect(segments).toHaveLength(3);
      expect(segments[0]!.url).toBe("https://example.com/vod/seg1.ts");
      expect(segments[0]!.startTime).toBe(0);
      expect(segments[1]!.startTime).toBe(10);
      expect(segments[2]!.startTime).toBe(20);
      expect(segments[2]!.duration).toBe(5.5);
    });

    test("parseMediaPlaylist extracts #EXT-X-MAP initUrl for fMP4", () => {
      const text = ["#EXTM3U", '#EXT-X-MAP:URI="init.mp4"', "#EXTINF:2.0,", "seg1.m4s"].join("\n");

      const { initUrl, segments } = parseMediaPlaylist(text, "https://example.com/vod/");
      expect(initUrl).toBe("https://example.com/vod/init.mp4");
      expect(segments).toHaveLength(1);
    });

    test("filterSegmentsByRange filters segments overlapping the requested range", () => {
      const text = [
        "#EXTM3U",
        "#EXTINF:10.0,",
        "seg1.ts", // 0 - 10
        "#EXTINF:10.0,",
        "seg2.ts", // 10 - 20
        "#EXTINF:10.0,",
        "seg3.ts", // 20 - 30
      ].join("\n");

      const { segments } = parseMediaPlaylist(text, "https://example.com/vod/");
      const filtered = filterSegmentsByRange(segments, 5, 15);
      expect(filtered).toHaveLength(2);
      expect(filtered[0]!.url).toContain("seg1.ts");
      expect(filtered[1]!.url).toContain("seg2.ts");
    });
  });
});
