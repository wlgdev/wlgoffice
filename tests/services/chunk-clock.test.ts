import { describe, expect, test } from "bun:test";

import { ChunkClock } from "../../src/services/chunk-clock";

/** Для краткости: один кусок текста, возвращаем его отрезок. */
function one(clock: ChunkClock, text: string, audioSec: number) {
  const [span] = clock.assign([text], audioSec);
  return span!;
}

describe("chunk clock", () => {
  test("первый кусок начинается в момент старта аудио", () => {
    const clock = new ChunkClock(120, { latencySec: 0, maxSpanSec: 1000 });

    const span = one(clock, "привет", 135);

    expect(span.startSec).toBe(120);
    expect(span.endSec).toBe(135);
  });

  test("следующий кусок начинается там, где закончился предыдущий", () => {
    const clock = new ChunkClock(120, { latencySec: 0, maxSpanSec: 1000 });

    one(clock, "раз", 135);
    const second = one(clock, "два", 150);
    const third = one(clock, "три", 160);

    expect(second.startSec).toBe(135);
    expect(second.endSec).toBe(150);
    expect(third.startSec).toBe(150);
    expect(third.endSec).toBe(160);
  });

  test("задержка Gemini вычитается из позиции доставки", () => {
    const clock = new ChunkClock(100, { latencySec: 1 });

    const first = one(clock, "раз", 110);
    const second = one(clock, "два", 120);

    expect(first.startSec).toBe(100);
    expect(first.endSec).toBe(109);
    expect(second.startSec).toBe(109);
    expect(second.endSec).toBe(119);
  });

  test("задержка по умолчанию 1 секунда", () => {
    const clock = new ChunkClock(0);

    const span = one(clock, "раз", 5);

    expect(span.endSec).toBeCloseTo(4, 10);
  });

  test("если аудио отправлено меньше задержки, отрезок вырождается в точку старта", () => {
    const clock = new ChunkClock(0, { latencySec: 2 });

    const span = one(clock, "раз", 1);

    expect(span.startSec).toBe(0);
    expect(span.endSec).toBe(0);
    expect(clock.cursor).toBe(0);
  });

  test("после долгой паузы начало не уезжает назад дальше maxSpanSec", () => {
    const clock = new ChunkClock(0, { latencySec: 0, maxSpanSec: 10 });

    one(clock, "раз", 5);
    const span = one(clock, "два", 100);

    expect(span.startSec).toBe(90);
    expect(span.endSec).toBe(100);
  });

  test("maxSpanSec по умолчанию 10 секунд", () => {
    const clock = new ChunkClock(0, { latencySec: 0 });

    const span = one(clock, "раз", 100);

    expect(span.startSec).toBe(80);
    expect(span.endSec).toBe(100);
  });

  test("кусок, пришедший вплотную к предыдущему, не отодвигается назад из-за maxSpanSec", () => {
    const clock = new ChunkClock(0, { latencySec: 0, maxSpanSec: 10 });

    one(clock, "раз", 8);
    const span = one(clock, "два", 12);

    expect(span.startSec).toBe(8);
    expect(span.endSec).toBe(12);
  });

  test("курсор не откатывается назад", () => {
    const clock = new ChunkClock(0, { latencySec: 0 });

    expect(one(clock, "раз", 5).startSec).toBe(0);

    const span = one(clock, "два", 4);

    expect(span.startSec).toBe(5);
    expect(span.endSec).toBe(5);
    expect(clock.cursor).toBe(5);
  });

  test("курсор после доставки равен позиции аудио минус задержка", () => {
    const clock = new ChunkClock(0, { latencySec: 1 });

    one(clock, "раз", 10);

    expect(clock.cursor).toBe(9);
  });

  test("пачка кусков делит отрезок пропорционально длине текста", () => {
    const clock = new ChunkClock(0, { latencySec: 0 });

    const [a, b] = clock.assign(["ab", "cdef"], 6);

    expect(a!.startSec).toBeCloseTo(0, 10);
    expect(a!.endSec).toBeCloseTo(2, 10);
    expect(b!.startSec).toBeCloseTo(2, 10);
    expect(b!.endSec).toBeCloseTo(6, 10);
  });

  test("куски пачки идут подряд без разрывов и пересечений", () => {
    const clock = new ChunkClock(10, { latencySec: 0, maxSpanSec: 1000 });

    const spans = clock.assign(["один", "два", "три", "четыре"], 30);

    expect(spans[0]!.startSec).toBeCloseTo(10, 10);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]!.startSec).toBeCloseTo(spans[i - 1]!.endSec, 10);
    }
    expect(spans[spans.length - 1]!.endSec).toBeCloseTo(30, 10);
  });

  test("пустой текст в пачке имеет минимальный вес, а не нулевую длину", () => {
    const clock = new ChunkClock(0, { latencySec: 0 });

    const [a, b] = clock.assign(["", "ab"], 3);

    expect(a!.startSec).toBeCloseTo(0, 10);
    expect(a!.endSec).toBeCloseTo(1, 10);
    expect(b!.startSec).toBeCloseTo(1, 10);
    expect(b!.endSec).toBeCloseTo(3, 10);
  });

  test("после пачки следующий кусок начинается там, где закончилась пачка", () => {
    const clock = new ChunkClock(0, { latencySec: 0 });

    clock.assign(["ab", "cd"], 6);
    const span = one(clock, "ef", 9);

    expect(span.startSec).toBe(6);
    expect(span.endSec).toBe(9);
  });

  test("начальный курсор равен времени старта аудио", () => {
    const clock = new ChunkClock(120);

    expect(clock.cursor).toBe(120);
  });

  test("minCharsPerSec: короткий текст после паузы откатывается недалеко", () => {
    const clock = new ChunkClock(0, { latencySec: 0, maxSpanSec: 100, minCharsPerSec: 5 });

    const span = one(clock, "привет мир", 100); // 10 символов → 2 секунды

    expect(span.startSec).toBe(98);
    expect(span.endSec).toBe(100);
  });

  test("minCharsPerSec: очень короткий текст получает минимальный запас 2 секунды", () => {
    const clock = new ChunkClock(0, { latencySec: 0, maxSpanSec: 100, minCharsPerSec: 5 });

    const span = one(clock, "да", 100);

    expect(span.startSec).toBe(98);
  });

  test("minCharsPerSec: длинный текст ограничен maxSpanSec", () => {
    const clock = new ChunkClock(0, { latencySec: 0, maxSpanSec: 10, minCharsPerSec: 5 });

    const span = one(clock, "а".repeat(200), 100);

    expect(span.startSec).toBe(90);
  });

  test("minCharsPerSec: курсор остаётся нижней границей начала", () => {
    const clock = new ChunkClock(0, { latencySec: 0, maxSpanSec: 100, minCharsPerSec: 5 });

    one(clock, "а".repeat(50), 10);
    const span = one(clock, "а".repeat(50), 20); // 50 символов → 10 секунд, курсор на 10

    expect(span.startSec).toBe(10);
  });
});
