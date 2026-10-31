import { describe, expect, test } from "bun:test";

import { humanizeDuration, parseTimeRanges, timeStringFromTs, timeToSeconds } from "../../src/utils";

describe("time utils", () => {
  describe("timeToSeconds", () => {
    test("converts pure seconds", () => {
      expect(timeToSeconds("0")).toBe(0);
      expect(timeToSeconds("10")).toBe(10);
      expect(timeToSeconds("3599")).toBe(3599);
    });

    test("converts MM:SS format", () => {
      expect(timeToSeconds("00:00")).toBe(0);
      expect(timeToSeconds("01:30")).toBe(90);
      expect(timeToSeconds("10:00")).toBe(600);
      expect(timeToSeconds("59:59")).toBe(3599);
    });

    test("converts HH:MM:SS format", () => {
      expect(timeToSeconds("01:00:00")).toBe(3600);
      expect(timeToSeconds("1:02:03")).toBe(3723);
      expect(timeToSeconds("10:20:30")).toBe(37230);
    });

    test("rejects invalid minutes or seconds (>59)", () => {
      expect(timeToSeconds("10:60")).toBeNull();
      expect(timeToSeconds("10:99")).toBeNull();
      expect(timeToSeconds("1:60:00")).toBeNull();
      expect(timeToSeconds("1:00:60")).toBeNull();
    });

    test("rejects malformed and non-numeric strings", () => {
      expect(timeToSeconds("")).toBeNull();
      expect(timeToSeconds("abc")).toBeNull();
      expect(timeToSeconds("-10")).toBeNull();
      expect(timeToSeconds("10:aa")).toBeNull();
      expect(timeToSeconds("1:2:3:4")).toBeNull();
    });
  });

  describe("parseTimeRanges", () => {
    test("parses standard MM:SS - MM:SS range", () => {
      const ranges = parseTimeRanges("10:00 - 12:30");
      expect(ranges).toHaveLength(1);
      expect(ranges[0]!.startSeconds).toBe(600);
      expect(ranges[0]!.endSeconds).toBe(750);
      expect(ranges[0]!.rawStart).toBe("10:00");
      expect(ranges[0]!.rawEnd).toBe("12:30");
    });

    test("parses plain seconds range", () => {
      const ranges = parseTimeRanges("100-234");
      expect(ranges).toHaveLength(1);
      expect(ranges[0]!.rawStart).toBe("100");
      expect(ranges[0]!.rawEnd).toBe("234");
      expect(ranges[0]!.startSeconds).toBe(100);
      expect(ranges[0]!.endSeconds).toBe(234);
    });

    test("supports various dashes and separators (hyphen, en-dash, em-dash, tilde)", () => {
      expect(parseTimeRanges("100 - 234")).toHaveLength(1);
      expect(parseTimeRanges("100 – 234")).toHaveLength(1);
      expect(parseTimeRanges("100 — 234")).toHaveLength(1);
      expect(parseTimeRanges("100 ~ 234")).toHaveLength(1);
    });

    test("supports mixing formats", () => {
      const mixed1 = parseTimeRanges("100 - 2:30");
      expect(mixed1).toHaveLength(1);
      expect(mixed1[0]!.startSeconds).toBe(100);
      expect(mixed1[0]!.endSeconds).toBe(150);

      const mixed2 = parseTimeRanges("10:00 - 234");
      expect(mixed2).toHaveLength(1);
      expect(mixed2[0]!.startSeconds).toBe(600);
      expect(mixed2[0]!.endSeconds).toBe(234);
    });

    test("parses multiple ranges in a single message", () => {
      const multi = parseTimeRanges("!клип 01:00 - 02:00 и 05:00 - 06:30");
      expect(multi).toHaveLength(2);
      expect(multi[0]!.startSeconds).toBe(60);
      expect(multi[0]!.endSeconds).toBe(120);
      expect(multi[1]!.startSeconds).toBe(300);
      expect(multi[1]!.endSeconds).toBe(390);
    });

    test("does not match numbers inside URLs", () => {
      expect(parseTimeRanges("!клип https://twitch.tv/videos/1234567890")).toHaveLength(0);
      expect(parseTimeRanges("!клип https://vkvideo.ru/video-46211765_456252477")).toHaveLength(0);
    });
  });

  describe("humanizeDuration", () => {
    test("handles non-positive durations", () => {
      expect(humanizeDuration(0)).toBe("0с");
      expect(humanizeDuration(-500)).toBe("0с");
    });

    test("formats seconds, minutes, hours, days", () => {
      expect(humanizeDuration(5000)).toBe("5с");
      expect(humanizeDuration(65000)).toBe("1м 5с");
      expect(humanizeDuration(3665000)).toBe("1ч 1м 5с");
      expect(humanizeDuration(86400000)).toBe("1д");
    });
  });

  describe("timeStringFromTs", () => {
    test("formats millisecond timestamps to HH:MM:SS", () => {
      expect(timeStringFromTs(0)).toBe("00:00:00");
      expect(timeStringFromTs(65000)).toBe("00:01:05");
      expect(timeStringFromTs(3665000)).toBe("01:01:05");
    });

    test("applies millisecond offset", () => {
      expect(timeStringFromTs(1000, 2000)).toBe("00:00:03");
    });
  });
});
