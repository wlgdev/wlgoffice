import { describe, expect, test } from "bun:test";
import config, { parseChatIds } from "./config";
import { parseQualities, parseVodId, parseVodMessage, parseTimeRanges, timeToSeconds } from "./utils";
import {
  parseMediaPlaylist,
  filterSegmentsByRange,
  pickVariant,
  QualityNotFoundError,
  variantMatchesQuality,
} from "./hls";
import type { TwtichHLSSourceFormat } from "@shevernitskiy/scraperator";
import { remuxHlsStream } from "./ffmpeg";

describe("parseChatIds", () => {
  test("single id", () => expect(parseChatIds("123123")).toEqual([123123]));
  test("list with spaces and negatives", () =>
    expect(parseChatIds("123123, 15125,-543856141")).toEqual([123123, 15125, -543856141]));
  test("invalid throws", () => {
    expect(() => parseChatIds("")).toThrow();
    expect(() => parseChatIds("123,abc")).toThrow();
  });
});

describe("utils (trust boundary: текст из Telegram)", () => {
  test("timeToSeconds", () => {
    expect(timeToSeconds("10")).toBe(10);
    expect(timeToSeconds("10:00")).toBe(600);
    expect(timeToSeconds("1:02:03")).toBe(3723);
    expect(timeToSeconds("10:99")).toBeNull();
    expect(timeToSeconds("abc")).toBeNull();
  });
  test("parseVodId", () => {
    expect(parseVodId("!клип https://www.twitch.tv/videos/123456 10:00 - 12:30")).toBe("123456");
    expect(parseVodId("без ссылки")).toBeNull();
  });
  test("parseTimeRanges", () => {
    const r = parseTimeRanges("10:00 - 12:30");
    expect(r).toHaveLength(1);
    expect([r[0]!.startSeconds, r[0]!.endSeconds]).toEqual([600, 750]);
  });
});

describe("ffmpeg (битый вход обязан падать, а не 'сохранять' 0 MB)", () => {
  test("remux rejects on errored input stream", async () => {
    const outPath = `${config.tmpDir}/test_broken.mp4`;
    const bad = new ReadableStream<Uint8Array>({
      start(c) {
        c.error(new Error("HTTP 403 for https://example.com/seg.ts"));
      },
    });
    await expect(remuxHlsStream({ stream: bad, outPath })).rejects.toThrow();
    try {
      await Bun.file(outPath).unlink();
    } catch {}
  }, 30000);
});

describe("parseQualities (цель: паттерн <цифры>p)", () => {
  test("одно качество", () => {
    expect(parseQualities("!клип https://twitch.tv/videos/123 10:00 - 11:00 720p")).toEqual(["720p"]);
  });
  test("несколько — порядок сохраняется, дубли и регистр схлопываются", () => {
    expect(parseQualities("1080p бла 720P бла 1080P 480p")).toEqual(["1080p", "720p", "480p"]);
  });
  test("без паттерна — пусто (качаем максимальное)", () => {
    expect(parseQualities("!клип https://twitch.tv/videos/123 10:00 - 11:00")).toEqual([]);
  });
  test("parseVodMessage прокидывает qualities", () => {
    const parsed = parseVodMessage("!клип https://twitch.tv/videos/123 10:00 - 11:00 720p");
    expect(parsed.qualities).toEqual(["720p"]);
    expect(parsed.vodId).toBe("123");
  });
});

describe("pickVariant (точный матч, без фолбэка на максимальное)", () => {
  const variants: TwtichHLSSourceFormat[] = [
    { bandwidth: 9000, codecs: "avc", resolution: "1920x1080", video: "1080p60", framerate: "60", url: "u1" },
    { bandwidth: 5000, codecs: "avc", resolution: "1280x720", video: "720p60", framerate: "60", url: "u2" },
    { bandwidth: 2000, codecs: "avc", resolution: "852x480", video: "480p30", framerate: "30", url: "u3" },
  ];

  test("без quality — максимальное", () => {
    expect(pickVariant(variants).video).toBe("1080p60");
  });
  test("720p матчится на 720p60", () => {
    expect(pickVariant(variants, "720p").video).toBe("720p60");
  });
  test("массив: первое совпавшее по порядку запроса", () => {
    expect(pickVariant(variants, ["480p", "720p"]).video).toBe("480p30");
    // 1080p отсутствует бы — берём следующее; здесь оба есть, проверяем пропуск отсутствующего
    expect(pickVariant(variants, ["1440p", "720p"]).video).toBe("720p60");
  });
  test("нет в манифесте — бросает QualityNotFoundError, ничего не качаем", () => {
    let err: unknown;
    try {
      pickVariant(variants, "2160p");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(QualityNotFoundError);
    const qe = err as QualityNotFoundError;
    expect(qe.requested).toEqual(["2160p"]);
    expect(qe.available).toContain("1080p60");
  });
  test("ни одно из нескольких не совпало — requested сохраняет порядок", () => {
    let err: unknown;
    try {
      pickVariant(variants, ["2160p", "1440p"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(QualityNotFoundError);
    expect((err as QualityNotFoundError).requested).toEqual(["2160p", "1440p"]);
  });
  test("variantMatchesQuality: префикс с fps и фолбэк на resolution", () => {
    const v = variants[1]!;
    expect(variantMatchesQuality(v, "720p")).toBe(true);
    expect(variantMatchesQuality(v, "1080p")).toBe(false);
    // resolution без video
    expect(
      variantMatchesQuality(
        { bandwidth: 1, codecs: "", resolution: "1280x720", video: "", framerate: "", url: "" },
        "720p",
      ),
    ).toBe(true);
  });
});

describe("hls playlist", () => {
  test("parse + filter", () => {
    const text = "#EXTM3U\n#EXTINF:10.0,\nseg1.ts\n#EXTINF:10.0,\nseg2.ts\n#EXTINF:10.0,\nseg3.ts";
    const { segments } = parseMediaPlaylist(text, "https://example.com/vod/");
    expect(segments).toHaveLength(3);
    expect(filterSegmentsByRange(segments, 5, 15)).toHaveLength(2);
  });
});
