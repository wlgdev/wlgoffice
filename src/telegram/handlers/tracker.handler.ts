import type { TelegramClient } from "@mtcute/bun";
import type { Dispatcher } from "@mtcute/dispatcher";
import { PropagationAction } from "@mtcute/dispatcher";

import config from "../../config";
import { resolveChatAccess } from "../../core/chat-target";
import { buildSessionsMessage } from "../../tracker/message";
import type { TrackerService } from "../../tracker/service";
import {
  describeSettings,
  parsePatternList,
  removeChannel,
  setAlias,
  setChannel,
  setChat,
  setEnabled,
  TrackerSettingsError,
} from "../../tracker/settings";
import type { TrackerSettings } from "../../tracker/types";
import { buildListBlock, buildNoticeBlock, escapeHtml } from "../formatters";
import { getMessageThreadId } from "../topic";

const COMMAND = "!tracker";

const TITLE = "<h3>🔎 Трекер ключевых слов</h3>";

const USAGE = [
  "<code>!tracker list</code> – текущие настройки",
  "<code>!tracker channel [login] [chatId]</code> – добавить/включить канал",
  "<code>!tracker enable|disable [login]</code> – вкл/выкл трекинг",
  "<code>!tracker chat [login] [chatId|default]</code> – чат статусного сообщения (<code>chatId_тред</code> для форума)",
  "<code>!tracker alias [login] [alias] [паттерны через запятую]</code> – задать паттерны",
  "<code>!tracker rm [login]</code> – удалить канал",
  "<code>!tracker export</code> – настройки в JSON",
];

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
      await send(`${TITLE}${buildListBlock(USAGE)}`);
      return undefined;
    }

    if (command === "list") {
      const settings = describeSettings(service.getSettings());
      const sessions = buildSessionsMessage(service.listActiveSessions());
      await send(`${TITLE}${settings}${sessions}`);
      return undefined;
    }

    if (command === "export") {
      await send(`${TITLE}<pre><code>${escapeHtml(JSON.stringify(service.getSettings(), null, 2))}</code></pre>`);
      return undefined;
    }

    const settings = applyCommand(service.getSettings(), command, args, tokens);
    service.saveSettings(settings);
    void service.tick();

    await send(`<h3>✅ Готово</h3>${describeSettings(settings)}`);
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
