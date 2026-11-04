import type { TrackerHit } from "./types";

const WORD_CLASS = "\\p{L}\\p{N}_";
const DEFAULT_DEDUPE_WINDOW_SEC = 30;
const MIN_OVERLAP_WORDS = 2;
const MIN_OVERLAP_CHARS = 8;
const MAX_SEEN_ENTRIES = 500;
const KEEP_CHARS = 2000;

interface CompiledPattern {
  alias: string;
  text: string;
  len: number;
  regex: RegExp;
}

interface MatchRange {
  start: number;
  end: number;
}

export interface TrackerMatcherOptions {
  dedupeWindowSec?: number;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isWordChar(char: string): boolean {
  return /[\p{L}\p{N}_]/u.test(char);
}

function compilePattern(alias: string, raw: string): CompiledPattern | null {
  const text = raw.toLowerCase().trim();
  if (!text) {
    return null;
  }

  const prefix = isWordChar(text.charAt(0)) ? `(?<![${WORD_CLASS}])` : "";
  const suffix = isWordChar(text.charAt(text.length - 1)) ? `(?![${WORD_CLASS}])` : "";

  return { alias, text, len: text.length, regex: new RegExp(prefix + escapeRegExp(text) + suffix, "gu") };
}

/**
 * Ищет в транскрибации литеральные вхождения паттернов алиасов.
 *
 * Правила сравнения:
 * - единственная нормализация — приведение к нижнему регистру;
 * - паттерн матчится только целиком и буквально: "джи джи сел" не совпадёт с "джи.джи.сел";
 * - перед паттерном и после него допустимы пробелы и пунктуация, но внутри слова паттерн
 *   не должен склеиваться с буквами/цифрами ("ggseltron" не совпадёт с "ggsel").
 *
 * Повтор того же совпадения в пределах окна дедупа схлопывается в первый таймкод,
 * но событие всё равно возвращается — так попадает в счётчик и в вид "(N)".
 */
export class TrackerMatcher {
  private patterns: CompiledPattern[] = [];
  private maxLen = 0;
  private buffer = "";
  private base = 0;
  private boundaries: { offset: number; timeSec: number }[] = [];
  private scanned = 0;
  private readonly accepted = new Map<string, MatchRange[]>();
  private readonly seen = new Map<string, number>();
  private readonly dedupeWindowSec: number;

  constructor(aliases: Record<string, string[]>, options: TrackerMatcherOptions = {}) {
    this.dedupeWindowSec = options.dedupeWindowSec ?? DEFAULT_DEDUPE_WINDOW_SEC;
    this.setAliases(aliases);
  }

  setAliases(aliases: Record<string, string[]>): void {
    const patterns: CompiledPattern[] = [];

    for (const [alias, list] of Object.entries(aliases)) {
      for (const raw of list ?? []) {
        const compiled = compilePattern(alias, String(raw));
        if (compiled) {
          patterns.push(compiled);
        }
      }
    }

    this.patterns = patterns;
    this.maxLen = patterns.reduce((max, pattern) => Math.max(max, pattern.len), 0);
  }

  push(chunk: { text: string; timeSec: number }): TrackerHit[] {
    const text = chunk.text.toLowerCase();
    const fresh = this.mergeOverlap(text);
    if (!fresh) {
      return [];
    }

    const separator = this.buffer && !/\s$/.test(this.buffer) ? " " : "";
    const offset = this.base + this.buffer.length + separator.length;
    this.buffer += separator + fresh;
    this.boundaries.push({ offset, timeSec: chunk.timeSec });

    const hits = this.scan();
    this.trim();
    return hits;
  }

  private mergeOverlap(text: string): string | null {
    if (!this.buffer) {
      return text;
    }

    const bufferWords = this.buffer.split(/\s+/).filter(Boolean);
    const newWords = text.split(/\s+/).filter(Boolean);
    if (newWords.length < MIN_OVERLAP_WORDS) {
      return text;
    }

    let overlap = 0;
    for (let k = Math.min(bufferWords.length, newWords.length); k >= MIN_OVERLAP_WORDS; k--) {
      const tail = bufferWords.slice(bufferWords.length - k).join(" ");
      if (tail === newWords.slice(0, k).join(" ")) {
        overlap = k;
        break;
      }
    }

    if (!overlap) {
      return text;
    }

    const overlapText = newWords.slice(0, overlap).join(" ");
    if (overlapText.length < MIN_OVERLAP_CHARS) {
      return text;
    }

    const wordRegex = /\S+/g;
    let count = 0;
    let cut = 0;
    let match: RegExpExecArray | null;
    while ((match = wordRegex.exec(text))) {
      count++;
      if (count > overlap) {
        break;
      }
      cut = match.index + match[0].length;
    }

    return text.slice(cut).replace(/^\s+/, "") || null;
  }

