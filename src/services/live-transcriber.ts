import { GeminiLive, type GeminiLiveSession } from "@shevernitskiy/llm";

import logger from "../logger";
import { ChunkClock } from "./chunk-clock";
import { resolveFfmpegBinary } from "./ffmpeg";

const BYTES_PER_SECOND = 16000 * 2;
const CHUNK_BYTES = BYTES_PER_SECOND / 5;
const CHUNK_MS = (CHUNK_BYTES / BYTES_PER_SECOND) * 1000;
const FLUSH_MS = 3000;
/** Куски текста, пришедшие в пределах этого окна, считаются одной пачкой. */
const BATCH_MS = 60;
const PLAYLIST_TIMEOUT_MS = 10000;
/** С какого сегмента live HLS начинает ffmpeg (отрицательное значение считается от конца). */
const LIVE_START_INDEX = -3;
/** Как часто перечитывать плейлист для контроля дрейфа. */
const WINDOW_POLL_MS = 30000;
/** Допустимое расхождение таймлинии аудио с окном плейлиста, сек. */
const DRIFT_TOLERANCE_SEC = 8;
/**
 * Сколько после старта pumpAudio не проверять дрейф: ffmpeg поднимается (в логах до ~18 с)
 * и догоняет край плейлиста, и в это время позиция законно отстаёт от окна.
 */
const DRIFT_GRACE_MS = 30000;
/**
 * При пропуске сегментов позицию переносим на начало окна плейлиста минус этот запас, сек.
 * ffmpeg после пропуска продолжает с самого старого сегмента окна; запас покрывает ошибку
 * экстраполяции окна и задержку обнаружения, чтобы метки не оказались позже реального аудио.
 */
const RESYNC_BACK_SEC = 2;
/**
 * Если позиция отстала от окна больше, чем на это, то это уже не пропуск нескольких сегментов,
 * а разрыв таймлинии: мягко не чиним, бросаем ошибку и перезапускаем транскрибер.
 */
const MAX_RESYNC_SEC = 60;
/**
 * Серия мягких переносов подряд означает не случайный пропуск, а то, что ffmpeg не успевает за
 * стримом (сеть, CDN): мягко такое не лечится, нужен рестарт ffmpeg и сессии Gemini.
 * Столько переносов за окно (включая текущий) приводят к ошибке.
 */
const RESYNC_STORM_LIMIT = 3;
const RESYNC_STORM_WINDOW_MS = 120000;
/** Если от ffmpeg не приходило аудио столько, он считается зависшим: ошибка и рестарт. */
const NO_AUDIO_TIMEOUT_MS = 30000;
/** При догоне (после лагов скачивания) отправлять аудио не быстрее этого множителя реального времени. */
const MAX_CATCHUP_SPEED = 2;

export interface LiveTranscriptionChunk {
  text: string;
  /** Начало куска, сек от начала стрима. */
  timeSec: number;
  endSec: number;
}

export interface LiveTranscriberOptions {
  hlsUrl: string;
  geminiApiKey: string;
  systemInstruction?: string;
  durationSec?: number;
  streamStartEpochMs?: number;
  staleTimeoutMs?: number;
  /** Задержка Gemini между речью и приходом текста, сек (по умолчанию 1.0). */
  latencySec?: number;
  /** Максимальный «откат назад» начала куска после паузы, сек (по умолчанию 10). */
  maxSpanSec?: number;
  /** Нижняя граница скорости речи для ограничения отката начала куска, симв/с (по умолчанию 5, 0 = выкл). */
  minCharsPerSec?: number;
  onAudioSent?: (bytes: number) => void;
}

export type TranscriptionHandler = (chunk: LiveTranscriptionChunk) => void;

interface PlaylistSegment {
  elapsedSec: number;
  durationSec: number;
}

/** Окно live-плейлиста в таймлинии стрима. */
interface StreamWindow {
  oldestSec: number;
  edgeSec: number;
  /** Date.now() на момент получения плейлиста. */
  fetchedAtMs: number;
}

/**
 * Разбирает media-плейлист Twitch. Тег #EXT-X-TWITCH-ELAPSED-SECS относится к ближайшему
 * следующему сегменту, время остальных считается накоплением длительностей (#EXTINF).
 * Для master-плейлиста (нет времён сегментов) возвращает пустой массив.
 */
