/**
 * Курсор по аудиодорожке для live-транскрипции.
 *
 * Gemini Live не отдаёт таймкоды, поэтому начало очередного куска текста оценивается
 * по позиции аудио на момент предыдущей доставки текста: начало куска — это место,
 * где закончилось предыдущее аудио, а не текущий момент. Иначе метка отставала бы
 * на длину куска плюс задержку доставки.
 */
export class ChunkClock {
  private cursorSec: number;

  constructor(startSec: number) {
    this.cursorSec = startSec;
  }

  get cursor(): number {
    return this.cursorSec;
  }

  /**
   * Возвращает начало аудио очередного куска и переводит курсор на текущую позицию.
   */
  take(nowSec: number): number {
    const startSec = this.cursorSec;
    this.cursorSec = Math.max(this.cursorSec, nowSec);
    return startSec;
  }
}
