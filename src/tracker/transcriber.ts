import { LiveTranscriber } from "../services/live-transcriber";
import type { TrackerTranscriberFactory } from "./types";

/**
 * Адаптер существующего LiveTranscriber под интерфейс трекера.
 * Каждая сессия получает собственный экземпляр, поэтому несколько независимых
 * обработчиков транскрибации могут работать параллельно.
 */
export function createLiveTranscriberFactory(): TrackerTranscriberFactory {
  return (options) => {
    const transcriber = new LiveTranscriber(options);
    return {
      start: () => transcriber.start(),
      stop: () => transcriber.stop(),
      onText: (handler) => transcriber.onText(handler),
    };
  };
}
