// MPQ v0 support for updating entries, adding assets and reclaiming unused space.
// Only zlib-compressed or uncompressed input entries are decoded.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { normalizeCompressionStrategies, SUPPORTED_OUTPUT_SECTOR_SHIFTS } from './config.mjs';
import { compressSectors } from './compress.mjs';

const crypt = new Uint32Array(1280);
const mapStates = new WeakMap();
const canonicalName = name => name.replaceAll('/', '\\').toUpperCase();
let seed = 0x100001;
for (let low = 0; low < 256; low++) {
    for (let high = 0; high < 5; high++) {
        seed = (seed * 125 + 3) % 0x2aaaab;
        const first = (seed & 0xffff) << 16;
        seed = (seed * 125 + 3) % 0x2aaaab;
        crypt[high * 256 + low] = (first | (seed & 0xffff)) >>> 0;
    }
}
function hash(name, type) {
    let a = 0x7fed7fed, b = 0xeeeeeeee;
    for (const c of Buffer.from(name.replaceAll('/', '\\').toUpperCase(), 'ascii')) {
        a = (crypt[type * 256 + c] ^ (a + b)) >>> 0;
        b = (c + a + b + (b << 5) + 3) >>> 0;
    }
    return a;
}

function transform(input, key, encrypt = false) {
    const bytes = Buffer.from(input);
    let state = 0xeeeeeeee;
    for (let i = 0; i + 4 <= bytes.length; i += 4) {
        state = (state + crypt[1024 + (key & 255)]) >>> 0;
        const inputWord = bytes.readUInt32LE(i);
        const outputWord = (inputWord ^ (key + state)) >>> 0;
        bytes.writeUInt32LE(outputWord, i);
        key = (((~key << 21) + 0x11111111) | (key >>> 11)) >>> 0;
        state = ((encrypt ? inputWord : outputWord) + state + (state << 5) + 3) >>> 0;
    }
    return bytes;
}

function fileKey(name, start, length, flags) {
    let key = hash(name.split(/[\\/]/).pop(), 3);
    if (flags & 0x20000) key = ((key + start) ^ length) >>> 0;
    return key;
}

