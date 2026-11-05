import type { StreamVariant } from "../core/types";

export interface TrackerChannelSettings {
  enabled: boolean;
  chatId?: number | string;
  threadId?: number;
  aliases: Record<string, string[]>;
}

export interface TrackerSettings {
  channels: Record<string, TrackerChannelSettings>;
}

export interface TrackerHit {
  alias: string;
  text: string;
  timeSec: number;
}

export type TrackerSessionStatus = "active" | "closed";

export interface TrackerSessionState {
  channel: string;
  broadcastId: string;
  chatId: number | string;
  threadId?: number;
  messageId?: number;
  vodId?: string;
  vodTitle?: string;
  hits: TrackerHit[];
  counts: Record<string, number>;
  sentBytes: number;
  receivedChars: number;
  startedAt: number;
  startTimeMs?: number;
  updatedAt: number;
  status: TrackerSessionStatus;
}

export interface TrackerStreamInfo {
  online: boolean;
  id: string;
  title: string;
  start_time: number;
}

export interface TrackerVodInfo {
  vodId: string;
  title: string;
}

export interface TrackerTranscriberChunk {
  text: string;
  timeSec: number;
}

export interface TrackerTranscriberOptions {
  hlsUrl: string;
  geminiApiKey: string;
  systemInstruction?: string;
  streamStartEpochMs?: number;
  staleTimeoutMs?: number;
  onAudioSent?: (bytes: number) => void;
}

export interface TrackerTranscriber {
  start(): Promise<void>;
  stop(): void;
  onText(handler: (chunk: TrackerTranscriberChunk) => void): () => void;
}

export type TrackerTranscriberFactory = (options: TrackerTranscriberOptions) => TrackerTranscriber;

export interface TwitchTrackerPort {
  streamInfo(channel: string): Promise<TrackerStreamInfo>;
  liveVariants(channel: string): Promise<StreamVariant[]>;
  findLiveVod(channel: string, broadcastId: string): Promise<TrackerVodInfo | null>;
}
