import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { which } from "bun";
import logger from "./logger";

// ─── Types ───────────────────────────────────────────────────

export interface RemuxToFileOptions {
  stream: ReadableStream<Uint8Array>;
  outPath: string;
  trimStart?: number;
  trimDuration?: number;
  ffmpegPath?: string;
  overwrite?: boolean;
  verbose?: boolean;
}

export interface RemuxToStreamOptions {
  stream: ReadableStream<Uint8Array>;
  trimStart?: number;
  trimDuration?: number;
  ffmpegPath?: string;
  verbose?: boolean;
}

export interface FfmpegRunResult {
  outPath: string;
  sizeBytes: number;
  sizeMB: number;
  duration: number;
  trimStart: number;
  bitrateKbps: number;
  elapsedMs: number;
}

export interface FfmpegStreamStats {
  sizeBytes: number;
  sizeMB: number;
  duration: number;
  trimStart: number;
  bitrateKbps: number;
  elapsedMs: number;
}

export interface FfmpegStreamResult {
  stream: ReadableStream<Uint8Array>;
  duration: number;
  trimStart: number;
  result: Promise<FfmpegStreamStats>; // Промис со статистикой, который завершится вместе со стримом
}

// ─── Binary Resolver ─────────────────────────────────────────

export function resolveFfmpegBinary(customPath?: string): string {
  if (customPath) {
    if (existsSync(customPath)) return customPath;
    throw new Error(`Specified FFmpeg binary not found at: ${customPath}`);
  }

  const isWindows = process.platform === "win32";
  const binaryName = isWindows ? "ffmpeg.exe" : "ffmpeg";

  // Скомпилированный бинарник могут запускать с любым cwd (через .bat) —
  // поэтому сначала смотрим рядом с самим exe, а не в cwd.
  const nextToExecutable = join(dirname(process.execPath), binaryName);
  if (existsSync(nextToExecutable)) return nextToExecutable;

  if (isWindows) {
    const localFileDir = join(import.meta.dir, binaryName);
    if (existsSync(localFileDir)) return localFileDir;

    const localCwd = join(process.cwd(), binaryName);
    if (existsSync(localCwd)) return localCwd;

    const inPath = which(binaryName) ?? which("ffmpeg");
    if (inPath && existsSync(inPath)) return inPath;
  }

  if (!isWindows) {
    const inPath = which(binaryName);
    if (inPath && existsSync(inPath)) return inPath;

    const localFileDir = join(import.meta.dir, binaryName);
    if (existsSync(localFileDir)) return localFileDir;

    const localCwd = join(process.cwd(), binaryName);
    if (existsSync(localCwd)) return localCwd;
  }

  throw new Error(
    `FFmpeg binary ("${binaryName}") not found. ` +
      (isWindows
        ? "Please place ffmpeg.exe next to this script or add it to system PATH."
        : "Please install ffmpeg via your package manager (e.g. apt/brew install ffmpeg)."),
  );
}

// ─── Helper: Setup Input Pipe ────────────────────────────────

function setupInputPipe(
  child: ReturnType<typeof spawn>,
  inputStream: ReadableStream<Uint8Array>,
  onInputError?: (err: any) => void,
) {
  const isPipeError = (err: any) =>
    err?.code === "EPIPE" || err?.errno === -4047 || String(err).includes("broken pipe");

  child.stdin?.on("error", (err: any) => {
    if (isPipeError(err)) return;
    onInputError?.(err);
  });

  const nodeReadable = Readable.fromWeb(inputStream as any);
  nodeReadable.on("error", (err: any) => {
    if (isPipeError(err)) return;
    onInputError?.(err);
  });

  nodeReadable.pipe(child.stdin!);
}

// ─── 1. Сохранение в файл ────────────────────────────────────

