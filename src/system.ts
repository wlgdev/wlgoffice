import { statSync } from "node:fs";
import { cpus, loadavg } from "node:os";

import pkg from "../package.json";
import config from "./config";
import { humanizeDuration } from "./core/utils";
import { resolveFfmpegBinary } from "./services/ffmpeg";
import { buildTable } from "./telegram/formatters";
import { buildSessionTable, formatBytes, formatDate, formatTime } from "./tracker/message";
import type { TrackerService } from "./tracker/service";

const STARTED_AT = Date.now();

const identity: { username: string } = { username: "" };

export function setBotIdentity(info: { username?: string | null }): void {
  identity.username = info.username ?? "";
}

function fileSize(path: string): string {
  try {
    return formatBytes(statSync(path).size);
  } catch {
    return "—";
  }
}

function ffmpegBinary(): string {
  try {
    return resolveFfmpegBinary();
  } catch {
    return "не найден";
  }
}

function flag(value: unknown): string {
  return value ? "✅" : "—";
}

export function buildSystemReport(service: TrackerService): string {
  const memory = process.memoryUsage();
  const channels = Object.values(service.getSettings().channels);
  const enabled = channels.filter((channel) => channel.enabled).length;
  const sessions = service.listActiveSessions();
  const heapUsage = memory.heapTotal > 0 ? Math.round((memory.heapUsed / memory.heapTotal) * 100) : 0;

  const botRows = [
    ["<b>Версия</b>", pkg.version],
    ["<b>Аптайм</b>", humanizeDuration(Date.now() - STARTED_AT)],
    ["<b>Запущен</b>", `${formatDate(STARTED_AT)} ${formatTime(STARTED_AT)}`],
    ["<b>Рантайм</b>", `Bun ${Bun.version}`],
    ["<b>Платформа</b>", `${process.platform} ${process.arch}`],
    ["<b>PID</b>", String(process.pid)],
    ["<b>Аккаунт</b>", identity.username ? `@${identity.username}` : "—"],
  ];

  const memoryRows = [
    ["<b>rss</b>", formatBytes(memory.rss)],
    ["<b>heap total</b>", formatBytes(memory.heapTotal)],
    ["<b>heap used</b>", `${formatBytes(memory.heapUsed)} (${heapUsage}%)`],
    ["<b>external</b>", formatBytes(memory.external)],
    ["<b>arrayBuffers</b>", formatBytes(memory.arrayBuffers)],
  ];

  const hostRows: string[][] = [["<b>CPU</b>", `${cpus().length} ядер`]];
  if (process.platform !== "win32") {
    hostRows.push([
      "<b>Load average</b>",
      loadavg()
        .map((value) => value.toFixed(2))
        .join(" / "),
    ]);
  }
  hostRows.push(["<b>Рабочая директория</b>", process.cwd()]);
  hostRows.push(["<b>Часовой пояс</b>", process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone]);

  const storageRows = [
    ["<b>БД</b>", `${config.db.path} (${fileSize(config.db.path)})`],
    ["<b>Сессия</b>", `${config.telegram.storage} (${fileSize(config.telegram.storage)})`],
    ["<b>FFmpeg</b>", ffmpegBinary()],
    ["<b>Временные файлы</b>", config.tmpDir],
  ];

  const serviceRows = [
    ["<b>Трекер</b>", config.gemini.apiKey ? "включён" : "выключен (нет GEMINI_APIKEY)"],
    ["<b>Каналов трекера</b>", channels.length ? `${channels.length} (включено ${enabled})` : "не настроено"],
    ["<b>Активных сессий</b>", String(sessions.length)],
    ["<b>Gemini</b>", flag(config.gemini.apiKey)],
    ["<b>Groq</b>", flag(config.groq.apiKey)],
    ["<b>Twitch OAuth</b>", flag(config.twitch.oauth)],
    ["<b>Прокси</b>", flag(config.proxy)],
    ["<b>Interop-чатов</b>", String(config.interop.chatIds.length)],
  ];

  return [
    "<h3>🛠 System</h3>",
    buildTable("Бот", botRows),
    buildTable("Память", memoryRows),
    buildTable("Хост", hostRows),
    buildTable("Хранилище", storageRows),
    buildTable("Сервисы", serviceRows),
    ...sessions.map(buildSessionTable),
  ].join("");
}
