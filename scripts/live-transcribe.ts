import { Twitch } from "@shevernitskiy/scraperator";

import config from "../src/config";
import { fromTwitchVariant, isAudioOnlyVariant, pickVariant } from "../src/hls";
import { LiveTranscriber } from "../src/live-transcriber";
import logger from "../src/logger";
import { timeStringFromTs } from "../src/utils";

const args = process.argv.slice(2);
const channel = args.find((a) => !a.startsWith("--")) ?? "welovegames";

const durationSecStr = args.find((a) => a.startsWith("--duration="))?.split("=")[1];
const durationSec = durationSecStr ? Number(durationSecStr) : undefined;

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

  const transcriber = new LiveTranscriber({
    hlsUrl: audioVariant.url,
    geminiApiKey: config.gemini.apiKey!,
    durationSec,
    streamStartEpochMs: info.start_time,
  });
  transcriber.onText(({ text, timeSec }) => console.log(`[${timeStringFromTs(timeSec * 1000)}]`, text));

  await transcriber.start();
  logger.info("test done");
}

main().catch((err) => {
  console.error("[error]", err);
  process.exit(1);
});
