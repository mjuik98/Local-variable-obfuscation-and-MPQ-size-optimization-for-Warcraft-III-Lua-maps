import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { crc32 } from '../src/mpq.mjs';

const crypt = new Uint32Array(1280);
let seed = 0x100001;
for (let low = 0; low < 256; low++) {
    for (let high = 0; high < 5; high++) {
        seed = (seed * 125 + 3) % 0x2aaaab;
        const first = (seed & 0xffff) << 16;
        seed = (seed * 125 + 3) % 0x2aaaab;
        crypt[high * 256 + low] = (first | (seed & 0xffff)) >>> 0;
    }
}
export function fixtureHash(name, type) {
    let a = 0x7fed7fed, b = 0xeeeeeeee;
    // Warcraft III hashes UTF-8 bytes and folds only ASCII letters and slashes.
    for (const c of Buffer.from(name, 'utf8').map(byte => byte === 47 ? 92 : byte >= 97 && byte <= 122 ? byte - 32 : byte)) {
        a = (crypt[type * 256 + c] ^ (a + b)) >>> 0;
        b = (c + a + b + (b << 5) + 3) >>> 0;
    }
    return a;
}
export function fixtureTransform(input, key, encrypt = false) {
    const bytes = Buffer.from(input);
    let state = 0xeeeeeeee;
    for (let i = 0; i + 4 <= bytes.length; i += 4) {
        state = (state + crypt[1024 + (key & 255)]) >>> 0;
        const original = bytes.readUInt32LE(i), result = (original ^ (key + state)) >>> 0;
        bytes.writeUInt32LE(result, i);
        key = (((~key << 21) + 0x11111111) | (key >>> 11)) >>> 0;
        state = ((encrypt ? original : result) + state + (state << 5) + 3) >>> 0;
    }
    return bytes;
}
function encode(raw, name, start, flags, level, sectorSize) {
    if (!(flags & 0x200)) return Buffer.from(raw);
    const count = Math.ceil(raw.length / sectorSize), offsets = Buffer.alloc((count + 1) * 4), chunks = [];
    let cursor = offsets.length, key = fixtureHash(name.split(/[\\/]/).pop(), 3);
    if (flags & 0x20000) key = ((key + start) ^ raw.length) >>> 0;
    for (let i = 0; i < count; i++) {
        offsets.writeUInt32LE(cursor, i * 4);
        const part = raw.subarray(i * sectorSize, (i + 1) * sectorSize);
        const compressed = Buffer.concat([Buffer.from([2]), zlib.deflateSync(part, { level })]);
        let packed = compressed.length < part.length ? compressed : part;
        if (flags & 0x10000) packed = fixtureTransform(packed, (key + i) >>> 0, true);
        chunks.push(packed);
        cursor += packed.length;
    }
    offsets.writeUInt32LE(cursor, count * 4);
    return Buffer.concat([flags & 0x10000 ? fixtureTransform(offsets, (key - 1) >>> 0, true) : offsets, ...chunks]);
}

