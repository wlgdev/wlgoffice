import { describe, expect, test } from "bun:test";

import { buildTrackerMessage, formatDate, formatTimestamp, formatTwitchTime } from "../../src/tracker/message";
import type { TrackerSessionState } from "../../src/tracker/types";

function state(overrides: Partial<TrackerSessionState> = {}): TrackerSessionState {
  return {
    channel: "welovegames",
    broadcastId: "broadcast-1",
    chatId: -100,
    vodId: "vod-1",
    vodTitle: "Ночной стрим",
    hits: [],
    counts: {},
    startedAt: new Date(2026, 10, 1).getTime(),
    startTimeMs: new Date(2026, 10, 1).getTime(),
    updatedAt: 0,
    status: "active",
    ...overrides,
  };
}

describe("tracker message", () => {
  test("формат времени", () => {
    expect(formatTimestamp(0)).toBe("0:00:00");
    expect(formatTimestamp(83)).toBe("0:01:23");
    expect(formatTimestamp(8430)).toBe("2:20:30");
    expect(formatTwitchTime(8430)).toBe("2h20m30s");
    expect(formatDate(new Date(2026, 10, 1).getTime())).toBe("01.11.2026");
  });

  test("шапка: заголовок, дата с каналом, тайтл и ссылка на VOD", () => {
    const text = buildTrackerMessage(state());

    expect(text).toContain("🔎 <b>Трекер ключевых слов</b>");
  });

  test("HTML в названии экранируется", () => {
    const text = buildTrackerMessage(state({ vodTitle: "<script>alert(1)</script>" }));

    const amp = String.fromCharCode(38);
    const escaped = `${amp}lt;script${amp}gt;alert(1)${amp}lt;/script${amp}gt;`;

    expect(text).not.toContain("<script>");
    expect(text).toContain(escaped);
  });

  test("таймстемпы сгруппированы по алиасам и ведут на VOD", () => {
    const text = buildTrackerMessage(
      state({
        hits: [
          { alias: "ggsel", text: "ggsel", timeSec: 8430 },
          { alias: "ggsel", text: "ggsel", timeSec: 9780 },
          { alias: "gg", text: "gg", timeSec: 605 },
        ],
        counts: { ggsel: 2, gg: 1 },
      }),
    );

    expect(text).toContain('<a href="https://www.twitch.tv/videos/vod-1?t=2h20m30s">2:20:30</a>');
    expect(text).toContain('<a href="https://www.twitch.tv/videos/vod-1?t=2h43m0s">2:43:00</a>');
    expect(text).toContain('<a href="https://www.twitch.tv/videos/vod-1?t=0h10m5s">0:10:05</a>');
    expect(text).toContain("<b>ggsel:</b>");
    expect(text).toContain("<b>gg:</b>");
  });

  test("без VOD ссылки на таймстемпы не ведут, строка VOD отсутствует", () => {
    const text = buildTrackerMessage(
      state({ vodId: undefined, hits: [{ alias: "ggsel", text: "ggsel", timeSec: 60 }] }),
    );

    expect(text).not.toContain("?t=");
    expect(text).not.toContain("🆔");
    expect(text).toContain("0:01:00");
    expect(text).toContain('<a href="https://www.twitch.tv/welovegames">@welovegames</a>');
  });

  test("одинаковые таймкоды схлопываются с количеством вхождений", () => {
    const text = buildTrackerMessage(
      state({
        hits: [
          { alias: "мат", text: "мат", timeSec: 3730 },
          { alias: "мат", text: "мат", timeSec: 3730 },
          { alias: "мат", text: "мат", timeSec: 3731 },
          { alias: "мат", text: "мат", timeSec: 5000 },
        ],
        counts: { мат: 4 },
      }),
    );

    expect(text).toContain('<a href="https://www.twitch.tv/videos/vod-1?t=1h2m10s">1:02:10</a> (2)');
    expect(text).toContain('<a href="https://www.twitch.tv/videos/vod-1?t=1h23m20s">1:23:20</a>');
    expect(text.match(/<a href="https:\/\/www\.twitch\.tv\/videos\/vod-1\?t=/g)).toHaveLength(3);
  });

  test("футер завершения эфира и итоги", () => {
    const text = buildTrackerMessage(
      state({
        status: "closed",
        hits: [{ alias: "ggsel", text: "ggsel", timeSec: 60 }],
        counts: { ggsel: 4 },
      }),
    );

    expect(text).toContain("🏁 <b>Эфир завершён</b>");
    expect(text).toContain("ggsel – 4");
    expect(text).not.toContain("—");
  });

  test("лишние таймстемпы обрезаются с пометкой", () => {
    const hits = Array.from({ length: 150 }, (_, index) => ({
      alias: "ggsel",
      text: "ggsel",
      timeSec: index * 60,
    }));

    const text = buildTrackerMessage(state({ hits, counts: { ggsel: 150 } }));

    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toContain("…ещё");
    expect(text.match(/<a href="https:\/\/www\.twitch\.tv\/videos\/vod-1\?t=/g)!.length).toBeLessThanOrEqual(90);
  });
});
