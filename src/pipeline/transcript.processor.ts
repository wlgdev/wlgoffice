import config from "../config";
import type { ParsedTimeRange } from "../core/types";
import { safeDeleteFile } from "../core/utils";
import { remuxHlsStream } from "../services/ffmpeg";
import { GROQ_MAX_FILE_BYTES, MAX_TRANSCRIPT_SECONDS, polishTranscript, transcribeAudio } from "../services/transcribe";
import { DurationLimitError, GroqFileSizeLimitError, type StreamFetcher, type TranscriptProcessResult } from "./types";

export interface ProcessTranscriptOptions {
  range: ParsedTimeRange;
  vodId: string;
  fetchStream: StreamFetcher;
  preferTurbo: boolean;
  onProgress?: (stage: "fetch" | "remux" | "stt" | "polish") => void;
}

export async function processTranscript(options: ProcessTranscriptOptions): Promise<TranscriptProcessResult> {
  const { range, vodId, fetchStream, preferTurbo, onProgress } = options;
  const clipDuration = range.endSeconds - range.startSeconds;

  if (clipDuration > MAX_TRANSCRIPT_SECONDS) {
    throw new DurationLimitError(clipDuration, MAX_TRANSCRIPT_SECONDS);
  }

  const stem = `${config.tmpDir}/transcript_${vodId}_${range.startSeconds}_${range.endSeconds}`;
  const audioPath = `${stem}.m4a`;
  const txtPath = `${stem}.txt`;

  try {
    onProgress?.("fetch");
    const hlsStream = await fetchStream(range.startSeconds, range.endSeconds);

    onProgress?.("remux");
    const remuxResult = await remuxHlsStream({
      stream: hlsStream.stream,
      outPath: audioPath,
      trimStart: hlsStream.trimStart,
      trimDuration: hlsStream.trimDuration,
      verbose: false,
      audioOnly: true,
    });

    await hlsStream.muteStats.catch(() => {});

    if (remuxResult.sizeBytes > GROQ_MAX_FILE_BYTES) {
      throw new GroqFileSizeLimitError(remuxResult.sizeMB);
    }

    onProgress?.("stt");
    const stt = await transcribeAudio(Bun.file(audioPath), remuxResult.duration, preferTurbo);

    onProgress?.("polish");
    const polish = await polishTranscript(stt.text);

    await Bun.write(txtPath, `${polish.text}\n`);

    return {
      txtPath,
      stt,
      polish,
      remux: remuxResult,
    };
  } finally {
    await safeDeleteFile(audioPath);
  }
}
