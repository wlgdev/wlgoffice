import { GeminiLive, type GeminiLiveSession } from "@shevernitskiy/llm";

import { resolveFfmpegBinary } from "./ffmpeg";
import logger from "./logger";

const BYTES_PER_SECOND = 16000 * 2;
const CHUNK_BYTES = BYTES_PER_SECOND / 5; // 200ms
const FLUSH_MS = 3000;

export interface LiveTranscriptionChunk {
  text: string;
  timeSec: number;
}

export interface LiveTranscriberOptions {
  hlsUrl: string;
  geminiApiKey: string;
  systemInstruction?: string;
  durationSec?: number;
  /** Момент начала стрима (ms epoch) — запасной источник смещения таймстемпов. */
  streamStartEpochMs?: number;
}

export type TranscriptionHandler = (chunk: LiveTranscriptionChunk) => void;

export class LiveTranscriber {
  private options: LiveTranscriberOptions;
  private ffmpeg?: Bun.Subprocess<"ignore", "pipe", "inherit">;
  private session?: GeminiLiveSession;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private sentBytes = 0;
  /** Смещение таймстемпа от начала транскрибации (секунды от начала стрима). */
  private offsetSec = 0;
  private textHandlers = new Set<TranscriptionHandler>();

  constructor(options: LiveTranscriberOptions) {
    this.options = options;
  }

  onText(handler: TranscriptionHandler): () => void {
    this.textHandlers.add(handler);
    return () => this.textHandlers.delete(handler);
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    clearTimeout(this.timer);
    this.ffmpeg?.kill();
  }

  async start(): Promise<void> {
    if (this.session || this.ffmpeg) {
      throw new Error("LiveTranscriber already started");
    }

    let session: GeminiLiveSession | undefined;
    try {
      session = await new GeminiLive(this.options.geminiApiKey).connect("gemini-3.5-transcribe-live", {
        inputTranscription: true,
        timeout: 30000,
        systemInstruction: this.options.systemInstruction,
      });
      this.session = session;

      const receiveTask = this.receiveLoop(session);

      this.offsetSec = await this.resolveOffsetSec();

      const ffmpeg = Bun.spawn(
        [
          resolveFfmpegBinary(),
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          this.options.hlsUrl,
          "-f",
          "s16le",
          "-ar",
          "16000",
          "-ac",
          "1",
          "pipe:1",
        ],
        { stdout: "pipe", stderr: "inherit" },
      );
      this.ffmpeg = ffmpeg;

      if (this.options.durationSec) {
        this.timer = setTimeout(() => this.stop(), this.options.durationSec * 1000);
      }

      await this.pumpAudio(ffmpeg, session);

      const exitCode = await ffmpeg.exited;
      if (exitCode !== 0 && !this.stopped) {
        throw new Error(`ffmpeg exited with code ${exitCode}`);
      }

      await Bun.sleep(FLUSH_MS);
      session.close();
      await receiveTask;
    } catch (err) {
      this.stop();
      session?.close();
      throw err;
    } finally {
      this.ffmpeg = undefined;
      this.session = undefined;
      this.stopped = false;
    }
  }

  /**
   * Смещение таймстемпов от начала стрима.
   * Twitch отдаёт в медиаплейлисте EXT-X-TWITCH-ELAPSED-SECS — время от начала стрима
   * для первого сегмента окна (ровно то, с чего начнёт читать ffmpeg).
   * Если тега нет — считаем по времени начала стрима (fallback).
   */
  private async resolveOffsetSec(): Promise<number> {
    try {
      const res = await fetch(this.options.hlsUrl);
      const text = await res.text();
      const match = text.match(/#EXT-X-TWITCH-ELAPSED-SECS:([\d.]+)/);
      if (match?.[1]) {
        const offset = parseFloat(match[1]);
        // logger.info(`[LiveTranscriber] смещение от начала стрима: ${offset.toFixed(1)}s`);
        return offset;
      }
    } catch (err) {
      logger.warn("[LiveTranscriber] не удалось получить плейлист для смещения:", err);
    }

    if (this.options.streamStartEpochMs) {
      const offset = (Date.now() - this.options.streamStartEpochMs) / 1000;
      logger.info(`[LiveTranscriber] смещение от начала стрима (fallback): ${offset.toFixed(1)}s`);
      return offset;
    }

    return 0;
  }

  private async receiveLoop(session: GeminiLiveSession): Promise<void> {
    try {
      for await (const event of session.receive()) {
        if (event.type === "inputTranscription" && event.text.trim()) {
          const chunk: LiveTranscriptionChunk = {
            text: event.text,
            timeSec: this.offsetSec + this.sentBytes / BYTES_PER_SECOND,
          };
          for (const handler of this.textHandlers) {
            try {
              handler(chunk);
            } catch (err) {
              logger.warn("[LiveTranscriber] onText handler failed:", err);
            }
          }
        }
      }
    } catch (err) {
      logger.warn("[LiveTranscriber] gemini receive failed:", err);
      this.stop();
    }
  }

  private async pumpAudio(
    ffmpeg: Bun.Subprocess<"ignore", "pipe", "inherit">,
    session: GeminiLiveSession,
  ): Promise<void> {
    const reader = ffmpeg.stdout.getReader();
    let carry = new Uint8Array(0);
    const startedAt = Date.now();
    this.sentBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        let data = value!;
        if (carry.length > 0) {
          const merged = new Uint8Array(carry.length + data.length);
          merged.set(carry);
          merged.set(data, carry.length);
          data = merged;
        }
        const wholeChunks = Math.floor(data.length / CHUNK_BYTES);
        if (wholeChunks === 0) {
          carry = data;
          continue;
        }
        carry = data.slice(wholeChunks * CHUNK_BYTES);

        for (let i = 0; i < wholeChunks; i++) {
          const offset = i * CHUNK_BYTES;
          const wait = startedAt + ((this.sentBytes + offset) / BYTES_PER_SECOND) * 1000 - Date.now();
          if (wait > 0) await Bun.sleep(wait);
          session.sendAudio(data.subarray(offset, offset + CHUNK_BYTES));
        }
        this.sentBytes += wholeChunks * CHUNK_BYTES;
      }
    } catch (err) {
      if (!this.stopped) {
        throw err;
      }
    }
  }
}
