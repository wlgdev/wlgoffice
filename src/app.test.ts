import { describe, expect, test } from "bun:test";
import config, { parseChannelAliases, parseChatIds } from "./config";
import {
  parseChannelAlias,
  parseQualities,
  parseVodId,
  parseVodMessage,
  parseVodUrl,
  parseTimeRanges,
  parseVkVideoId,
  parseVodMode,
  timeToSeconds,
} from "./utils";
import {
  parseMediaPlaylist,
  filterSegmentsByRange,
  isAudioOnlyVariant,
  pickVariant,
  QualityNotFoundError,
  variantMatchesQuality,
  type StreamVariant,
} from "./hls";
import { parseVkMasterPlaylist } from "./vk";
import { remuxHlsStream } from "./ffmpeg";
import { pickLiveVod } from "./twitch";
import { parseInteropPayload, stripInteropPayload } from "./interop";
import { formatRetryAfter, FALLBACK_STT_MODEL, GROQ_MAX_FILE_BYTES, PRIMARY_STT_MODEL } from "./transcribe";
import type { TwitchStreamInfo, TwitchVodInfo } from "@shevernitskiy/scraperator";

describe("parseChatIds", () => {
  test("single id", () => expect(parseChatIds("123123")).toEqual([123123]));
  test("list with spaces and negatives", () =>
    expect(parseChatIds("123123, 15125,-543856141")).toEqual([123123, 15125, -543856141]));
  test("invalid throws", () => {
    expect(() => parseChatIds("")).toThrow();
    expect(() => parseChatIds("123,abc")).toThrow();
  });
});

describe("utils (trust boundary: текст из Telegram)", () => {
  test("timeToSeconds", () => {
    expect(timeToSeconds("10")).toBe(10);
    expect(timeToSeconds("10:00")).toBe(600);
    expect(timeToSeconds("1:02:03")).toBe(3723);
    expect(timeToSeconds("10:99")).toBeNull();
    expect(timeToSeconds("abc")).toBeNull();
  });
  test("parseVodId", () => {
    expect(parseVodId("!клип https://www.twitch.tv/videos/123456 10:00 - 12:30")).toBe("123456");
    expect(parseVodId("без ссылки")).toBeNull();
  });
  test("parseVodUrl (оригинальная ссылка из поста, протокол нормализуем к https)", () => {
    expect(parseVodUrl("!клип https://www.twitch.tv/videos/123456 10:00 - 12:30")).toBe(
      "https://www.twitch.tv/videos/123456",
    );
    expect(parseVodUrl("!клип http://m.twitch.tv/videos/123456 10:00 - 12:30")).toBe(
      "https://m.twitch.tv/videos/123456",
    );
    expect(parseVodUrl("!клип twitch.tv/videos/123456 10:00 - 12:30")).toBe("https://twitch.tv/videos/123456");
    expect(parseVodUrl("без ссылки")).toBeNull();
  });
  test("parseTimeRanges", () => {
    const r = parseTimeRanges("10:00 - 12:30");
    expect(r).toHaveLength(1);
    expect([r[0]!.startSeconds, r[0]!.endSeconds]).toEqual([600, 750]);
  });
  test("parseVkVideoId", () => {
    expect(parseVkVideoId("!клип https://vkvideo.ru/video-46211765_456252477 10:00 - 12:30")).toBe(
      "-46211765_456252477",
    );
    expect(parseVkVideoId("!клип https://vkvideo.ru/live-46211765_456252477 10:00 - 12:30")).toBe(
      "-46211765_456252477",
    );
    expect(parseVkVideoId("!клип https://vk.com/clip-46211765_456252477 10:00 - 12:30")).toBe(
      "-46211765_456252477",
    );
    // без минуса у owner_id — нормализуем, иначе Vk.getVideoByID бросит "Invalid video id"
    expect(parseVkVideoId("https://vkvideo.ru/video46211765_456252477")).toBe("-46211765_456252477");
    expect(parseVkVideoId("!клип https://www.twitch.tv/videos/123456 10:00 - 12:30")).toBeNull();
  });
  test("parseVodMessage определяет платформу", () => {
    const vk = parseVodMessage("!клип https://vkvideo.ru/video-46211765_456252477 10:00 - 12:30 720p");
    expect(vk.platform).toBe("vk");
    expect(vk.vodId).toBe("-46211765_456252477");
    expect(vk.vodUrl).toBe("https://vkvideo.ru/video-46211765_456252477");
    expect(vk.channel).toBeNull();
    expect(vk.ranges).toHaveLength(1);
    expect(vk.qualities).toEqual(["720p"]);

    const twitch = parseVodMessage("!клип https://twitch.tv/videos/123 10:00 - 12:30");
    expect(twitch.platform).toBe("twitch");
    expect(twitch.vodId).toBe("123");

    expect(parseVodMessage("!клип просто текст").platform).toBeNull();
  });
  test("parseVodMode различает !клип и !аудио", () => {
    expect(parseVodMode("!клип https://twitch.tv/videos/123 10:00 - 11:00")).toBe("video");
    expect(parseVodMode("!аудио https://twitch.tv/videos/123 10:00 - 11:00")).toBe("audio");
    expect(parseVodMode("!audio https://twitch.tv/videos/123 10:00 - 11:00")).toBe("audio");
    expect(parseVodMode("!аудио")).toBe("audio");
    expect(parseVodMode("!аудиочки шумим")).toBe("video");
  });
  test("parseVodMode различает !транскрипт", () => {
    expect(parseVodMode("!транскрипт https://twitch.tv/videos/123 10:00 - 11:00")).toBe("transcript");
    expect(parseVodMode("!транскрипция https://twitch.tv/videos/123")).toBe("transcript");
    expect(parseVodMode("!транс https://twitch.tv/videos/123")).toBe("transcript");
    expect(parseVodMode("!transcript https://twitch.tv/videos/123")).toBe("transcript");
    expect(parseVodMode("!ТРАНСКРИПТ https://twitch.tv/videos/123")).toBe("transcript");
    // префикс команды не должен матчить слова, начинающиеся так же
    expect(parseVodMode("!транскрипты шумим")).toBe("video");
    // в сообщении без команды упоминание транскрипта не переключает режим
    expect(parseVodMode("!клип https://twitch.tv/videos/123 транскрипт")).toBe("video");
  });
});