function parsePlaylistSegments(text: string): PlaylistSegment[] {
  const segments: PlaylistSegment[] = [];
  let elapsed: number | undefined;
  let duration = 0;
  let prevEnd: number | undefined;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith("#EXT-X-TWITCH-ELAPSED-SECS:")) {
      elapsed = parseFloat(line.slice(line.indexOf(":") + 1));
    } else if (line.startsWith("#EXTINF:")) {
      duration = parseFloat(line.slice(line.indexOf(":") + 1));
    } else if (!line.startsWith("#")) {
      const start = elapsed ?? prevEnd;
      if (start === undefined || Number.isNaN(start)) return [];
      segments.push({ elapsedSec: start, durationSec: duration });
      prevEnd = start + duration;
      elapsed = undefined;
    }
  }
  return segments;
}

function toWindow(segments: PlaylistSegment[]): StreamWindow | undefined {
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (!first || !last) return undefined;
  return {
    oldestSec: first.elapsedSec,
    edgeSec: last.elapsedSec + last.durationSec,
    fetchedAtMs: Date.now(),
  };
}

export class LiveTranscriber {
  private options: LiveTranscriberOptions;
  private ffmpeg?: Bun.Subprocess<"ignore", "pipe", "inherit">;
  private session?: GeminiLiveSession;
  private timer?: ReturnType<typeof setTimeout>;
  private pollTimer?: ReturnType<typeof setInterval>;
  private window?: StreamWindow;
  /** Date.now(), раньше которого checkDrift ничего не проверяет (grace-период после старта). */
  private driftCheckAfterMs = 0;
  /** Моменты последних мягких переносов (для защиты от серии). */
  private resyncTimesMs: number[] = [];
  /** Причина аварийной остановки (ошибка Gemini и т.п.): start() обязан её пробросить для реконнекта. */
  private failure?: Error;
  /** Штатное закрытие сессии: окончание приёма в это время не ошибка. */
  private closing = false;
  private stopped = false;
  private sentBytes = 0;
  private offsetSec = 0;
  private textHandlers = new Set<TranscriptionHandler>();
  private clock = new ChunkClock(0);

  private batch: string[] = [];
  private batchAudioSec = 0;
  private batchTimer?: ReturnType<typeof setTimeout>;

  constructor(options: LiveTranscriberOptions) {
    this.options = options;
  }

  onText(handler: TranscriptionHandler): () => void {
    this.textHandlers.add(handler);
    return () => this.textHandlers.delete(handler);
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    clearTimeout(this.timer);
    this.ffmpeg?.kill();
  }

