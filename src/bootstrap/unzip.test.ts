import { strictEqual, throws } from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { describe, it } from 'node:test';

import { extractFromZip } from './unzip.js';

/**
 * Собирает ZIP руками: готового упаковщика в стандартной библиотеке нет, а
 * проверить распаковку нужно — это единственное место, где мы разбираем чужой
 * бинарный формат, и ошибка здесь означала бы битый бинарник vault.
 */
const buildZip = (entries: Array<{ name: string; content: Buffer; store?: boolean }>): Buffer => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const payload = entry.store ? entry.content : deflateRawSync(entry.content);
    const method = entry.store ? 0 : 8;
    const name = Buffer.from(entry.name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(name.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, payload);
    centrals.push(central, name);
    offset += local.length + name.length + payload.length;
  }

  const localBlock = Buffer.concat(locals);
  const centralBlock = Buffer.concat(centrals);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBlock.length, 12);
  eocd.writeUInt32LE(localBlock.length, 16);

  return Buffer.concat([localBlock, centralBlock, eocd]);
};

describe('extractFromZip', () => {
  it('распаковывает сжатый файл', () => {
    // Содержимое длиннее и с повторами — иначе deflate может оказаться
    // больше исходника и тест не проверит собственно распаковку.
    const content = Buffer.from('#!/bin/sh\n'.repeat(500));
    const zip = buildZip([{ name: 'vault', content }]);
    strictEqual(extractFromZip(zip, 'vault').equals(content), true);
  });

  it('распаковывает файл, сохранённый без сжатия', () => {
    const content = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
    const zip = buildZip([{ name: 'vault', content, store: true }]);
    strictEqual(extractFromZip(zip, 'vault').equals(content), true);
  });

  it('находит нужный файл среди нескольких', () => {
    const zip = buildZip([
      { name: 'LICENSE.txt', content: Buffer.from('MPL'.repeat(100)) },
      { name: 'vault', content: Buffer.from('binary'.repeat(100)) }
    ]);
    strictEqual(extractFromZip(zip, 'vault').toString(), 'binary'.repeat(100));
  });

  it('сообщает, если файла в архиве нет', () => {
    const zip = buildZip([{ name: 'LICENSE.txt', content: Buffer.from('MPL'.repeat(100)) }]);
    throws(() => extractFromZip(zip, 'vault'), /нет файла vault/);
  });

  it('не притворяется, что разобрал не-ZIP', () => {
    throws(() => extractFromZip(Buffer.alloc(64), 'vault'), /не похоже на zip/i);
  });
});
