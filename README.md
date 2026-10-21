<!--suppress HtmlUnknownAnchorTarget, HtmlDeprecatedAttribute -->
<div id="top"></div>

<div align="center">
  <a href="https://github.com/wlgdev/wlgofficebot/actions/workflows/secrets-update.yml">
    <img src="https://github.com/wlgdev/wlgofficebot/actions/workflows/secrets-update.yml/badge.svg" alt="status"/>
  </a>
</div>
<h1 align="center">
  wlgofficebot
</h1>

<p align="center">
  Telegram-бот для нарезки клипов из Twitch VOD канала
</p>

<div align="center">
  📦 :octocat:
</div>
<div align="center">
  <img src="./docs/description.webp" alt="description"/>
</div>

<!-- TABLE OF CONTENT -->
<details>
  <summary>Table of Contents</summary>
  <ol>
    <li>
      <a href="#-description">📃 Description</a>
      <ul>
        <li><a href="#built-with">Built With</a></li>
      </ul>
    </li>
    <li>
      <a href="#-getting-started">🪧 Getting Started</a>
      <ul>
        <li><a href="#prerequisites">Prerequisites</a></li>
        <li><a href="#installation">Installation</a></li>
      </ul>
    </li>
    <li>
      <a href="#%EF%B8%8F-how-to-use">⚠️ How to use</a>
      <ul>
        <li><a href="#possible-exceptions">Possible Exceptions</a></li>
      </ul>
    </li>
    <li>
      <a href="#%EF%B8%8F-deployment">⬆️ Deployment</a>
      <ul>
        <li><a href="#environment-variables">Environment Variables</a></li>
        <li><a href="#cli-arguments">CLI Arguments</a></li>
      </ul>
    </li>
    <li>
      <a href="#-reference">🔗 Reference</a>
    </li>
  </ol>
</details>

<br>

## 📃 Description

Telegram-бот, который по команде `!клип` вырезает один или несколько фрагментов из Twitch VOD или VK Видео, склеивает HLS-сегменты в MP4 через FFmpeg (без перекодирования, `copy`) и загружает готовые клипы обратно в чат/канал.

Что умеет:

- парсинг ссылки на видео (`twitch.tv/videos/<id>`, `vkvideo.ru/video-<owner>_<id>` / `live-`, `vk.com/clip-`; включая `www` / `m` subdomain и вариант без протокола) и временных интервалов (`СС`, `ММ:СС`, `ЧЧ:ММ:СС`);
- выбор качества (`720p`, `1080p`, ...; по умолчанию — максимальное из манифеста);
- восстановление замьюченных сегментов (пробует `-unmuted` вариант файла, считает статистику `размьючено N/M`);
- очередь из нескольких клипов в одном сообщении со статус-постом и live-прогрессом;
- лимиты: длительность клипа до 30 минут, размер файла до 4 ГБ;
- работа в группах, супергруппах и каналах (в каналах — без reply, обычным сообщением);
- опциональный прокси для Twitch API/metadata и Twitch OAuth-токен.

<p align="right">(<a href="#top">back to top</a>)</p>

### Built With