  private scan(): TrackerHit[] {
    const bufferEnd = this.base + this.buffer.length;
    if (!this.patterns.length) {
      this.scanned = bufferEnd;
      return [];
    }

    const from = Math.max(this.base, this.scanned - this.maxLen + 1);
    const found: { alias: string; text: string; start: number; end: number }[] = [];

    for (const pattern of this.patterns) {
      const start = Math.max(this.base, this.scanned - pattern.len + 1);
      pattern.regex.lastIndex = start - this.base;
      let match: RegExpExecArray | null;
      while ((match = pattern.regex.exec(this.buffer))) {
        if (match[0].length === 0) {
          pattern.regex.lastIndex++;
          continue;
        }
        found.push({
          alias: pattern.alias,
          text: match[0],
          start: this.base + match.index,
          end: this.base + match.index + match[0].length,
        });
      }
    }

    this.scanned = bufferEnd;

    const byAlias = new Map<string, typeof found>();
    for (const item of found) {
      const list = byAlias.get(item.alias);
      if (list) {
        list.push(item);
      } else {
        byAlias.set(item.alias, [item]);
      }
    }

    const now = this.boundaries[this.boundaries.length - 1]?.timeSec ?? 0;
    const hits: TrackerHit[] = [];

    for (const [alias, list] of byAlias) {
      list.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
      const ranges = (this.accepted.get(alias) ?? []).filter((r) => r.end > from);

      for (const item of list) {
        if (ranges.some((r) => item.start < r.end && item.end > r.start)) {
          continue;
        }

        const timeSec = this.timeAt(item.start);
        const key = `${alias}\u0000${item.text}`;
        const previous = this.seen.get(key);
        if (previous !== undefined && Math.abs(timeSec - previous) <= this.dedupeWindowSec) {
          ranges.push({ start: item.start, end: item.end });
          hits.push({ alias, text: item.text, timeSec: previous });
          continue;
        }

        ranges.push({ start: item.start, end: item.end });
        this.seen.set(key, timeSec);
        hits.push({ alias, text: item.text, timeSec });
      }

      this.accepted.set(alias, ranges);
    }

    if (this.seen.size > MAX_SEEN_ENTRIES) {
      for (const [key, timeSec] of this.seen) {
        if (now - timeSec > this.dedupeWindowSec) {
          this.seen.delete(key);
        }
      }
    }

    return hits;
  }

  /**
   * Отрезает старый хвост буфера, чтобы память и стоимость разбора не росли с длиной сессии.
   * Смещения в accepted и boundaries абсолютные, поэтому при обрезке их не нужно сдвигать.
   */
  private trim(): void {
    const keep = Math.max(KEEP_CHARS, this.maxLen * 2);
    if (this.buffer.length <= keep * 2) {
      return;
    }

    const cut = this.wordStartBefore(this.buffer.length - keep);
    if (cut <= 0) {
      return;
    }

    this.buffer = this.buffer.slice(cut);
    this.base += cut;

    let firstKept = this.boundaries.findIndex((b) => b.offset >= this.base);
    if (firstKept === -1) {
      firstKept = this.boundaries.length;
    }
    this.boundaries = this.boundaries.slice(Math.max(0, firstKept - 1));

    for (const [alias, ranges] of this.accepted) {
      this.accepted.set(
        alias,
        ranges.filter((r) => r.end > this.base),
      );
    }
  }

  private wordStartBefore(limit: number): number {
    for (let i = limit; i >= 0; i--) {
      const code = this.buffer.charCodeAt(i);
      if (code === 32 || code === 9 || code === 10 || code === 13) {
        return i + 1;
      }
    }
    return 0;
  }

  private timeAt(offset: number): number {
    let timeSec = 0;
    for (const boundary of this.boundaries) {
      if (boundary.offset > offset) {
        break;
      }
      timeSec = boundary.timeSec;
    }
    return timeSec;
  }
}
