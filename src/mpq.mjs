// MPQ v0 support for updating entries, adding assets and reclaiming unused space.
// Only zlib-compressed or uncompressed input entries are decoded.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

export const MPQ_SIGNATURE = Buffer.from([77, 80, 81, 26]); // "MPQ\x1a"
const HEADER_SIZE = 32, ENTRY_SIZE = 16;
// Byte offsets inside the MPQ v0 header and the decrypted table entries.
const HEADER = { headerSize: 4, archiveSize: 8, formatVersion: 12, sectorShift: 14, hashPos: 16, blockPos: 20, hashCount: 24, blockCount: 28 };
const HASH_ENTRY = { nameA: 0, nameB: 4, locale: 8, blockIndex: 12 };
const BLOCK_ENTRY = { start: 0, packedSize: 4, size: 8, flags: 12 };
const FILE_IMPLODE = 0x100, FILE_COMPRESS = 0x200, FILE_ENCRYPTED = 0x10000, FILE_FIX_KEY = 0x20000;
const FILE_SINGLE_UNIT = 0x1000000, FILE_EXISTS = 0x80000000;
const FIXED_ENCRYPTION = FILE_ENCRYPTED | FILE_FIX_KEY, COMPRESSED_FILE = (FILE_EXISTS | FILE_COMPRESS) >>> 0;
// Hash slots whose block index is at least HASH_DELETED are free (deleted or never used).
const HASH_DELETED = 0xfffffffe;
const ZLIB_MASK = 2;
// Hash types: probe start, name checks A/B and encryption key.
const HASH_OFFSET = 0, HASH_A = 1, HASH_B = 2, HASH_KEY = 3;
// (attributes) arrays in file order: [flag, bytes per block] for CRC32, FILETIME and MD5.
const ATTRIBUTES_VERSION = 100, ATTRIBUTES_HEADER_SIZE = 8;
const ATTRIBUTE_CRC32 = 1, ATTRIBUTE_MD5 = 4;
const ATTRIBUTE_ARRAYS = [[ATTRIBUTE_CRC32, 4], [2, 8], [ATTRIBUTE_MD5, 16]];

const mapStates = new WeakMap();
const crypt = new Uint32Array(1280);
{
    let seed = 0x100001;
    for (let low = 0; low < 256; low++) {
        for (let high = 0; high < 5; high++) {
            seed = (seed * 125 + 3) % 0x2aaaab;
            const first = (seed & 0xffff) << 16;
            seed = (seed * 125 + 3) % 0x2aaaab;
            crypt[high * 256 + low] = (first | (seed & 0xffff)) >>> 0;
        }
    }
}
const crcTable = new Uint32Array(256);
for (let byte = 0; byte < 256; byte++) {
    let crc = byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    crcTable[byte] = crc >>> 0;
}

export const canonicalPath = name => name.replaceAll('/', '\\').toUpperCase();
const validName = name => typeof name === 'string' && name.length > 0 && !/[\0\r\n]/.test(name);

function hash(name, type) {
    let a = 0x7fed7fed, b = 0xeeeeeeee;
    for (const c of Buffer.from(canonicalPath(name), 'ascii')) {
        a = (crypt[type * 256 + c] ^ (a + b)) >>> 0;
        b = (c + a + b + (b << 5) + 3) >>> 0;
    }
    return a;
}
const HASH_TABLE_KEY = hash('(hash table)', HASH_KEY), BLOCK_TABLE_KEY = hash('(block table)', HASH_KEY);
const slotKey = (a, b) => a + ':' + b;