describe("ffmpeg (битый вход обязан падать, а не 'сохранять' 0 MB)", () => {
  test("remux rejects on errored input stream", async () => {
    const outPath = `${config.tmpDir}/test_broken.mp4`;
    const bad = new ReadableStream<Uint8Array>({
      start(c) {
        c.error(new Error("HTTP 403 for https://example.com/seg.ts"));
      },
    });
    await expect(remuxHlsStream({ stream: bad, outPath })).rejects.toThrow();
    try {
      await Bun.file(outPath).unlink();
    } catch {}
  }, 30000);
});

describe("parseQualities (цель: паттерн <цифры>p)", () => {
  test("одно качество", () => {
    expect(parseQualities("!клип https://twitch.tv/videos/123 10:00 - 11:00 720p")).toEqual(["720p"]);
  });
  test("несколько — порядок сохраняется, дубли и регистр схлопываются", () => {
    expect(parseQualities("1080p бла 720P бла 1080P 480p")).toEqual(["1080p", "720p", "480p"]);
  });
  test("без паттерна — пусто (качаем максимальное)", () => {
    expect(parseQualities("!клип https://twitch.tv/videos/123 10:00 - 11:00")).toEqual([]);
  });
  test("parseVodMessage прокидывает qualities", () => {
    const parsed = parseVodMessage("!клип https://twitch.tv/videos/123 10:00 - 11:00 720p");
    expect(parsed.qualities).toEqual(["720p"]);
    expect(parsed.vodId).toBe("123");
  });
});

