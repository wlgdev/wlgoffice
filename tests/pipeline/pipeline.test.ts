import { describe, expect, test } from "bun:test";

import { MAX_DURATION_SECONDS, processClip } from "../../src/pipeline/clip.processor";
import { processTranscript } from "../../src/pipeline/transcript.processor";
import { DurationLimitError } from "../../src/pipeline/types";
import { MAX_TRANSCRIPT_SECONDS } from "../../src/services/transcribe";

describe("pipeline processors", () => {
  describe("processClip", () => {
    test("throws DurationLimitError when range exceeds 60 minutes", async () => {
      const longRange = {
        startSeconds: 0,
        endSeconds: MAX_DURATION_SECONDS + 10,
        rawStart: "00:00",
        rawEnd: "61:00",
      };

      await expect(
        processClip({
          range: longRange,
          vodId: "123",
          isAudio: false,
          fetchStream: async () => ({}) as any,
        }),
      ).rejects.toBeInstanceOf(DurationLimitError);
    });
  });

  describe("processTranscript", () => {
    test("throws DurationLimitError when range exceeds 20 minutes", async () => {
      const longRange = {
        startSeconds: 0,
        endSeconds: MAX_TRANSCRIPT_SECONDS + 10,
        rawStart: "00:00",
        rawEnd: "21:00",
      };

      await expect(
        processTranscript({
          range: longRange,
          vodId: "123",
          preferTurbo: false,
          fetchStream: async () => ({}) as any,
        }),
      ).rejects.toBeInstanceOf(DurationLimitError);
    });
  });
});
