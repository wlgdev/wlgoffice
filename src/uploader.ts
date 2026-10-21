import { randomLong } from "@mtcute/core/utils.js";
import { tl } from "@mtcute/core";
import { stat, open } from "node:fs/promises";
import { basename } from "node:path";

/**
 * Свой загрузчик файлов в Telegram.
 *
 * Зачем: mtcute в upload-file.js выдаёт номер части (`filePart`) ДО чтения данных
 * из потока, а читает их уже под локом. При параллельной загрузке индекс и
 * содержимое части расходятся, и Telegram склеивает файл из переставленных
 * 128-килобайтных кусков — видео «запирается» на середине.
 *
 * Здесь номер части присваивается строго после того, как данные прочитаны,
 * поэтому содержимое и индекс всегда совпадают. Поток остаётся стриминговым:
 * файл целиком в память не читается.
 */

export interface UploadedFile {
  inputFile: tl.TypeInputFile;
  size: number;
  mime: string;
}

export interface UploadOptions {
  /** MIME-тип файла. По умолчанию определяется по расширению. */
  mime?: string;
  /** Размер одной части в байтах. По умолчанию 512 КБ (максимум Telegram). */
  partSize?: number;
  /** Имя файла, которое увидит Telegram. По умолчанию — basename пути. */
  fileName?: string;
  /** Колбэк прогресса: (загружено байт, всего байт). */
  progressCallback?: (uploaded: number, total: number) => void;
  abortSignal?: AbortSignal;
}

const MIME_BY_EXT: Record<string, string> = {
  mp4: "video/mp4",
  m4a: "audio/mp4",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  webm: "video/webm",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
};

const DEFAULT_PART_SIZE = 512 * 1024;
const MIN_PART_SIZE = 4096;

function guessMime(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/**
 * Загружает файл в Telegram частями, сохраняя соответствие «индекс ↔ данные».
 *
 * @param client клиент mtcute (TelegramClient из @mtcute/bun)
 * @param filePath путь к файлу на диске
 */
export async function uploadFile(client: any, filePath: string, options: UploadOptions = {}): Promise<UploadedFile> {
  const {
    mime = guessMime(filePath),
    partSize = DEFAULT_PART_SIZE,
    fileName = basename(filePath),
    progressCallback,
    abortSignal,
  } = options;

  const size = (await stat(filePath)).size;
  const chunkSize = Math.max(MIN_PART_SIZE, partSize);
  const partCount = Math.max(1, Math.ceil(size / chunkSize));

  const fileId = randomLong();
  const fh = await open(filePath, "r");

  let uploaded = 0;

  try {
    for (let partIndex = 0; partIndex < partCount; partIndex++) {
      abortSignal?.throwIfAborted();

      const offset = partIndex * chunkSize;
      const length = Math.min(chunkSize, size - offset);
      let buf = new Uint8Array(length);

      // Читаем строго с нужного смещения — позиция не зависит от порядка обработки.
      let read = 0;
      while (read < length) {
        const { bytesRead } = await fh.read(buf, read, length - read, offset + read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      if (read < length) {
        buf = buf.subarray(0, read);
      }

      await client.call(
        {
          _: "upload.saveBigFilePart",
          fileId,
          filePart: partIndex,
          fileTotalParts: partCount,
          bytes: buf,
        },
        {
          kind: "upload",
          maxRetryCount: Infinity,
          floodSleepThreshold: Infinity,
          abortSignal,
        },
      );

      uploaded += buf.length;
      progressCallback?.(uploaded, size);
    }
  } finally {
    await fh.close();
  }

  return {
    inputFile: {
      _: "inputFileBig",
      id: fileId,
      parts: partCount,
      name: fileName,
    },
    size,
    mime,
  };
}
