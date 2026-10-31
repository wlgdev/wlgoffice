export type VodMode = "video" | "audio" | "transcript";
export type VodPlatform = "twitch" | "vk";
export type AudioPick = "none" | "best" | "cheapest";

export interface ParsedTimeRange {
  startSeconds: number;
  endSeconds: number;
  rawStart: string;
  rawEnd: string;
}

export interface ParsedVodMessage {
  platform: VodPlatform | null;
  vodId: string | null;
  vodUrl: string | null;
  channel: string | null;
  ranges: ParsedTimeRange[];
  qualities: string[];
}

export interface InteropPayload {
  from: string;
  to: number | null;
  username: string | null;
  channel: string | null;
}

export interface StreamVariant {
  bandwidth: number;
  resolution: string;
  video: string;
  framerate: string;
  codecs: string;
  url: string;
}

export interface VariantInfo {
  quality: string;
  resolution: string;
  width: number;
  height: number;
  framerate: number;
  bandwidth: number;
  bandwidthMbps: number;
  codecs: string;
  videoCodec?: string;
  audioCodec?: string;
  url: string;
}

export interface MuteStats {
  totalSegments: number;
  mutedFound: number;
  unmutedSuccess: number;
  remainedMuted: number;
}
