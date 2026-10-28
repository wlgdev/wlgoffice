import { Gemini, Groq, type GroqTranscriptionModel, LlmApiError } from "@shevernitskiy/llm";

import config from "./config";
import logger from "./logger";

// ─── Types ───────────────────────────────────────────────────

export type SttModel = GroqTranscriptionModel;

export const PRIMARY_STT_MODEL: SttModel = "whisper-large-v3";
export const FALLBACK_STT_MODEL: SttModel = "whisper-large-v3-turbo";

export const POLISH_MODEL = "gemini-3.5-flash-lite";

/** Groq free tier: ASH 7.2K сек/час, ASD 28.8K сек/сут на каждую модель отдельно. */
export const GROQ_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_TRANSCRIPT_SECONDS = 20 * 60;

/**
 * Whisper укладывается в real-time с большим запасом, поэтому таймаут задаём от длины
 * аудио: загрузка файла пропорциональна длительности и на длинном фрагменте
 * 300-секундного потолка не хватает.
 */
const STT_TIMEOUT_MARGIN_SEC = 10;
const POLISH_TIMEOUT_MS = 120_000;
const POLISH_RETRY_DELAY_MS = 2000;

const TRANSCRIBE_LANGUAGE = "ru";

/**
 * Подсказка Whisper (лимит 224 токена) задаёт стиль и подсказывает написание имён.
 * Стоит вписать имена ведущих и названия игр канала — это заметно поднимает точность
 * транскрипции имён собственных.
 */
const TRANSCRIBE_PROMPT = "Разговорный русский стрим про игры и технику.";

export interface SttResult {
  text: string;
  model: SttModel;
  /** Почему ушли с основной модели, если ушли. */
  fallbackReason?: string;
}

export interface PolishResult {
  text: string;
  polished: boolean;
  /** Почему текст остался сырым. */
  failureReason?: string;
}

/** Лимит Groq исчерпан и ни одна из моделей не справилась. */
export class RateLimitError extends Error {
  constructor(
    readonly retryAfterSec: number | null,
    readonly detail: string,
  ) {
    super(detail);
    this.name = "RateLimitError";
  }
}

/** Аудио не содержит распознаваемой речи. */
export class EmptyTranscriptError extends Error {
  constructor() {
    super("В этом фрагменте не распознано речи");
    this.name = "EmptyTranscriptError";
  }
}

// ─── Helpers ─────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireApiKey(apiKey: string | undefined, envName: string): string {
  if (!apiKey) {
    throw new Error(`${envName} не задан — расшифровка речи недоступна`);
  }
  return apiKey;
}

/**
 * Groq отдаёт retry-after только на 429; в теле ошибки дублирует его человекочитаемо.
 * Возвращает null, если восстановить время сброса не удалось.
 */
function parseRetryAfter(err: LlmApiError): number | null {
  const fromHeader = Number(err.headers["retry-after"] ?? err.headers["Retry-After"]);
  if (Number.isFinite(fromHeader) && fromHeader >= 0) return fromHeader;

  const fromBody = err.message.match(/try again in\s+([\d.]+)\s*s/i);
  if (fromBody?.[1]) {
    const seconds = Number(fromBody[1]);
    if (Number.isFinite(seconds)) return seconds;
  }
  return null;
}

/**
 * На тишине и музыке Groq отдаёт 200 с пустым text, и transcribe() сам падает
 * с LlmApiError (status 200, "empty response"). Это не сбой, а пустой результат —
 * переводим в собственный тип, чтобы хендлер показал понятный статус.
 */
function isEmptyTranscript(err: unknown): boolean {
  return err instanceof LlmApiError && err.status === 200 && /empty response/i.test(err.message);
}

/** Короткое человекочитаемое описание сбоя для статуса в чате. */
function describeFailure(err: unknown): string {
  if (err instanceof LlmApiError) {
    // status 2xx у Groq/Gemini означает не API-ошибку, а пустой результат
    if (err.status >= 200 && err.status < 300) return "пустой ответ модели";
    return `HTTP ${err.status}`;
  }
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") return "таймаут запроса";
    return err.message.slice(0, 120) || err.name;
  }
  return String(err).slice(0, 120);
}

