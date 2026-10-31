import type { MessageContext } from "@mtcute/dispatcher";

import config from "../config";
import type { InteropPayload } from "../core/types";

export function validateInterop(msg: MessageContext, payload: InteropPayload): string | null {
  if (msg.chat.type !== "user") {
    return "❌ <b>Интероп-запросы принимаются только в личке бота.</b>";
  }

  if (payload.to === null) {
    return "❌ <b>Интероп-запрос:</b> не указан корректный <code>to</code> (chat id получателя).";
  }

  if (!config.interop.chatIds.includes(payload.to)) {
    return `❌ <b>Интероп-запрос:</b> чат <code>${payload.to}</code> не разрешён для клипов.`;
  }

  return null;
}
