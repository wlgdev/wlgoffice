import type { MessageContext } from "@mtcute/dispatcher";

/**
 * id треда форума, в котором пришло сообщение (id корневого сообщения треда).
 */
export function getMessageThreadId(msg: Pick<MessageContext, "isTopicMessage" | "replyToMessage">): number | undefined {
  if (!msg.isTopicMessage) {
    return undefined;
  }
  return msg.replyToMessage?.threadId ?? undefined;
}
