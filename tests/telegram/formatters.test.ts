import { describe, expect, test } from "bun:test";

import type { FfmpegRunResult } from "../../src/ffmpeg";
import { type HlsStreamResult, type MuteStats, QualityNotFoundError } from "../../src/hls";
import type { InteropPayload } from "../../src/interop";
import {
  buildCaption,
  buildQualityNotFoundStatus,
  buildRequesterLine,
  buildStatusMessage,
  buildTranscriptCaption,
  escapeHtml,
  formatMuteBadge,
  toTelegramHtml,
  transcriptBadge,
} from "../../src/telegram";
import { FALLBACK_STT_MODEL, PRIMARY_STT_MODEL } from "../../src/transcribe";

describe("telegram formatters", () => {
  describe("escapeHtml and toTelegramHtml", () => {
    test("escapes HTML special characters", () => {
      expect(escapeHtml("<test>&\"'</test>")).toBe("&lt;test&gt;&amp;\"'&lt;/test&gt;");
    });

    test("converts newlines to <br>", () => {
      const htmlText = toTelegramHtml("line1\nline2\r\nline3");
      expect(String(htmlText)).toBeDefined();
    });
  });

  describe("buildRequesterLine", () => {
    test("returns empty string when interop is null", () => {
      expect(buildRequesterLine(null)).toBe("");
    });

    test("formats requester line with username", () => {
      const interop: InteropPayload = {
        from: "twitch",
        to: 12345,
        username: "tester",
        channel: "welovegames",
      };
      const line = buildRequesterLine(interop);
      expect(line).toContain("twitch");
      expect(line).toContain("tester");
      expect(line).toContain("Инициировано из:");
    });

    test("formats requester line without username", () => {
      const interop: InteropPayload = {
        from: "vk",
        to: 12345,
        username: null,
        channel: null,
      };
      const line = buildRequesterLine(interop);
      expect(line).toContain("vk");
      expect(line).not.toContain("username:");
    });
  });

  describe("formatMuteBadge", () => {
    test("clean audio when no muted segments", () => {
      expect(formatMuteBadge({ totalSegments: 10, mutedFound: 0, unmutedSuccess: 0, remainedMuted: 0 })).toBe(
        "🔊 чистый звук",
      );
    });

    test("all muted segments unmuted successfully", () => {
      expect(formatMuteBadge({ totalSegments: 10, mutedFound: 3, unmutedSuccess: 3, remainedMuted: 0 })).toBe(
        "🔊 3/3 размьючено ✓",
      );
    });

    test("partially unmuted segments warning", () => {
      expect(formatMuteBadge({ totalSegments: 10, mutedFound: 5, unmutedSuccess: 3, remainedMuted: 2 })).toBe(
        "⚠️ 3/5 размьючено (2 без звука)",
      );
    });
  });

  describe("buildCaption", () => {
    const fakeRemux: FfmpegRunResult = {
      outPath: "tmp/test.mp4",
      sizeBytes: 15500000,
      sizeMB: 15.5,
      duration: 60,
      trimStart: 0,
      bitrateKbps: 2000,
      elapsedMs: 3500,
    };

    const fakeHls = {
      variant: {
        quality: "1080p60",
        width: 1920,
        height: 1080,
        framerate: 60,
      },
    } as unknown as HlsStreamResult;

    test("single video clip caption without index", () => {
      const caption = buildCaption({
        range: { rawStart: "10:00", rawEnd: "11:00" },
        hls: fakeHls,
        muteStats: { totalSegments: 10, mutedFound: 0, unmutedSuccess: 0, remainedMuted: 0 },
        remux: fakeRemux,
        vodId: "123456",
        vodUrl: "https://twitch.tv/videos/123456",
        index: 1,
        total: 1,
        mode: "video",
      });

      expect(caption).toContain("🎬 <b>Клип [10:00 - 11:00]</b>");
      expect(caption).toContain("1080p60 (1920x1080 @ 60fps)");
      expect(caption).toContain("15.5 MB");
      expect(caption).toContain("чистый (без мьютов) ✅");
      expect(caption).toContain("https://twitch.tv/videos/123456");
      expect(caption).not.toContain("1/1");
    });

    test("multi clip caption shows index/total", () => {
      const caption = buildCaption({
        range: { rawStart: "10:00", rawEnd: "11:00" },
        hls: fakeHls,
        muteStats: { totalSegments: 10, mutedFound: 2, unmutedSuccess: 2, remainedMuted: 0 },
        remux: fakeRemux,
        vodId: "123456",
        vodUrl: "https://twitch.tv/videos/123456",
        index: 2,
        total: 3,
        mode: "video",
      });

      expect(caption).toContain("🎬 <b>Клип 2/3 [10:00 - 11:00]</b>");
      expect(caption).toContain("размьючено 2/2 ✅");
    });

    test("audio mode shows AAC bitrate instead of video resolution", () => {
      const caption = buildCaption({
        range: { rawStart: "10:00", rawEnd: "11:00" },
        hls: fakeHls,
        muteStats: { totalSegments: 10, mutedFound: 0, unmutedSuccess: 0, remainedMuted: 0 },
        remux: fakeRemux,
        vodId: "123456",
        vodUrl: "https://twitch.tv/videos/123456",
        index: 1,
        total: 1,
        mode: "audio",
      });

      expect(caption).toContain("🎵 <b>Аудио [10:00 - 11:00]</b>");
      expect(caption).toContain("AAC (2000 kbps)");
      expect(caption).not.toContain("1080p60");
    });

    test("includes requester line when interop is provided", () => {
      const interop: InteropPayload = {
        from: "twitch",
        to: 12345,
        username: "nikita",
        channel: null,
      };

      const caption = buildCaption({
        range: { rawStart: "10:00", rawEnd: "11:00" },
        hls: fakeHls,
        muteStats: { totalSegments: 10, mutedFound: 0, unmutedSuccess: 0, remainedMuted: 0 },
        remux: fakeRemux,
        vodId: "123456",
        vodUrl: "https://twitch.tv/videos/123456",
        index: 1,
        total: 1,
        mode: "video",
        interop,
      });

      expect(caption).toContain("Инициировано из:");
      expect(caption).toContain("nikita");
    });
  });

  describe("buildTranscriptCaption and transcriptBadge", () => {
    test("buildTranscriptCaption with primary STT and polished text", () => {
      const caption = buildTranscriptCaption({
        range: { rawStart: "05:00", rawEnd: "06:00" },
        stt: { text: "Привет мир", model: PRIMARY_STT_MODEL },
        polish: { text: "Привет, мир!", polished: true },
        durationSec: 60,
        vodId: "999",
        vodUrl: "https://twitch.tv/videos/999",
      });

      expect(caption).toContain("Whisper Large V3");
      expect(caption).toContain("причесан gemini-3.5-flash-lite");
      expect(caption).toContain("Длительность:</b> 60с");
      expect(caption).not.toContain("fallback:");
    });

    test("buildTranscriptCaption with fallback STT and unpolished text", () => {
      const caption = buildTranscriptCaption({
        range: { rawStart: "05:00", rawEnd: "06:00" },
        stt: { text: "Сырой текст", model: FALLBACK_STT_MODEL, fallbackReason: "HTTP 429" },
        polish: { text: "Сырой текст", polished: false, failureReason: "timeout" },
        durationSec: 60,
        vodId: "999",
        vodUrl: "https://twitch.tv/videos/999",
      });

      expect(caption).toContain("Whisper Large V3 Turbo");
      expect(caption).toContain("fallback: HTTP 429");
      expect(caption).toContain("сырой текст без причесывания");
      expect(caption).toContain("timeout");
    });

    test("transcriptBadge formatting", () => {
      expect(transcriptBadge({ text: "", model: PRIMARY_STT_MODEL }, { text: "", polished: true })).toBe(
        "V3 · причесан",
      );
      expect(transcriptBadge({ text: "", model: FALLBACK_STT_MODEL }, { text: "", polished: false })).toBe(
        "V3 Turbo ⚠️ · сырой",
      );
    });
  });

  describe("buildStatusMessage", () => {
    test("builds status message with default header", () => {
      const msg = buildStatusMessage("123", ["line 1", "line 2"]);
      expect(msg).toContain("Обработка VOD <code>123</code>");
      expect(msg).toContain("line 1\nline 2");
    });

    test("builds status message with custom header and subtitle", () => {
      const msg = buildStatusMessage("123", ["line 1"], "Custom Header", "Sub text");
      expect(msg).toContain("Custom Header");
      expect(msg).toContain("Sub text");
      expect(msg).toContain("line 1");
    });
  });

  describe("buildQualityNotFoundStatus", () => {
    test("single requested quality not found", () => {
      const err = new QualityNotFoundError(["2160p"], ["1080p60", "720p60"]);
      const status = buildQualityNotFoundStatus(1, 2, "10:00 - 11:00", err);
      expect(status).toContain("качество <code>2160p</code> не найдено");
      expect(status).toContain("доступно: 1080p60, 720p60");
    });

    test("multiple requested qualities not found", () => {
      const err = new QualityNotFoundError(["2160p", "1440p"], ["1080p60"]);
      const status = buildQualityNotFoundStatus(1, 2, "10:00 - 11:00", err);
      expect(status).toContain("ни одно из запрошенных качеств (<code>2160p</code>, <code>1440p</code>) не найдено");
    });
  });
});
