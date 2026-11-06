import { describe, expect, test } from "bun:test";

import { LiveTranscriber } from "../../src/services/live-transcriber";

const BYTES_PER_SECOND = 16000 * 2;

/** checkDrift приватный и завязан на поля класса, поэтому тесты ставят состояние напрямую. */
interface Internals {
  window?: { oldestSec: number; edgeSec: number; fetchedAtMs: number };
  driftCheckAfterMs: number;
  offsetSec: number;
  sentBytes: number;
  resyncTimesMs: number[];
  checkDrift(): void;
  audioPosSec(): number;
}

interface Setup {
  /** Позиция аудио (offsetSec), сек. */
  pos: number;
  /** Начало и край окна плейлиста на момент опроса, сек. */
  oldest: number;
  edge: number;
  /** Сколько мс назад был получен плейлист (по умолчанию только что). */
  fetchedAgoMs?: number;
  /** Сколько мс ещё длится grace-период (по умолчанию уже закончился). */
  graceLeftMs?: number;
  /** Уже отправлено аудио, сек (добавляется к позиции). */
  sentSec?: number;
  noWindow?: boolean;
}

function makeTranscriber(s: Setup): Internals {
  const t = new LiveTranscriber({
    hlsUrl: "http://localhost/test.m3u8",
    geminiApiKey: "test",
  }) as unknown as Internals;

  t.offsetSec = s.pos;
  t.sentBytes = (s.sentSec ?? 0) * BYTES_PER_SECOND;
  t.window = s.noWindow
    ? undefined
    : { oldestSec: s.oldest, edgeSec: s.edge, fetchedAtMs: Date.now() - (s.fetchedAgoMs ?? 0) };
  t.driftCheckAfterMs = Date.now() + (s.graceLeftMs ?? -1);
  return t;
}

describe("LiveTranscriber.checkDrift", () => {
  describe("без окна плейлиста", () => {
    test("ничего не делает", () => {
      const t = makeTranscriber({ pos: 100, oldest: 500, edge: 506, noWindow: true });
      expect(() => t.checkDrift()).not.toThrow();
      expect(t.audioPosSec()).toBe(100);
    });
  });

  describe("grace-период", () => {
    test("отставание игнорируется, позиция не двигается", () => {
      const t = makeTranscriber({ pos: 100, oldest: 150, edge: 156, graceLeftMs: 10_000 });
      expect(() => t.checkDrift()).not.toThrow();
      expect(t.audioPosSec()).toBe(100);
    });

    test("рассинхрон вперёд тоже игнорируется", () => {
      const t = makeTranscriber({ pos: 300, oldest: 150, edge: 156, graceLeftMs: 10_000 });
      expect(() => t.checkDrift()).not.toThrow();
    });

    test("после окончания проверка включается", () => {
      const t = makeTranscriber({ pos: 100, oldest: 150, edge: 156, graceLeftMs: -1 });
      t.checkDrift();
      expect(t.audioPosSec()).toBeCloseTo(148, 1);
    });
  });

  describe("мягкий перенос при пропуске сегментов", () => {
    test("отставание в пределах допуска не трогает позицию", () => {
      const t = makeTranscriber({ pos: 143, oldest: 150, edge: 156 });
      t.checkDrift();
      expect(t.audioPosSec()).toBe(143);
    });

    test("ровно на границе допуска (8 с) не срабатывает", () => {
      const t = makeTranscriber({ pos: 142, oldest: 150, edge: 156 });
      t.checkDrift();
      expect(t.audioPosSec()).toBe(142);
    });

    test("за границей допуска переносит позицию на начало окна минус запас 2 с, без ошибки", () => {
      const t = makeTranscriber({ pos: 100, oldest: 150, edge: 156 });
      expect(() => t.checkDrift()).not.toThrow();
      expect(t.audioPosSec()).toBeCloseTo(148, 1);
    });

    test("учитывает уже отправленное аудио и не трогает sentBytes", () => {
      const t = makeTranscriber({ pos: 100, sentSec: 10, oldest: 150, edge: 156 });
      const sentBefore = t.sentBytes;
      t.checkDrift();
      expect(t.audioPosSec()).toBeCloseTo(148, 1);
      expect(t.offsetSec).toBeCloseTo(138, 1);
      expect(t.sentBytes).toBe(sentBefore);
    });

    test("сдвигает окно на время, прошедшее с опроса плейлиста", () => {
      // окно опрошено 30 с назад: сейчас оно начинается на ~130 с
      const t = makeTranscriber({ pos: 100, oldest: 100, edge: 106, fetchedAgoMs: 30_000 });
      t.checkDrift();
      expect(t.audioPosSec()).toBeCloseTo(128, 0);
    });

    test("повторный вызов после переноса ничего не меняет", () => {
      const t = makeTranscriber({ pos: 100, oldest: 150, edge: 156 });
      t.checkDrift();
      const after = t.audioPosSec();
      t.checkDrift();
      expect(t.audioPosSec()).toBeCloseTo(after, 1);
    });

    test("отставание больше 60 с считается разрывом таймлинии и бросает ошибку", () => {
      const t = makeTranscriber({ pos: 100, oldest: 200, edge: 206 });
      expect(() => t.checkDrift()).toThrow("пропуск сегментов");
      expect(t.audioPosSec()).toBe(100);
    });
  });

  describe("серия мягких переносов", () => {
    test("третий перенос за 2 минуты бросает ошибку и позицию не двигает", () => {
      const t = makeTranscriber({ pos: 100, oldest: 150, edge: 156 });
      t.checkDrift();
      t.offsetSec = 100;
      t.checkDrift();
      t.offsetSec = 100;
      expect(() => t.checkDrift()).toThrow("не успевает за стримом");
      expect(t.audioPosSec()).toBe(100);
    });

    test("два переноса подряд ещё допустимы", () => {
      const t = makeTranscriber({ pos: 100, oldest: 150, edge: 156 });
      t.checkDrift();
      t.offsetSec = 100;
      expect(() => t.checkDrift()).not.toThrow();
      expect(t.resyncTimesMs.length).toBe(2);
    });

    test("старые переносы (за пределами окна 2 минуты) не считаются", () => {
      const t = makeTranscriber({ pos: 100, oldest: 150, edge: 156 });
      t.resyncTimesMs = [Date.now() - 200_000, Date.now() - 190_000];
      expect(() => t.checkDrift()).not.toThrow();
      expect(t.resyncTimesMs.length).toBe(1);
    });
  });

  describe("рассинхрон вперёд", () => {
    test("позиция за краем плейлиста бросает ошибку", () => {
      const t = makeTranscriber({ pos: 200, oldest: 150, edge: 156 });
      expect(() => t.checkDrift()).toThrow("рассинхрон таймлинии");
    });

    test("позиция чуть впереди края в пределах допуска не бросает", () => {
      const t = makeTranscriber({ pos: 162, oldest: 150, edge: 156 });
      expect(() => t.checkDrift()).not.toThrow();
    });
  });
});