describe("pickVariant (точный матч, без фолбэка на максимальное)", () => {
  const variants: StreamVariant[] = [
    { bandwidth: 9000, codecs: "avc", resolution: "1920x1080", video: "1080p60", framerate: "60", url: "u1" },
    { bandwidth: 5000, codecs: "avc", resolution: "1280x720", video: "720p60", framerate: "60", url: "u2" },
    { bandwidth: 2000, codecs: "avc", resolution: "852x480", video: "480p30", framerate: "30", url: "u3" },
  ];

  test("без quality — максимальное", () => {
    expect(pickVariant(variants).video).toBe("1080p60");
  });
  test("720p матчится на 720p60", () => {
    expect(pickVariant(variants, "720p").video).toBe("720p60");
  });
  test("массив: первое совпавшее по порядку запроса", () => {
    expect(pickVariant(variants, ["480p", "720p"]).video).toBe("480p30");
    // 1080p отсутствует бы — берём следующее; здесь оба есть, проверяем пропуск отсутствующего
    expect(pickVariant(variants, ["1440p", "720p"]).video).toBe("720p60");
  });
  test("нет в манифесте — бросает QualityNotFoundError, ничего не качаем", () => {
    let err: unknown;
    try {
      pickVariant(variants, "2160p");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(QualityNotFoundError);
    const qe = err as QualityNotFoundError;
    expect(qe.requested).toEqual(["2160p"]);
    expect(qe.available).toContain("1080p60");
  });
  test("ни одно из нескольких не совпало — requested сохраняет порядок", () => {
    let err: unknown;
    try {
      pickVariant(variants, ["2160p", "1440p"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(QualityNotFoundError);
    expect((err as QualityNotFoundError).requested).toEqual(["2160p", "1440p"]);
  });
  test("variantMatchesQuality: префикс с fps и фолбэк на resolution", () => {
    const v = variants[1]!;
    expect(variantMatchesQuality(v, "720p")).toBe(true);
    expect(variantMatchesQuality(v, "1080p")).toBe(false);
    // resolution без video
    expect(
      variantMatchesQuality(
        { bandwidth: 1, codecs: "", resolution: "1280x720", video: "", framerate: "", url: "" },
        "720p",
      ),
    ).toBe(true);
  });
});

describe('pickVariant audio-only (режим !аудио)', () => {
  const withAudio: StreamVariant[] = [
    { bandwidth: 9000, codecs: "avc1.4D0028,mp4a.40.2", resolution: "1920x1080", video: "1080p60", framerate: "60", url: "v1" },
    { bandwidth: 2000, codecs: "avc1.4D401F,mp4a.40.2", resolution: "852x480", video: "480p30", framerate: "30", url: "v2" },
    { bandwidth: 160000, codecs: "mp4a.40.2", resolution: "", video: "audio_only", framerate: "", url: "a1" },
  ];
  const videoOnly: StreamVariant[] = withAudio.slice(0, 2);

  test("без quality в аудио-режиме — audio_only приоритетнее максимального видео", () => {
    expect(pickVariant(withAudio, undefined, "best").url).toBe("a1");
  });

  test("isAudioOnlyVariant отличает аудиодорожку от видео", () => {
    expect(isAudioOnlyVariant(withAudio[2]!)).toBe(true);
    expect(isAudioOnlyVariant(withAudio[0]!)).toBe(false);
    // видеокодек без resolution (VK QUALITY=audio с h264) — не audio-only
    expect(isAudioOnlyVariant({ bandwidth: 1, codecs: "avc1,mp4a", resolution: "", video: "", framerate: "", url: "" })).toBe(
      false,
    );
  });

  test("audio-only вариант есть — берём его, а не максимальное видео", () => {
    expect(pickVariant(withAudio, undefined, "best").url).toBe("a1");
  });

  test("audio-only варианта нет — фолбэк на максимальный bandwidth (лучший AAC)", () => {
    expect(pickVariant(videoOnly, undefined, "best").url).toBe("v1");
  });

  test("quality в аудио-режиме выбирает источник звука, приоритетнее audio_only", () => {
    expect(pickVariant(withAudio, "480p", "best").url).toBe("v2");
    expect(pickVariant(withAudio, ["1080p", "480p"], "best").url).toBe("v1");
  });

  test("quality в аудио-режиме не найдено — фолбэк на audio_only, а не ошибка", () => {
    expect(pickVariant(withAudio, "2160p", "best").url).toBe("a1");
  });

  test("video-режим на том же манифесте по-прежнему даёт максимальное", () => {
    expect(pickVariant(withAudio).url).toBe("v1");
    expect(pickVariant(videoOnly).url).toBe("v1");
  });
});

describe('pickVariant cheapest (режим !транскрипт)', () => {
  // Twitch для многих VOD не отдаёт audio_only вообще — только видео-варианты с AAC.
  const videoOnly: StreamVariant[] = [
    { bandwidth: 7630000, codecs: "avc1.4D402A,mp4a.40.2", resolution: "1920x1080", video: "1080p60", framerate: "60", url: "v1080" },
    { bandwidth: 1330000, codecs: "avc1.4D401F,mp4a.40.2", resolution: "852x480", video: "480p30", framerate: "30", url: "v480" },
    { bandwidth: 247753, codecs: "avc1.4D400C,mp4a.40.2", resolution: "284x160", video: "160p30", framerate: "30", url: "v160" },
  ];
  const withAudio: StreamVariant[] = [
    ...videoOnly,
    { bandwidth: 160000, codecs: "mp4a.40.2", resolution: "", video: "audio_only", framerate: "", url: "a1" },
  ];

  test("без audio_only — самое низкое качество, а не максимальное", () => {
    expect(pickVariant(videoOnly, undefined, "cheapest").url).toBe("v160");
  });

  test("это в разы легче, чем дефолт для !аудио на том же манифесте", () => {
    expect(pickVariant(videoOnly, undefined, "best").url).toBe("v1080");
    const cheap = pickVariant(videoOnly, undefined, "cheapest").bandwidth;
    const best = pickVariant(videoOnly, undefined, "best").bandwidth;
    expect(best / cheap).toBeGreaterThan(20);
  });

  test("audio_only приоритетнее даже в cheapest — он и лёгкий, и чистый", () => {
    expect(pickVariant(withAudio, undefined, "cheapest").url).toBe("a1");
  });

  test("quality из команды в режиме транскрипта не учитывается (выбор делает вызывающий)", () => {
    // В !транскрипт effectiveQualities всегда undefined, поэтому quality сюда не доходит
    expect(pickVariant(videoOnly, undefined, "cheapest").url).toBe("v160");
  });
});

describe("hls playlist", () => {
  test("parse + filter", () => {
    const text = "#EXTM3U\n#EXTINF:10.0,\nseg1.ts\n#EXTINF:10.0,\nseg2.ts\n#EXTINF:10.0,\nseg3.ts";
    const { segments } = parseMediaPlaylist(text, "https://example.com/vod/");
    expect(segments).toHaveLength(3);
    expect(filterSegmentsByRange(segments, 5, 15)).toHaveLength(2);
  });
});

describe("алиасы Twitch-каналов (влг/wlg → welovegames, табула/tabula → tabula)", () => {
  const aliases = parseChannelAliases();

  test("parseChannelAliases: дефолты на месте", () => {
    expect(aliases["влг"]).toBe("welovegames");
    expect(aliases["wlg"]).toBe("welovegames");
    expect(aliases["welovegames"]).toBe("welovegames");
    expect(aliases["табула"]).toBe("tabula");
    expect(aliases["tabula"]).toBe("tabula");
  });

  test("parseChannelAliases: env расширяет мапу, логин добавляется в алиасы сам", () => {
    const custom = parseChannelAliases("mychan:мк;tabula:табула");
    expect(custom["мк"]).toBe("mychan");
    expect(custom["mychan"]).toBe("mychan");
    expect(custom["табула"]).toBe("tabula");
    // дефолты не теряются
    expect(custom["влг"]).toBe("welovegames");
  });

  test("parseChannelAlias находит алиас в команде", () => {
    expect(parseChannelAlias("!клип влг 10:00 - 12:30", aliases)).toBe("welovegames");
    expect(parseChannelAlias("!клип wlg 10:00 - 12:30", aliases)).toBe("welovegames");
    expect(parseChannelAlias("!клип welovegames 10:00 - 12:30", aliases)).toBe("welovegames");
    expect(parseChannelAlias("!клип табула 10:00 - 12:30", aliases)).toBe("tabula");
    expect(parseChannelAlias("!клип tabula 10:00 - 12:30", aliases)).toBe("tabula");
  });

  test("регистр не важен", () => {
    expect(parseChannelAlias("!клип WLG 10:00", aliases)).toBe("welovegames");
    expect(parseChannelAlias("!клип ТАБУЛА 10:00", aliases)).toBe("tabula");
  });

  test("границы слова строгие — подстроки не матчатся", () => {
    expect(parseChannelAlias("!клип wlgx 10:00", aliases)).toBeNull();
    expect(parseChannelAlias("!клип влгоп 10:00", aliases)).toBeNull();
    expect(parseChannelAlias("!клип xwlg 10:00", aliases)).toBeNull();
    expect(parseChannelAlias("!клип tabula2 10:00", aliases)).toBeNull();
  });

  test("parseVodMessage: алиас вместо ссылки — платформа twitch, vodId ждёт резолва", () => {
    const parsed = parseVodMessage("!клип влг 10:00 - 12:30", aliases);
    expect(parsed.platform).toBe("twitch");
    expect(parsed.vodId).toBeNull();
    expect(parsed.vodUrl).toBeNull();
    expect(parsed.channel).toBe("welovegames");
    expect(parsed.ranges).toHaveLength(1);
  });

  test("ссылка важнее алиаса", () => {
    const parsed = parseVodMessage("!клип https://twitch.tv/videos/123 влг 10:00 - 12:30", aliases);
    expect(parsed.vodId).toBe("123");
    expect(parsed.channel).toBe("welovegames");
  });

  test("без алиаса и без ссылки — платформа не определяется", () => {
    const parsed = parseVodMessage("!клип просто текст", aliases);
    expect(parsed.platform).toBeNull();
    expect(parsed.channel).toBeNull();
  });
});

describe("интероп-запросы от внешних ботов", () => {
  const command = '!клип {from:"twitch";to:"182834";username:"Nikitawrik"} 05:00 - 10:00 480p';

  test("разбирает payload в свободном формате", () => {
    const payload = parseInteropPayload(command);
    expect(payload).not.toBeNull();
    expect(payload!.from).toBe("twitch");
    expect(payload!.to).toBe(182834);
    expect(payload!.username).toBe("Nikitawrik");
    expect(payload!.channel).toBeNull();
  });

  test("строгий JSON тоже принимается", () => {
    const payload = parseInteropPayload(
      '!клип {"from":"twitch","to":"182834","username":"Nikitawrik","channel":"welovegames"} 05:00 - 10:00',
    );
    expect(payload!.from).toBe("twitch");
    expect(payload!.to).toBe(182834);
    expect(payload!.username).toBe("Nikitawrik");
    expect(payload!.channel).toBe("welovegames");
  });

  test("chat id канала — с минусом", () => {
    expect(parseInteropPayload('!клип {from:"twitch";to:"-1001234567890"} 05:00 - 10:00')!.to).toBe(
      -1001234567890,
    );
  });

  test("to не число → null (запрос отклоняется валидацией)", () => {
    expect(parseInteropPayload('!клип {from:"twitch";to:"abc"} 05:00 - 10:00')!.to).toBeNull();
  });

  test("обычная команда без payload → null", () => {
    expect(parseInteropPayload("!клип https://twitch.tv/videos/123 05:00 - 10:00")).toBeNull();
    expect(parseInteropPayload("!клип влг 05:00 - 10:00")).toBeNull();
  });

  test("блок без полей from/to → не интероп", () => {
    expect(parseInteropPayload('!клип {note:"что-то"} 05:00 - 10:00')).toBeNull();
  });

  test("stripInteropPayload вырезает блок, таймкоды и качество читаются", () => {
    const stripped = stripInteropPayload(command);
    expect(stripped).not.toContain("{");
    expect(stripped).not.toContain("182834");

    const parsed = parseVodMessage(stripped, {});
    expect(parsed.ranges).toHaveLength(1);
    expect([parsed.ranges[0]!.startSeconds, parsed.ranges[0]!.endSeconds]).toEqual([300, 600]);
    expect(parsed.qualities).toEqual(["480p"]);
  });

  test("цифры из payload не ломают разбор интервалов", () => {
    const parsed = parseVodMessage(stripInteropPayload(command), {});
    expect(parsed.ranges).toHaveLength(1);
    expect(parsed.ranges[0]!.rawStart).toBe("05:00");
    expect(parsed.ranges[0]!.rawEnd).toBe("10:00");
  });
});

describe("pickLiveVod (VOD текущего эфира)", () => {
  const vod = (id: string, broadcastId: string) => ({ id, broadcast_id: broadcastId }) as TwitchVodInfo;
  const info = (online: boolean, id: string) => ({ online, id }) as TwitchStreamInfo;

  test("эфир онлайн и broadcast id совпал — берём VOD последнего архива", () => {
    const live = pickLiveVod([vod("123", "456")], info(true, "456"));
    expect(live?.vodId).toBe("123");
    expect(live?.vodUrl).toBe("https://www.twitch.tv/videos/123");
  });

  test("канал офлайн — VOD нет", () => {
    expect(pickLiveVod([vod("123", "456")], info(false, "456"))).toBeNull();
  });

  test("broadcast id не совпал — архив чужой, VOD нет", () => {
    expect(pickLiveVod([vod("123", "456")], info(true, "789"))).toBeNull();
  });

  test("архивов нет — VOD нет", () => {
    expect(pickLiveVod([], info(true, "456"))).toBeNull();
  });
});

describe("parseVkMasterPlaylist (реальный формат VK: относительные URL, произвольный порядок параметров)", () => {
  const master = `https://vkvd.okcdn.ru/srcIp/1.2.3.4/pr/71/x.m3u8`;
  const playlist = [
    "#EXTM3U",
    '#EXT-X-STREAM-INF:QUALITY=mobile,BANDWIDTH=212992,RESOLUTION=256x144,FRAME-RATE=60.000,CODECS="avc1.42001e,mp4a.40.2"',
    "mob/track.m3u8",
    "#EXT-X-STREAM-INF:QUALITY=fullhd,BANDWIDTH=5063647,RESOLUTION=1920x1080,FRAME-RATE=60.000,CODECS=",
    "fhd/track.m3u8",
  ].join("\n");

  test("парсит варианты и склеивает URL с базой", () => {
    const variants = parseVkMasterPlaylist(playlist, master);
    expect(variants).toHaveLength(2);
    expect(variants[0]!.url).toBe("https://vkvd.okcdn.ru/srcIp/1.2.3.4/pr/71/mob/track.m3u8");
    expect(variants[1]!.bandwidth).toBe(5063647);
    expect(variants[1]!.video).toBe("1080p60");
  });

  test("выбор качества общий с Twitch", () => {
    const variants = parseVkMasterPlaylist(playlist, master);
    expect(pickVariant(variants).video).toBe("1080p60");
    expect(pickVariant(variants, "144p").video).toBe("144p60");
  });

  test("пустой манифест — пустой список", () => {
    expect(parseVkMasterPlaylist("#EXTM3U", master)).toHaveLength(0);
  });
});

describe("транскрипт: лимиты Groq free tier", () => {
  test("основная модель V3, фолбэк turbo (у них раздельные счётчики ASH/ASD)", () => {
    expect(PRIMARY_STT_MODEL).toBe("whisper-large-v3");
    expect(FALLBACK_STT_MODEL).toBe("whisper-large-v3-turbo");
  });

  test("лимит файла 25 MB — это ~20 минут AAC 160 kbps", () => {
    expect(GROQ_MAX_FILE_BYTES).toBe(26214400);
    // 20 мин * 160 kbps / 8 = 24 МБ, в лимит влезает
    expect((20 * 60 * 160_000) / 8).toBeLessThan(GROQ_MAX_FILE_BYTES);
  });

  test("formatRetryAfter: до 90с — секунды, дальше — минуты", () => {
    expect(formatRetryAfter(2)).toBe("через 2с");
    expect(formatRetryAfter(89)).toBe("через 89с");
    expect(formatRetryAfter(90)).toBe("через ~2 мин");
    expect(formatRetryAfter(3600)).toBe("через ~60 мин");
    expect(formatRetryAfter(null)).toBe("неизвестно");
  });
});
