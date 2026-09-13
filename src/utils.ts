export interface ParsedTimeRange {
  startSeconds: number;
  endSeconds: number;
  rawStart: string;
  rawEnd: string;
}

/**
 * Конвертирует строку времени вида "ЧЧ:ММ:СС", "ММ:СС" или "СС" в секунды.
 * Возвращает null, если формат некорректен.
 */
export function timeToSeconds(timeStr: string): number | null {
  const parts = timeStr.split(":");
  const numbers: number[] = [];

  for (const part of parts) {
    // Проверяем, что часть состоит только из цифр
    if (!/^\d+$/.test(part)) {
      return null;
    }
    const num = Number(part);
    if (!Number.isFinite(num) || num < 0) {
      return null;
    }
    numbers.push(num);
  }

  // ЧЧ:ММ:СС
  if (numbers.length === 3) {
    const h = numbers[0];
    const m = numbers[1];
    const s = numbers[2];

    if (h === undefined || m === undefined || s === undefined) {
      return null;
    }
    if (m > 59 || s > 59) {
      return null;
    }

    return h * 3600 + m * 60 + s;
  }

  // ММ:СС
  if (numbers.length === 2) {
    const m = numbers[0];
    const s = numbers[1];

    if (m === undefined || s === undefined) {
      return null;
    }
    if (s > 59) {
      return null;
    }

    return m * 60 + s;
  }

  // СС
  if (numbers.length === 1) {
    const s = numbers[0];

    if (s === undefined) {
      return null;
    }

    return s;
  }

  return null;
}

/**
 * Парсит временные диапазоны из текста
 * @param text Исходное сообщение
 * @returns Массив найденных интервалов с переводом в секунды
 */
export function parseTimeRanges(text: string): ParsedTimeRange[] {
  const timeRangeRegex = /\b(\d{1,2}(?::\d{1,2}){0,2})\s*[-‐‑‒–—―−~]\s*(\d{1,2}(?::\d{1,2}){0,2})\b/g;

  const results: ParsedTimeRange[] = [];
  let match: RegExpExecArray | null;

  while ((match = timeRangeRegex.exec(text)) !== null) {
    const rawStart = match[1];
    const rawEnd = match[2];

    // Защита от undefined из regex-групп для strict TypeScript
    if (rawStart === undefined || rawEnd === undefined) {
      continue;
    }

    const startSeconds = timeToSeconds(rawStart);
    const endSeconds = timeToSeconds(rawEnd);

    if (startSeconds !== null && endSeconds !== null) {
      results.push({
        startSeconds,
        endSeconds,
        rawStart,
        rawEnd,
      });
    }
  }

  return results;
}

/**
 * Извлекает первый найденный Twitch VOD ID из текста.
 * Поддерживает: http(s), www, мобильную версию m.twitch.tv или ссылку без протокола.
 *
 * @param text Исходный текст со ссылкой
 * @returns ID видео в виде строки или null, если ссылка не найдена
 */
export function parseVodId(text: string): string | null {
  const vodRegex = /(?:https?:\/\/)?(?:www\.|m\.)?twitch\.tv\/videos\/(\d+)/i;
  const match = vodRegex.exec(text);

  if (!match) {
    return null;
  }

  const vodId = match[1];
  return vodId !== undefined ? vodId : null;
}

/**
 * Извлекает ВСЕ Twitch VOD ID из текста (если в сообщении несколько ссылок)
 *
 * @param text Исходный текст
 * @returns Массив найденных VOD ID
 */
export function parseAllVodIds(text: string): string[] {
  const vodRegex = /(?:https?:\/\/)?(?:www\.|m\.)?twitch\.tv\/videos\/(\d+)/gi;
  const ids: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = vodRegex.exec(text)) !== null) {
    const vodId = match[1];
    if (vodId !== undefined) {
      ids.push(vodId);
    }
  }

  return ids;
}

export interface ParsedVodMessage {
  vodId: string | null;
  ranges: ParsedTimeRange[];
  qualities: string[];
}

/**
 * Извлекает запрошенные качества из текста (паттерн "<цифры>p": 720p, 1080p).
 * Возвращает нормализованные (lowercase) значения в порядке появления, без дублей.
 */
export function parseQualities(text: string): string[] {
  const qualityRegex = /\b(\d+p)\b/gi;
  const result: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = qualityRegex.exec(text)) !== null) {
    const raw = match[1];
    if (raw === undefined) {
      continue;
    }
    const normalized = raw.toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }

  return result;
}

export function parseVodMessage(text: string): ParsedVodMessage {
  return {
    vodId: parseVodId(text),
    ranges: parseTimeRanges(text),
    qualities: parseQualities(text),
  };
}
