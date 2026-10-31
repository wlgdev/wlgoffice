import type { InteropPayload } from "./types";

export type { InteropPayload };

const PAYLOAD_BLOCK_RE = /\{[^{}]*\}/;
const FIELD_RE = /["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|([^\s,;{}"']+))/g;

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

export function stripInteropPayload(text: string): string {
  return text.replace(PAYLOAD_BLOCK_RE, " ").trim();
}
