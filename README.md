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

Telegram-бот, который по команде `!клип` вырезает один или несколько фрагментов из Twitch VOD, склеивает HLS-сегменты в MP4 через FFmpeg (без перекодирования, `copy`) и загружает готовые клипы обратно в чат/канал.

Что умеет:

- парсинг ссылки на VOD (`twitch.tv/videos/<id>`, включая `www` / `m` subdomain и вариант без протокола) и временных интервалов (`СС`, `ММ:СС`, `ЧЧ:ММ:СС`);
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
!клип <ссылка на VOD> <интервал> [<интервал> ...] [<качество> ...]
```

Примеры:

```
!клип https://www.twitch.tv/videos/123456 10:00 - 12:30
!клип https://twitch.tv/videos/123 10:00 - 11:00 720p
!клип https://twitch.tv/videos/123 10:00-10:45 12:00-12:30 1080p 720p
```

Правила парсинга (`src/utils.ts`):

- VOD ID — первое совпадение `twitch.tv/videos/<digits>` (протокол и `www.`/`m.` опциональны);
- интервалы — паттерн `<время> - <время>`, время в формате `СС` / `ММ:СС` / `ЧЧ:ММ:СС`, разделитель — `-`, `–`, `—`, `~` и др.;
- качества — все совпадения `<цифры>p` (`720p`, `1080p60` матчится на `720p`/`1080p` либо на высоту из `resolution`), порядок сохраняется, дубли схлопываются; если качеств нет — берётся максимальное из манифеста; если указано несколько — берётся первое найденное в манифесте.

Что происходит дальше:

1. бот шлёт статус-пост `📥 Запрос принят!` со списком клипов в очереди;
2. для каждого клипа: получение HLS → ремукс MP4 → загрузка в Telegram, статус-строка обновляется (`🔄 → ⚙️ → ⬆️ → ✅`);
3. готовый клип приходит видео-файлом с подписью: таймкоды, длительность, качество (`1080p (1920x1080 @ 60fps)`), размер/битрейт, статистика звука, время обработки, ссылка на VOD;
4. при полном успехе всех клипов статус-пост удаляется, чтобы не мусорить; при частичных ошибках остаётся с диагностикой по каждому клипу.

Ограничения (захардкожены в `src/telegram.ts`):

- длительность одного клипа ≤ 30 минут;
- размер готового MP4 ≤ 4 ГБ;
- временные файлы — `tmp/clip_<vod>_<start>_<end>.mp4` (+ `.in.tmp` на время ремукса), удаляются в `finally` после каждого клипа;
- сессия Telegram MTProto — `db/session.sqlite` (по умолчанию).

### Possible Exceptions

| Сообщение в статусе                                                      | Причина                                                                                                                       |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `❌ Ошибка парсинга команды`                                             | текст не распарсился (битый формат времени)                                                                                   |
| `❌ Ошибка: не удалось извлечь VOD ID`                                   | нет ссылки вида `twitch.tv/videos/<id>`                                                                                       |
| `❌ Ошибка: не найдены временные интервалы`                              | нет интервалов вида `10:00 - 12:30`                                                                                           |
| `❌ ... — некорректный интервал`                                         | `start >= end` или невалидные секунды                                                                                         |
| `❌ ... — превышен лимит длительности (X мин > 30 мин)`                  | клип длиннее `MAX_DURATION_SECONDS`                                                                                           |
| `❌ ... — превышен лимит размера (X GB > 4.0 GB)`                        | готовый MP4 больше `MAX_FILE_SIZE_BYTES`                                                                                      |
| `❌ ... — качество 2160p не найдено (доступно: ...). Ничего не скачано.` | `QualityNotFoundError`: запрошенного качества нет в манифесте; остальные клипы помечаются `⏭ пропущен (качество не найдено)` |
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
| `PROXY`     | нет         | —                   | Любое непустое значение включает прокси `boostyflare` для Twitch metadata                  |
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
- Структура кода: `src/main.ts` (вход) → `src/telegram.ts` (хендлер `!клип`, статусы, загрузка) → `src/hls.ts` (варианты, сегменты, unmute) → `src/ffmpeg.ts` (ремукс в файл/стрим) → `src/utils.ts` (парсинг команды) → `src/config.ts` (env/flags) → `src/logger.ts`

<p align="right">(<a href="#top">back to top</a>)</p>