- [Bun 1.4+](https://bun.com) + [TypeScript](https://www.typescriptlang.org/) (ESNext, `module: Preserve`)
- [@mtcute/bun + @mtcute/dispatcher ^0.32.0](https://github.com/mtcute/mtcute) — Telegram client (MTProto, bot login)
- [@shevernitskiy/scraperator](https://jsr.io/@shevernitskiy/scraperator) — `Twitch.vodHLSMetadata()` для получения HLS-манифеста VOD
- [FFmpeg](https://ffmpeg.org/) (внешний бинарь: `ffmpeg.exe` рядом на Windows, системный `ffmpeg` на Linux) — ремукс HLS → MP4
- [@shevernitskiy/llm](https://jsr.io/@shevernitskiy/llm) — `Groq.transcribe()` для Whisper и `Gemini.request()` для причёсывания текста

## 🪧 Getting Started

Бот запускается из исходников через Bun (dev) либо как скомпилированный бинарь (`bun build --compile`, env зашит через `--env=inline`).

### Prerequisites

- [Bun](https://bun.sh/docs/installation) >= 1.4
- FFmpeg бинарь:
  - Windows: `ffmpeg.exe` в корне проекта (уже лежит в репозитории) либо в PATH;
  - Linux: установленный `ffmpeg` (`apt/brew install ffmpeg`) либо файл рядом с бинарем бота;
- Telegram: `API_ID` + `API_HASH` (my.telegram.org) и токен бота (`BOT_TOKEN` от @BotFather). Боту нужна админка в канале с правом «Публикация сообщений», в группе — право писать сообщения;
- Twitch OAuth-токен (`OAUTH`) — опционально, нужен для приватных/саб-only VOD;
- Для обхода региональных ограничений Twitch — флаг `PROXY` (трафик metadata идёт через `https://boostyflare.mahahuha5816.workers.dev/`).

### Installation

```bash
bun install
cp .env.development .env.local  # или создай .env / .env.development вручную (см. Environment Variables)
bun --env-file=.env.development src/main.ts
```

Проверка без запуска бота (юнит-тесты парсеров, HLS-плейлистов и ремукса):

```bash
bun test
```

<p align="right">(<a href="#top">back to top</a>)</p>

## ⚠️ How to use

Бот реагирует только на сообщения из разрешённых чатов (`CHAT_ID`). Проверка связи:

```
!ping
→ pong
```

Нарезка клипа:

```
!клип <ссылка на видео> <интервал> [<интервал> ...] [<качество> ...]
```

Примеры:

```
!клип https://www.twitch.tv/videos/123456 10:00 - 12:30
!клип https://twitch.tv/videos/123 10:00 - 11:00 720p
!клип https://twitch.tv/videos/123 10:00-10:45 12:00-12:30 1080p 720p
!клип https://vkvideo.ru/video-46211765_456252477 10:00 - 12:30 1080p
!клип https://vkvideo.ru/live-46211765_456252477 1:00:00 - 1:10:00
```

### Клип с live-эфира (алиас канала)

Вместо ссылки можно указать канал — бот сам найдёт VOD текущей трансляции и нарежет клип по таймкодам **от начала эфира**:

```
!клип <канал> <интервал> [<интервал> ...] [<качество> ...]
```

```
!клип влг 10:00 - 12:30
!клип табула 1:00:00 - 1:10:00 720p
!аудио wlg 30:00 - 31:00
!транскрипт табула 5:00 - 15:00
```

| Алиас            | Twitch-канал    |
| ---------------- | --------------- |
| `влг`, `wlg`, `welovegames` | `welovegames` |
| `табула`, `tabula` | `tabula`      |

Алиасы задаются переменной `TWITCH_CHANNELS` (формат: `логин:алиас1,алиас2;логин2:алиас3`), дефолты — `влг/wlg/welovegames` и `табула/tabula`.

Как это работает (`src/twitch.ts`):

1. `Twitch.vods("TIME", 1, "ARCHIVE")` — последний архив канала;
2. `Twitch.streamInfo()` — состояние стрима;
3. если канал онлайн и `broadcast_id` последнего архива совпал со `stream id` из `streamInfo` — берём `vod id` этого архива и качаем его HLS-манифест (сегменты live-VOD доступны с начала эфира).

Если канал не в эфире или архив текущей трансляции ещё не создан — бот отвечает ошибкой и ничего не качает. Явная ссылка на VOD всегда важнее алиаса.

Правила парсинга (`src/utils.ts`):

- VOD ID — первое совпадение `twitch.tv/videos/<digits>` (протокол и `www.`/`m.` опциональны);
- VK ID — первое совпадение `vkvideo.ru|vk.com|vk.ru/(video|live|clip)?<owner>_<id>`, `owner` нормализуется к виду с ведущим минусом (требование VK API);
- алиас канала — первое совпадение `влг`/`wlg`/`welovegames`/`табула`/`tabula` как отдельного слова (границы строгие: `wlgx` не подходит); если в тексте есть ссылка — она важнее алиаса;
- интервалы — паттерн `<время> - <время>`, время в формате `СС` / `ММ:СС` / `ЧЧ:ММ:СС`, разделитель — `-`, `–`, `—`, `~` и др.;
- качества — все совпадения `<цифры>p` (`720p`, `1080p60` матчится на `720p`/`1080p` либо на высоту из `resolution`), порядок сохраняется, дубли схлопываются; если качеств нет — берётся максимальное из манифеста; если указано несколько — берётся первое найденное в манифесте.

### Расшифровка речи

```
!транскрипт <ссылка на видео> <интервал> [<интервал> ...]
```

Алиасы: `!транскрипция`, `!транс`, `!transcript`. Качество из команды игнорируется.

Выбор источника звука (`AudioPick` в `src/hls.ts`) — режимы различаются только фолбэком, когда в манифесте **нет отдельной `audio_only` дорожки**, а для Twitch VOD это обычное дело:

| Режим | Поведение | Фолбэк без `audio_only` |
| ----- | --------- | ----------------------- |
| `!клип` | качество из команды / максимальное | — |
| `!аудио` (`best`) | `audio_only`, иначе лучший AAC | максимальный bandwidth |
| `!транскрипт` (`cheapest`) | `audio_only`, иначе самый лёгкий поток | **минимальный** bandwidth |

Для `!транскрипт` это критично: видео всё равно выкинет ffmpeg, а качать 1080p60 ради AAC не нужно. На VOD `2901440797` фрагмент 13 минут весит 4.92 MB из `160p30` против 19.64 MB из `1080p60` — и скачивается вчетверо быстрее.

Конвейер (`src/transcribe.ts`):

1. аудио качается и ремуксится в M4A тем же пайплайном, что `!аудио` (`-c copy`, без перекодирования);
2. `POST /audio/transcriptions` на Groq — `whisper-large-v3`, язык зафиксирован либой как `ru`;
3. результат прогоняется через `gemini-3.5-flash-lite` (`thinkingLevel: low`) — промпт приводит разговорную расшифровку к читаемому виду, сохраняя смысл и слова;
4. на выходе `.txt`-файл с подписью, где указано: какая модель распознавала, был ли fallback и удалось ли причесать текст.

Ограничения Groq free tier:

| Параметр | Значение |
| -------- | -------- |
| Лимит файла | 25 MB (~20 минут AAC 160 kbps) |
| Аудио-секунд | 7 200/час и 28 800/сутки — **отдельно для каждой модели** |
| Транскрипция | 20 req/min, 2 000 req/сутки |

Обработка ошибок:

- `413` и превышение 20 минут ловятся до отправки — в статусе понятное сообщение с просьбой разбить интервал;
- `429` на Whisper V3 — один переход на `whisper-large-v3-turbo` (у неё свой счётчик аудио-секунд), весь остаток команды дальше идёт на turbo; `retry-after` из заголовков попадает в лог и в подпись;
- `429` на обеих моделях — текущий фрагмент помечается ошибкой со временем сброса, остальные `⏭ пропущен (лимит Groq)`;
- недоступный Gemini не роняет фрагмент: отдаётся сырая расшифровка с пометкой `⚠️ сырой текст без причесывания`, ровно один ретрай;
- пустой ответ Whisper (тишина, музыка) — `в этом фрагменте не распознано речи`. Учти: Whisper на не-речи часто галлюцинирует (классика — «Продолжение следует...»), это не отсекается проверкой на пустой ответ.

Что происходит дальше:

1. бот шлёт статус-пост `📥 Запрос принят!` со списком клипов в очереди;
2. для каждого клипа: получение HLS → ремукс MP4 → загрузка в Telegram, статус-строка обновляется (`🔄 → ⚙️ → ⬆️ → ✅`);
3. готовый клип приходит видео-файлом с подписью: таймкоды, длительность, качество (`1080p (1920x1080 @ 60fps)`), размер/битрейт, статистика звука, время обработки, ссылка на VOD;
4. при полном успехе всех клипов статус-пост удаляется, чтобы не мусорить; при частичных ошибках остаётся с диагностикой по каждому клипу.

Особенности VK Видео (`src/vk.ts`):

- метаданные берутся анонимным токеном через `Vk.getVideoByID("<owner>_<id>")`, оттуда же берётся `hls_ondemand`;
- master-манифест VK разбирается своим парсером: параметры читаются по именам (порядок у VK другой, чем у Twitch, а готовый метод пакета `liveHLSMetadata` на on-demand манифест не срабатывает), URL вариантов относительные — склеиваются с базой;
- качества те же, что и у Twitch (`144p`…`1440p`), по умолчанию максимальное;
- сегменты — TS (`sN.ts`), без init-сегмента, размьючивание не применяется (в подписи будет «🔊 чистый звук»);
- если `hls_ondemand` не отдан (идущая трансляция, закрытое видео) — понятная ошибка в статусе.

Ограничения (захардкожены в `src/telegram.ts`):

- длительность одного клипа ≤ 30 минут;
- размер готового MP4 ≤ 4 ГБ;
- временные файлы — `tmp/clip_<vod>_<start>_<end>.mp4` (+ `.in.tmp` на время ремукса), удаляются в `finally` после каждого клипа;
- сессия Telegram MTProto — `db/session.sqlite` (по умолчанию).

### Possible Exceptions

| Сообщение в статусе                                                      | Причина                                                                                                                       |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `❌ Ошибка парсинга команды`                                             | текст не распарсился (битый формат времени)                                                                                   |
| `❌ Ошибка: не удалось распознать ссылку (Twitch VOD или VK Видео)`         | нет ссылки вида `twitch.tv/videos/<id>` или `vkvideo.ru/video-<owner>_<id>`                                                  |
| `❌ Ошибка: не найдены временные интервалы`                              | нет интервалов вида `10:00 - 12:30`                                                                                           |
| `❌ ... — некорректный интервал`                                         | `start >= end` или невалидные секунды                                                                                         |
| `❌ ... — превышен лимит длительности (X мин > 30 мин)`                  | клип длиннее `MAX_DURATION_SECONDS`                                                                                           |
| `❌ ... — превышен лимит размера (X GB > 4.0 GB)`                        | готовый MP4 больше `MAX_FILE_SIZE_BYTES`                                                                                      |
| `❌ ... — качество 2160p не найдено (доступно: ...). Ничего не скачано.` | `QualityNotFoundError`: запрошенного качества нет в манифесте; остальные клипы помечаются `⏭ пропущен (качество не найдено)` |
| `❌ ... — лимит Groq исчерпан (... HTTP 429, повтор через ~37 мин)` | исчерпан лимит аудио-секунд Groq на обеих Whisper; остальные фрагменты `⏭ пропущен (лимит Groq)` |
| `❌ ... — слишком большой фрагмент для Groq (24.5 MB > 25 MB)` | M4A не влезает в лимит загрузки Groq free tier — разбей интервал пополам |
| `⚠️ ... — в этом фрагменте не распознано речи` | Whisper вернул пустой результат (тишина/музыка) |
| `❌ ... — ошибка: ...` (до 200 символов)                                 | ошибка сети/HLS/FFmpeg/Telegram на этом клипе, остальные продолжают обрабатываться                                            |
| `❌ Критическая ошибка: ...`                                             | упал весь хендлер — дописывается в статус-пост (или отдельным сообщением, если статус не был создан)                          |
| `CHAT_ADMIN_REQUIRED` в логах                                            | боту не дали админку в канале / добавили не того бота                                                                         |
| `API_ID / API_HASH / BOT_TOKEN / CHAT_ID is not defined` на старте       | не заданы обязательные env (процесс завершается с кодом 1)                                                                    |
| `FFmpeg binary ("ffmpeg[.exe]") not found`                               | бинарь не найден рядом с exe / в корне / в PATH (`src/ffmpeg.ts: resolveFfmpegBinary`)                                        |

<p align="right">(<a href="#top">back to top</a>)</p>

## ⬆️ Deployment

Сборка самодостаточных бинарей (env зашивается внутрь через `--env=inline`, `.env` берётся на момент сборки):

```bash
bun run build:windows  # dist/wlgofficebot.exe (target bun-windows-x64)
bun run build:linux    # dist/wlgofficebot (target bun-linux-x64)
```

Выкладка на сервер (кастомный скрипт, путь/юнит захардкожены в `package.json`):

```bash
bun run upload  # build:linux + bun E:/deploy.ts ./dist/wlgofficebot /opt/bots/wlgoffice/wlgofficebot wlgoffice
```

На проде рядом с бинарем должен лежать `ffmpeg` (Linux ищет через `which`, затем рядом с exe). `STORAGE` (`db/session.sqlite`) и `TMP_DIR` (`tmp/`) создаются автоматически при старте (`src/config.ts`). Перезапуск при падении уже встроен: `startBot()` ретраит коннект каждые 5 секунд, плюс глобальные хендлеры `unhandledRejection`/`uncaughtException` без падения процесса.

Запуск dev / prod:

```bash
bun --env-file=.env.development src/main.ts  # dev (скрипт bun run start)
./dist/wlgofficebot --api-id=... --bot-token=...  # prod-бинарь, env уже внутри, но можно переопределить флагами
```

### Environment Variables

| Переменная  | Обязательна | Дефолт              | Описание                                                                                   |
| ----------- | ----------- | ------------------- | ------------------------------------------------------------------------------------------ |
| `API_ID`    | да          | —                   | Telegram API ID (число)                                                                    |
| `API_HASH`  | да          | —                   | Telegram API hash                                                                          |
| `BOT_TOKEN` | да          | —                   | Токен бота от @BotFather                                                                   |
| `CHAT_ID`   | да          | —                   | Список разрешённых чатов через запятую, напр. `187038,-1002...` (минусы для групп/каналов) |
| `OAUTH`     | нет         | —                   | Twitch OAuth-токен для `vodHLSMetadata` (саб-only VOD)                                     |
| `GROQ_APIKEY` | нет       | —                   | Ключ Groq для `!транскрипт` (Whisper). Без него режим отдаёт ошибку, бот работает |
| `GEMINI_APIKEY` | нет     | —                   | Ключ Gemini для причёсывания текста. Без него отдаётся сырая расшифровка |
| `PROXY`     | нет         | —                   | Любое непустое значение включает прокси `boostyflare` для Twitch metadata                  |
| `TWITCH_CHANNELS` | нет   | `влг/wlg/welovegames`, `табула/tabula` | Алиасы Twitch-каналов: `логин:алиас1,алиас2;логин2:алиас3`             |
| `STORAGE`   | нет         | `db/session.sqlite` | Путь к SQLite-сессии mtcute                                                                |
| `TMP_DIR`   | нет         | `tmp`               | Каталог временных MP4                                                                      |

> `.env*` файлы в `.gitignore` — примеры значений не коммитить. Прод-сборка читает `.env`, dev-запуск — `.env.development`.

### CLI Arguments

Флаги переопределяют env (удобно для бинаря, разбираются в `src/config.ts`):

```
--api-id=<id> --api-hash=<hash> --bot-token=<token> --chat-id=<id1,id2> --proxy --oauth=<token>
```

`--proxy` — без значения (включает тот же `boostyflare` прокси). Невалидный набор (`API_ID` не число, пустой `CHAT_ID` и т.п.) — ошибка в консоль и `process.exit(1)`.

<p align="right">(<a href="#top">back to top</a>)</p>

## 🔗 Reference

- [Bun docs](https://bun.sh/docs) — рантайм, сборка (`bun build --compile`), тесты (`bun test`)
- [mtcute](https://github.com/mtcute/mtcute) — Telegram client (`@mtcute/bun`, `@mtcute/dispatcher`)
- [scraperator](https://jsr.io/@shevernitskiy/scraperator) — Twitch metadata/HLS (`Twitch.vodHLSMetadata`)
- [Twitch VOD / HLS](https://dev.twitch.tv/docs/video-broadcast/) — устройство VOD и манифестов
- [FFmpeg docs](https://ffmpeg.org/documentation.html) — ремукс (`-c copy`, `-movflags +faststart`), поиск `ffmpeg.exe` — `src/ffmpeg.ts: resolveFfmpegBinary`
- Структура кода: `src/main.ts` (вход) → `src/telegram.ts` (хендлеры `!клип`/`!аудио`/`!транскрипт`, статусы, загрузка) → `src/hls.ts` (общее ядро: варианты, сегменты, unmute) + `src/vk.ts` (VK-специфика) + `src/twitch.ts` (VOD текущего эфира по алиасу канала) → `src/ffmpeg.ts` (ремукс в файл/стрим) → `src/transcribe.ts` (Whisper + Gemini, лимиты Groq) → `src/utils.ts` (парсинг команды) → `src/config.ts` (env/flags) → `src/logger.ts`

<p align="right">(<a href="#top">back to top</a>)</p>
