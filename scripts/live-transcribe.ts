import { GeminiLive } from "@shevernitskiy/llm";
import { Twitch } from "@shevernitskiy/scraperator";

import config from "../src/config";
import logger from "../src/logger";
import { fromTwitchVariant, isAudioOnlyVariant, pickVariant } from "../src/hls";
import { resolveFfmpegBinary } from "../src/ffmpeg";

const args = process.argv.slice(2);
const channel = args.find((a) => !a.startsWith("--")) ?? "welovegames";
const durationSec = Number(args.find((a) => a.startsWith("--duration="))?.split("=")[1]);

const BYTES_PER_SECOND = 16000 * 2;
const CHUNK_BYTES = BYTES_PER_SECOND / 5; // 200ms

async function main() {
  const twitch = new Twitch(channel, {
    proxy: config.proxy,
    OAuthToken: config.twitch.oauth,
  });

  const info = await twitch.streamInfo();
  if (!info.online) {
    console.error(`[twitch] "${channel}" не в эфире`);
    process.exit(1);
  }
  logger.info(`[twitch] "${channel}" в эфире (stream id ${info.id})`);

  const variants = (await twitch.liveHLSMetadata()).map(fromTwitchVariant);
  const audioVariant = pickVariant(variants, undefined, "cheapest");

  if (!isAudioOnlyVariant(audioVariant)) {
    logger.warn(`[twitch] отдельной audio_only дорожки нет, взяли ${audioVariant.video || audioVariant.resolution}`);
  }
  logger.info(
    `[twitch] variant: ${audioVariant.video || "audio"} (${Math.round(audioVariant.bandwidth / 1000)} kbps, codecs: ${audioVariant.codecs})`,
  );

  const ffmpeg = Bun.spawn(
    [
      resolveFfmpegBinary(),
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      audioVariant.url,
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
  logger.info(`[ffmpeg] spawned, pid ${ffmpeg.pid}`);

  const live = new GeminiLive(config.gemini.apiKey!);
  const session = await live.connect("gemini-3.5-transcribe-live", {
    inputTranscription: true,
    timeout: 30000,
  });
  logger.info("[gemini] session connected");

  const receiveTask = (async () => {
    try {
      for await (const event of session.receive()) {
        if (event.type === "inputTranscription") console.log("[user]", event.text);
        if (event.type === "text") console.log("[model]", event.text);
        if (event.type === "interrupted") console.log("[interrupted]");
        if (event.type === "turnComplete") console.log("[turnComplete]");
      }
    } catch (err) {
      logger.warn("[gemini] receive failed:", err);
    }
  })();

  let stopTimer;
  if (durationSec) {
    stopTimer = setTimeout(() => {
      logger.info(`[duration] прошло ${durationSec}s, останавливаюсь`);
      ffmpeg.kill();
    }, durationSec * 1000);
  }

  process.on("SIGINT", () => {
    logger.info("[sigint] останавливаюсь");
    ffmpeg.kill();
  });

  const startedAt = Date.now();
  let sentBytes = 0;
  let reportedSeconds = -1;

  const reader = ffmpeg.stdout.getReader();
  let carry = new Uint8Array(0);
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
      const targetAt = startedAt + ((sentBytes + offset) / BYTES_PER_SECOND) * 1000;
      const wait = targetAt - Date.now();
      if (wait > 0) await Bun.sleep(wait);
      session.sendAudio(data.subarray(offset, offset + CHUNK_BYTES));
    }
    sentBytes += wholeChunks * CHUNK_BYTES;

    const seconds = Math.floor(sentBytes / BYTES_PER_SECOND);
    if (seconds !== reportedSeconds && seconds % 10 === 0) {
      reportedSeconds = seconds;
      console.log(`[audio] ~${seconds}s sent`);
    }
  }

  await ffmpeg.exited;
  if (stopTimer) {
    clearTimeout(stopTimer);
  }
  logger.info(`[audio] ffmpeg finished, ~${Math.round(sentBytes / BYTES_PER_SECOND)}s total`);

  await Bun.sleep(5000);
  session.close();
  await receiveTask;
  logger.info("[gemini] session closed, test done");
}

main().catch((err) => {
  console.error("[error]", err);
  process.exit(1);
});
