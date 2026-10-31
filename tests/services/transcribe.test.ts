import { describe, expect, test } from "bun:test";

import { LlmApiError } from "@shevernitskiy/llm";

import {
  describeFailure,
  EmptyTranscriptError,
  FALLBACK_STT_MODEL,
  formatRetryAfter,
  GROQ_MAX_FILE_BYTES,
  isEmptyTranscript,
  MAX_TRANSCRIPT_SECONDS,
  parseRetryAfter,
  POLISH_MODEL,
  PRIMARY_STT_MODEL,
  RateLimitError,
} from "../../src/services/transcribe";

describe("transcribe service", () => {
  describe("constants and limits", () => {
    test("models configured properly", () => {
      expect(PRIMARY_STT_MODEL).toBe("whisper-large-v3");
      expect(FALLBACK_STT_MODEL).toBe("whisper-large-v3-turbo");
      expect(POLISH_MODEL).toBe("gemini-3.5-flash-lite");
    });

    test("Groq free tier limits", () => {
      expect(GROQ_MAX_FILE_BYTES).toBe(25 * 1024 * 1024);
      expect(MAX_TRANSCRIPT_SECONDS).toBe(20 * 60);
      // 20 min * 160 kbps / 8 = 24 MB, fits within 25 MB limit
      expect((MAX_TRANSCRIPT_SECONDS * 160_000) / 8).toBeLessThan(GROQ_MAX_FILE_BYTES);
    });
  });

  describe("error classes", () => {
    test("RateLimitError carries retryAfterSec and detail", () => {
      const err = new RateLimitError(30, "Rate limit reached");
      expect(err.name).toBe("RateLimitError");
      expect(err.retryAfterSec).toBe(30);
      expect(err.detail).toBe("Rate limit reached");
    });

    test("EmptyTranscriptError has standard message", () => {
      const err = new EmptyTranscriptError();
      expect(err.name).toBe("EmptyTranscriptError");
      expect(err.message).toContain("не распознано речи");
    });
  });

  describe("formatRetryAfter", () => {
    test("formats null as unknown", () => {
      expect(formatRetryAfter(null)).toBe("неизвестно");
    });

    test("formats seconds below 90 as seconds", () => {
      expect(formatRetryAfter(2)).toBe("через 2с");
      expect(formatRetryAfter(89)).toBe("через 89с");
    });

    test("formats 90+ seconds as approximate minutes", () => {
      expect(formatRetryAfter(90)).toBe("через ~2 мин");
      expect(formatRetryAfter(3600)).toBe("через ~60 мин");
    });
  });

  describe("parseRetryAfter", () => {
    test("parses retry-after from lowercase headers", () => {
      const err = new LlmApiError("rate limit", 429, { "retry-after": "15" });
      expect(parseRetryAfter(err)).toBe(15);
    });

    test("parses Retry-After from capitalized headers", () => {
      const err = new LlmApiError("rate limit", 429, { "Retry-After": "45" });
      expect(parseRetryAfter(err)).toBe(45);
    });

    test("parses retry seconds from error message body fallback", () => {
      const err = new LlmApiError("Rate limit: please try again in 12.5s", 429, {});
      expect(parseRetryAfter(err)).toBe(12.5);
    });

    test("returns null when no retry-after info is present", () => {
      const err = new LlmApiError("Rate limit without timing", 429, {});
      expect(parseRetryAfter(err)).toBeNull();
    });
  });

  describe("isEmptyTranscript", () => {
    test("returns true for LlmApiError 200 with empty response", () => {
      const err = new LlmApiError("empty response from Groq", 200, {});
      expect(isEmptyTranscript(err)).toBe(true);
    });

    test("returns false for server error status codes", () => {
      const err = new LlmApiError("server error", 500, {});
      expect(isEmptyTranscript(err)).toBe(false);
    });

    test("returns false for regular Error", () => {
      expect(isEmptyTranscript(new Error("regular error"))).toBe(false);
    });
  });

  describe("describeFailure", () => {
    test("describes 2xx LlmApiError as empty model response", () => {
      const err = new LlmApiError("empty response", 200, {});
      expect(describeFailure(err)).toBe("пустой ответ модели");
    });

    test("describes non-2xx LlmApiError with HTTP status", () => {
      const err = new LlmApiError("rate limit", 429, {});
      expect(describeFailure(err)).toBe("HTTP 429");
    });

    test("describes TimeoutError and AbortError", () => {
      const timeout = new Error("timeout");
      timeout.name = "TimeoutError";
      expect(describeFailure(timeout)).toBe("таймаут запроса");

      const abort = new Error("abort");
      abort.name = "AbortError";
      expect(describeFailure(abort)).toBe("таймаут запроса");
    });

    test("truncates regular error messages to 120 characters", () => {
      const longMessage = "a".repeat(200);
      const desc = describeFailure(new Error(longMessage));
      expect(desc.length).toBe(120);
    });
  });
});
