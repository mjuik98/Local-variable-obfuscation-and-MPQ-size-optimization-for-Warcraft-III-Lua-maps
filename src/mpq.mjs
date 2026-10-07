// MPQ v0 support for updating entries, adding assets and reclaiming unused space.
// Only zlib-compressed or uncompressed input entries are decoded.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { canonicalPath, normalizeCompressionStrategies, SUPPORTED_OUTPUT_SECTOR_SHIFTS } from './config.mjs';
import { compressSectors } from './compress.mjs';

const crypt = new Uint32Array(1280);
const mapStates = new WeakMap();
const canonicalName = canonicalPath;
const validName = name => typeof name === 'string' && name.length > 0 && name.isWellFormed() && !/[\0\r\n]/.test(name);
let seed = 0x100001;
for (let low = 0; low < 256; low++) {
    for (let high = 0; high < 5; high++) {
        seed = (seed * 125 + 3) % 0x2aaaab;
        const first = (seed & 0xffff) << 16;
        seed = (seed * 125 + 3) % 0x2aaaab;
        crypt[high * 256 + low] = (first | (seed & 0xffff)) >>> 0;
    }
}
// Canonical MPQ path bytes: '/' becomes '\\' and only ASCII letters are folded.
const canonicalByte = c => c === 47 ? 92 : c >= 97 && c <= 122 ? c - 32 : c;
function canonicalBytes(input) {
    const normalized = Buffer.from(input);
    for (let i = 0; i < normalized.length; i++) normalized[i] = canonicalByte(normalized[i]);
    return normalized;
}
function hash(name, type) {
    let a = 0x7fed7fed, b = 0xeeeeeeee;
    const table = type * 256;
    for (const byte of Buffer.from(name, 'utf8')) {
        const c = canonicalByte(byte);
        a = (crypt[table + c] ^ (a + b)) >>> 0;
        b = (c + a + b + (b << 5) + 3) >>> 0;
    }
    return a;
}
const HASH_TABLE_KEY = hash('(hash table)', 3), BLOCK_TABLE_KEY = hash('(block table)', 3);
// Both path hashes identify a hash slot's name; the locale is separate.
const pathKey = name => hash(name, 1) + ':' + hash(name, 2);

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

// Listfiles may contain legacy byte encodings and mixed line ends. Rows are
// compared as canonical bytes and never transcoded, so unrelated rows survive.
const listfileKey = input => canonicalBytes(input).toString('latin1');
function listfileRows(list) {
    const rows = [];
    let start = 0;
    for (let end = 0; end < list.length; end++) {
        if (list[end] !== 10) continue;
        const nameEnd = end > start && list[end - 1] === 13 ? end - 1 : end;
        rows.push({ name: list.subarray(start, nameEnd), line: list.subarray(start, end + 1) });
        start = end + 1;
    }
    if (start < list.length) rows.push({ name: list.subarray(start), line: list.subarray(start) });
    return rows;
}
// A row that is not UTF-8 cannot be named through this string API; it stays
// in the archive and in the listfile unchanged.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function rowName(bytes) {
    try { return utf8.decode(bytes); }
    catch { return null; }
}

// Fail with the message only: byte diffs of archive data are not useful output.
// A function message is built only on failure.
function check(condition, message) {
    if (!condition) throw new assert.AssertionError({ message: typeof message === 'function' ? message() : message, stackStartFn: check });
}
const sameBytes = (actual, expected) => Buffer.isBuffer(actual) && actual.equals(expected);

// zlib candidates shared by every encoding entry point.
function encodingOptions({ levels = [6, 9], strategies = ['default'], zopfli }) {
    assert(Array.isArray(levels) && levels.length > 0 && levels.every(level => Number.isInteger(level) && level >= 0 && level <= 9), 'Invalid zlib compression levels');
    const encoding = { levels: [...new Set(levels)], strategies: normalizeCompressionStrategies(strategies), zopfli: zopfli ?? false };
    assert.equal(typeof encoding.zopfli, 'boolean', 'zopfli must be boolean');
    return encoding;
}

