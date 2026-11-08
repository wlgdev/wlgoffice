import { describe, expect, test } from "bun:test";

import { type MediaJobSnapshot, renderMediaJob } from "../../src/telegram/media-job";

function block(itemId: number): string {
  return (
    `<ul><li>🎬 10:00–10:30 · 30с · 1.00 МБ · 1080p60</li>` +
    `<li>🔊 Звук: чистый ✓</li>` +
    `<li>⚡ Обработка: 5с</li></ul>` +
    `<tg-button-row align="center">` +
    `<tg-button type="url" url="https://example.com/1">🔗 VOD</tg-button>` +
    `<tg-button type="callback_data" style="danger" data="del:media:${itemId}">🗑 Удалить</tg-button>` +
    `</tg-button-row>`
  );
}

function snapshot(count: number): MediaJobSnapshot {
  return {
    title: "🎬 Клипы",
    source: '› 📺 <a href="https://example.com/1">1</a>',
    notes: [],
    items: Array.from({ length: count }, (_, index) => ({
      id: index + 1,
      range: "10:00–10:30",
      vodUrl: "https://example.com/1",
      vodLabel: "VOD",
      stage: null,
      block: block(index + 1),
      media: null,
    })),
  };
}

function countBlocks(html: string): number {
  const tags = html.match(/<(?:h[1-6]|p|ul|footer|tg-button-row)[ >]/g)?.length ?? 0;
  const items = html.match(/<li[ >]/g)?.length ?? 0;
  return tags + items;
}

describe("media job rendering", () => {
  test("пропуск строки между метаинформацией, списком ренджей и результатами", () => {
    const { html } = renderMediaJob({
      ...snapshot(1),
      items: [
        { ...snapshot(1).items[0]!, block: null, stage: "⏳ [1/2] 10:00–10:30 — получение HLS…" },
        { ...snapshot(1).items[0]!, id: 2 },
      ],
    });

    expect(html).toContain("</p><ul>");
    expect(html).toContain("<br><br></p>");
    expect(html).toContain("</ul><p><br></p>");
  });

  test("небольшая задача целиком помещается в лимиты Telegram", () => {
    const { html } = renderMediaJob(snapshot(10));

    expect(html).not.toContain("…ещё");
    expect(html.length).toBeLessThanOrEqual(32000);
    expect(countBlocks(html)).toBeLessThanOrEqual(500);
  });

  test("лишние блоки обрезаются и помечаются счётчиком", () => {
    const { html } = renderMediaJob(snapshot(400));

    expect(html).toContain("…ещё");
    expect(html.length).toBeLessThanOrEqual(32000);
    expect(countBlocks(html)).toBeLessThanOrEqual(500);
  });

  test("обрезка не теряет уже готовые блоки", () => {
    const { html, attachments } = renderMediaJob(snapshot(400));

    expect(html).toContain("del:media:1");
    expect(Object.keys(attachments)).toHaveLength(0);
  });
});