export function crc32(bytes) {
    if (typeof zlib.crc32 === 'function') return zlib.crc32(bytes) >>> 0;
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

// Storm recognizes an archive header only at a 512-byte aligned offset. A
// signature elsewhere, for example inside a prefix, is not the game's archive.
export function findArchiveOffset(bytes) {
    for (let position = 0; position + 4 <= bytes.length; position += 512) {
        if (bytes.readUInt32LE(position) === 0x1a51504d) return position;
    }
    return -1;
}

export function openMap(input) {
    const bytes = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
    const offset = findArchiveOffset(bytes);
    assert(offset >= 0, 'MPQ header not found at a 512-byte aligned offset');
    const header = bytes.subarray(offset, offset + 32);
    assert.equal(header.length, 32, 'Truncated MPQ header');
    assert.equal(header.readUInt16LE(12), 0, 'Only MPQ v0 archives are supported');
    assert.equal(header.readUInt32LE(4), 32, 'Unsupported MPQ header size');
    const archiveEnd = offset + header.readUInt32LE(8);
    assert.equal(archiveEnd, bytes.length, 'Archive has a trailer/signature; refusing to modify it');
    const sectorShift = header.readUInt16LE(14);
    assert(sectorShift <= 23, 'Unsupported MPQ sector size shift: ' + sectorShift);
    const sectorSize = 512 * 2 ** sectorShift;
    const hashCount = header.readUInt32LE(24), blockCount = header.readUInt32LE(28);
    // Storm starts probing at hash & (count - 1); other table sizes are unreadable.
    assert(hashCount > 0 && Number.isInteger(Math.log2(hashCount)), 'MPQ hash table size must be a nonzero power of two');
    function table(field, count, name) {
        const start = offset + header.readUInt32LE(field);
        assert(start >= offset + 32 && start + count * 16 <= archiveEnd, 'Invalid MPQ table');
        return transform(bytes.subarray(start, start + count * 16), hash(name, 3));
    }
    const hashTable = table(16, hashCount, '(hash table)');
    const blockTable = table(20, blockCount, '(block table)');
    // Tables are immutable for this reader. Index both path hashes once while
    // retaining every matching slot, including distinct locale/alias records.
    const pathSlots = new Map();
    for (let p = 0; p < hashTable.length; p += 16) {
        if (hashTable.readUInt32LE(p + 12) >= blockCount) continue;
        const key = hashTable.readUInt32LE(p) + ':' + hashTable.readUInt32LE(p + 4);
        const slots = pathSlots.get(key);
        if (slots) slots.push(p);
        else pathSlots.set(key, [p]);
    }

    function matchingSlots(name) {
        return pathSlots.get(hash(name, 1) + ':' + hash(name, 2)) ?? [];
    }
    function indexOf(name) {
        const matches = matchingSlots(name);
        assert(matches.length <= 1, 'Multiple locale entries require explicit handling: ' + name);
        return matches.length ? hashTable.readUInt32LE(matches[0] + 12) : -1;
    }
    function has(name) {
        return matchingSlots(name).length > 0;
    }
    function listNames() {
        const list = read('(listfile)');
        if (!list) return [];
        const seen = new Set();
        return list.toString('utf8').split(/\r?\n/).filter(name => {
            if (!name || seen.has(canonicalName(name)) || !has(name)) return false;
            seen.add(canonicalName(name));
            return true;
        });
    }
    function inspect({ includeHashes = false, includeListedNames = true, names = [] } = {}) {
        assert(typeof includeListedNames === 'boolean', 'includeListedNames must be boolean');
        assert(Array.isArray(names) && names.every(name => typeof name === 'string' && name.length > 0 && /^[\x20-\x7e]+$/.test(name)), 'Inspection names must be explicit ASCII MPQ paths');
        const references = new Uint32Array(blockCount);
        for (let i = 0; i < hashCount; i++) {
            const index = hashTable.readUInt32LE(i * 16 + 12);
            if (index < blockCount) references[index]++;
        }
        const result = { formatVersion: 0, archiveOffset: offset, archiveSize: archiveEnd - offset,
            sectorSize, hashCount, blockCount, blocks: Array.from({ length: blockCount }, (_, index) => {
                const p = index * 16, flags = blockTable.readUInt32LE(p + 12);
                return { index, offset: blockTable.readUInt32LE(p), packedSize: blockTable.readUInt32LE(p + 4),
                    size: blockTable.readUInt32LE(p + 8), flags, live: Boolean(flags & 0x80000000), hashReferences: references[index] };
            }) };
        if (includeHashes) {
            result.hashes = Array.from({ length: hashCount }, (_, slot) => {
                const p = slot * 16;
                return { slot, hashA: hashTable.readUInt32LE(p), hashB: hashTable.readUInt32LE(p + 4),
                    localePlatform: hashTable.readUInt32LE(p + 8), blockIndex: hashTable.readUInt32LE(p + 12) };
            });
            const seen = new Set();
            result.namedEntries = [...(includeListedNames ? listNames() : []), ...names].filter(name => {
                const canonical = canonicalName(name);
                if (seen.has(canonical) || !has(name)) return false;
                seen.add(canonical); return true;
            }).map(name => ({ name, slots: matchingSlots(name).map(p => p / 16) }));
        }
        return result;
    }

    function read(name, skipUnsupported = false) {
        const index = indexOf(name);
        if (index < 0) return null;
        return readBlock(index, name, skipUnsupported);
    }

    // An unnamed block is decodable only when its key does not need a name.
    function readBlock(index, name = null, skipUnsupported = false) {
        const label = name ?? '#' + index;
        const p = index * 16, start = blockTable.readUInt32LE(p);
        const packed = blockTable.readUInt32LE(p + 4), length = blockTable.readUInt32LE(p + 8);
        const flags = blockTable.readUInt32LE(p + 12);
        assert(flags & 0x80000000, 'Entry is not live: ' + label);
        // Opaque input files remain replaceable even when we cannot decode them
        // for the optional identical-content comparison.
        if (skipUnsupported && ((flags & (0x100 | 0x1000000)) ||
            ((flags & 0x10000) && !(flags & 0x200)))) return null;
        assert.equal(flags & 0x100, 0, 'PKWARE compression is unsupported: ' + label);
        // Warcraft III ignores SINGLE_UNIT, unlike generic MPQ readers.
        // Accepting it here would let a self-readable but unplayable map pass validation.
        assert.equal(flags & 0x1000000, 0, 'Warcraft III does not support single-unit MPQ entries: ' + label);
        assert(offset + start + packed <= archiveEnd, 'Entry outside archive: ' + label);
        const data = bytes.subarray(offset + start, offset + start + packed);
        let key = 0;
        if (flags & 0x10000) {
            assert(name !== null, 'Encrypted MPQ block has no known name: ' + label);
            key = fileKey(name, start, length, flags);
        }
        function unpack(chunk, expected) {
            if (chunk.length === expected) return chunk;
            assert(flags & 0x200, 'Uncompressed length mismatch: ' + label);
            if (skipUnsupported && chunk[0] !== 2) return null;
            assert.equal(chunk[0], 2, 'Unsupported compression mask: ' + label);
            const result = zlib.inflateSync(chunk.subarray(1), { maxOutputLength: expected });
            assert.equal(result.length, expected);
            return result;
        }
        if (!(flags & 0x200)) {
            assert(!(flags & 0x10000), 'Encrypted raw sectors are unsupported');
            assert.equal(packed, length);
            return data;
        }
        const count = Math.ceil(length / sectorSize), tableSize = (count + 1) * 4;
        assert(tableSize <= data.length, 'Truncated MPQ sector table: ' + label);
        const sectors = flags & 0x10000 ? transform(data.subarray(0, tableSize), (key - 1) >>> 0) : data.subarray(0, tableSize);
        const chunks = [];
        for (let i = 0; i < count; i++) {
            const a = sectors.readUInt32LE(i * 4), b = sectors.readUInt32LE(i * 4 + 4);
            assert(a >= tableSize && b >= a && b <= data.length, 'Invalid sector offsets');
            let chunk = data.subarray(a, b);
            if (flags & 0x10000) chunk = transform(chunk, (key + i) >>> 0);
            const raw = unpack(chunk, Math.min(sectorSize, length - i * sectorSize));
            if (raw === null) return null;
            chunks.push(raw);
        }
        const result = Buffer.concat(chunks);
        assert.equal(result.length, length, 'Decoded MPQ entry length mismatch: ' + label);
        return result;
    }

    function validateArchive() {
        assert(!has('(signature)'), 'Signed maps are not supported');
        const live = [];
        const ranges = [[0, 32],
            [header.readUInt32LE(16), header.readUInt32LE(16) + hashTable.length],
            [header.readUInt32LE(20), header.readUInt32LE(20) + blockTable.length]];
        for (let i = 0; i < hashCount; i++) {
            const index = hashTable.readUInt32LE(i * 16 + 12);
            if (index >= 0xfffffffe) continue;
            assert(index < blockCount, 'Invalid MPQ block reference');
            assert(blockTable.readUInt32LE(index * 16 + 12) & 0x80000000, 'MPQ hash references an inactive block');
        }
        // Keep all live blocks, including files absent from (listfile), and retain
        // their indices so locale entries and attributes arrays remain aligned.
        for (let index = 0; index < blockCount; index++) {
            const p = index * 16, flags = blockTable.readUInt32LE(p + 12);
            if (!(flags & 0x80000000)) continue;
            const start = blockTable.readUInt32LE(p), size = blockTable.readUInt32LE(p + 4);
            assert(start >= 32 && offset + start + size <= archiveEnd, 'Invalid live MPQ payload range');
            const entry = { index, start, size, fixed: (flags & 0x30000) === 0x30000,
                data: bytes.subarray(offset + start, offset + start + size) };
            live.push(entry);
            if (size) ranges.push([start, start + size]);
            // FIX_KEY encryption includes the original MPQ-relative offset.
            // Pin these bytes instead of guessing names or changing encryption.
        }
        ranges.sort((a, b) => a[0] - b[0]);
        let end = 0;
        for (const [start, stop] of ranges) {
            if (start === stop) continue;
            assert(start >= end, 'Overlapping MPQ payloads or tables; refusing to compact');
            end = stop;
        }
        return live;
    }
    function compact() {
        const live = validateArchive(), pinned = live.filter(entry => entry.fixed);
        pinned.sort((a, b) => a.start - b.start);
        const free = [];
        let cursor = 32;
        for (const entry of pinned) {
            if (entry.start > cursor) free.push({ start: cursor, end: entry.start });
            cursor = Math.max(cursor, entry.start + entry.size);
        }
        free.push({ start: cursor, end: Infinity });
        const blocks = Buffer.from(blockTable);
        let payloadEnd = 32;
        for (const entry of live) {
            let start = entry.start;
            if (!entry.fixed) {
                // First-fit leaves small gaps available for later, smaller files.
                const gap = free.find(range => entry.size <= range.end - range.start);
                assert(gap, 'No MPQ payload placement available');
                start = gap.start;
                gap.start += entry.size;
            }
            blocks.writeUInt32LE(start, entry.index * 16);
            payloadEnd = Math.max(payloadEnd, start + entry.size);
        }
        const hashOffset = payloadEnd, blockOffset = hashOffset + hashTable.length;
        const size = blockOffset + blocks.length;
        // Pinned encryption may prevent useful reclamation. Never grow an archive
        // just to rearrange it, and make an already compact archive a bytewise no-op.
        if (offset + size >= bytes.length) return Buffer.from(bytes);
        const result = Buffer.alloc(offset + size);
        bytes.copy(result, 0, 0, offset + 32);
        for (const entry of live) entry.data.copy(result, offset + blocks.readUInt32LE(entry.index * 16));
        transform(hashTable, hash('(hash table)', 3), true).copy(result, offset + hashOffset);
        transform(blocks, hash('(block table)', 3), true).copy(result, offset + blockOffset);
        result.writeUInt32LE(size, offset + 8);
        result.writeUInt32LE(hashOffset, offset + 16);
        result.writeUInt32LE(blockOffset, offset + 20);
        openMap(result); // Recheck archive/table boundaries after serialization.
        assert.deepEqual(result.subarray(0, offset), bytes.subarray(0, offset), 'MPQ prefix preservation');
        assert.deepEqual(transform(result.subarray(offset + hashOffset, offset + blockOffset), hash('(hash table)', 3)), hashTable, 'MPQ hash/locale preservation');
        const verifiedBlocks = transform(result.subarray(offset + blockOffset), hash('(block table)', 3));
        for (let index = 0; index < blockCount; index++) {
            const p = index * 16, flags = blockTable.readUInt32LE(p + 12);
            assert.deepEqual(verifiedBlocks.subarray(p + 4, p + 16), blockTable.subarray(p + 4, p + 16), 'MPQ block metadata preservation');
            const oldStart = blockTable.readUInt32LE(p), newStart = verifiedBlocks.readUInt32LE(p);
            if (!(flags & 0x80000000) || (flags & 0x30000) === 0x30000) {
                assert.equal(newStart, oldStart, 'MPQ fixed/inactive block preservation');
            }
            if (flags & 0x80000000) {
                const packed = blockTable.readUInt32LE(p + 4);
                assert.deepEqual(result.subarray(offset + newStart, offset + newStart + packed),
                    bytes.subarray(offset + oldStart, offset + oldStart + packed), 'MPQ packed payload preservation');
            }
        }
        return result;
    }

    // Encode files with one batch of sectors, so large and small files share
    // the compression threads. Encrypted blocks keep a sector table even when
    // no sector compresses, since encrypted raw sector data cannot be read back.
    function encodeMany(items, levels, strategies, zopfli) {
        const sectors = [];
        const layout = items.map(({ contents, size = sectorSize }) => {
            const first = sectors.length, count = Math.ceil(contents.length / size);
            for (let i = 0; i < count; i++) sectors.push(contents.subarray(i * size, (i + 1) * size));
            return { first, count };
        });
        const packed = compressSectors(sectors, { levels, strategies, zopfli });
        return items.map(({ contents, keepSectors = false }, item) => {
            const { first, count } = layout[item], table = Buffer.alloc((count + 1) * 4), chunks = [table];
            let cursor = table.length;
            for (let i = 0; i < count; i++) {
                table.writeUInt32LE(cursor, i * 4);
                chunks.push(packed[first + i]);
                cursor += packed[first + i].length;
            }
            table.writeUInt32LE(cursor, count * 4);
            const compressed = Buffer.concat(chunks);
            return keepSectors || compressed.length < contents.length ? { data: compressed, flags: 0x80000200 } : { data: contents, flags: 0x80000000 };
        });
    }
    function encode(contents, levels, strategies, zopfli) {
        return encodeMany([{ contents }], levels, strategies, zopfli)[0];
    }
    function compressionLevels(levels = [6, 9]) {
        assert(Array.isArray(levels) && levels.length > 0 && levels.every(level => Number.isInteger(level) && level >= 0 && level <= 9), 'Invalid zlib compression levels');
        return [...new Set(levels)];
    }
    function replace(entries, options = {}) {
        validateArchive();
        const levels = compressionLevels(options.levels), strategies = normalizeCompressionStrategies(options.strategies === undefined ? ['default'] : options.strategies);
        const zopfli = options.zopfli ?? false;
        assert.equal(typeof zopfli, 'boolean', 'zopfli must be boolean');
        const encoded = new Map(), metadata = inspect();
        const requested = [...entries];
        assert(requested.every(entry => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && entry[0].length > 0 && !/[\0\r\n]/.test(entry[0])), 'Invalid MPQ replacement entries');
        assert.equal(new Set(requested.map(([name]) => canonicalName(name))).size, requested.length, 'Duplicate MPQ paths');
        const changes = new Map(requested.map(([name, contents]) => [canonicalName(name) === '(LISTFILE)' ? '(listfile)' : name, contents]));
        assert(![...changes.keys()].some(name => canonicalName(name) === '(ATTRIBUTES)'), 'Attributes are updated automatically');
        assert(![...changes.keys()].some(name => canonicalName(name) === '(SIGNATURE)'), 'Signed maps are not supported');
        const canonical = canonicalName;
        assert.equal(new Set([...changes.keys()].map(canonical)).size, changes.size, 'Duplicate MPQ paths');
        const same = new Map();
        for (const [name, contents] of changes) {
            assert(name.length > 0 && !/[\0\r\n]/.test(name), 'Invalid MPQ entry name');
            assert(Buffer.isBuffer(contents), 'Replacement contents must be a Buffer');
            const identical = read(name, true)?.equals(contents);
            if (identical && !options.recompress) changes.delete(name);
            else same.set(name, identical);
        }
        const candidates = encodeMany([...changes.values()].map(contents => ({ contents })), levels, strategies, zopfli);
        for (const [position, [name]] of [...changes].entries()) {
            const index = indexOf(name), identical = same.get(name), candidate = candidates[position];
            if (identical && candidate.data.length >= blockTable.readUInt32LE(index * 16 + 4)) { changes.delete(name); continue; }
            if (index >= 0) {
                const references = metadata.blocks[index].hashReferences;
                assert.equal(references, 1, 'Aliased entries cannot be replaced independently: ' + name);
            }
            encoded.set(name, candidate);
        }
        if (!changes.size) return compact();
        const additions = [...changes.keys()].filter(name => indexOf(name) < 0);
        if (additions.length) {
            const list = changes.get('(listfile)') ?? read('(listfile)');
            assert(list, 'Adding assets requires an existing MPQ listfile');
            const names = list.toString('utf8').split(/\r?\n/).filter(Boolean);
            const known = new Set(names.map(canonical));
            for (const name of additions) {
                if (!known.has(canonical(name))) { names.push(name); known.add(canonical(name)); }
            }
            const updated = Buffer.from(names.join('\r\n') + '\r\n');
            if (!read('(listfile)')?.equals(updated)) {
                changes.set('(listfile)', updated);
                encoded.delete('(listfile)');
            }
        }
        const hashes = Buffer.from(hashTable), indices = new Map();
        let nextBlock = blockCount;
        for (const name of changes.keys()) {
            let index = indexOf(name);
            if (index < 0) {
                let slot = -1;
                for (let step = 0; step < hashCount; step++) {
                    const p = ((hash(name, 0) + step) % hashCount) * 16;
                    if (hashes.readUInt32LE(p + 12) >= 0xfffffffe) { slot = p; break; }
                }
                assert(slot >= 0, 'MPQ hash table is full; cannot add ' + name);
                index = nextBlock++;
                hashes.writeUInt32LE(hash(name, 1), slot);
                hashes.writeUInt32LE(hash(name, 2), slot + 4);
                hashes.writeUInt32LE(0, slot + 8); // Neutral locale/platform.
                hashes.writeUInt32LE(index, slot + 12);
            }
            indices.set(name, index);
        }
        const attributes = read('(attributes)');
        if (attributes) {
            assert.equal(attributes.readUInt32LE(0), 100, 'Unsupported attributes version');
            const flags = attributes.readUInt32LE(4);
            assert.equal(flags & ~7, 0, 'Unsupported attribute flags');
            const expected = 8 + blockCount * ((flags & 1 ? 4 : 0) + (flags & 2 ? 8 : 0) + (flags & 4 ? 16 : 0));
            assert.equal(attributes.length, expected, 'Unexpected attributes size');
            const updated = Buffer.alloc(8 + nextBlock * ((flags & 1 ? 4 : 0) + (flags & 2 ? 8 : 0) + (flags & 4 ? 16 : 0)));
            attributes.copy(updated, 0, 0, 8);
            let oldStart = 8, newStart = 8;
            for (const [flag, stride] of [[1, 4], [2, 8], [4, 16]]) {
                if (!(flags & flag)) continue;
                attributes.copy(updated, newStart, oldStart, oldStart + blockCount * stride);
                oldStart += blockCount * stride;
                newStart += nextBlock * stride;
            }
            for (const [name, contents] of changes) {
                const index = indices.get(name);
                if (flags & 1) updated.writeUInt32LE(crc32(contents), 8 + index * 4);
                // Preserve timestamps; builds are deterministic for the same inputs.
                if (flags & 4) {
                    const start = 8 + nextBlock * ((flags & 1 ? 4 : 0) + (flags & 2 ? 8 : 0));
                    createHash('md5').update(contents).digest().copy(updated, start + index * 16);
                }
            }
            if (!updated.equals(attributes)) {
                changes.set('(attributes)', updated);
                indices.set('(attributes)', indexOf('(attributes)'));
            }
        }
        for (const name of changes.keys()) {
            const index = indexOf(name);
            if (index >= 0) assert.equal(metadata.blocks[index].hashReferences, 1, 'Aliased entries cannot be replaced independently: ' + name);
        }
        // Buffer.concat copies every chunk into the new archive. Keep the source
        // as a read-only chunk instead of allocating an intermediate full copy.
        const blocks = Buffer.alloc(nextBlock * 16), chunks = [bytes];
        blockTable.copy(blocks);
        let cursor = bytes.length;
        for (const [name, contents] of changes) {
            // Warcraft requires sector tables; single-unit compressed entries are never emitted.
            const { data, flags } = encoded.get(name) ?? encode(contents, levels, strategies, zopfli);
            const p = indices.get(name) * 16;
            blocks.writeUInt32LE(cursor - offset, p);
            blocks.writeUInt32LE(data.length, p + 4);
            blocks.writeUInt32LE(contents.length, p + 8);
            blocks.writeUInt32LE(flags, p + 12);
            chunks.push(data);
            cursor += data.length;
        }
        const hashOffset = cursor - offset;
        chunks.push(transform(hashes, hash('(hash table)', 3), true));
        cursor += hashes.length;
        const blockOffset = cursor - offset;
        chunks.push(transform(blocks, hash('(block table)', 3), true));
        cursor += blocks.length;
        assert(cursor - offset <= 0xffffffff, 'MPQ v0 size limit exceeded');
        const result = Buffer.concat(chunks);
        result.writeUInt32LE(cursor - offset, offset + 8);
        result.writeUInt32LE(hashOffset, offset + 16);
        result.writeUInt32LE(blockOffset, offset + 20);
        result.writeUInt32LE(nextBlock, offset + 28);
        const verified = openMap(result);
        for (const [name, contents] of changes) assert.deepEqual(verified.read(name), contents, 'MPQ readback mismatch: ' + name);
        for (let i = 0; i < blockCount; i++) {
            if ([...changes.keys()].some(name => indexOf(name) === i)) continue;
            assert.deepEqual(blocks.subarray(i * 16, i * 16 + 16), blockTable.subarray(i * 16, i * 16 + 16));
        }
        const resultBytes = verified.compact();
        verifyPreserved(resultBytes, { changedNames: [...changes.keys()] });
        return resultBytes;
    }
    function remove(names) {
        validateArchive();
        assert(Array.isArray(names) && names.every(name => typeof name === 'string' && name.length > 0 && !/[\0\r\n]/.test(name)), 'Invalid MPQ removal names');
        const requested = [...new Map(names.map(name => [canonicalName(name), name])).values()];
        assert(!requested.some(name => ['(ATTRIBUTES)', '(SIGNATURE)'].includes(canonicalName(name))), 'Cannot remove MPQ attributes or signatures');
        const hashes = Buffer.from(hashTable), blocks = Buffer.from(blockTable), removed = new Set();
        for (const name of requested) {
            for (const p of matchingSlots(name)) {
                removed.add(hashTable.readUInt32LE(p + 12));
                hashes.writeUInt32LE(0xfffffffe, p + 12);
            }
        }
        if (!removed.size) return compact();
        const referenced = new Set();
        for (let p = 0; p < hashes.length; p += 16) {
            const index = hashes.readUInt32LE(p + 12);
            if (index < blockCount) referenced.add(index);
        }
        // Only blocks that lost their last named reference are deactivated.
        // Original orphan blocks and aliases still referenced by other names survive.
        for (const index of removed) {
            if (!referenced.has(index)) blocks.writeUInt32LE((blocks.readUInt32LE(index * 16 + 12) & ~0x80000000) >>> 0, index * 16 + 12);
        }
        // Table sizes are unchanged, so editing their existing positions avoids
        // growing archives whose fixed-key payloads prevent useful compaction.
        const result = Buffer.from(bytes);
        transform(hashes, hash('(hash table)', 3), true).copy(result, offset + header.readUInt32LE(16));
        transform(blocks, hash('(block table)', 3), true).copy(result, offset + header.readUInt32LE(20));
        let output = openMap(result).compact();
        const deleted = new Set(requested.map(canonicalName));
        const list = deleted.has('(LISTFILE)') ? null : read('(listfile)');
        const changedNames = [];
        if (list) {
            // Listfiles may contain legacy byte encodings and mixed line ends.
            // Compare ASCII path bytes without transcoding unrelated rows.
            const pathBytes = input => {
                const normalized = Buffer.from(input);
                for (let i = 0; i < normalized.length; i++) {
                    if (normalized[i] === 47) normalized[i] = 92;
                    else if (normalized[i] >= 97 && normalized[i] <= 122) normalized[i] -= 32;
                }
                return normalized.toString('latin1');
            };
            const deletedRows = new Set(requested.map(name => pathBytes(Buffer.from(name))));
            const retained = [];
            let start = 0;
            for (let end = 0; end < list.length; end++) {
                if (list[end] !== 10) continue;
                const nameEnd = end > start && list[end - 1] === 13 ? end - 1 : end;
                if (!deletedRows.has(pathBytes(list.subarray(start, nameEnd)))) retained.push(list.subarray(start, end + 1));
                start = end + 1;
            }
            if (start < list.length && !deletedRows.has(pathBytes(list.subarray(start)))) retained.push(list.subarray(start));
            const updated = Buffer.concat(retained);
            if (!updated.equals(list)) {
                output = openMap(output).replace([['(listfile)', updated]]);
                changedNames.push('(listfile)');
            }
        }
        verifyPreserved(output, { changedNames, removedNames: requested });
        for (const name of requested) assert(!openMap(output).has(name), 'Removed MPQ path is still present: ' + name);
        return output;
    }
    function optimize(options = {}) {
        validateArchive();
        const levels = compressionLevels(options.levels), strategies = normalizeCompressionStrategies(options.strategies === undefined ? ['default'] : options.strategies);
        const zopfli = options.zopfli ?? false;
        assert.equal(typeof zopfli, 'boolean', 'zopfli must be boolean');
        const replacements = new Map(), metadata = inspect();
        const names = options.names ?? listNames();
        assert(Array.isArray(names) && names.every(name => typeof name === 'string'), 'Invalid MPQ optimization names');
        const seen = new Set();
        for (const name of names) {
            if (seen.has(canonicalName(name))) continue;
            seen.add(canonicalName(name));
            const matches = matchingSlots(name);
            if (matches.length !== 1 || ['(ATTRIBUTES)', '(SIGNATURE)'].includes(canonicalName(name))) continue;
            const index = hashTable.readUInt32LE(matches[0] + 12), entry = metadata.blocks[index];
            if (entry.hashReferences !== 1 || ![0x80000000, 0x80000200].includes(entry.flags)) continue;
            const contents = read(name, true);
            if (contents) replacements.set(name, contents);
        }
        const candidate = replace(replacements, { levels, strategies, zopfli, recompress: true });
        const output = candidate.length < bytes.length ? candidate : compact();
        verifyPreserved(output, { changedNames: [...replacements.keys()] });
        return output;
    }
    // Re-encode every live block for another archive sector size. Contents,
    // hash/locale slots, block indices, sizes and encryption are kept; only
    // offsets, packed sizes and the compression bit may change. A block must be
    // decodable: an encrypted block needs exactly one known name. Warcraft III
    // support for a non-default sector size requires an in-game check.
    function resector(options = {}) {
        const live = validateArchive();
        const shift = options.shift;
        assert(SUPPORTED_OUTPUT_SECTOR_SHIFTS.includes(shift), 'MPQ sector size shift must be one of ' + SUPPORTED_OUTPUT_SECTOR_SHIFTS.join(', '));
        const levels = compressionLevels(options.levels), strategies = normalizeCompressionStrategies(options.strategies === undefined ? ['default'] : options.strategies);
        const zopfli = options.zopfli ?? false;
        assert.equal(typeof zopfli, 'boolean', 'zopfli must be boolean');
        const size = 512 * 2 ** shift, metadata = inspect(), names = new Map();
        for (const name of [...listNames(), '(listfile)', '(attributes)']) {
            for (const p of matchingSlots(name)) {
                const index = hashTable.readUInt32LE(p + 12);
                if (index < blockCount && !names.has(index)) names.set(index, name);
            }
        }
        const entries = live.map(({ index }) => {
            const flags = blockTable.readUInt32LE(index * 16 + 12), name = names.get(index) ?? null, label = name ?? '#' + index;
            assert.equal(flags & ~0x80030200, 0, 'Unsupported MPQ block flags for a sector size change: ' + label);
            if (flags & 0x10000) assert(name !== null && metadata.blocks[index].hashReferences === 1, 'An encrypted MPQ block needs exactly one known name for a sector size change: ' + label);
            return { index, name, flags, contents: readBlock(index, name) };
        });
        const encodings = encodeMany(entries.map(entry => ({ contents: entry.contents, size, keepSectors: Boolean(entry.flags & 0x10000) })), levels, strategies, zopfli);
        entries.forEach((entry, position) => {
            entry.data = encodings[position].data;
            entry.flags = ((entry.flags & ~0x200) | (encodings[position].flags & 0x200)) >>> 0;
        });
        const blocks = Buffer.from(blockTable), chunks = [bytes.subarray(0, offset + 32)];
        let cursor = 32;
        for (const entry of entries) {
            let data = entry.data;
            if (entry.flags & 0x10000) {
                // FIX_KEY includes the new MPQ-relative offset of the block.
                const key = fileKey(entry.name, cursor, entry.contents.length, entry.flags);
                const count = Math.ceil(entry.contents.length / size), table = data.subarray(0, (count + 1) * 4);
                const parts = [transform(table, (key - 1) >>> 0, true)];
                for (let i = 0; i < count; i++) parts.push(transform(data.subarray(table.readUInt32LE(i * 4), table.readUInt32LE(i * 4 + 4)), (key + i) >>> 0, true));
                data = Buffer.concat(parts);
            }
            const p = entry.index * 16;
            blocks.writeUInt32LE(cursor, p);
            blocks.writeUInt32LE(data.length, p + 4);
            blocks.writeUInt32LE(entry.flags, p + 12);
            chunks.push(data);
            cursor += data.length;
        }
        const hashOffset = cursor, blockOffset = hashOffset + hashTable.length, archiveSize = blockOffset + blocks.length;
        assert(archiveSize <= 0xffffffff, 'MPQ v0 size limit exceeded');
        chunks.push(transform(hashTable, hash('(hash table)', 3), true), transform(blocks, hash('(block table)', 3), true));
        const result = Buffer.concat(chunks);
        result.writeUInt32LE(archiveSize, offset + 8);
        result.writeUInt16LE(shift, offset + 14);
        result.writeUInt32LE(hashOffset, offset + 16);
        result.writeUInt32LE(blockOffset, offset + 20);
        const other = mapStates.get(openMap(result));
        other.validateArchive();
        assert.equal(other.offset, offset, 'MPQ prefix offset changed');
        assert(other.bytes.subarray(0, offset).equals(bytes.subarray(0, offset)), 'MPQ prefix changed');
        assert.equal(other.sectorSize, size, 'MPQ sector size was not applied');
        assert(other.hashTable.equals(hashTable), 'MPQ hash/locale slots changed');
        assert.equal(other.blockCount, blockCount, 'MPQ block indices changed');
        for (let index = 0; index < blockCount; index++) {
            const p = index * 16, flags = blockTable.readUInt32LE(p + 12);
            if (!(flags & 0x80000000)) {
                assert(other.blockTable.subarray(p, p + 16).equals(blockTable.subarray(p, p + 16)), 'Inactive MPQ block changed');
                continue;
            }
            assert.equal(other.blockTable.readUInt32LE(p + 8), blockTable.readUInt32LE(p + 8), 'MPQ block size changed');
            assert.equal((other.blockTable.readUInt32LE(p + 12) | 0x200) >>> 0, (flags | 0x200) >>> 0, 'MPQ block flags changed');
        }
        for (const entry of entries) assert(other.readBlock(entry.index, entry.name).equals(entry.contents), 'MPQ sector rebuild readback mismatch: ' + (entry.name ?? '#' + entry.index));
        return result;
    }
    function verifyPreserved(candidate, { changedNames = [], removedNames = [] } = {}) {
        validateArchive();
        const otherMap = openMap(candidate), other = mapStates.get(otherMap);
        other.validateArchive();
        assert.equal(other.offset, offset, 'MPQ prefix offset changed');
        assert.deepEqual(other.bytes.subarray(0, offset), bytes.subarray(0, offset), 'MPQ prefix changed');
        assert.equal(other.hashCount, hashCount, 'MPQ hash count changed');
        assert(other.blockCount >= blockCount, 'MPQ block indices were removed');
        assert.equal(other.sectorSize, sectorSize, 'MPQ sector size changed');
        const changedIndices = new Set(), removedSlots = new Set(), removedIndices = new Set();
        for (const name of changedNames) for (const p of matchingSlots(name)) changedIndices.add(hashTable.readUInt32LE(p + 12));
        for (const name of removedNames) for (const p of matchingSlots(name)) {
            removedSlots.add(p);
            removedIndices.add(hashTable.readUInt32LE(p + 12));
        }
        const remaining = new Set();
        for (let p = 0; p < other.hashTable.length; p += 16) {
            const index = other.hashTable.readUInt32LE(p + 12);
            if (index < other.blockCount) remaining.add(index);
            if (removedSlots.has(p)) {
                assert.equal(index, 0xfffffffe, 'Removed MPQ hash must be a tombstone');
                assert.deepEqual(other.hashTable.subarray(p, p + 12), hashTable.subarray(p, p + 12), 'Removed MPQ locale metadata changed');
            } else if (hashTable.readUInt32LE(p + 12) >= 0xfffffffe && index < other.blockCount) {
                assert(changedNames.some(name => other.hashTable.readUInt32LE(p) === hash(name, 1) && other.hashTable.readUInt32LE(p + 4) === hash(name, 2)), 'Unexpected MPQ hash addition');
            } else assert.deepEqual(other.hashTable.subarray(p, p + 16), hashTable.subarray(p, p + 16), 'Unchanged MPQ hash/locale slot changed');
        }
        const attributesIndex = indexOf('(attributes)');
        if (attributesIndex >= 0) changedIndices.add(attributesIndex);
        for (let index = 0; index < blockCount; index++) {
            const p = index * 16, flags = blockTable.readUInt32LE(p + 12);
            if (removedIndices.has(index) && !remaining.has(index)) {
                // A preceding replacement/compaction may have moved the payload
                // before deletion. Inactive offsets have no execution meaning.
                assert.deepEqual(other.blockTable.subarray(p + 4, p + 12), blockTable.subarray(p + 4, p + 12), 'Removed MPQ block size metadata changed');
                assert.equal(other.blockTable.readUInt32LE(p + 12), (flags & ~0x80000000) >>> 0, 'Removed MPQ block remains active');
                continue;
            }
            if (changedIndices.has(index)) continue;
            assert.deepEqual(other.blockTable.subarray(p + 4, p + 16), blockTable.subarray(p + 4, p + 16), 'Unchanged MPQ block metadata changed');
            const start = blockTable.readUInt32LE(p), nextStart = other.blockTable.readUInt32LE(p);
            if (!(flags & 0x80000000) || (flags & 0x30000) === 0x30000) assert.equal(nextStart, start, 'Pinned/inactive MPQ block offset changed');
            if (flags & 0x80000000) {
                const size = blockTable.readUInt32LE(p + 4);
                assert.deepEqual(other.bytes.subarray(offset + nextStart, offset + nextStart + size), bytes.subarray(offset + start, offset + start + size), 'Unchanged MPQ packed payload changed');
            }
        }
        if (attributesIndex >= 0) {
            const before = read('(attributes)'), after = otherMap.read('(attributes)');
            assert(after, 'MPQ attributes were removed');
            assert.equal(before.readUInt32LE(0), 100, 'Unsupported attributes version');
            const flags = before.readUInt32LE(4);
            assert.equal(flags & ~7, 0, 'Unsupported attribute flags');
            assert.deepEqual(after.subarray(0, 8), before.subarray(0, 8), 'MPQ attributes header changed');
            let oldStart = 8, newStart = 8;
            for (const [flag, stride] of [[1, 4], [2, 8], [4, 16]]) {
                if (!(flags & flag)) continue;
                for (let index = 0; index < blockCount; index++) {
                    // Timestamps and deleted slots retain their values; checksum updates
                    // are allowed only for explicitly changed content blocks.
                    if (flag !== 2 && changedIndices.has(index) && index !== attributesIndex) continue;
                    assert.deepEqual(after.subarray(newStart + index * stride, newStart + (index + 1) * stride), before.subarray(oldStart + index * stride, oldStart + (index + 1) * stride), 'Unchanged MPQ attribute slot changed');
                }
                oldStart += blockCount * stride;
                newStart += other.blockCount * stride;
            }
            assert.equal(before.length, oldStart, 'Unexpected source attributes size');
            assert.equal(after.length, newStart, 'Unexpected output attributes size');
        }
        return true;
    }
    const api = { read, replace, compact, has, listNames, inspect, remove, optimize, resector, verifyPreserved,
        validate: () => { validateArchive(); return true; } };
    mapStates.set(api, { bytes, offset, sectorSize, hashCount, blockCount, hashTable, blockTable, validateArchive, readBlock });
    return api;
}

export function runMpqTests() {
    const exists = 0x80000000, fixedEncrypted = 0x80030200;
    const prefix = Buffer.alloc(512);
    prefix.write('HM3W: preserve the editor map prefix\0');
    function tables(bytes) {
        const offset = findArchiveOffset(bytes);
        const header = bytes.subarray(offset, offset + 32);
        const hashStart = offset + header.readUInt32LE(16), blockStart = offset + header.readUInt32LE(20);
        return { offset, header,
            hashes: transform(bytes.subarray(hashStart, hashStart + header.readUInt32LE(24) * 16), hash('(hash table)', 3)),
            blocks: transform(bytes.subarray(blockStart, blockStart + header.readUInt32LE(28) * 16), hash('(block table)', 3)) };
    }
    function fixture(source, { attributes = false, tight = false } = {}) {
        const entries = source.map(entry => ({ ...entry, data: Buffer.from(entry.data) }));
        if (attributes) entries.push({ name: '(attributes)', data: Buffer.alloc(0) });
        const count = entries.length;
        if (attributes) {
            const data = Buffer.alloc(8 + count * 28);
            data.writeUInt32LE(100, 0); data.writeUInt32LE(7, 4);
            entries.forEach((entry, index) => {
                const original = entry.decoded ?? entry.data;
                data.writeUInt32LE(crc32(original), 8 + index * 4);
                data.writeBigUInt64LE(0x0102030405060708n + BigInt(index), 8 + count * 4 + index * 8);
                createHash('md5').update(original).digest().copy(data, 8 + count * 12 + index * 16);
            });
            entries[count - 1].data = data;
        }
        const hashes = Buffer.alloc(32 * 16, 0xff), blocks = Buffer.alloc(count * 16);
        let cursor = 32;
        entries.forEach((entry, index) => {
            const start = entry.start ?? (tight ? cursor : 512 + index * 1024);
            blocks.writeUInt32LE(start, index * 16);
            blocks.writeUInt32LE(entry.data.length, index * 16 + 4);
            blocks.writeUInt32LE(entry.length ?? entry.decoded?.length ?? entry.data.length, index * 16 + 8);
            blocks.writeUInt32LE(entry.flags ?? exists, index * 16 + 12);
            cursor = Math.max(cursor, start + entry.data.length);
            if (entry.name === undefined) return;
            let slot = hash(entry.name, 0) % 32;
            while (hashes.readUInt32LE(slot * 16 + 12) !== 0xffffffff) slot = (slot + 1) % 32;
            hashes.writeUInt32LE(hash(entry.name, 1), slot * 16);
            hashes.writeUInt32LE(hash(entry.name, 2), slot * 16 + 4);
            hashes.writeUInt32LE(entry.locale ?? 0, slot * 16 + 8);
            hashes.writeUInt32LE(index, slot * 16 + 12);
        });
        const empty = Array.from({ length: 32 }, (_, index) => index)
            .find(index => hashes.readUInt32LE(index * 16 + 12) === 0xffffffff);
        hashes.writeUInt32LE(0xfffffffe, empty * 16 + 12);
        const hashOffset = cursor + (tight ? 0 : 2048), blockOffset = hashOffset + hashes.length;
        const archiveSize = blockOffset + blocks.length, bytes = Buffer.alloc(prefix.length + archiveSize, 0x73);
        prefix.copy(bytes);
        const header = bytes.subarray(prefix.length, prefix.length + 32);
        header.fill(0); Buffer.from([77, 80, 81, 26]).copy(header);
        header.writeUInt32LE(32, 4); header.writeUInt32LE(archiveSize, 8);
        header.writeUInt32LE(hashOffset, 16); header.writeUInt32LE(blockOffset, 20);
        header.writeUInt32LE(32, 24); header.writeUInt32LE(count, 28);
        entries.forEach((entry, index) => entry.data.copy(bytes, prefix.length + blocks.readUInt32LE(index * 16)));
        transform(hashes, hash('(hash table)', 3), true).copy(bytes, prefix.length + hashOffset);
        transform(blocks, hash('(block table)', 3), true).copy(bytes, prefix.length + blockOffset);
        return bytes;
    }
    function mutate(bytes, change) {
        const result = Buffer.from(bytes), state = tables(result);
        change(state, result);
        transform(state.hashes, hash('(hash table)', 3), true).copy(result, state.offset + state.header.readUInt32LE(16));
        transform(state.blocks, hash('(block table)', 3), true).copy(result, state.offset + state.header.readUInt32LE(20));
        return result;
    }
    function packed(bytes, index) {
        const state = tables(bytes), p = index * 16;
        const start = state.offset + state.blocks.readUInt32LE(p);
        return bytes.subarray(start, start + state.blocks.readUInt32LE(p + 4));
    }
    function attributeRow(data, count, index) {
        return Buffer.concat([data.subarray(8 + index * 4, 12 + index * 4),
            data.subarray(8 + count * 4 + index * 8, 16 + count * 4 + index * 8),
            data.subarray(8 + count * 12 + index * 16, 24 + count * 12 + index * 16)]);
    }
    function encryptedSectors(name, raw, start) {
        const count = Math.ceil(raw.length / 512), offsets = Buffer.alloc((count + 1) * 4), chunks = [];
        const key = ((hash(name.split(/[\\/]/).pop(), 3) + start) ^ raw.length) >>> 0;
        let cursor = offsets.length;
        for (let index = 0; index < count; index++) {
            offsets.writeUInt32LE(cursor, index * 4);
            const sector = Buffer.concat([Buffer.from([2]), zlib.deflateSync(raw.subarray(index * 512, (index + 1) * 512))]);
            chunks.push(transform(sector, (key + index) >>> 0, true));
            cursor += sector.length;
        }
        offsets.writeUInt32LE(cursor, count * 4);
        return Buffer.concat([transform(offsets, (key - 1) >>> 0, true), ...chunks]);
    }
    const fixedName = 'vault\\fixed.bin', fixedStart = 96;
    const secret = Buffer.from('encrypted map payload '.repeat(80));
    const source = fixture([
        { name: 'readable.txt', data: Buffer.from('original readable payload') },
        { name: 'localized.bin', locale: 0, data: Buffer.from('neutral') },
        { name: 'localized.bin', locale: 0x01000412, data: Buffer.from('Korean') },
        { name: 'opaque.bin', flags: 0x80000100, length: 123, data: Buffer.from('opaque PKWARE bytes') },
        { data: Buffer.alloc(80, 0x42) },
        { name: fixedName, start: fixedStart, flags: fixedEncrypted, decoded: secret,
            data: encryptedSectors(fixedName, secret, fixedStart) },
        { name: 'empty.bin', data: Buffer.alloc(0) },
        // An empty fixed-key block inside a real pinned interval reserves no space.
        { name: 'fixed-empty.bin', start: fixedStart + 1, flags: 0x80030000, data: Buffer.alloc(0) },
        { name: '(listfile)', data: Buffer.from('readable.txt\r\nlocalized.bin\r\nvault\\fixed.bin\r\nempty.bin\r\n(listfile)\r\n(attributes)\r\n') }
    ], { attributes: true });
    const original = tables(source), originalCount = original.header.readUInt32LE(28);
    assert.deepEqual(openMap(source).read(fixedName), secret, 'Encrypted fixture must really decode');
    assert.throws(() => openMap(source).read('localized.bin'), /Multiple locale/);
    assert.throws(() => openMap(source).read('opaque.bin'), /PKWARE/);
    const compacted = openMap(source).compact(), compactState = tables(compacted);
    assert(compacted.length < source.length, 'Gapped fixture must shrink');
    assert.deepEqual(compacted.subarray(0, prefix.length), prefix);
    assert.deepEqual(compactState.hashes, original.hashes, 'Hash slots, locale and deletion markers must survive');
    for (let index = 0; index < originalCount; index++) {
        assert.deepEqual(packed(compacted, index), packed(source, index), 'Every live block, including orphan bytes, must survive');
        assert.deepEqual(compactState.blocks.subarray(index * 16 + 4, index * 16 + 16),
            original.blocks.subarray(index * 16 + 4, index * 16 + 16));
    }
    assert.equal(compactState.blocks.readUInt32LE(5 * 16), fixedStart, 'FIX_KEY ciphertext must stay at its original offset');
    assert.equal(compactState.blocks.readUInt32LE(7 * 16), fixedStart + 1, 'Empty fixed-key block keeps its offset');
    assert.deepEqual(openMap(compacted).read(fixedName), secret, 'Pinned encrypted sectors must remain readable');
    assert.deepEqual(openMap(compacted).read('empty.bin'), Buffer.alloc(0));
    assert.deepEqual(openMap(compacted).read('(attributes)'), openMap(source).read('(attributes)'));
    assert.deepEqual(openMap(compacted).compact(), compacted, 'Compaction must be bytewise idempotent');
    const identical = [['readable.txt', openMap(source).read('readable.txt')], [fixedName, secret], ['empty.bin', Buffer.alloc(0)]];
    assert.deepEqual(openMap(source).replace(identical), compacted, 'Identical replacements must only reclaim gaps');
    assert.deepEqual(openMap(compacted).replace(identical), compacted, 'Identical replacements must not rewrite encrypted or empty entries');

    const changed = Buffer.alloc(900, 0x51), assetName = 'new\\asset.bin', asset = Buffer.from('new imported asset');
    const requested = [['readable.txt', changed], [assetName, asset]];
    const replaced = openMap(source).replace(requested), replacedMap = openMap(replaced), replacementState = tables(replaced);
    assert.deepEqual(replacedMap.read('readable.txt'), changed);
    assert.deepEqual(replacedMap.read(assetName), asset);
    assert.deepEqual(replacedMap.read(fixedName), secret);
    assert.equal(replacementState.header.readUInt32LE(28), originalCount + 1, 'Only the addition gets a new block index');
    for (let slot = 0; slot < 32; slot++) {
        if (original.hashes.readUInt32LE(slot * 16 + 12) < originalCount) {
            assert.deepEqual(replacementState.hashes.subarray(slot * 16, slot * 16 + 16), original.hashes.subarray(slot * 16, slot * 16 + 16));
        }
    }
    const importedNames = replacedMap.read('(listfile)').toString('utf8').split(/\r?\n/);
    assert.equal(importedNames.filter(name => name === assetName).length, 1);
    const oldAttributes = openMap(source).read('(attributes)'), attributes = replacedMap.read('(attributes)');
    const nextCount = originalCount + 1;
    assert.equal(attributes.length, 8 + nextCount * 28);
    for (let index = 0; index < originalCount; index++) {
        assert.deepEqual(attributes.subarray(8 + nextCount * 4 + index * 8, 16 + nextCount * 4 + index * 8),
            oldAttributes.subarray(8 + originalCount * 4 + index * 8, 16 + originalCount * 4 + index * 8), 'Existing timestamps must survive at their block indices');
        if (index !== 0 && index !== 8) assert.deepEqual(attributeRow(attributes, nextCount, index), attributeRow(oldAttributes, originalCount, index));
    }
    for (const [index, raw] of [[0, changed], [8, replacedMap.read('(listfile)')], [originalCount, asset]]) {
        assert.equal(attributes.readUInt32LE(8 + index * 4), crc32(raw));
        assert.deepEqual(attributes.subarray(8 + nextCount * 12 + index * 16, 24 + nextCount * 12 + index * 16), createHash('md5').update(raw).digest());
    }
    assert.equal(attributes.readBigUInt64LE(8 + nextCount * 4 + originalCount * 8), 0n, 'New entries have deterministic zero timestamps');
    assert.deepEqual(openMap(replaced).replace(requested), replaced, 'Repeated replacements and additions must be bytewise idempotent');
    assert.deepEqual(openMap(replaced).replace([[assetName, asset]]), replaced, 'An existing addition must not append another listfile entry');
    assert.deepEqual(openMap(replaced).compact(), replaced);
    const opaqueReplacement = Buffer.from('replacement for unsupported original data');
    assert.deepEqual(openMap(openMap(source).replace([['opaque.bin', opaqueReplacement]])).read('opaque.bin'), opaqueReplacement);

    const tight = fixture([{ name: 'tight.bin', data: Buffer.from('already compact') }, { name: 'zero.bin', data: Buffer.alloc(0) }], { tight: true });
    assert.deepEqual(openMap(tight).compact(), tight, 'An equal-size candidate must not rearrange an archive');
    const highEmpty = mutate(source, ({ header, blocks }) => blocks.writeUInt32LE(header.readUInt32LE(8), 7 * 16));
    assert.deepEqual(openMap(highEmpty).compact(), highEmpty, 'A larger candidate caused by a high pinned offset must keep the original archive');

    assert.throws(() => openMap(mutate(source, ({ blocks }) => blocks.writeUInt32LE(31, 0))).compact(), /Invalid live MPQ payload range/);
    assert.throws(() => openMap(mutate(source, ({ header, blocks }) => blocks.writeUInt32LE(header.readUInt32LE(8), 4))).compact(), /Invalid live MPQ payload range/);
    assert.throws(() => openMap(mutate(source, ({ header, blocks }) => blocks.writeUInt32LE(header.readUInt32LE(16), 0))).compact(), /Overlapping/);
    assert.throws(() => openMap(mutate(source, ({ hashes }) => hashes.writeUInt32LE(originalCount, 12))).compact(), /Invalid MPQ block reference/);
    assert.throws(() => openMap(mutate(source, ({ blocks }) => blocks.writeUInt32LE(0, 12))).compact(), /inactive block/);
    const signed = fixture([{ name: '(signature)', data: Buffer.from('signed archive') }]);
    assert.throws(() => openMap(signed).compact(), /Signed maps/);
    assert.throws(() => openMap(signed).replace([]), /Signed maps/);
    assert.throws(() => openMap(Buffer.concat([source, Buffer.from([0])])), /trailer\/signature/);

    const unsupported = Buffer.alloc(9); unsupported.writeUInt32LE(8, 0); unsupported.writeUInt32LE(9, 4); unsupported[8] = 8;
    const unsupportedMap = fixture([{ name: 'mask.bin', flags: 0x80000200, length: 32, data: unsupported }]);
    assert.throws(() => openMap(unsupportedMap).read('mask.bin'), /Unsupported compression mask/);
    assert.deepEqual(openMap(openMap(unsupportedMap).replace([['mask.bin', opaqueReplacement]])).read('mask.bin'), opaqueReplacement);
    const broken = Buffer.alloc(12); broken.writeUInt32LE(8, 0); broken.writeUInt32LE(12, 4); broken.set([2, 255, 255, 255], 8);
    const malformed = fixture([{ name: 'broken.bin', flags: 0x80000200, length: 32, data: broken }]);
    assert.throws(() => openMap(malformed).replace([['broken.bin', opaqueReplacement]]), 'Corrupt zlib data must not become an optimization fallback');
    const badOffsets = Buffer.from(broken); badOffsets.writeUInt32LE(7, 0);
    const invalidSectors = fixture([{ name: 'broken.bin', flags: 0x80000200, length: 32, data: badOffsets }]);
    assert.throws(() => openMap(invalidSectors).replace([['broken.bin', opaqueReplacement]]), /Invalid sector offsets/);
    console.log('MPQ tests passed: live/orphan bytes, locale slots, attributes, encrypted pinning, empty entries, no-op/idempotent updates and malformed archives.');
}