// (attributes) v100 stores CRC32 (4), FILETIME (8) and MD5 (16) arrays with
// one row per block, in this order, for each flag that is present.
const ATTRIBUTE_ARRAYS = [[1, 4], [2, 8], [4, 16]];
const attributeRowSize = flags => ATTRIBUTE_ARRAYS.reduce((size, [flag, stride]) => size + (flags & flag ? stride : 0), 0);

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
    function table(field, count, key) {
        const start = offset + header.readUInt32LE(field);
        assert(start >= offset + 32 && start + count * 16 <= archiveEnd, 'Invalid MPQ table');
        return transform(bytes.subarray(start, start + count * 16), key);
    }
    const hashTable = table(16, hashCount, HASH_TABLE_KEY);
    const blockTable = table(20, blockCount, BLOCK_TABLE_KEY);
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

    // Names are resolved repeatedly by each stage; the shared slot arrays are
    // read-only, like the tables they index.
    const resolvedSlots = new Map();
    function matchingSlots(name) {
        let slots = resolvedSlots.get(name);
        if (slots === undefined) {
            slots = pathSlots.get(pathKey(name)) ?? [];
            resolvedSlots.set(name, slots);
        }
        return slots;
    }
    let references = null;
    function hashReferences() {
        if (references) return references;
        references = new Uint32Array(blockCount);
        for (let i = 0; i < hashCount; i++) {
            const index = hashTable.readUInt32LE(i * 16 + 12);
            if (index < blockCount) references[index]++;
        }
        return references;
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
        const seen = new Set(), names = [];
        for (const row of listfileRows(list)) {
            const name = rowName(row.name);
            if (!name || seen.has(canonicalName(name)) || !has(name)) continue;
            seen.add(canonicalName(name));
            names.push(name);
        }
        return names;
    }
    function inspect({ includeHashes = false, includeListedNames = true, names = [] } = {}) {
        assert(typeof includeListedNames === 'boolean', 'includeListedNames must be boolean');
        assert(Array.isArray(names) && names.every(validName), 'Inspection names must be explicit MPQ paths');
        const references = hashReferences();
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
            let result;
            try { result = zlib.inflateSync(chunk.subarray(1), { maxOutputLength: expected }); }
            catch (cause) { throw new Error('Corrupt zlib sector in ' + label + ': ' + cause.message, { cause }); }
            assert.equal(result.length, expected, 'Decompressed sector size mismatch: ' + label);
            return result;
        }
        if (!(flags & 0x200)) {
            assert(!(flags & 0x10000), 'Encrypted raw sectors are unsupported: ' + label);
            assert.equal(packed, length, 'Uncompressed entry size mismatch: ' + label);
            return data;
        }
        const count = Math.ceil(length / sectorSize), tableSize = (count + 1) * 4;
        assert(tableSize <= data.length, 'Truncated MPQ sector table: ' + label);
        const sectors = flags & 0x10000 ? transform(data.subarray(0, tableSize), (key - 1) >>> 0) : data.subarray(0, tableSize);
        const chunks = [];
        for (let i = 0; i < count; i++) {
            const a = sectors.readUInt32LE(i * 4), b = sectors.readUInt32LE(i * 4 + 4);
            assert(a >= tableSize && b >= a && b <= data.length, 'Invalid sector offsets: ' + label);
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

    // Error-message label for a block; listed names are resolved once, and an
    // unreadable listfile only leaves the label without a name.
    let blockNames = null;
    function blockLabel(index) {
        if (!blockNames) {
            blockNames = new Map();
            try {
                for (const name of listNames()) {
                    for (const p of matchingSlots(name)) blockNames.set(hashTable.readUInt32LE(p + 12), name);
                }
            } catch { /* Labels are informational only. */ }
        }
        return 'block ' + index + (blockNames.has(index) ? ' (' + blockNames.get(index) + ')' : '');
    }
    let liveEntries = null;
    function validateArchive() {
        if (liveEntries) return liveEntries;
        assert(!has('(signature)'), 'Signed maps are not supported');
        const live = [];
        const ranges = [[0, 32],
            [header.readUInt32LE(16), header.readUInt32LE(16) + hashTable.length],
            [header.readUInt32LE(20), header.readUInt32LE(20) + blockTable.length]];
        for (let i = 0; i < hashCount; i++) {
            const index = hashTable.readUInt32LE(i * 16 + 12);
            if (index >= 0xfffffffe) continue;
            assert(index < blockCount, 'Invalid MPQ block reference in hash slot ' + i);
            assert(blockTable.readUInt32LE(index * 16 + 12) & 0x80000000, 'MPQ hash slot ' + i + ' references inactive block ' + index);
        }
        // Keep all live blocks, including files absent from (listfile), and retain
        // their indices so locale entries and attributes arrays remain aligned.
        for (let index = 0; index < blockCount; index++) {
            const p = index * 16, flags = blockTable.readUInt32LE(p + 12);
            if (!(flags & 0x80000000)) continue;
            const start = blockTable.readUInt32LE(p), size = blockTable.readUInt32LE(p + 4);
            assert(start >= 32 && offset + start + size <= archiveEnd, 'Invalid live MPQ payload range: block ' + index);
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
            assert(start >= end, 'Overlapping MPQ payloads or tables at archive offset ' + start + '; refusing to compact');
            end = stop;
        }
        liveEntries = live;
        return live;
    }
    // Packed bytes of a block row that still points into this archive.
    function storedPayload(blocks, index) {
        const start = blocks.readUInt32LE(index * 16), packed = blocks.readUInt32LE(index * 16 + 4);
        return bytes.subarray(offset + start, offset + start + packed);
    }
    // Serialize an archive with the given decrypted tables and every live payload
    // packed from the start. FIX_KEY encryption includes the MPQ-relative offset,
    // so those payloads stay pinned; the rest fill gaps first-fit in block order.
    // Placement depends only on the tables, so a modified archive is written
    // directly instead of being materialized and then compacted. Returns null
    // when the result would not be smaller than `limit`: never grow an archive
    // just to rearrange it.
    function layout(hashes, blocks, payload, limit) {
        const total = blocks.length / 16, live = [];
        for (let index = 0; index < total; index++) {
            const p = index * 16, flags = blocks.readUInt32LE(p + 12);
            if (flags & 0x80000000) live.push({ index, start: blocks.readUInt32LE(p), size: blocks.readUInt32LE(p + 4), fixed: (flags & 0x30000) === 0x30000 });
        }
        const free = [];
        let cursor = 32;
        for (const entry of live.filter(entry => entry.fixed).sort((a, b) => a.start - b.start)) {
            if (entry.start > cursor) free.push({ start: cursor, end: entry.start });
            cursor = Math.max(cursor, entry.start + entry.size);
        }
        free.push({ start: cursor, end: Infinity });
        const placed = Buffer.from(blocks);
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
            placed.writeUInt32LE(start, entry.index * 16);
            payloadEnd = Math.max(payloadEnd, start + entry.size);
        }
        const hashOffset = payloadEnd, blockOffset = hashOffset + hashes.length;
        const size = blockOffset + placed.length;
        if (offset + size >= limit) return null;
        const result = Buffer.alloc(offset + size);
        bytes.copy(result, 0, 0, offset + 32);
        for (const entry of live) payload(entry.index).copy(result, offset + placed.readUInt32LE(entry.index * 16));
        transform(hashes, HASH_TABLE_KEY, true).copy(result, offset + hashOffset);
        transform(placed, BLOCK_TABLE_KEY, true).copy(result, offset + blockOffset);
        result.writeUInt32LE(size, offset + 8);
        result.writeUInt32LE(hashOffset, offset + 16);
        result.writeUInt32LE(blockOffset, offset + 20);
        result.writeUInt32LE(total, offset + 28);
        openMap(result); // Recheck archive/table boundaries after serialization.
        check(sameBytes(result.subarray(0, offset), bytes.subarray(0, offset)), 'MPQ prefix preservation');
        check(sameBytes(transform(result.subarray(offset + hashOffset, offset + blockOffset), HASH_TABLE_KEY), hashes), 'MPQ hash/locale preservation');
        const verifiedBlocks = transform(result.subarray(offset + blockOffset), BLOCK_TABLE_KEY);
        for (let index = 0; index < total; index++) {
            const p = index * 16, flags = blocks.readUInt32LE(p + 12);
            check(sameBytes(verifiedBlocks.subarray(p + 4, p + 16), blocks.subarray(p + 4, p + 16)), () => 'MPQ block metadata preservation: ' + blockLabel(index));
            const oldStart = blocks.readUInt32LE(p), newStart = verifiedBlocks.readUInt32LE(p), packed = verifiedBlocks.readUInt32LE(p + 4);
            if (!(flags & 0x80000000) || (flags & 0x30000) === 0x30000) {
                check(newStart === oldStart, () => 'MPQ fixed/inactive block preservation: ' + blockLabel(index));
            }
            if (flags & 0x80000000) {
                check(sameBytes(result.subarray(offset + newStart, offset + newStart + packed), payload(index)),
                    () => 'MPQ packed payload preservation: ' + blockLabel(index));
            }
        }
        return result;
    }
    function compact() {
        validateArchive();
        return layout(hashTable, blockTable, index => storedPayload(blockTable, index), bytes.length) ?? Buffer.from(bytes);
    }

    // Encode files with one batch of sectors, so large and small files share
    // the compression threads. Encrypted blocks keep a sector table even when
    // no sector compresses, since encrypted raw sector data cannot be read back.
    function encodeMany(items, { levels, strategies, zopfli }) {
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
    function encode(contents, encoding) {
        return encodeMany([{ contents }], encoding)[0];
    }
    function replace(entries, options = {}) {
        validateArchive();
        const encoding = encodingOptions(options);
        const encoded = new Map();
        const requested = [...entries];
        assert(requested.every(entry => Array.isArray(entry) && entry.length === 2 && validName(entry[0])), 'Invalid MPQ replacement entries');
        assert.equal(new Set(requested.map(([name]) => canonicalName(name))).size, requested.length, 'Duplicate MPQ paths');
        const changes = new Map(requested.map(([name, contents]) => [canonicalName(name) === '(LISTFILE)' ? '(listfile)' : name, contents]));
        assert(![...changes.keys()].some(name => canonicalName(name) === '(ATTRIBUTES)'), 'Attributes are updated automatically');
        assert(![...changes.keys()].some(name => canonicalName(name) === '(SIGNATURE)'), 'Signed maps are not supported');
        const same = new Map();
        for (const [name, contents] of changes) {
            assert(Buffer.isBuffer(contents), 'Replacement contents must be a Buffer');
            const identical = read(name, true)?.equals(contents);
            if (identical && !options.recompress) changes.delete(name);
            else same.set(name, identical);
        }
        const candidates = encodeMany([...changes.values()].map(contents => ({ contents })), encoding);
        for (const [position, [name]] of [...changes].entries()) {
            const index = indexOf(name), identical = same.get(name), candidate = candidates[position];
            if (identical && candidate.data.length >= blockTable.readUInt32LE(index * 16 + 4)) { changes.delete(name); continue; }
            if (index >= 0) assert.equal(hashReferences()[index], 1, 'Aliased entries cannot be replaced independently: ' + name);
            encoded.set(name, candidate);
        }
        return commit(changes, encoded, encoding);
    }
    // Write `changes` (name -> contents, with optional pre-encoded payloads) plus
    // the listfile and attributes updates they need, then verify the result.
    function commit(changes, encoded, encoding) {
        if (!changes.size) return compact();
        const additions = [...changes.keys()].filter(name => indexOf(name) < 0);
        if (additions.length) {
            const list = changes.get('(listfile)') ?? read('(listfile)');
            assert(list, 'Adding assets requires an existing MPQ listfile');
            // Append missing rows and keep every existing listfile byte.
            const known = new Set(listfileRows(list).map(row => listfileKey(row.name))), appended = [];
            for (const name of additions) {
                const key = listfileKey(Buffer.from(name));
                if (!known.has(key)) { appended.push(name + '\r\n'); known.add(key); }
            }
            const separator = appended.length && list.length && list.at(-1) !== 10 ? '\r\n' : '';
            const updated = Buffer.concat([list, Buffer.from(separator + appended.join(''))]);
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
                const home = hash(name, 0);
                for (let step = 0; step < hashCount; step++) {
                    const p = ((home + step) % hashCount) * 16;
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
            assert.equal(attributes.length, 8 + blockCount * attributeRowSize(flags), 'Unexpected attributes size');
            const updated = Buffer.alloc(8 + nextBlock * attributeRowSize(flags));
            attributes.copy(updated, 0, 0, 8);
            let oldStart = 8, newStart = 8;
            for (const [flag, stride] of ATTRIBUTE_ARRAYS) {
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
            if (index >= 0) assert.equal(hashReferences()[index], 1, 'Aliased entries cannot be replaced independently: ' + name);
        }
        const blocks = Buffer.alloc(nextBlock * 16), packed = new Map();
        blockTable.copy(blocks);
        // Rows first describe the appended layout: changed payloads after the
        // current archive, followed by both tables.
        let cursor = bytes.length;
        for (const [name, contents] of changes) {
            // Warcraft requires sector tables; single-unit compressed entries are never emitted.
            const { data, flags } = encoded.get(name) ?? encode(contents, encoding);
            const index = indices.get(name), p = index * 16;
            blocks.writeUInt32LE(cursor - offset, p);
            blocks.writeUInt32LE(data.length, p + 4);
            blocks.writeUInt32LE(contents.length, p + 8);
            blocks.writeUInt32LE(flags, p + 12);
            packed.set(index, data);
            cursor += data.length;
        }
        const appendedEnd = cursor + hashes.length + blocks.length;
        assert(appendedEnd - offset <= 0xffffffff, 'MPQ v0 size limit exceeded');
        const changedIndices = new Set([...changes.keys()].map(indexOf));
        for (let index = 0; index < blockCount; index++) {
            if (!changedIndices.has(index)) check(sameBytes(blocks.subarray(index * 16, index * 16 + 16), blockTable.subarray(index * 16, index * 16 + 16)), () => 'Unchanged MPQ block entry changed: ' + blockLabel(index));
        }
        const payload = index => packed.get(index) ?? storedPayload(blocks, index);
        let result = layout(hashes, blocks, payload, appendedEnd);
        if (!result) {
            // Pinned payloads prevent reclamation: keep the appended layout.
            const hashOffset = cursor - offset, blockOffset = hashOffset + hashes.length;
            result = Buffer.concat([bytes, ...packed.values(), transform(hashes, HASH_TABLE_KEY, true), transform(blocks, BLOCK_TABLE_KEY, true)]);
            result.writeUInt32LE(appendedEnd - offset, offset + 8);
            result.writeUInt32LE(hashOffset, offset + 16);
            result.writeUInt32LE(blockOffset, offset + 20);
            result.writeUInt32LE(nextBlock, offset + 28);
        }
        const verified = openMap(result);
        for (const [name, contents] of changes) check(sameBytes(verified.read(name), contents), 'MPQ readback mismatch: ' + name);
        verifyPreserved(result, { changedNames: [...changes.keys()] });
        return result;
    }
    function remove(names) {
        validateArchive();
        assert(Array.isArray(names) && names.every(validName), 'Invalid MPQ removal names');
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
        let output = layout(hashes, blocks, index => storedPayload(blocks, index), bytes.length);
        if (!output) {
            // Table sizes are unchanged, so editing their existing positions avoids
            // growing archives whose fixed-key payloads prevent useful compaction.
            output = Buffer.from(bytes);
            transform(hashes, HASH_TABLE_KEY, true).copy(output, offset + header.readUInt32LE(16));
            transform(blocks, BLOCK_TABLE_KEY, true).copy(output, offset + header.readUInt32LE(20));
        }
        const deleted = new Set(requested.map(canonicalName));
        const list = deleted.has('(LISTFILE)') ? null : read('(listfile)');
        const changedNames = [];
        if (list) {
            const deletedRows = new Set(requested.map(name => listfileKey(Buffer.from(name))));
            const updated = Buffer.concat(listfileRows(list).filter(row => !deletedRows.has(listfileKey(row.name))).map(row => row.line));
            if (!updated.equals(list)) {
                output = openMap(output).replace([['(listfile)', updated]]);
                changedNames.push('(listfile)');
            }
        }
        verifyPreserved(output, { changedNames, removedNames: requested });
        const outputMap = openMap(output);
        for (const name of requested) assert(!outputMap.has(name), 'Removed MPQ path is still present: ' + name);
        return output;
    }
    function optimize(options = {}) {
        validateArchive();
        const encoding = encodingOptions(options);
        const candidates = new Map();
        const names = options.names ?? listNames();
        assert(Array.isArray(names) && names.every(name => typeof name === 'string'), 'Invalid MPQ optimization names');
        const seen = new Set();
        for (const name of names) {
            if (seen.has(canonicalName(name))) continue;
            seen.add(canonicalName(name));
            const matches = matchingSlots(name);
            if (matches.length !== 1 || ['(ATTRIBUTES)', '(SIGNATURE)'].includes(canonicalName(name))) continue;
            const index = hashTable.readUInt32LE(matches[0] + 12), flags = blockTable.readUInt32LE(index * 16 + 12);
            if (hashReferences()[index] !== 1 || (flags !== 0x80000000 && flags !== 0x80000200)) continue;
            const contents = read(name, true);
            if (!contents) continue;
            assert(validName(name), 'Invalid MPQ replacement entries');
            candidates.set(canonicalName(name) === '(LISTFILE)' ? '(listfile)' : name, { contents, packedSize: blockTable.readUInt32LE(index * 16 + 4) });
        }
        // Each candidate is decoded once and encoded in one batch; only entries
        // whose payload shrinks are written, as replace() with recompress does.
        const encodings = encodeMany([...candidates.values()].map(({ contents }) => ({ contents })), encoding);
        const changes = new Map(), encoded = new Map();
        [...candidates].forEach(([name, { contents, packedSize }], position) => {
            if (encodings[position].data.length >= packedSize) return;
            changes.set(name, contents);
            encoded.set(name, encodings[position]);
        });
        const candidate = commit(changes, encoded, encoding);
        const output = candidate.length < bytes.length ? candidate : compact();
        verifyPreserved(output, { changedNames: [...changes.keys()] });
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
        const encoding = encodingOptions(options);
        const size = 512 * 2 ** shift, names = new Map();
        for (const name of [...listNames(), '(listfile)', '(attributes)']) {
            for (const p of matchingSlots(name)) {
                const index = hashTable.readUInt32LE(p + 12);
                if (index < blockCount && !names.has(index)) names.set(index, name);
            }
        }
        const entries = live.map(({ index }) => {
            const flags = blockTable.readUInt32LE(index * 16 + 12), name = names.get(index) ?? null, label = name ?? '#' + index;
            assert.equal(flags & ~0x80030200, 0, 'Unsupported MPQ block flags for a sector size change: ' + label);
            if (flags & 0x10000) assert(name !== null && hashReferences()[index] === 1, 'An encrypted MPQ block needs exactly one known name for a sector size change: ' + label);
            return { index, name, flags, contents: readBlock(index, name) };
        });
        const encodings = encodeMany(entries.map(entry => ({ contents: entry.contents, size, keepSectors: Boolean(entry.flags & 0x10000) })), encoding);
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
        chunks.push(transform(hashTable, HASH_TABLE_KEY, true), transform(blocks, BLOCK_TABLE_KEY, true));
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
        check(sameBytes(other.bytes.subarray(0, offset), bytes.subarray(0, offset)), 'MPQ prefix changed');
        assert.equal(other.hashCount, hashCount, 'MPQ hash count changed');
        assert(other.blockCount >= blockCount, 'MPQ block indices were removed');
        assert.equal(other.sectorSize, sectorSize, 'MPQ sector size changed');
        const changedIndices = new Set(), removedSlots = new Set(), removedIndices = new Set();
        for (const name of changedNames) for (const p of matchingSlots(name)) changedIndices.add(hashTable.readUInt32LE(p + 12));
        for (const name of removedNames) for (const p of matchingSlots(name)) {
            removedSlots.add(p);
            removedIndices.add(hashTable.readUInt32LE(p + 12));
        }
        const changedKeys = new Set(changedNames.map(pathKey));
        const remaining = new Set();
        for (let p = 0; p < other.hashTable.length; p += 16) {
            const index = other.hashTable.readUInt32LE(p + 12);
            if (index < other.blockCount) remaining.add(index);
            if (removedSlots.has(p)) {
                assert.equal(index, 0xfffffffe, 'Removed MPQ hash must be a tombstone: hash slot ' + p / 16);
                check(sameBytes(other.hashTable.subarray(p, p + 12), hashTable.subarray(p, p + 12)), () => 'Removed MPQ locale metadata changed: hash slot ' + p / 16);
            } else if (hashTable.readUInt32LE(p + 12) >= 0xfffffffe && index < other.blockCount) {
                assert(changedKeys.has(other.hashTable.readUInt32LE(p) + ':' + other.hashTable.readUInt32LE(p + 4)), 'Unexpected MPQ hash addition: hash slot ' + p / 16);
            } else check(sameBytes(other.hashTable.subarray(p, p + 16), hashTable.subarray(p, p + 16)), () => 'Unchanged MPQ hash/locale slot changed: hash slot ' + p / 16);
        }
        const attributesIndex = indexOf('(attributes)');
        if (attributesIndex >= 0) changedIndices.add(attributesIndex);
        for (let index = 0; index < blockCount; index++) {
            const p = index * 16, flags = blockTable.readUInt32LE(p + 12);
            if (removedIndices.has(index) && !remaining.has(index)) {
                // A preceding replacement/compaction may have moved the payload
                // before deletion. Inactive offsets have no execution meaning.
                check(sameBytes(other.blockTable.subarray(p + 4, p + 12), blockTable.subarray(p + 4, p + 12)), () => 'Removed MPQ block size metadata changed: ' + blockLabel(index));
                check(other.blockTable.readUInt32LE(p + 12) === (flags & ~0x80000000) >>> 0, () => 'Removed MPQ block remains active: ' + blockLabel(index));
                continue;
            }
            if (changedIndices.has(index)) continue;
            check(sameBytes(other.blockTable.subarray(p + 4, p + 16), blockTable.subarray(p + 4, p + 16)), () => 'Unchanged MPQ block metadata changed: ' + blockLabel(index));
            const start = blockTable.readUInt32LE(p), nextStart = other.blockTable.readUInt32LE(p);
            if (!(flags & 0x80000000) || (flags & 0x30000) === 0x30000) check(nextStart === start, () => 'Pinned/inactive MPQ block offset changed: ' + blockLabel(index));
            if (flags & 0x80000000) {
                const size = blockTable.readUInt32LE(p + 4);
                check(sameBytes(other.bytes.subarray(offset + nextStart, offset + nextStart + size), bytes.subarray(offset + start, offset + start + size)), () => 'Unchanged MPQ packed payload changed: ' + blockLabel(index));
            }
        }
        if (attributesIndex >= 0) {
            const before = read('(attributes)'), after = otherMap.read('(attributes)');
            assert(after, 'MPQ attributes were removed');
            assert.equal(before.readUInt32LE(0), 100, 'Unsupported attributes version');
            const flags = before.readUInt32LE(4);
            assert.equal(flags & ~7, 0, 'Unsupported attribute flags');
            check(sameBytes(after.subarray(0, 8), before.subarray(0, 8)), 'MPQ attributes header changed');
            let oldStart = 8, newStart = 8;
            for (const [flag, stride] of ATTRIBUTE_ARRAYS) {
                if (!(flags & flag)) continue;
                for (let index = 0; index < blockCount; index++) {
                    // Timestamps and deleted slots retain their values; checksum updates
                    // are allowed only for explicitly changed content blocks.
                    if (flag !== 2 && changedIndices.has(index) && index !== attributesIndex) continue;
                    check(sameBytes(after.subarray(newStart + index * stride, newStart + (index + 1) * stride), before.subarray(oldStart + index * stride, oldStart + (index + 1) * stride)), () => 'Unchanged MPQ attribute slot changed: ' + blockLabel(index));
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
