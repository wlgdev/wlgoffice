import { describe, expect, test } from "bun:test";

import { ChunkClock } from "../../src/services/chunk-clock";

describe("chunk clock", () => {
  test("первый кусок начинается в момент старта аудио", () => {
    const clock = new ChunkClock(120);

    expect(clock.take(135)).toBe(120);
  });

  test("следующий кусок начинается там, где закончилось предыдущее аудио", () => {
    const clock = new ChunkClock(120);

    clock.take(135);
    expect(clock.take(150)).toBe(135);
    expect(clock.take(160)).toBe(150);
  });

  test("длинный кусок не сдвигает метку на его длину", () => {
    const clock = new ChunkClock(0);

    clock.take(10);
    const start = clock.take(70);

    expect(start).toBe(10);
  });

  test("курсор не откатывается назад", () => {
    const clock = new ChunkClock(0);

    expect(clock.take(5)).toBe(0);
    expect(clock.take(4)).toBe(5);
    expect(clock.cursor).toBe(5);
  });
});