  async start(): Promise<void> {
    if (this.session || this.ffmpeg) {
      throw new Error("LiveTranscriber already started");
    }

    let session: GeminiLiveSession | undefined;
    try {
      session = await new GeminiLive(this.options.geminiApiKey).connect("gemini-3.5-transcribe-live", {
        inputTranscription: true,
        timeout: 30000,
        systemInstruction: this.options.systemInstruction,
        staleTimeout: this.options.staleTimeoutMs,
      });
      this.session = session;

      const receiveTask = this.receiveLoop(session);

      // Плейлист берём прямо перед запуском ffmpeg: окно плейлиста двигается только вперёд,
      // так что ffmpeg начнёт с того же или более позднего сегмента, чем мы посчитали.
      // Метки получатся не позже реального аудио, и слово окажется впереди ссылки.
      const snapshot = await this.fetchSegments();
      // Сессия могла закрыться, пока брали плейлист: ffmpeg запускать незачем.
      if (this.failure) throw this.failure;

      const ffmpeg = Bun.spawn(
        [
          resolveFfmpegBinary(),
          "-hide_banner",
          "-loglevel",
          "error",
          "-live_start_index",
          String(LIVE_START_INDEX),
          "-i",
          this.options.hlsUrl,
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
      this.ffmpeg = ffmpeg;

      this.offsetSec = this.resolveOffsetSec(snapshot);
      this.window = toWindow(snapshot);
      this.clock = new ChunkClock(this.offsetSec, {
        latencySec: this.options.latencySec,
        maxSpanSec: this.options.maxSpanSec,
        minCharsPerSec: this.options.minCharsPerSec ?? 5,
      });

      this.pollTimer = setInterval(() => void this.refreshWindow(), WINDOW_POLL_MS);

      if (this.options.durationSec) {
        this.timer = setTimeout(() => this.stop(), this.options.durationSec * 1000);
      }

      await this.pumpAudio(ffmpeg, session);

      // Остановка из-за сбоя (например, закрылась сессия Gemini) не должна выглядеть как штатное
      // завершение: иначе внешний код не перезапустит транскрибер.
      if (this.failure) throw this.failure;
      this.closing = true;

      const exitCode = await ffmpeg.exited;
      if (exitCode !== 0 && !this.stopped) {
        throw new Error(`ffmpeg exited with code ${exitCode}`);
      }

      await Bun.sleep(FLUSH_MS);
      session.close();
      await receiveTask;
    } catch (err) {
      this.stop();
      session?.close();
      throw err;
    } finally {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
      this.window = undefined;
      clearTimeout(this.batchTimer);
      this.batchTimer = undefined;
      this.batch = [];
      this.ffmpeg = undefined;
      this.session = undefined;
      this.stopped = false;
      this.closing = false;
      this.failure = undefined;
    }
  }

  private async fetchSegments(): Promise<PlaylistSegment[]> {
    try {
      const res = await fetch(this.options.hlsUrl, { signal: AbortSignal.timeout(PLAYLIST_TIMEOUT_MS) });
      if (!res.ok) return [];
      return parsePlaylistSegments(await res.text());
    } catch (err) {
      logger.warn("[LiveTranscriber] не удалось получить плейлист:", err);
      return [];
    }
  }

  private async refreshWindow(): Promise<void> {
    const win = toWindow(await this.fetchSegments());
    if (win && !this.stopped) {
      this.window = win;
    }
  }

  /**
   * Время стрима (сек) сегмента, с которого ffmpeg начнёт читать плейлист.
   */
  private resolveOffsetSec(segments: PlaylistSegment[]): number {
    if (segments.length > 0) {
      const n = segments.length;
      const idx = LIVE_START_INDEX < 0 ? Math.max(0, n + LIVE_START_INDEX) : Math.min(LIVE_START_INDEX, n - 1);
      const offset = segments[idx]!.elapsedSec;
      logger.info(`[LiveTranscriber] смещение по плейлисту: ${offset.toFixed(1)}s (сегмент ${idx}/${n})`);
      return offset;
    }

    logger.warn("[LiveTranscriber] не удалось получить тайминги из плейлиста");

    if (this.options.streamStartEpochMs) {
      const offset = (Date.now() - this.options.streamStartEpochMs) / 1000;
      logger.info(`[LiveTranscriber] смещение от начала стрима (fallback): ${offset.toFixed(1)}s`);
      return offset;
    }

    return 0;
  }

  /**
   * Следит за расхождением таймлинии аудио с живым плейлистом.
   *
   * - Первые DRIFT_GRACE_MS после старта не проверяется: ffmpeg ещё поднимается и догоняет.
   * - Если позиция отстала от окна (ffmpeg пропустил сегменты, потому что не успел за коротким
   *   окном плейлиста), то позиция мягко переносится вперёд на начало окна: ffmpeg после пропуска
   *   продолжает именно с него. Транскрибер и сессия Gemini при этом не перезапускаются.
   *   Если отставание больше MAX_RESYNC_SEC (разрыв таймлинии) или переносы идут серией
   *   (ffmpeg не успевает за стримом), бросается ошибка.
   * - Если позиция ушла за край плейлиста, таймлиния сломана (сброс счётчика, смена эфира):
   *   бросается ошибка, start() завершается, и внешний код перезапускает транскрибер
   *   с новым смещением.
   *
   * Окно плейлиста известно на момент последнего опроса, а живое окно с тех пор ушло вперёд
   * со скоростью реального времени, поэтому края сдвигаются на прошедшее время.
   */
  private checkDrift(): void {
    const win = this.window;
    if (!win || Date.now() < this.driftCheckAfterMs) return;

    const shiftSec = (Date.now() - win.fetchedAtMs) / 1000;
    const oldest = win.oldestSec + shiftSec;
    const edge = win.edgeSec + shiftSec;
    const pos = this.audioPosSec();

    if (pos + DRIFT_TOLERANCE_SEC < oldest) {
      const jumpSec = oldest - RESYNC_BACK_SEC - pos;
      if (jumpSec > MAX_RESYNC_SEC) {
        throw new Error(`HLS: пропуск сегментов (позиция ${pos.toFixed(1)}s, окно плейлиста с ${oldest.toFixed(1)}s)`);
      }

      const now = Date.now();
      this.resyncTimesMs = this.resyncTimesMs.filter((t) => now - t < RESYNC_STORM_WINDOW_MS);
      this.resyncTimesMs.push(now);
      if (this.resyncTimesMs.length >= RESYNC_STORM_LIMIT) {
        throw new Error(
          `HLS: ffmpeg не успевает за стримом (${this.resyncTimesMs.length} пропусков за ${RESYNC_STORM_WINDOW_MS / 1000}с)`,
        );
      }

      this.offsetSec += jumpSec;
      logger.warn(
        `[LiveTranscriber] HLS: пропуск сегментов, позиция ${pos.toFixed(1)}s -> ${this.audioPosSec().toFixed(1)}s ` +
          `(+${jumpSec.toFixed(1)}s, окно с ${oldest.toFixed(1)}s)`,
      );
      return;
    }
    if (pos - DRIFT_TOLERANCE_SEC > edge) {
      throw new Error(`HLS: рассинхрон таймлинии (позиция ${pos.toFixed(1)}s, край плейлиста ${edge.toFixed(1)}s)`);
    }
  }

  /**
   * Позиция последнего отправленного в Gemini аудио в таймлинии стрима.
   */
  private audioPosSec(): number {
    return this.offsetSec + this.sentBytes / BYTES_PER_SECOND;
  }

  private enqueueText(text: string): void {
    if (this.batch.length === 0) {
      this.batchAudioSec = this.audioPosSec();
      this.batchTimer = setTimeout(() => this.flushBatch(), BATCH_MS);
    }
    this.batch.push(text);
  }

  private flushBatch(): void {
    clearTimeout(this.batchTimer);
    this.batchTimer = undefined;
    if (this.batch.length === 0) {
      return;
    }

    const texts = this.batch;
    this.batch = [];
    const spans = this.clock.assign(texts, this.batchAudioSec);

    for (let i = 0; i < texts.length; i++) {
      const chunk: LiveTranscriptionChunk = {
        text: texts[i]!,
        timeSec: spans[i]!.startSec,
        endSec: spans[i]!.endSec,
      };
      for (const handler of this.textHandlers) {
        try {
          handler(chunk);
        } catch (err) {
          logger.warn("[LiveTranscriber] onText handler failed:", err);
        }
      }
    }
  }

  private async receiveLoop(session: GeminiLiveSession): Promise<void> {
    try {
      for await (const event of session.receive()) {
        if (event.type === "inputTranscription" && event.text.trim()) {
          this.enqueueText(event.text);
        }
      }
      // Приём закончился сам, а мы ничего не закрывали: сервер закрыл сессию, это сбой.
      this.fail(new Error("Gemini: сессия закрыта сервером"));
    } catch (err) {
      logger.warn("[LiveTranscriber] gemini receive failed:", err);
      this.fail(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.flushBatch();
    }
  }

  /**
   * Аварийная остановка: запоминает причину и гасит ffmpeg, а start() потом бросит эту ошибку.
   * Во время штатной остановки или закрытия ничего не делает.
   */
  private fail(err: Error): void {
    if (this.stopped || this.closing) return;
    this.failure = err;
    this.stop();
  }

  /** Ждёт чтение из ffmpeg не дольше таймаута: зависший ffmpeg (сеть, CDN) не должен подвешивать транскрибер навсегда. */
  private async readWithTimeout<T>(read: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`ffmpeg: нет аудио ${NO_AUDIO_TIMEOUT_MS / 1000}с`)),
        NO_AUDIO_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([read, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async pumpAudio(
    ffmpeg: Bun.Subprocess<"ignore", "pipe", "inherit">,
    session: GeminiLiveSession,
  ): Promise<void> {
    const reader = ffmpeg.stdout.getReader();
    let carry = new Uint8Array(0);
    const startedAt = Date.now();
    this.driftCheckAfterMs = startedAt + DRIFT_GRACE_MS;
    this.resyncTimesMs = [];
    let lastSentAt = 0;
    this.sentBytes = 0;

    try {
      while (true) {
        const { done, value } = await this.readWithTimeout(reader.read());
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
          this.checkDrift();

          const earliest = Math.max(
            startedAt + (this.sentBytes / BYTES_PER_SECOND) * 1000, // не раньше реального времени
            lastSentAt + CHUNK_MS / MAX_CATCHUP_SPEED, // и не быстрее MAX_CATCHUP_SPEED
          );
          const wait = earliest - Date.now();
          if (wait > 0) await Bun.sleep(wait);

          session.sendAudio(data.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES));
          lastSentAt = Date.now();
          this.sentBytes += CHUNK_BYTES;
          this.options.onAudioSent?.(CHUNK_BYTES);
        }
      }
    } catch (err) {
      if (!this.stopped) {
        throw err;
      }
    }
  }
}
