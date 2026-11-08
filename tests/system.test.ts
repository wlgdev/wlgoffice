import { describe, expect, test } from "bun:test";

import pkg from "../package.json";
import config from "../src/config";
import { buildSystemReport } from "../src/system";
import type { TrackerService } from "../src/tracker/service";
import type { TrackerSessionState } from "../src/tracker/types";

function createService(sessions: TrackerSessionState[] = []): TrackerService {
  return {
    getSettings: () => ({
      channels: { welovegames: { enabled: true, aliases: {} } },
    }),
    listActiveSessions: () => sessions,
  } as unknown as TrackerService;
}

function session(overrides: Partial<TrackerSessionState> = {}): TrackerSessionState {
  return {
    channel: "welovegames",
    broadcastId: "123456789",
    chatId: -100,
    hits: [],
    counts: {},
    sentBytes: 1024,
    receivedChars: 10,
    startedAt: Date.now() - 60_000,
    startTimeMs: Date.now() - 120_000,
    updatedAt: 0,
    status: "active",
    ...overrides,
  };
}

describe("system report", () => {
  test("собирается из compact-таблиц с блоками", () => {
    const html = buildSystemReport(createService());

    expect(html).toContain("<h3>🛠 System</h3>");
    expect(html).toContain("<caption>Бот</caption>");
    expect(html).toContain("<caption>Память</caption>");
    expect(html).toContain("<caption>Хост</caption>");
    expect(html).toContain("<caption>Хранилище</caption>");
    expect(html).toContain("<caption>Сервисы</caption>");
    expect(html).toContain("<b>Версия</b>");
    expect(html).toContain("<b>rss</b>");
    expect(html).toContain("<b>heap used</b>");
  });

  test("версия берётся из package.json", () => {
    const html = buildSystemReport(createService());

    expect(html).toContain(`<b>Версия</b></td><td>${pkg.version}</td>`);
  });

  test("активные сессии добавляются отдельными таблицами", () => {
    const html = buildSystemReport(createService([session()]));

    expect(html).toContain("<caption>@welovegames · эфир 123456789</caption>");
    expect(html).toContain("<b>В Gemini</b>");
  });

  test("без активных сессий лишних таблиц нет", () => {
    const html = buildSystemReport(createService());

    expect(html).not.toContain("<caption>@welovegames");
  });

  test("ключи и токены в отчёт не попадают", () => {
    const html = buildSystemReport(createService());

    for (const secret of [config.gemini.apiKey, config.groq.apiKey, config.twitch.oauth, config.telegram.botToken]) {
      if (secret) {
        expect(html).not.toContain(secret);
      }
    }
  });
});
