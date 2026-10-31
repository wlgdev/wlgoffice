import { describe, expect, test } from "bun:test";

import { parseInteropPayload, stripInteropPayload } from "../../src/interop";
import { parseVodMessage } from "../../src/utils";

describe("interop payload utils", () => {
  const command = '!клип {from:"twitch";to:"182834";username:"Nikitawrik"} 05:00 - 10:00 480p';

  describe("parseInteropPayload", () => {
    test("parses loose formatted payload", () => {
      const payload = parseInteropPayload(command);
      expect(payload).not.toBeNull();
      expect(payload!.from).toBe("twitch");
      expect(payload!.to).toBe(182834);
      expect(payload!.username).toBe("Nikitawrik");
      expect(payload!.channel).toBeNull();
    });

    test("parses strict JSON payload with channel", () => {
      const payload = parseInteropPayload(
        '!клип {"from":"twitch","to":"182834","username":"Nikitawrik","channel":"welovegames"} 05:00 - 10:00',
      );
      expect(payload).not.toBeNull();
      expect(payload!.from).toBe("twitch");
      expect(payload!.to).toBe(182834);
      expect(payload!.username).toBe("Nikitawrik");
      expect(payload!.channel).toBe("welovegames");
    });

    test("parses negative channel chat id", () => {
      const payload = parseInteropPayload('!клип {from:"twitch";to:"-1001234567890"} 05:00 - 10:00');
      expect(payload!.to).toBe(-1001234567890);
    });

    test("returns null for to field when not numeric", () => {
      const payload = parseInteropPayload('!клип {from:"twitch";to:"abc"} 05:00 - 10:00');
      expect(payload!.to).toBeNull();
    });

    test("returns null when command does not contain payload block", () => {
      expect(parseInteropPayload("!клип https://twitch.tv/videos/123 05:00 - 10:00")).toBeNull();
      expect(parseInteropPayload("!клип влг 05:00 - 10:00")).toBeNull();
    });

    test("returns null when block has neither from nor to", () => {
      expect(parseInteropPayload('!клип {note:"что-то"} 05:00 - 10:00')).toBeNull();
    });
  });

  describe("stripInteropPayload", () => {
    test("removes payload block cleanly", () => {
      const stripped = stripInteropPayload(command);
      expect(stripped).not.toContain("{");
      expect(stripped).not.toContain("182834");
      expect(stripped).toContain("05:00 - 10:00 480p");
    });

    test("numbers inside payload do not corrupt time range parser", () => {
      const parsed = parseVodMessage(stripInteropPayload(command), {});
      expect(parsed.ranges).toHaveLength(1);
      expect(parsed.ranges[0]!.rawStart).toBe("05:00");
      expect(parsed.ranges[0]!.rawEnd).toBe("10:00");
      expect(parsed.qualities).toEqual(["480p"]);
    });
  });
});
