import { describe, expect, test } from "bun:test";

import type { InteropPayload, MuteStats } from "../../src/core/types";
import { PRIMARY_STT_MODEL } from "../../src/services/transcribe";
import {
  buildDeleteMediaData,
  buildListBlock,
  buildMediaErrorBlock,
  buildMediaResultBlock,
  buildMediaSkippedBlock,
  buildNoticeBlock,
  buildRequesterLine,
  buildStageLine,
  escapeHtml,
  formatDuration,
  formatMuteLine,
  parseDeleteMediaData,
  plural,
} from "../../src/telegram/formatters";

const AMP = String.fromCharCode(38);

describe("telegram formatters", () => {
  describe("escapeHtml", () => {
    test("escapes HTML special characters", () => {
      expect(escapeHtml("<test>&\"'</test>")).toBe(`${AMP}lt;test${AMP}gt;${AMP}amp;"'${AMP}lt;/test${AMP}gt;`);
    });
  });

  describe("buildListBlock and buildNoticeBlock", () => {
    test("список собирается из пунктов", () => {
      expect(buildListBlock(["первый", "второй"])).toBe("<ul><li>первый</li><li>второй</li></ul>");
    });

    test("уведомление: заголовок, текст и необязательная заметка", () => {
      const notice = buildNoticeBlock({ icon: "❌", title: "Ошибка", body: "что-то сломалось" });

      expect(notice).toContain("<h3>❌ Ошибка</h3>");
      expect(notice).toContain("<p>что-то сломалось</p>");
      expect(notice).not.toContain("<p>›");
    });

    test("уведомление с заметкой интеропа", () => {
      const notice = buildNoticeBlock({
        icon: "❌",
        title: "Ошибка",
        body: "текст",
        note: buildRequesterLine({ from: "twitch", to: 1, username: null, channel: null }),
      });

      expect(notice).toContain("<p>› 🔗 <b>Инициировано из:</b> <b>twitch</b></p>");
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

  describe("formatDuration", () => {
    test("short durations in seconds", () => {
      expect(formatDuration(13)).toBe("13с");
      expect(formatDuration(13.6)).toBe("14с");
    });

    test("long durations in minutes", () => {
      expect(formatDuration(795)).toBe("13:15");
      expect(formatDuration(60)).toBe("1:00");
    });
  });

  describe("plural", () => {
    test("picks the right form", () => {
      expect(plural(1, "символ", "символа", "символов")).toBe("символ");
      expect(plural(4, "символ", "символа", "символов")).toBe("символа");
      expect(plural(11, "символ", "символа", "символов")).toBe("символов");
      expect(plural(6004, "символ", "символа", "символов")).toBe("символа");
    });
  });

  describe("formatMuteLine", () => {
    const clean: MuteStats = { totalSegments: 10, mutedFound: 0, unmutedSuccess: 0, remainedMuted: 0 };

    test("clean audio", () => {
      expect(formatMuteLine(clean)).toBe("🔊 Звук: чистый ✓");
    });

    test("all muted segments unmuted successfully", () => {
      expect(formatMuteLine({ totalSegments: 10, mutedFound: 3, unmutedSuccess: 3, remainedMuted: 0 })).toBe(
        "🔊 Звук: размьючено 3/3 ✓",
      );
    });

    test("partially muted segments warning", () => {
      expect(formatMuteLine({ totalSegments: 10, mutedFound: 5, unmutedSuccess: 3, remainedMuted: 2 })).toBe(
        "⚠️ Звук: размьючено 3/5 (2 без звука)",
      );
    });
  });

  describe("delete callback data", () => {
    test("builds and parses item id", () => {
      expect(buildDeleteMediaData(3)).toBe("del:media:3");
      expect(parseDeleteMediaData("del:media:3")).toBe(3);
    });

    test("ignores unrelated data", () => {
      expect(parseDeleteMediaData("del:media")).toBeNull();
      expect(parseDeleteMediaData("del:media:abc")).toBeNull();
      expect(parseDeleteMediaData("other")).toBeNull();
    });
  });

  describe("buildStageLine", () => {
    test("renders progress line with plain range", () => {
      const line = buildStageLine({
        icon: "🔄",
        index: 2,
        total: 3,
        range: "07:12:04–07:12:17",
        text: "получение HLS…",
      });
      expect(line).toContain("🔄 [2/3]");
      expect(line).toContain("07:12:04–07:12:17");
      expect(line).not.toContain("<code>");
      expect(line).toContain("получение HLS…");
    });
  });

  describe("buildMediaResultBlock", () => {
    const base = {
      itemId: 1,
      range: "25:46:09–25:46:21",
      vodUrl: "https://www.twitch.tv/videos/1?t=25h46m9s",
      vodLabel: "VOD 1",
    };

    test("clip block contains media meta, sound and timing", () => {
      const block = buildMediaResultBlock({
        ...base,
        mode: "video",
        durationSec: 13,
        sizeMB: 2.07,
        elapsedSec: 2,
        quality: "480p30",
        muteStats: { totalSegments: 3, mutedFound: 3, unmutedSuccess: 3, remainedMuted: 0 },
      });

      expect(block).toContain("<li>🎬 25:46:09–25:46:21 · 13с · 2.07 МБ · 480p30</li>");
      expect(block).toContain("🔊 Звук: размьючено 3/3 ✓");
      expect(block).toContain("⚡ Обработка: 2с");
      expect(block).not.toContain('style="primary"');
      expect(block).toContain('style="danger"');
      expect(block).toContain('data="del:media:1"');
    });

    test("audio block shows format instead of quality", () => {
      const block = buildMediaResultBlock({
        ...base,
        mode: "audio",
        durationSec: 795,
        sizeMB: 12.28,
        elapsedSec: 19,
        bitrateKbps: 128,
        muteStats: { totalSegments: 24, mutedFound: 12, unmutedSuccess: 12, remainedMuted: 0 },
      });

      expect(block).toContain("🎵 25:46:09–25:46:21 · 13:15 · 12.28 МБ · AAC 128k");
      expect(block).not.toContain("480p30");
    });

    test("transcript block shows model and polish state", () => {
      const block = buildMediaResultBlock({
        ...base,
        mode: "transcript",
        durationSec: 795,
        sizeMB: 12.28,
        elapsedSec: 42,
        sttModel: PRIMARY_STT_MODEL,
        polished: true,
        chars: 6004,
      });

      expect(block).toContain("🎙 25:46:09–25:46:21 · 13:15 · 6");
      expect(block).toContain("Whisper Large V3");
      expect(block).toContain("причесан");
    });
  });

  describe("buildMediaErrorBlock and buildMediaSkippedBlock", () => {
    test("error block keeps the same shape as a result block", () => {
      const block = buildMediaErrorBlock({
        itemId: 2,
        range: "07:12:04–07:12:17",
        vodUrl: "https://www.twitch.tv/videos/1?t=7h12m4s",
        vodLabel: "VOD 1",
        stage: "ремуксинг MP4",
        detail: "ffmpeg: код 1",
        elapsedSec: 12,
      });

      expect(block).toContain("❌ 07:12:04–07:12:17 · ремуксинг MP4 — ошибка");
      expect(block).toContain("ffmpeg: код 1");
      expect(block).toContain("⚡ Обработка: 12с");
      expect(block).toContain('data="del:media:2"');
    });

    test("skipped block explains the reason", () => {
      const block = buildMediaSkippedBlock({
        itemId: 3,
        range: "12:45:30–12:45:43",
        vodUrl: "https://www.twitch.tv/videos/1?t=12h45m30s",
        vodLabel: "VOD 1",
        reason: "качество не найдено",
      });

      expect(block).toContain("⏭ 12:45:30–12:45:43 · пропущен (качество не найдено)");
    });
  });
});
