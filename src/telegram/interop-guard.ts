import type { MessageContext } from "@mtcute/dispatcher";

import config from "../config";
import type { InteropPayload } from "../core/types";

export function validateInterop(msg: MessageContext, payload: InteropPayload): string | null {
  if (msg.chat.type !== "user") {
    return "Интероп-запросы принимаются только в личке бота.";
  }

  if (payload.to === null) {
    return "Интероп-запрос: не указан корректный <code>to</code> (chat id получателя).";
  }

  if (!config.interop.chatIds.includes(payload.to)) {
    return `Интероп-запрос: чат <code>${payload.to}</code> не разрешён для клипов.`;
  }

  return null;
}
