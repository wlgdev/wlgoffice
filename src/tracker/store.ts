import type { DB } from "../services/db";
import { normalizeTrackerSettings, TRACKER_SETTINGS_KEY } from "./settings";
import type { TrackerSessionState, TrackerSettings } from "./types";

const SESSION_KEY_PREFIX = "tracker:session:";

export class TrackerStore {
  constructor(private readonly db: DB) {}

  getSettings(): TrackerSettings {
    return normalizeTrackerSettings(this.db.getJson(TRACKER_SETTINGS_KEY));
  }

  saveSettings(settings: TrackerSettings): void {
    this.db.setJson(TRACKER_SETTINGS_KEY, settings);
  }

  getSession(channel: string): TrackerSessionState | null {
    const state = this.db.getJson<TrackerSessionState>(SESSION_KEY_PREFIX + channel.toLowerCase());
    if (!state || typeof state !== "object" || typeof state.channel !== "string") {
      return null;
    }
    return { ...state, hits: state.hits ?? [], counts: state.counts ?? {} };
  }

  saveSession(state: TrackerSessionState): void {
    this.db.setJson(SESSION_KEY_PREFIX + state.channel.toLowerCase(), state);
  }

  removeSession(channel: string): void {
    this.db.delete(SESSION_KEY_PREFIX + channel.toLowerCase());
  }

  listSessionChannels(): string[] {
    return this.db.keys(SESSION_KEY_PREFIX).map((key) => key.slice(SESSION_KEY_PREFIX.length));
  }
}
