/**
 * Интероп-запросы от внешних ботов.
 *
 * Формат команды:
 *   !клип {from:"twitch";to:"182834";username:"Nikitawrik";channel:"welovegames"} 05:00 - 10:00 480p
 *
 * Парсер терпим к вариантам записи: разделитель `;` или `,`, ключи в кавычках или без,
 * значения в двойных/одинарных кавычках или без них (тогда только числа).
 */

export interface InteropPayload {
  /** Платформа-источник: "twitch" | "vk" */
  from: string;
  /** Chat id получателя; null, если поле отсутствует или значение не число */
  to: number | null;
  /** Никнейм инициатора запроса */
  username: string | null;
  /** Логин Twitch-канала, из которого берётся live-VOD */
  channel: string | null;
}

const PAYLOAD_BLOCK_RE = /\{[^{}]*\}/;

const FIELD_RE = /["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|([^\s,;{}"']+))/g;

/**
 * Разбирает блок `{...}` из текста команды.
 * Возвращает null, если блока нет или в нём нет полей from/to.
 */
export function parseInteropPayload(text: string): InteropPayload | null {
  const block = PAYLOAD_BLOCK_RE.exec(text);
  if (!block) {
    return null;
  }

  const fields = new Map<string, string>();
  FIELD_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = FIELD_RE.exec(block[0])) !== null) {
    const key = match[1];
    if (key === undefined) {
      continue;
    }
    const value = match[2] ?? match[3] ?? match[4];
    if (value === undefined) {
      continue;
    }
    fields.set(key.toLowerCase(), value);
  }

  if (!fields.has("from") && !fields.has("to")) {
    return null;
  }

  const toRaw = fields.get("to")?.trim();
  const to = toRaw && /^-?\d+$/.test(toRaw) ? Number(toRaw) : null;

  return {
    from: fields.get("from")?.trim().toLowerCase() || "twitch",
    to,
    username: fields.get("username")?.trim() || null,
    channel: fields.get("channel")?.trim() || null,
  };
}

/**
 * Вырезает блок payload из текста команды, чтобы цифры и никнеймы из него
 * не попадали в разбор таймкодов, качества и алиасов канала.
 */
export function stripInteropPayload(text: string): string {
  return text.replace(PAYLOAD_BLOCK_RE, " ").trim();
}
