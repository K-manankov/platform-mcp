import { inflateRawSync } from 'node:zlib';

/**
 * Минимальная распаковка ZIP: HashiCorp отдаёт vault архивом, а в Node нет
 * встроенного распаковщика.
 *
 * Зависимость ради этого тянуть не хочется (лишний пакет в цепочке поставки
 * ради одного файла), звать системный `unzip` — тоже: смысл автоустановки как
 * раз в том, чтобы не требовать ничего постороннего. Архив здесь предельно
 * простой: один-два файла, deflate или stored, без шифрования и Zip64.
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

/** Извлекает один файл по имени. Возвращает его содержимое. */
export const extractFromZip = (zip: Buffer, wanted: string): Buffer => {
  const eocd = findEndOfCentralDirectory(zip);
  const entries = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);

  for (let i = 0; i < entries; i += 1) {
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

    if (name === wanted) {
      if (zip.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
        throw new Error('Повреждённый ZIP: сбит локальный заголовок файла.');
      }
      // Длины полей в локальном заголовке могут отличаться от центрального —
      // читать их нужно именно отсюда.
      const localNameLength = zip.readUInt16LE(localOffset + 26);
      const localExtraLength = zip.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const raw = zip.subarray(dataStart, dataStart + compressedSize);

      if (method === 0) return Buffer.from(raw);
      if (method !== 8) {
        throw new Error(`ZIP: неподдерживаемый метод сжатия ${method} у файла ${name}.`);
      }

      const inflated = inflateRawSync(raw);
      if (inflated.length !== uncompressedSize) {
        throw new Error(
          `ZIP: размер после распаковки (${inflated.length}) не совпал с заявленным (${uncompressedSize}).`
        );
      }
      return inflated;
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }

  throw new Error(`В архиве нет файла ${wanted}.`);
};
