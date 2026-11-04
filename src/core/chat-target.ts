export interface ChatTarget {
  chatId: number | string;
  threadId?: number;
}

/**
 * Разбирает цель в формате `<chatId>` или `<chatId>_<threadId>`.
 * Возвращает null, если формат неверный.
 */
export function parseChatTarget(raw: string): ChatTarget | null {
  const parts = raw.trim().split("_");
  if (parts.length > 2) {
    return null;
  }

  const chatId = Number(parts[0]);
  if (!Number.isFinite(chatId)) {
    return null;
  }

  if (parts.length === 1) {
    return { chatId };
  }

  const threadId = Number(parts[1]);
  if (!Number.isInteger(threadId) || threadId <= 0) {
    return null;
  }

  return { chatId, threadId };
}

/**
 * Разбирает список целей через запятую. Бросает Error, если список пуст или содержит мусор.
 */
export function parseChatTargets(raw?: string, label = "CHAT_ID"): ChatTarget[] {
  const entries = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const targets = entries.map(parseChatTarget);

  if (!targets.length || targets.some((target) => !target)) {
    throw new Error(`${label} is not defined`);
  }

  return targets as ChatTarget[];
}

export function formatChatTarget(target: ChatTarget): string {
  return target.threadId === undefined ? String(target.chatId) : `${target.chatId}_${target.threadId}`;
}

/**
 * Проверяет, разрешён ли чат, и в какой тред отвечать.
 * Чат без указания треда открыт целиком; чат с тредами — только эти треды.
 */
export function resolveChatAccess(
  targets: ChatTarget[],
  chatId: number,
  threadId?: number,
): { chatId: number; threadId?: number } | null {
  const entries = targets.filter((target) => Number(target.chatId) === chatId);
  if (!entries.length) {
    return null;
  }

  if (entries.some((target) => target.threadId === undefined)) {
    return { chatId, threadId };
  }

  if (threadId === undefined || !entries.some((target) => target.threadId === threadId)) {
    return null;
  }

  return { chatId, threadId };
}
