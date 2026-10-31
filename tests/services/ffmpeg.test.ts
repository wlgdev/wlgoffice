import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

import config from "../../src/config";
import { remuxHlsStream, resolveFfmpegBinary } from "../../src/services/ffmpeg";

describe("ffmpeg service", () => {
  describe("resolveFfmpegBinary", () => {
    test("finds binary in repo or PATH", () => {
      const bin = resolveFfmpegBinary();
      expect(bin).toBeDefined();
      expect(existsSync(bin)).toBe(true);
    });

    test("accepts valid custom path", () => {
      const bin = resolveFfmpegBinary();
      expect(resolveFfmpegBinary(bin)).toBe(bin);
    });

    test("throws on nonexistent custom path", () => {
      expect(() => resolveFfmpegBinary("nonexistent/ffmpeg/bin")).toThrow();
    });
  });

  describe("remuxHlsStream", () => {
    test("remux rejects on errored input stream", async () => {
      const outPath = `${config.tmpDir}/test_broken_suite.mp4`;
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
});
