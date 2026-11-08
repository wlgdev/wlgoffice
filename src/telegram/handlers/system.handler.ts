import type { TelegramClient } from "@mtcute/bun";
import type { Dispatcher } from "@mtcute/dispatcher";
import { PropagationAction } from "@mtcute/dispatcher";

import config from "../../config";
import { resolveChatAccess } from "../../core/chat-target";
import { buildSystemReport } from "../../system";
import type { TrackerService } from "../../tracker/service";
import { getMessageThreadId } from "../topic";

const COMMAND = "!system";

export interface SystemMessageContext {
  text?: string;
  chat: { id: number };
  threadId?: number;
}

export async function handleSystemMessage(
  msg: SystemMessageContext,
  tg: Pick<TelegramClient, "sendRichMessage">,
  service: TrackerService,
): Promise<PropagationAction | undefined> {
  const text = msg.text?.trim();
  if (text !== COMMAND) {
    return PropagationAction.Continue;
  }
  const access = resolveChatAccess(config.telegram.targets, msg.chat.id, msg.threadId);
  if (!access) {
    return PropagationAction.Continue;
  }

  await tg.sendRichMessage(msg.chat.id, {
    content: { type: "html", content: buildSystemReport(service) },
    threadId: access.threadId,
  });

  return undefined;
}

export function setupSystemHandler(dp: Dispatcher, tg: TelegramClient, service: TrackerService): void {
  dp.onNewMessage(
    async (msg) =>
      await handleSystemMessage({ text: msg.text, chat: msg.chat, threadId: getMessageThreadId(msg) }, tg, service),
  );
}