export async function remuxHlsStream(options: RemuxToFileOptions): Promise<FfmpegRunResult> {
  const { stream, outPath, trimStart = 0, trimDuration = 0, ffmpegPath, overwrite = true, verbose = false } = options;

  const startTime = performance.now();
  const ffmpegBin = resolveFfmpegBinary(ffmpegPath);

  // Пишем вход во временный файл: mov-демuxer сикается по входу (default-base-is-moof/sidx),
  // на pipe:0 это даёт "partial file" и пустой выхлоп с кодом 0.
  // ponytail: +1 проход по диску (~60MB), уберётся само; альтернатива — чинить сики в ffmpeg, нет.
  const tmpIn = `${outPath}.in.tmp`;

  const args: string[] = [];

  if (overwrite) args.push("-y");
  args.push("-hide_banner");
  args.push("-loglevel", verbose ? "info" : "error");

  args.push("-fflags", "+genpts+igndts+discardcorrupt");
  args.push("-avoid_negative_ts", "make_zero");

  if (trimStart > 0) args.push("-ss", String(trimStart));
  args.push("-i", tmpIn);
  if (trimDuration > 0) args.push("-t", String(trimDuration));

  args.push(
    "-c",
    "copy",
    "-bsf:a",
    "aac_adtstoasc",
    "-bsf",
    "setts=pts=PTS-STARTPTS:dts=DTS-STARTDTS",
    "-muxpreload",
    "0",
    "-muxdelay",
    "0",
    "-movflags",
    "+faststart",
    outPath,
  );

  logger.info(`Spawning FFmpeg (${ffmpegBin}) -> File: ${outPath}...`);

  try {
    await Bun.write(tmpIn, new Response(stream));

    return await new Promise<FfmpegRunResult>((resolve, reject) => {
      const child = spawn(ffmpegBin, args, {
        stdio: ["ignore", verbose ? "inherit" : "ignore", "pipe"],
        windowsHide: true,
      });

      let stderrData = "";
      child.stderr?.on("data", (chunk) => {
        stderrData += chunk.toString();
      });

      child.on("close", async (code) => {
        if (code !== 0) {
          return reject(new Error(`FFmpeg exited with code ${code}: ${stderrData.trim() || "Unknown error"}`));
        }

        try {
          const elapsedMs = Math.round(performance.now() - startTime);
          const resultFile = Bun.file(outPath);
          const sizeBytes = await resultFile.size;
          const sizeMB = +(sizeBytes / 1e6).toFixed(2);
          const bitrateKbps = trimDuration > 0 ? Math.round((sizeBytes * 8) / trimDuration / 1000) : 0;

          logger.info(`Saved "${outPath}" (${sizeMB} MB, ~${bitrateKbps} kbps) in ${(elapsedMs / 1000).toFixed(1)}s`);

          resolve({
            outPath,
            sizeBytes,
            sizeMB,
            duration: trimDuration,
            trimStart,
            bitrateKbps,
            elapsedMs,
          });
        } catch (e) {
          reject(e);
        }
      });

      child.on("error", (err) => reject(err));
    });
  } finally {
    await rm(tmpIn, { force: true }).catch(() => {});
  }
}

// ─── 2. Ремуксинг в выходной ReadableStream (fMP4) ───────────

export function remuxHlsToStream(options: RemuxToStreamOptions): FfmpegStreamResult {
  const { stream, trimStart = 0, trimDuration = 0, ffmpegPath, verbose = false } = options;

  const startTime = performance.now();
  const ffmpegBin = resolveFfmpegBinary(ffmpegPath);

  const args: string[] = ["-hide_banner", "-loglevel", verbose ? "info" : "error"];

  if (trimStart > 0) args.push("-ss", String(trimStart));
  args.push("-i", "pipe:0");
  if (trimDuration > 0) args.push("-t", String(trimDuration));

  // Флаги фрагментированного MP4 для стриминга в pipe:1
  args.push(
    "-c",
    "copy",
    "-bsf:a",
    "aac_adtstoasc",
    "-f",
    "mp4",
    "-movflags",
    "frag_keyframe+empty_moov+default_base_moof",
    "pipe:1",
  );

  logger.info(`Spawning FFmpeg (${ffmpegBin}) -> ReadableStream (fMP4)...`);

  const child = spawn(ffmpegBin, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let stderrData = "";
  child.stderr?.on("data", (chunk) => {
    stderrData += chunk.toString();
  });

  // Пайпим входящие TS сегменты
  setupInputPipe(child, stream);

  let totalBytes = 0;
  let resolveStats!: (stats: FfmpegStreamStats) => void;
  let rejectStats!: (err: any) => void;

  const result = new Promise<FfmpegStreamStats>((resolve, reject) => {
    resolveStats = resolve;
    rejectStats = reject;
  });

  // Создаем исходящий Web ReadableStream из stdout FFmpeg
  const outStream = new ReadableStream<Uint8Array>({
    start(controller) {
      child.stdout?.on("data", (chunk: Buffer) => {
        const u8 = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        totalBytes += u8.byteLength;
        controller.enqueue(u8);
      });

      child.stdout?.on("end", () => {
        controller.close();
      });

      child.stdout?.on("error", (err) => {
        controller.error(err);
        rejectStats(err);
      });
    },
  });

  child.on("close", (code) => {
    if (code !== 0) {
      return rejectStats(new Error(`FFmpeg exited with code ${code}: ${stderrData.trim() || "Unknown error"}`));
    }

    const elapsedMs = Math.round(performance.now() - startTime);
    const sizeMB = +(totalBytes / 1e6).toFixed(2);
    const bitrateKbps = trimDuration > 0 ? Math.round((totalBytes * 8) / trimDuration / 1000) : 0;

    logger.info(`Stream finished: ${sizeMB} MB (~${bitrateKbps} kbps) in ${(elapsedMs / 1000).toFixed(1)}s`);

    resolveStats({
      sizeBytes: totalBytes,
      sizeMB,
      duration: trimDuration,
      trimStart,
      bitrateKbps,
      elapsedMs,
    });
  });

  child.on("error", (err) => rejectStats(err));

  return {
    stream: outStream,
    duration: trimDuration,
    trimStart,
    result,
  };
}
