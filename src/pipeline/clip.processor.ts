import config from "../config";
import type { ParsedTimeRange } from "../core/types";
import { remuxHlsStream } from "../services/ffmpeg";
import { type ClipProcessResult, DurationLimitError, FileSizeLimitError, type StreamFetcher } from "./types";

export const MAX_DURATION_SECONDS = 60 * 60;
export const MAX_FILE_SIZE_BYTES = 3.5 * 1024 * 1024 * 1024;

export interface ProcessClipOptions {
  range: ParsedTimeRange;
  vodId: string;
  isAudio: boolean;
  fetchStream: StreamFetcher;
  onProgress?: (stage: "fetch" | "remux") => void;
}

export async function processClip(options: ProcessClipOptions): Promise<ClipProcessResult> {
  const { range, vodId, isAudio, fetchStream, onProgress } = options;
  const clipDuration = range.endSeconds - range.startSeconds;

  if (clipDuration > MAX_DURATION_SECONDS) {
    throw new DurationLimitError(clipDuration, MAX_DURATION_SECONDS);
  }

  const outPath = `${config.tmpDir}/${isAudio ? "audio" : "clip"}_${vodId}_${range.startSeconds}_${range.endSeconds}.${isAudio ? "m4a" : "mp4"}`;

  onProgress?.("fetch");
  const hlsStream = await fetchStream(range.startSeconds, range.endSeconds);

  onProgress?.("remux");
  const [remuxResult, muteStats] = await Promise.all([
    remuxHlsStream({
      stream: hlsStream.stream,
      outPath,
      trimStart: hlsStream.trimStart,
      trimDuration: hlsStream.trimDuration,
      verbose: false,
      audioOnly: isAudio,
    }),
    hlsStream.muteStats,
  ]);

  if (remuxResult.sizeBytes > MAX_FILE_SIZE_BYTES) {
    throw new FileSizeLimitError(remuxResult.sizeBytes, MAX_FILE_SIZE_BYTES);
  }

  return {
    outPath,
    remux: remuxResult,
    muteStats,
    hls: hlsStream,
  };
}
