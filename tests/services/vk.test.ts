import { describe, expect, test } from "bun:test";

import { pickVariant } from "../../src/hls";
import { parseVkMasterPlaylist } from "../../src/vk";

describe("vk service", () => {
  const master = "https://vkvd.okcdn.ru/srcIp/1.2.3.4/pr/71/x.m3u8";
  const playlist = [
    "#EXTM3U",
    '#EXT-X-STREAM-INF:QUALITY=mobile,BANDWIDTH=212992,RESOLUTION=256x144,FRAME-RATE=60.000,CODECS="avc1.42001e,mp4a.40.2"',
    "mob/track.m3u8",
    "#EXT-X-STREAM-INF:QUALITY=fullhd,BANDWIDTH=5063647,RESOLUTION=1920x1080,FRAME-RATE=60.000,CODECS=",
    "fhd/track.m3u8",
  ].join("\n");

  test("parses variants and joins relative URLs with base URL", () => {
    const variants = parseVkMasterPlaylist(playlist, master);
    expect(variants).toHaveLength(2);
    expect(variants[0]!.url).toBe("https://vkvd.okcdn.ru/srcIp/1.2.3.4/pr/71/mob/track.m3u8");
    expect(variants[0]!.bandwidth).toBe(212992);
    expect(variants[0]!.video).toBe("144p60");
    expect(variants[1]!.url).toBe("https://vkvd.okcdn.ru/srcIp/1.2.3.4/pr/71/fhd/track.m3u8");
    expect(variants[1]!.bandwidth).toBe(5063647);
    expect(variants[1]!.video).toBe("1080p60");
  });

  test("quality picker works seamlessly with parsed VK variants", () => {
    const variants = parseVkMasterPlaylist(playlist, master);
    expect(pickVariant(variants).video).toBe("1080p60");
    expect(pickVariant(variants, "144p").video).toBe("144p60");
  });

  test("returns empty list for empty master playlist", () => {
    expect(parseVkMasterPlaylist("#EXTM3U", master)).toHaveLength(0);
    expect(parseVkMasterPlaylist("", master)).toHaveLength(0);
  });
});