export function formatRetryAfter(seconds: number | null): string {
  if (seconds === null) return "неизвестно";
  if (seconds < 90) return `через ${Math.ceil(seconds)}с`;
  return `через ~${Math.round(seconds / 60)} мин`;
}

// ─── Groq: Speech-to-Text ────────────────────────────────────

/**
 * Распознаёт речь через Groq. Основная модель — Whisper Large V3; если на неё
 * пришёл 429 (исчерпан лимит аудио-секунд), один раз переключаемся на turbo —
 * у него отдельный счётчик ASH/ASD. На остальные ошибки переключения нет.
 */
export async function transcribeAudio(file: Blob, durationSec: number, preferTurbo = false): Promise<SttResult> {
  const groq = new Groq(requireApiKey(config.groq.apiKey, "GROQ_APIKEY"));
  const timeoutMs = Math.round((durationSec + STT_TIMEOUT_MARGIN_SEC) * 1000);

  const models: SttModel[] = preferTurbo
    ? [FALLBACK_STT_MODEL, PRIMARY_STT_MODEL]
    : [PRIMARY_STT_MODEL, FALLBACK_STT_MODEL];

  let fallbackReason: string | undefined;

  for (let i = 0; i < models.length; i++) {
    const model = models[i]!;
    const isLast = i === models.length - 1;

    let raw: string;
    try {
      raw = (
        await groq.transcribe(file, model, {
          timeout: timeoutMs,
          responseFormat: "json",
          language: TRANSCRIBE_LANGUAGE,
          prompt: TRANSCRIBE_PROMPT,
        })
      ).trim();
    } catch (err) {
      if (isEmptyTranscript(err)) throw new EmptyTranscriptError();

      if (err instanceof LlmApiError && err.status === 429) {
        const retryAfterSec = parseRetryAfter(err);

        if (isLast) {
          throw new RateLimitError(
            retryAfterSec,
            `лимит Groq исчерпан (${model}, HTTP 429, повтор ${formatRetryAfter(retryAfterSec)})`,
          );
        }

        fallbackReason = `лимит ${model} исчерпан (HTTP 429, повтор ${formatRetryAfter(retryAfterSec)})`;
        logger.warn(`[Groq] ${fallbackReason} — переключаюсь на ${models[i + 1]}`);
        continue;
      }

      throw new Error(`Groq ${model}: ${describeFailure(err)}`);
    }

    if (!raw) throw new EmptyTranscriptError();
    return { text: raw, model, fallbackReason };
  }

  throw new Error("Groq: не удалось распознать речь");
}

// ─── Gemini: причёсывание текста ─────────────────────────────

const POLISH_PROMPT = `Далее будет текст - расшифровка после STT модели. Текст может быть отрывистым и
с неправильно сложенными предложениями и пунктуацией. Могут быть даже ошибки.
Твоя задача максимально точно всё сохранить, и мысли и слова, только сделать
этот текст пригодный для чтения. Можно убирать слова паразиты или чутка
перескладывать предложения, чтобы текст стал более печатным. Отвечай только отредактированным текстом.`;

/**
 * Приводит сырую расшифровку к читаемому виду. Ровно один ретрай: Groq уже
 * потратил аудио-секунды, терять результат из-за недоступности Gemini жалко —
 * при неудаче отдаём исходный текст, помечая его как сырой.
 */
export async function polishTranscript(raw: string): Promise<PolishResult> {
  const gemini = new Gemini(requireApiKey(config.gemini.apiKey, "GEMINI_APIKEY"));

  const prompt = `${POLISH_PROMPT}\n\n<text>\n${raw}\n</text>`;
  let failureReason: string | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const polished = await gemini.request(prompt, POLISH_MODEL, {
        thinkingLevel: "low",
        timeout: POLISH_TIMEOUT_MS,
        proxy: config.proxy,
      });

      const trimmed = polished.trim();
      if (trimmed) return { text: trimmed, polished: true };

      failureReason = "пустой ответ";
    } catch (err) {
      failureReason = describeFailure(err);
      logger.warn(`[Gemini] причёсывание не удалось (попытка ${attempt + 1}): ${failureReason}`);
    }

    if (attempt === 0) await sleep(POLISH_RETRY_DELAY_MS);
  }

  return { text: raw, polished: false, failureReason };
}
