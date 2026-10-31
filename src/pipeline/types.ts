import type { FfmpegRunResult } from "../services/ffmpeg";
import type { HlsStreamResult, MuteStats } from "../services/hls";
import type { PolishResult, SttResult } from "../services/transcribe";

export type StreamFetcher = (start: number, end: number) => Promise<HlsStreamResult>;

export class DurationLimitError extends Error {
  constructor(
    public readonly requestedSeconds: number,
    public readonly maxSeconds: number,
  ) {
    const reqMin = (requestedSeconds / 60).toFixed(1);
    const maxMin = Math.round(maxSeconds / 60);
    super(`превышен лимит длительности (${reqMin} мин > ${maxMin} мин)`);
    this.name = "DurationLimitError";
  }
}

export class FileSizeLimitError extends Error {
  constructor(
    public readonly actualBytes: number,
    public readonly maxBytes: number,
  ) {
    const actGb = (actualBytes / (1024 * 1024 * 1024)).toFixed(2);
    const maxGb = (maxBytes / (1024 * 1024 * 1024)).toFixed(1);
    super(`превышен лимит размера (${actGb} GB > ${maxGb} GB)`);
    this.name = "FileSizeLimitError";
  }
}

export class GroqFileSizeLimitError extends Error {
  constructor(public readonly sizeMB: number) {
    super(`слишком большой фрагмент для Groq (${sizeMB} MB > 25 MB). Разбей интервал пополам.`);
    this.name = "GroqFileSizeLimitError";
  }
}

export interface ClipProcessResult {
  outPath: string;
  remux: FfmpegRunResult;
  muteStats: MuteStats;
  hls: HlsStreamResult;
}

export interface TranscriptProcessResult {
  txtPath: string;
  stt: SttResult;
  polish: PolishResult;
  remux: FfmpegRunResult;
}
