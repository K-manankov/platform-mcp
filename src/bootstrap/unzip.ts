import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

/**
 * Минимальная распаковка ZIP: HashiCorp отдаёт vault архивом, Keycloak —
 * целиком дистрибутивом под kcadm, а в Node нет встроенного распаковщика.
 *
 * Зависимость ради этого тянуть не хочется (лишний пакет в цепочке поставки),
 * звать системный `unzip` — тоже. Архивы здесь без шифрования и без Zip64.
 */
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** Комментарий архива не длиннее 64 КБ, дальше начала EOCD искать бессмысленно. */
const MAX_COMMENT = 0xffff;

const findEndOfCentralDirectory = (zip: Buffer): number => {
  const earliest = Math.max(0, zip.length - MAX_COMMENT - 22);
  for (let i = zip.length - 22; i >= earliest; i -= 1) {
    if (zip.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new Error('Не похоже на ZIP: не найдена запись End of Central Directory.');
};

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

const listEntries = (zip: Buffer): ZipEntry[] => {
  const eocd = findEndOfCentralDirectory(zip);
  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];

  for (let i = 0; i < count; i += 1) {
    if (zip.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error('Повреждённый ZIP: сбита структура центрального каталога.');
    }

    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const uncompressedSize = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');

    entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
};

const readEntryPayload = (zip: Buffer, entry: ZipEntry): Buffer => {
  if (zip.readUInt32LE(entry.localOffset) !== LOCAL_SIGNATURE) {
    throw new Error('Повреждённый ZIP: сбит локальный заголовок файла.');
  }
  // Длины полей в локальном заголовке могут отличаться от центрального —
  // читать их нужно именно отсюда.
  const localNameLength = zip.readUInt16LE(entry.localOffset + 26);
  const localExtraLength = zip.readUInt16LE(entry.localOffset + 28);
  const dataStart = entry.localOffset + 30 + localNameLength + localExtraLength;
  const raw = zip.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method !== 8) {
    throw new Error(`ZIP: неподдерживаемый метод сжатия ${entry.method} у файла ${entry.name}.`);
  }

  const inflated = inflateRawSync(raw);
  if (inflated.length !== entry.uncompressedSize) {
    throw new Error(
      `ZIP: размер после распаковки (${inflated.length}) не совпал с заявленным (${entry.uncompressedSize}).`
    );
  }
  return inflated;
};

/** Извлекает один файл по имени. Возвращает его содержимое. */
export const extractFromZip = (zip: Buffer, wanted: string): Buffer => {
  for (const entry of listEntries(zip)) {
    if (entry.name === wanted) return readEntryPayload(zip, entry);
  }
  throw new Error(`В архиве нет файла ${wanted}.`);
};

/**
 * Распаковывает все файлы архива в каталог. Защита от zip-slip: путь после
 * normalize обязан оставаться внутри targetDir.
 */
export const extractZipToDir = (zip: Buffer, targetDir: string): void => {
  const root = normalize(targetDir) + sep;
  mkdirSync(targetDir, { recursive: true, mode: 0o700 });

  for (const entry of listEntries(zip)) {
    if (entry.name.endsWith('/')) {
      const dir = join(targetDir, entry.name);
      if (!normalize(dir + sep).startsWith(root)) {
        throw new Error(`ZIP: недопустимый путь каталога ${entry.name}.`);
      }
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      continue;
    }

    const dest = join(targetDir, entry.name);
    if (!normalize(dest).startsWith(root)) {
      throw new Error(`ZIP: недопустимый путь файла ${entry.name}.`);
    }
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    writeFileSync(dest, readEntryPayload(zip, entry), { mode: 0o600 });
  }
};