// Basic callers supply Map<string, Buffer> or [name, Buffer][]. Rich record values
// and options.records/aliases let MPQ tests exercise locales, orphans and encryption.
// All fixtures remain in memory; this helper never creates a map file.
export function createTestMap(entries, options = {}) {
    const records = [...entries].map(([name, value]) => ({ name, ...(Buffer.isBuffer(value) ? { data: value } : value) }));
    records.push(...(options.records ?? []).map(record => ({ ...record })));
    const known = records.filter(record => record.name !== undefined).map(record => record.name);
    known.push(...(options.aliases ?? []).map(alias => alias.name));
    if (options.listfile !== false && !records.some(record => record.name?.toLowerCase() === '(listfile)')) {
        known.push('(listfile)');
        if (options.attributes) known.push('(attributes)');
        records.push({ name: '(listfile)', data: Buffer.from([...new Set(known)].join('\r\n') + '\r\n') });
    }
    if (options.attributes) records.push({ name: '(attributes)', data: Buffer.alloc(0) });
    // Storm reads archives only at 512-byte aligned offsets, like editor maps.
    const suppliedPrefix = options.prefix ?? Buffer.from('HM3W-memory-test\0');
    const prefix = Buffer.concat([suppliedPrefix, Buffer.alloc((512 - suppliedPrefix.length % 512) % 512)]);
    const count = records.length;
    const hashCount = options.hashCount ?? 64, sectorShift = options.sectorShift ?? 0, sectorSize = 512 * 2 ** sectorShift;
    const hashes = Buffer.alloc(hashCount * 16, 0xff), blocks = Buffer.alloc(count * 16);
    if (options.attributes) {
        const attributes = Buffer.alloc(8 + count * 28);
        attributes.writeUInt32LE(100, 0); attributes.writeUInt32LE(7, 4);
        records.forEach((record, index) => {
            const data = Buffer.from(record.decoded ?? record.data);
            attributes.writeUInt32LE(crc32(data), 8 + index * 4);
            attributes.writeBigUInt64LE(BigInt(100 + index), 8 + count * 4 + index * 8);
            createHash('md5').update(data).digest().copy(attributes, 8 + count * 12 + index * 16);
        });
        records[count - 1].data = attributes;
    }
    function addHash(name, index, locale = 0) {
        let slot = fixtureHash(name, 0) % hashCount;
        for (let attempt = 0; attempt < hashCount; attempt++) {
            if (hashes.readUInt32LE(slot * 16 + 12) === 0xffffffff) {
                hashes.writeUInt32LE(fixtureHash(name, 1), slot * 16);
                hashes.writeUInt32LE(fixtureHash(name, 2), slot * 16 + 4);
                hashes.writeUInt32LE(locale, slot * 16 + 8);
                hashes.writeUInt32LE(index, slot * 16 + 12);
                return;
            }
            slot = (slot + 1) % hashCount;
        }
        throw new Error('Fixture hash table is full');
    }
    let cursor = 32;
    records.forEach((record, index) => {
        const flags = record.flags ?? 0x80000000, start = record.start ?? cursor + (options.gap ?? 0);
        const raw = Buffer.from(record.decoded ?? record.data);
        const packed = record.decoded !== undefined ? Buffer.from(record.data) : encode(raw, record.name ?? 'orphan', start, flags, record.level ?? 6, sectorSize);
        record.packed = packed;
        blocks.writeUInt32LE(start, index * 16);
        blocks.writeUInt32LE(packed.length, index * 16 + 4);
        blocks.writeUInt32LE(record.length ?? raw.length, index * 16 + 8);
        blocks.writeUInt32LE(flags, index * 16 + 12);
        cursor = Math.max(cursor, start + packed.length);
        if (record.name !== undefined) addHash(record.name, index, record.locale ?? 0);
    });
    for (const alias of options.aliases ?? []) {
        const index = records.findIndex(record => record.name === alias.target);
        assert(index >= 0, 'Missing fixture alias target');
        addHash(alias.name, index, alias.locale ?? 0);
    }
    const hashOffset = cursor + (options.gap ?? 0), blockOffset = hashOffset + hashes.length, archiveSize = blockOffset + blocks.length;
    const output = Buffer.alloc(prefix.length + archiveSize);
    prefix.copy(output);
    const header = output.subarray(prefix.length, prefix.length + 32);
    Buffer.from([77, 80, 81, 26]).copy(header);
    header.writeUInt32LE(32, 4); header.writeUInt32LE(archiveSize, 8); header.writeUInt16LE(sectorShift, 14);
    header.writeUInt32LE(hashOffset, 16); header.writeUInt32LE(blockOffset, 20);
    header.writeUInt32LE(hashCount, 24); header.writeUInt32LE(count, 28);
    records.forEach((record, index) => record.packed.copy(output, prefix.length + blocks.readUInt32LE(index * 16)));
    fixtureTransform(hashes, fixtureHash('(hash table)', 3), true).copy(output, prefix.length + hashOffset);
    fixtureTransform(blocks, fixtureHash('(block table)', 3), true).copy(output, prefix.length + blockOffset);
    return output;
}
export function inspectTestTables(bytes) {
    const offset = bytes.indexOf(Buffer.from([77, 80, 81, 26])), header = bytes.subarray(offset, offset + 32);
    const hashOffset = header.readUInt32LE(16), blockOffset = header.readUInt32LE(20);
    return { offset, header,
        hashes: fixtureTransform(bytes.subarray(offset + hashOffset, offset + hashOffset + header.readUInt32LE(24) * 16), fixtureHash('(hash table)', 3)),
        blocks: fixtureTransform(bytes.subarray(offset + blockOffset, offset + blockOffset + header.readUInt32LE(28) * 16), fixtureHash('(block table)', 3)) };
}
export function mutateTestMap(bytes, change) {
    const output = Buffer.from(bytes), state = inspectTestTables(output);
    change(state, output);
    fixtureTransform(state.hashes, fixtureHash('(hash table)', 3), true).copy(output, state.offset + state.header.readUInt32LE(16));
    fixtureTransform(state.blocks, fixtureHash('(block table)', 3), true).copy(output, state.offset + state.header.readUInt32LE(20));
    return output;
}