function transform(input, key, encrypt) {
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
const decrypt = (input, key) => transform(input, key, false);
const encrypt = (input, key) => transform(input, key, true);

export function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function readBlock(table, index) {
    const p = index * ENTRY_SIZE;
    return { start: table.readUInt32LE(p + BLOCK_ENTRY.start), packedSize: table.readUInt32LE(p + BLOCK_ENTRY.packedSize),
        size: table.readUInt32LE(p + BLOCK_ENTRY.size), flags: table.readUInt32LE(p + BLOCK_ENTRY.flags) };
}
const blockRow = (table, index) => table.subarray(index * ENTRY_SIZE, (index + 1) * ENTRY_SIZE);
const slotBlockIndex = (table, p) => table.readUInt32LE(p + HASH_ENTRY.blockIndex);
const isFixedKey = flags => (flags & FIXED_ENCRYPTION) === FIXED_ENCRYPTION;

function attributesLayout(attributes) {
    assert.equal(attributes.readUInt32LE(0), ATTRIBUTES_VERSION, 'Unsupported attributes version');
    const flags = attributes.readUInt32LE(4);
    assert.equal(flags & ~7, 0, 'Unsupported attribute flags');
    const arrays = ATTRIBUTE_ARRAYS.filter(([flag]) => flags & flag);
    return { flags, arrays, rowSize: arrays.reduce((sum, [, stride]) => sum + stride, 0) };
}

function compressionLevels(levels = [6, 9]) {
    assert(Array.isArray(levels) && levels.length > 0 && levels.every(level => Number.isInteger(level) && level >= 0 && level <= 9), 'Invalid zlib compression levels');
    return [...new Set(levels)];
}

// Listfiles may contain legacy byte encodings and mixed line ends. Compare
// ASCII path bytes case-insensitively without transcoding unrelated rows.
function listfileKey(input) {
    const normalized = Buffer.from(input);
    for (let i = 0; i < normalized.length; i++) {
        if (normalized[i] === 47) normalized[i] = 92;
        else if (normalized[i] >= 97 && normalized[i] <= 122) normalized[i] -= 32;
    }
    return normalized.toString('latin1');
}

export function openMap(input) {
    const bytes = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
    const offset = bytes.indexOf(MPQ_SIGNATURE);
    assert(offset >= 0, 'MPQ header not found');
    const header = bytes.subarray(offset, offset + HEADER_SIZE);
    assert.equal(header.length, HEADER_SIZE, 'Truncated MPQ header');
    assert.equal(header.readUInt16LE(HEADER.formatVersion), 0, 'Only MPQ v0 archives are supported');
    assert.equal(header.readUInt32LE(HEADER.headerSize), HEADER_SIZE, 'Unsupported MPQ header size');
    const archiveEnd = offset + header.readUInt32LE(HEADER.archiveSize);
    assert.equal(archiveEnd, bytes.length, 'Archive has a trailer/signature; refusing to modify it');
    const sectorSize = 512 * 2 ** header.readUInt16LE(HEADER.sectorShift);
    const hashCount = header.readUInt32LE(HEADER.hashCount), blockCount = header.readUInt32LE(HEADER.blockCount);
    const hashPos = header.readUInt32LE(HEADER.hashPos), blockPos = header.readUInt32LE(HEADER.blockPos);
    function table(start, count, key) {
        assert(start >= HEADER_SIZE && offset + start + count * ENTRY_SIZE <= archiveEnd, 'Invalid MPQ table');
        return decrypt(bytes.subarray(offset + start, offset + start + count * ENTRY_SIZE), key);
    }
    const hashTable = table(hashPos, hashCount, HASH_TABLE_KEY);
    const blockTable = table(blockPos, blockCount, BLOCK_TABLE_KEY);
    const encryptedTables = (hashes, blocks) => [encrypt(hashes, HASH_TABLE_KEY), encrypt(blocks, BLOCK_TABLE_KEY)];

    // The tables never change after opening, so derived lookups are built once.
    // Every matching slot is indexed, not only the probe chain, so that locale
    // variants and stray duplicates are always seen.
    let slotIndex = null, referenceCounts = null, liveEntries = null;
    function matchingSlots(name) {
        if (!slotIndex) {
            slotIndex = new Map();
            for (let p = 0; p < hashTable.length; p += ENTRY_SIZE) {
                if (slotBlockIndex(hashTable, p) >= blockCount) continue;
                const key = slotKey(hashTable.readUInt32LE(p + HASH_ENTRY.nameA), hashTable.readUInt32LE(p + HASH_ENTRY.nameB));
                if (slotIndex.has(key)) slotIndex.get(key).push(p);
                else slotIndex.set(key, [p]);
            }
        }
        return slotIndex.get(slotKey(hash(name, HASH_A), hash(name, HASH_B))) ?? [];
    }
    function hashReferences() {
        if (!referenceCounts) {
            referenceCounts = new Uint32Array(blockCount);
            for (let p = 0; p < hashTable.length; p += ENTRY_SIZE) {
                const index = slotBlockIndex(hashTable, p);
                if (index < blockCount) referenceCounts[index]++;
            }
        }
        return referenceCounts;
    }
    function indexOf(name) {
        const matches = matchingSlots(name);
        assert(matches.length <= 1, 'Multiple locale entries require explicit handling: ' + name);
        return matches.length ? slotBlockIndex(hashTable, matches[0]) : -1;
    }
    function has(name) {
        return matchingSlots(name).length > 0;
    }
    function listNames() {
        const list = read('(listfile)');
        if (!list) return [];
        const seen = new Set();
        return list.toString('utf8').split(/\r?\n/).filter(name => {
            if (!name || seen.has(canonicalPath(name)) || !has(name)) return false;
            seen.add(canonicalPath(name));
            return true;
        });
    }
    function inspect() {
        const references = hashReferences();
        return { formatVersion: 0, archiveOffset: offset, archiveSize: archiveEnd - offset,
            sectorSize, hashCount, blockCount, blocks: Array.from({ length: blockCount }, (_, index) => {
                const { start, packedSize, size, flags } = readBlock(blockTable, index);
                return { index, offset: start, packedSize, size, flags, live: Boolean(flags & FILE_EXISTS), hashReferences: references[index] };
            }) };
    }
    function assertIndependent(name) {
        const index = indexOf(name);
        if (index >= 0) assert.equal(hashReferences()[index], 1, 'Aliased entries cannot be replaced independently: ' + name);
    }

    function read(name, skipUnsupported = false) {
        const index = indexOf(name);
        if (index < 0) return null;
        const { start, packedSize, size: length, flags } = readBlock(blockTable, index);
        assert(flags & FILE_EXISTS, 'Entry is not live: ' + name);
        // Opaque input files remain replaceable even when we cannot decode them
        // for the optional identical-content comparison.
        if (skipUnsupported && ((flags & (FILE_IMPLODE | FILE_SINGLE_UNIT)) ||
            ((flags & FILE_ENCRYPTED) && !(flags & FILE_COMPRESS)))) return null;
        assert.equal(flags & FILE_IMPLODE, 0, 'PKWARE compression is unsupported: ' + name);
        // Warcraft III ignores SINGLE_UNIT, unlike generic MPQ readers.
        // Accepting it here would let a self-readable but unplayable map pass validation.
        assert.equal(flags & FILE_SINGLE_UNIT, 0, 'Warcraft III does not support single-unit MPQ entries: ' + name);
        assert(offset + start + packedSize <= archiveEnd, 'Entry outside archive: ' + name);
        const data = bytes.subarray(offset + start, offset + start + packedSize);
        let key = hash(name.split(/[\\/]/).pop(), HASH_KEY);
        if (flags & FILE_FIX_KEY) key = ((key + start) ^ length) >>> 0;
        function unpack(chunk, expected) {
            if (chunk.length === expected) return chunk;
            assert(flags & FILE_COMPRESS, 'Uncompressed length mismatch: ' + name);
            if (skipUnsupported && chunk[0] !== ZLIB_MASK) return null;
            assert.equal(chunk[0], ZLIB_MASK, 'Unsupported compression mask: ' + name);
            const result = zlib.inflateSync(chunk.subarray(1), { maxOutputLength: expected });
            assert.equal(result.length, expected);
            return result;
        }
        if (!(flags & FILE_COMPRESS)) {
            assert(!(flags & FILE_ENCRYPTED), 'Encrypted raw sectors are unsupported');
            assert.equal(packedSize, length);
            return data;
        }
        const count = Math.ceil(length / sectorSize), tableSize = (count + 1) * 4;
        const sectors = flags & FILE_ENCRYPTED ? decrypt(data.subarray(0, tableSize), (key - 1) >>> 0) : data.subarray(0, tableSize);
        const chunks = [];
        for (let i = 0; i < count; i++) {
            const a = sectors.readUInt32LE(i * 4), b = sectors.readUInt32LE(i * 4 + 4);
            assert(a >= tableSize && b >= a && b <= data.length, 'Invalid sector offsets');
            let chunk = data.subarray(a, b);
            if (flags & FILE_ENCRYPTED) chunk = decrypt(chunk, (key + i) >>> 0);
            const raw = unpack(chunk, Math.min(sectorSize, length - i * sectorSize));
            if (raw === null) return null;
            chunks.push(raw);
        }
        return Buffer.concat(chunks);
    }

    function validateArchive() {
        if (liveEntries) return liveEntries;
        assert(!has('(signature)'), 'Signed maps are not supported');
        const live = [];
        const ranges = [[0, HEADER_SIZE], [hashPos, hashPos + hashTable.length], [blockPos, blockPos + blockTable.length]];
        for (let p = 0; p < hashTable.length; p += ENTRY_SIZE) {
            const index = slotBlockIndex(hashTable, p);
            if (index >= HASH_DELETED) continue;
            assert(index < blockCount, 'Invalid MPQ block reference');
            assert(readBlock(blockTable, index).flags & FILE_EXISTS, 'MPQ hash references an inactive block');
        }
        // Keep all live blocks, including files absent from (listfile), and retain
        // their indices so locale entries and attributes arrays remain aligned.
        for (let index = 0; index < blockCount; index++) {
            const { start, packedSize: size, flags } = readBlock(blockTable, index);
            if (!(flags & FILE_EXISTS)) continue;
            assert(start >= HEADER_SIZE && offset + start + size <= archiveEnd, 'Invalid live MPQ payload range');
            // FIX_KEY encryption includes the original MPQ-relative offset.
            // Pin these bytes instead of guessing names or changing encryption.
            live.push({ index, start, size, fixed: isFixedKey(flags), data: bytes.subarray(offset + start, offset + start + size) });
            if (size) ranges.push([start, start + size]);
        }
        ranges.sort((a, b) => a[0] - b[0]);
        let end = 0;
        for (const [start, stop] of ranges) {
            if (start === stop) continue;
            assert(start >= end, 'Overlapping MPQ payloads or tables; refusing to compact');
            end = stop;
        }
        liveEntries = live;
        return live;
    }
    function compact() {
        const live = validateArchive(), pinned = live.filter(entry => entry.fixed).sort((a, b) => a.start - b.start);
        const free = [];
        let cursor = HEADER_SIZE;
        for (const entry of pinned) {
            if (entry.start > cursor) free.push({ start: cursor, end: entry.start });
            cursor = Math.max(cursor, entry.start + entry.size);
        }
        free.push({ start: cursor, end: Infinity });
        const blocks = Buffer.from(blockTable);
        let payloadEnd = HEADER_SIZE;
        for (const entry of live) {
            let start = entry.start;
            if (!entry.fixed) {
                // First-fit leaves small gaps available for later, smaller files.
                const gap = free.find(range => entry.size <= range.end - range.start);
                assert(gap, 'No MPQ payload placement available');
                start = gap.start;
                gap.start += entry.size;
            }
            blocks.writeUInt32LE(start, entry.index * ENTRY_SIZE + BLOCK_ENTRY.start);
            payloadEnd = Math.max(payloadEnd, start + entry.size);
        }
        const hashOffset = payloadEnd, blockOffset = hashOffset + hashTable.length;
        const size = blockOffset + blocks.length;
        // Pinned encryption may prevent useful reclamation. Never grow an archive
        // just to rearrange it, and make an already compact archive a bytewise no-op.
        if (offset + size >= bytes.length) return Buffer.from(bytes);
        const result = Buffer.alloc(offset + size);
        bytes.copy(result, 0, 0, offset + HEADER_SIZE);
        for (const entry of live) entry.data.copy(result, offset + readBlock(blocks, entry.index).start);
        const [hashes, encryptedBlocks] = encryptedTables(hashTable, blocks);
        hashes.copy(result, offset + hashOffset);
        encryptedBlocks.copy(result, offset + blockOffset);
        result.writeUInt32LE(size, offset + HEADER.archiveSize);
        result.writeUInt32LE(hashOffset, offset + HEADER.hashPos);
        result.writeUInt32LE(blockOffset, offset + HEADER.blockPos);
        openMap(result); // Recheck archive/table boundaries after serialization.
        assert.deepEqual(result.subarray(0, offset), bytes.subarray(0, offset), 'MPQ prefix preservation');
        assert.deepEqual(decrypt(result.subarray(offset + hashOffset, offset + blockOffset), HASH_TABLE_KEY), hashTable, 'MPQ hash/locale preservation');
        const verifiedBlocks = decrypt(result.subarray(offset + blockOffset), BLOCK_TABLE_KEY);
        for (let index = 0; index < blockCount; index++) {
            const p = index * ENTRY_SIZE, { start: oldStart, packedSize, flags } = readBlock(blockTable, index);
            assert.deepEqual(verifiedBlocks.subarray(p + 4, p + ENTRY_SIZE), blockTable.subarray(p + 4, p + ENTRY_SIZE), 'MPQ block metadata preservation');
            const newStart = readBlock(verifiedBlocks, index).start;
            if (!(flags & FILE_EXISTS) || isFixedKey(flags)) {
                assert.equal(newStart, oldStart, 'MPQ fixed/inactive block preservation');
            }
            if (flags & FILE_EXISTS) {
                assert.deepEqual(result.subarray(offset + newStart, offset + newStart + packedSize),
                    bytes.subarray(offset + oldStart, offset + oldStart + packedSize), 'MPQ packed payload preservation');
            }
        }
        return result;
    }

    function encode(contents, levels) {
        const count = Math.ceil(contents.length / sectorSize);
        const sectors = Buffer.alloc((count + 1) * 4), chunks = [sectors];
        let cursor = sectors.length;
        for (let i = 0; i < count; i++) {
            sectors.writeUInt32LE(cursor, i * 4);
            const raw = contents.subarray(i * sectorSize, (i + 1) * sectorSize);
            let best = raw;
            for (const level of levels) {
                const candidate = Buffer.concat([Buffer.from([ZLIB_MASK]), zlib.deflateSync(raw, { level })]);
                if (candidate.length < best.length) best = candidate;
            }
            chunks.push(best);
            cursor += best.length;
        }
        sectors.writeUInt32LE(cursor, count * 4);
        const compressed = Buffer.concat(chunks);
        return compressed.length < contents.length ? { data: compressed, flags: COMPRESSED_FILE } : { data: contents, flags: FILE_EXISTS };
    }
    function updateAttributes(attributes, changes, indices, nextBlock) {
        const { arrays, rowSize } = attributesLayout(attributes);
        assert.equal(attributes.length, ATTRIBUTES_HEADER_SIZE + blockCount * rowSize, 'Unexpected attributes size');
        const updated = Buffer.alloc(ATTRIBUTES_HEADER_SIZE + nextBlock * rowSize), arrayStarts = new Map();
        attributes.copy(updated, 0, 0, ATTRIBUTES_HEADER_SIZE);
        let oldStart = ATTRIBUTES_HEADER_SIZE, newStart = ATTRIBUTES_HEADER_SIZE;
        for (const [flag, stride] of arrays) {
            attributes.copy(updated, newStart, oldStart, oldStart + blockCount * stride);
            arrayStarts.set(flag, newStart);
            oldStart += blockCount * stride;
            newStart += nextBlock * stride;
        }
        for (const [name, contents] of changes) {
            const index = indices.get(name);
            if (arrayStarts.has(ATTRIBUTE_CRC32)) updated.writeUInt32LE(crc32(contents), arrayStarts.get(ATTRIBUTE_CRC32) + index * 4);
            // Preserve timestamps; builds are deterministic for the same inputs.
            if (arrayStarts.has(ATTRIBUTE_MD5)) createHash('md5').update(contents).digest().copy(updated, arrayStarts.get(ATTRIBUTE_MD5) + index * 16);
        }
        return updated;
    }
    function replace(entries, options = {}) {
        validateArchive();
        const levels = compressionLevels(options.levels), encoded = new Map();
        const requested = [...entries];
        assert(requested.every(entry => Array.isArray(entry) && entry.length === 2 && validName(entry[0])), 'Invalid MPQ replacement entries');
        assert.equal(new Set(requested.map(([name]) => canonicalPath(name))).size, requested.length, 'Duplicate MPQ paths');
        const changes = new Map(requested.map(([name, contents]) => [canonicalPath(name) === '(LISTFILE)' ? '(listfile)' : name, contents]));
        assert(![...changes.keys()].some(name => canonicalPath(name) === '(ATTRIBUTES)'), 'Attributes are updated automatically');
        assert(![...changes.keys()].some(name => canonicalPath(name) === '(SIGNATURE)'), 'Signed maps are not supported');
        for (const [name, contents] of changes) {
            assert(Buffer.isBuffer(contents), 'Replacement contents must be a Buffer');
            const index = indexOf(name), identical = read(name, true)?.equals(contents);
            if (identical && !options.recompress) { changes.delete(name); continue; }
            const candidate = encode(contents, levels);
            if (identical && candidate.data.length >= readBlock(blockTable, index).packedSize) { changes.delete(name); continue; }
            assertIndependent(name);
            encoded.set(name, candidate);
        }
        if (!changes.size) return compact();
        const additions = [...changes.keys()].filter(name => indexOf(name) < 0);
        if (additions.length) {
            const list = changes.get('(listfile)') ?? read('(listfile)');
            assert(list, 'Adding assets requires an existing MPQ listfile');
            const names = list.toString('utf8').split(/\r?\n/).filter(Boolean);
            const known = new Set(names.map(canonicalPath));
            for (const name of additions) {
                if (!known.has(canonicalPath(name))) { names.push(name); known.add(canonicalPath(name)); }
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
                    const p = ((hash(name, HASH_OFFSET) + step) % hashCount) * ENTRY_SIZE;
                    if (slotBlockIndex(hashes, p) >= HASH_DELETED) { slot = p; break; }
                }
                assert(slot >= 0, 'MPQ hash table is full; cannot add ' + name);
                index = nextBlock++;
                hashes.writeUInt32LE(hash(name, HASH_A), slot + HASH_ENTRY.nameA);
                hashes.writeUInt32LE(hash(name, HASH_B), slot + HASH_ENTRY.nameB);
                hashes.writeUInt32LE(0, slot + HASH_ENTRY.locale); // Neutral locale/platform.
                hashes.writeUInt32LE(index, slot + HASH_ENTRY.blockIndex);
            }
            indices.set(name, index);
        }
        const attributes = read('(attributes)');
        if (attributes) {
            const updated = updateAttributes(attributes, changes, indices, nextBlock);
            if (!updated.equals(attributes)) {
                changes.set('(attributes)', updated);
                indices.set('(attributes)', indexOf('(attributes)'));
            }
        }
        for (const name of changes.keys()) assertIndependent(name);
        const blocks = Buffer.alloc(nextBlock * ENTRY_SIZE), chunks = [Buffer.from(bytes)];
        blockTable.copy(blocks);
        let cursor = bytes.length;
        for (const [name, contents] of changes) {
            // Warcraft requires sector tables; single-unit compressed entries are never emitted.
            const { data, flags } = encoded.get(name) ?? encode(contents, levels);
            const p = indices.get(name) * ENTRY_SIZE;
            blocks.writeUInt32LE(cursor - offset, p + BLOCK_ENTRY.start);
            blocks.writeUInt32LE(data.length, p + BLOCK_ENTRY.packedSize);
            blocks.writeUInt32LE(contents.length, p + BLOCK_ENTRY.size);
            blocks.writeUInt32LE(flags, p + BLOCK_ENTRY.flags);
            chunks.push(data);
            cursor += data.length;
        }
        const hashOffset = cursor - offset, blockOffset = hashOffset + hashes.length;
        chunks.push(...encryptedTables(hashes, blocks));
        cursor += hashes.length + blocks.length;
        assert(cursor - offset <= 0xffffffff, 'MPQ v0 size limit exceeded');
        const result = Buffer.concat(chunks);
        result.writeUInt32LE(cursor - offset, offset + HEADER.archiveSize);
        result.writeUInt32LE(hashOffset, offset + HEADER.hashPos);
        result.writeUInt32LE(blockOffset, offset + HEADER.blockPos);
        result.writeUInt32LE(nextBlock, offset + HEADER.blockCount);
        const verified = openMap(result);
        for (const [name, contents] of changes) assert.deepEqual(verified.read(name), contents, 'MPQ readback mismatch: ' + name);
        const changedIndices = new Set([...changes.keys()].map(indexOf));
        for (let index = 0; index < blockCount; index++) {
            if (!changedIndices.has(index)) assert.deepEqual(blockRow(blocks, index), blockRow(blockTable, index));
        }
        const resultBytes = verified.compact();
        verifyPreserved(resultBytes, { changedNames: [...changes.keys()] });
        return resultBytes;
    }
    function remove(names) {
        validateArchive();
        assert(Array.isArray(names) && names.every(validName), 'Invalid MPQ removal names');
        const requested = [...new Map(names.map(name => [canonicalPath(name), name])).values()];
        assert(!requested.some(name => ['(ATTRIBUTES)', '(SIGNATURE)'].includes(canonicalPath(name))), 'Cannot remove MPQ attributes or signatures');
        const hashes = Buffer.from(hashTable), blocks = Buffer.from(blockTable), removed = new Set();
        for (const name of requested) {
            for (const p of matchingSlots(name)) {
                removed.add(slotBlockIndex(hashTable, p));
                hashes.writeUInt32LE(HASH_DELETED, p + HASH_ENTRY.blockIndex);
            }
        }
        if (!removed.size) return compact();
        const referenced = new Set();
        for (let p = 0; p < hashes.length; p += ENTRY_SIZE) {
            const index = slotBlockIndex(hashes, p);
            if (index < blockCount) referenced.add(index);
        }
        // Only blocks that lost their last named reference are deactivated.
        // Original orphan blocks and aliases still referenced by other names survive.
        for (const index of removed) {
            const p = index * ENTRY_SIZE + BLOCK_ENTRY.flags;
            if (!referenced.has(index)) blocks.writeUInt32LE((blocks.readUInt32LE(p) & ~FILE_EXISTS) >>> 0, p);
        }
        // Table sizes are unchanged, so editing their existing positions avoids
        // growing archives whose fixed-key payloads prevent useful compaction.
        const result = Buffer.from(bytes), [encryptedHashes, encryptedBlocks] = encryptedTables(hashes, blocks);
        encryptedHashes.copy(result, offset + hashPos);
        encryptedBlocks.copy(result, offset + blockPos);
        let output = openMap(result).compact();
        const deleted = new Set(requested.map(canonicalPath));
        const list = deleted.has('(LISTFILE)') ? null : read('(listfile)');
        const changedNames = [];
        if (list) {
            const deletedRows = new Set(requested.map(name => listfileKey(Buffer.from(name))));
            const retained = [];
            let start = 0;
            for (let end = 0; end < list.length; end++) {
                if (list[end] !== 10) continue;
                const nameEnd = end > start && list[end - 1] === 13 ? end - 1 : end;
                if (!deletedRows.has(listfileKey(list.subarray(start, nameEnd)))) retained.push(list.subarray(start, end + 1));
                start = end + 1;
            }
            if (start < list.length && !deletedRows.has(listfileKey(list.subarray(start)))) retained.push(list.subarray(start));
            const updated = Buffer.concat(retained);
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
        const levels = compressionLevels(options.levels), replacements = new Map(), references = hashReferences();
        const names = options.names ?? listNames();
        assert(Array.isArray(names) && names.every(name => typeof name === 'string'), 'Invalid MPQ optimization names');
        const seen = new Set();
        for (const name of names) {
            if (seen.has(canonicalPath(name))) continue;
            seen.add(canonicalPath(name));
            const matches = matchingSlots(name);
            if (matches.length !== 1 || ['(ATTRIBUTES)', '(SIGNATURE)'].includes(canonicalPath(name))) continue;
            const index = slotBlockIndex(hashTable, matches[0]), { flags } = readBlock(blockTable, index);
            if (references[index] !== 1 || ![FILE_EXISTS, COMPRESSED_FILE].includes(flags)) continue;
            const contents = read(name, true);
            if (contents) replacements.set(name, contents);
        }
        const candidate = replace(replacements, { levels, recompress: true });
        const output = candidate.length < bytes.length ? candidate : compact();
        verifyPreserved(output, { changedNames: [...replacements.keys()] });
        return output;
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
        for (const name of changedNames) for (const p of matchingSlots(name)) changedIndices.add(slotBlockIndex(hashTable, p));
        for (const name of removedNames) for (const p of matchingSlots(name)) {
            removedSlots.add(p);
            removedIndices.add(slotBlockIndex(hashTable, p));
        }
        const changedKeys = new Set(changedNames.map(name => slotKey(hash(name, HASH_A), hash(name, HASH_B))));
        const remaining = new Set();
        for (let p = 0; p < other.hashTable.length; p += ENTRY_SIZE) {
            const index = slotBlockIndex(other.hashTable, p);
            if (index < other.blockCount) remaining.add(index);
            if (removedSlots.has(p)) {
                assert.equal(index, HASH_DELETED, 'Removed MPQ hash must be a tombstone');
                assert.deepEqual(other.hashTable.subarray(p, p + HASH_ENTRY.blockIndex), hashTable.subarray(p, p + HASH_ENTRY.blockIndex), 'Removed MPQ locale metadata changed');
            } else if (slotBlockIndex(hashTable, p) >= HASH_DELETED && index < other.blockCount) {
                assert(changedKeys.has(slotKey(other.hashTable.readUInt32LE(p + HASH_ENTRY.nameA), other.hashTable.readUInt32LE(p + HASH_ENTRY.nameB))), 'Unexpected MPQ hash addition');
            } else assert.deepEqual(other.hashTable.subarray(p, p + ENTRY_SIZE), hashTable.subarray(p, p + ENTRY_SIZE), 'Unchanged MPQ hash/locale slot changed');
        }
        const attributesIndex = indexOf('(attributes)');
        if (attributesIndex >= 0) changedIndices.add(attributesIndex);
        for (let index = 0; index < blockCount; index++) {
            const p = index * ENTRY_SIZE, { start, packedSize, flags } = readBlock(blockTable, index);
            if (removedIndices.has(index) && !remaining.has(index)) {
                // A preceding replacement/compaction may have moved the payload
                // before deletion. Inactive offsets have no execution meaning.
                assert.deepEqual(other.blockTable.subarray(p + 4, p + 12), blockTable.subarray(p + 4, p + 12), 'Removed MPQ block size metadata changed');
                assert.equal(readBlock(other.blockTable, index).flags, (flags & ~FILE_EXISTS) >>> 0, 'Removed MPQ block remains active');
                continue;
            }
            if (changedIndices.has(index)) continue;
            assert.deepEqual(other.blockTable.subarray(p + 4, p + ENTRY_SIZE), blockTable.subarray(p + 4, p + ENTRY_SIZE), 'Unchanged MPQ block metadata changed');
            const nextStart = readBlock(other.blockTable, index).start;
            if (!(flags & FILE_EXISTS) || isFixedKey(flags)) assert.equal(nextStart, start, 'Pinned/inactive MPQ block offset changed');
            if (flags & FILE_EXISTS) {
                assert.deepEqual(other.bytes.subarray(offset + nextStart, offset + nextStart + packedSize), bytes.subarray(offset + start, offset + start + packedSize), 'Unchanged MPQ packed payload changed');
            }
        }
        if (attributesIndex >= 0) {
            const before = read('(attributes)'), after = otherMap.read('(attributes)');
            assert(after, 'MPQ attributes were removed');
            const { arrays } = attributesLayout(before);
            assert.deepEqual(after.subarray(0, ATTRIBUTES_HEADER_SIZE), before.subarray(0, ATTRIBUTES_HEADER_SIZE), 'MPQ attributes header changed');
            let oldStart = ATTRIBUTES_HEADER_SIZE, newStart = ATTRIBUTES_HEADER_SIZE;
            for (const [flag, stride] of arrays) {
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
    const api = { read, replace, compact, has, listNames, inspect, remove, optimize, verifyPreserved };
    mapStates.set(api, { bytes, offset, sectorSize, hashCount, blockCount, hashTable, blockTable, validateArchive });
    return api;
}
