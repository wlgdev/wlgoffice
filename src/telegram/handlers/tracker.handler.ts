import type { TelegramClient } from "@mtcute/bun";
import type { Dispatcher } from "@mtcute/dispatcher";
import { PropagationAction } from "@mtcute/dispatcher";

import config from "../../config";
import { resolveChatAccess } from "../../core/chat-target";
import type { TrackerService } from "../../tracker/service";
import {
  describeSettings,
  parsePatternList,
  removeChannel,
  setAlias,
  setChannel,
  setChat,
  setEnabled,
  setVocabulary,
  TrackerSettingsError,
} from "../../tracker/settings";
import type { TrackerSettings } from "../../tracker/types";
import { buildListBlock, buildNoticeBlock, escapeHtml } from "../formatters";
import { getMessageThreadId } from "../topic";

const COMMAND = "!tracker";

const TITLE = "<h3>🔎 Трекер ключевых слов</h3>";

const USAGE: [string, string][] = [
  ["!tracker list", "текущие настройки"],
  ["!tracker channel [login] [chatId]", "добавить/включить канал"],
  ["!tracker enable|disable [login]", "вкл/выкл трекинг"],
  ["!tracker chat [login] [chatId|default]", "чат статусного сообщения (<code>chatId_тред</code> для форума)"],
  ["!tracker alias [login] [alias] [паттерны через запятую]", "задать паттерны"],
  ["!tracker vocab on|off", "передавать алиасы в Gemini как словарь"],
  ["!tracker rm [login]", "удалить канал"],
  ["!tracker export", "настройки в JSON"],
];

function buildUsage(): string {
  return buildListBlock(USAGE.map(([command, description]) => `<code>${command}</code> · ${description}`));
}

/**
 * Короткий итог применённой команды: одна строка вместо полного списка настроек.
 */
export function describeCommandResult(command: string, tokens: string[], settings: TrackerSettings): string {
  const [login, second] = tokens;
  const name = escapeHtml(login ?? "");
  switch (command) {
    case "channel":
      return `Канал <b>${name}</b> добавлен и включён`;
    case "enable":
      return `Канал <b>${name}</b> включён`;
    case "disable":
      return `Канал <b>${name}</b> выключен`;
    case "chat":
      return second === undefined || second === "default"
        ? `Чат канала <b>${name}</b> сброшен на по умолчанию`
        : `Чат канала <b>${name}</b>: <code>${escapeHtml(second)}</code>`;
    case "alias": {
      const kept = settings.channels[login?.toLowerCase() ?? ""]?.aliases[second ?? ""] !== undefined;
      return kept
        ? `Алиас <b>${escapeHtml(second ?? "")}</b> обновлён`
        : `Алиас <b>${escapeHtml(second ?? "")}</b> удалён`;
    }
    case "rm":
      return `Канал <b>${name}</b> удалён`;
    case "vocab":
      return `Словарь алиасов для Gemini <b>${settings.vocabularyEnabled ? "включён" : "выключен"}</b>`;
    default:
      return "Настройки обновлены";
  }
}

export function splitCommand(rest: string): { command: string; args: string; tokens: string[] } {
  const trimmed = rest.trim();
  const space = trimmed.search(/\s/);
  if (space === -1) {
    return { command: trimmed.toLowerCase(), args: "", tokens: [] };
  }
  const args = trimmed.slice(space + 1).trim();
  return { command: trimmed.slice(0, space).toLowerCase(), args, tokens: args.split(/\s+/).filter(Boolean) };
}

export function applyCommand(
  settings: TrackerSettings,
  command: string,
  args: string,
  tokens: string[],
): TrackerSettings {
  switch (command) {
    case "channel": {
      const [login, chatId] = tokens;
      if (!login) {
        throw new TrackerSettingsError("Нужен логин канала");
      }
      return setChannel(settings, login, chatId);
    }
    case "enable":
    case "disable": {
      const [login] = tokens;
      if (!login) {
        throw new TrackerSettingsError("Нужен логин канала");
      }
      return setEnabled(settings, login, command === "enable");
    }
    case "chat": {
      const [login, chatId] = tokens;
      if (!login) {
        throw new TrackerSettingsError("Нужен логин канала");
      }
      return setChat(settings, login, chatId === "default" ? undefined : chatId);
    }
    case "alias": {
      const match = /^(\S+)\s+(\S+)\s*([\s\S]*)$/.exec(args);
      if (!match) {
        throw new TrackerSettingsError("Формат: !tracker alias [login] [alias] [паттерны через запятую]");
      }
      const [, login, alias, patternsRaw] = match;
      return setAlias(settings, login!, alias!, patternsRaw ? parsePatternList(patternsRaw) : []);
    }
    case "rm": {
      const [login] = tokens;
      if (!login) {
        throw new TrackerSettingsError("Нужен логин канала");
      }
      return removeChannel(settings, login);
    }
    case "vocab": {
      const [mode] = tokens;
      if (mode !== "on" && mode !== "off") {
        throw new TrackerSettingsError("Формат: !tracker vocab on|off");
      }
      return setVocabulary(settings, mode === "on");
    }
    default:
      throw new TrackerSettingsError(`Неизвестная команда "${command}"`);
  }
}

export interface TrackerMessageContext {
  text?: string;
  chat: { id: number };
  threadId?: number;
}

export async function handleTrackerMessage(
  msg: TrackerMessageContext,
  tg: Pick<TelegramClient, "sendRichMessage">,
  service: TrackerService,
): Promise<PropagationAction | undefined> {
  const text = msg.text?.trim();
  if (!text || (text !== COMMAND && !text.startsWith(`${COMMAND} `))) {
    return PropagationAction.Continue;
  }
  const access = resolveChatAccess(config.telegram.targets, msg.chat.id, msg.threadId);
  if (!access) {
    return PropagationAction.Continue;
  }
  const send = (html: string) =>
    tg.sendRichMessage(msg.chat.id, { content: { type: "html", content: html }, threadId: access.threadId });

  const { command, args, tokens } = splitCommand(text.slice(COMMAND.length));

  try {
    if (!command) {
      await send(`${TITLE}<p>› Справка: <code>!tracker команда</code></p>${buildUsage()}`);
      return undefined;
    }

    if (command === "list") {
      const settings = describeSettings(service.getSettings());
      await send(`${TITLE}${settings}`);
      return undefined;
    }

    if (command === "export") {
      const json = escapeHtml(JSON.stringify(service.getSettings(), null, 2));
      await send(`${TITLE}<details><summary>Настройки в JSON</summary><pre><code>${json}</code></pre></details>`);
      return undefined;
    }

    const settings = applyCommand(service.getSettings(), command, args, tokens);
    service.saveSettings(settings);
    void service.tick();

    await send(
      `<h3>✅ Готово</h3><p>${describeCommandResult(command, tokens, settings)}</p>${describeSettings(settings)}`,
    );
  } catch (err) {
    const message = err instanceof TrackerSettingsError ? err.message : String(err);
    await send(buildNoticeBlock({ icon: "❌", title: "Ошибка", body: escapeHtml(message) }));
  }

  return undefined;
}

export function setupTrackerHandler(dp: Dispatcher, tg: TelegramClient, service: TrackerService): void {
  dp.onNewMessage(
    async (msg) =>
      await handleTrackerMessage({ text: msg.text, chat: msg.chat, threadId: getMessageThreadId(msg) }, tg, service),
  );
}
