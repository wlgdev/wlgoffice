/**
 * Курсор по аудиодорожке для live-транскрипции.
 *
 * Gemini Live не отдаёт таймкоды, поэтому начало очередного куска текста оценивается по позиции
 * аудио на момент доставки предыдущего куска, с поправкой на задержку Gemini.
 *
 * - Начало куска = конец предыдущего (курсор), но не раньше, чем lookback до момента доставки:
 *   после долгой паузы метка не уезжает на десятки секунд назад.
 * - lookback ограничен сверху maxSpanSec и, если включено minCharsPerSec, длиной текста:
 *   три слова после паузы не могут занимать 10 секунд. Это потолок, а не оценка скорости речи.
 * - Если за раз пришло несколько кусков, доступный отрезок делится между ними пропорционально
 *   длине текста, а не отдаётся всем одной меткой.
 * - Метки не уходят назад: курсор только растёт.
 */

const DEFAULT_LATENCY_SEC = 1.0;
const DEFAULT_MAX_SPAN_SEC = 20;
/** Минимальный запас назад для очень короткого текста, сек. */
const MIN_LOOKBACK_SEC = 2;

export interface ChunkSpan {
  startSec: number;
  endSec: number;
}

export interface ChunkClockOptions {
  /** Задержка между речью и приходом её транскрипции от Gemini, сек. */
  latencySec?: number;
  /** Максимальная длина отрезка аудио, который может покрывать одна доставка, сек. */
  maxSpanSec?: number;
  /**
   * Нижняя граница скорости речи для ограничения отката назад: текст из N символов не может
   * занимать больше N / minCharsPerSec секунд (но не меньше MIN_LOOKBACK_SEC).
   * 0 или не задано: ограничение по длине текста выключено.
   */
  minCharsPerSec?: number;
}

export class ChunkClock {
  private cursorSec: number;
  private readonly latencySec: number;
  private readonly maxSpanSec: number;
  private readonly minCharsPerSec: number;

  constructor(startSec: number, options: ChunkClockOptions = {}) {
    this.cursorSec = startSec;
    this.latencySec = options.latencySec ?? DEFAULT_LATENCY_SEC;
    this.maxSpanSec = options.maxSpanSec ?? DEFAULT_MAX_SPAN_SEC;
    this.minCharsPerSec = options.minCharsPerSec ?? 0;
  }

  get cursor(): number {
    return this.cursorSec;
  }

  /**
   * Раскладывает пачку кусков текста, пришедших одновременно, по таймлинии стрима.
   * @param texts     тексты кусков в порядке получения
   * @param audioSec  позиция последнего отправленного аудио (время стрима) на момент получения
   */
  assign(texts: string[], audioSec: number): ChunkSpan[] {
    const weights = texts.map((t) => Math.max(1, t.length));
    const total = weights.reduce((a, b) => a + b, 0);

    const textCapSec =
      this.minCharsPerSec > 0 ? Math.max(MIN_LOOKBACK_SEC, total / this.minCharsPerSec) : Number.POSITIVE_INFINITY;
    const lookbackSec = Math.min(this.maxSpanSec, textCapSec);

    const anchorSec = audioSec - this.latencySec;
    const startSec = Math.max(this.cursorSec, anchorSec - lookbackSec);
    const spanSec = Math.max(0, anchorSec - startSec);

    let acc = 0;
    const spans = weights.map((w) => {
      const s0 = startSec + (spanSec * acc) / total;
      acc += w;
      const s1 = startSec + (spanSec * acc) / total;
      return { startSec: s0, endSec: s1 };
    });

    this.cursorSec = Math.max(this.cursorSec, anchorSec);
    return spans;
  }
}
