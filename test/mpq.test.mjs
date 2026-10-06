import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import { openMap, runMpqTests, crc32 } from '../src/mpq.mjs';
import { createTestMap, inspectTestTables, mutateTestMap, fixtureHash } from './mpq-fixture.mjs';

const ALL_STRATEGIES = ['default', 'filtered', 'huffman-only', 'rle', 'fixed'];

test('original MPQ regressions remain intact', () => runMpqTests());

test('explicit inspection names do not require decoding an opaque listfile', () => {
    const source = createTestMap([['war3map.lua', Buffer.from('script')],
        ['(listfile)', { data: Buffer.from('opaque listfile bytes'), flags: 0x80000100 }]]);
    const map = openMap(source);
    assert.equal(map.read('(listfile)', true), null);
    assert.throws(() => map.inspect({ includeHashes: true }), /PKWARE/);
    const metadata = map.inspect({ includeHashes: true, includeListedNames: false,
        names: ['war3map.lua', 'WAR3MAP.LUA', '(listfile)', 'missing.bin'] });
    assert.deepEqual(metadata.namedEntries.map(entry => entry.name), ['war3map.lua', '(listfile)']);
    const scriptSlot = metadata.namedEntries[0].slots[0];
    assert.equal(metadata.hashes[scriptSlot].blockIndex, 0);
    assert.throws(() => map.inspect({ includeListedNames: 0 }), /includeListedNames/);
});

test('path lookup distinguishes both hashes and refreshes locale tombstones in a new reader', () => {
    const source = createTestMap([['first.bin', Buffer.from('first')], ['second.bin', Buffer.from('second')],
        ['localized.bin', Buffer.from('neutral')]], {
        aliases: [{ name: 'alias.bin', target: 'localized.bin' }],
        records: [{ name: 'localized.bin', locale: 0x412, data: Buffer.from('Korean') }],
    });
    const collision = mutateTestMap(source, ({ hashes }) => {
        for (let p = 0; p < hashes.length; p += 16) {
            if (hashes.readUInt32LE(p + 12) === 1) hashes.writeUInt32LE(fixtureHash('first.bin', 1), p);
        }
    });
    const reader = openMap(collision);
    assert.deepEqual(reader.read('FIRST.BIN'), Buffer.from('first'));
    assert.equal(reader.read('second.bin'), null);
    assert(reader.has('localized.bin'));
    assert.throws(() => reader.read('localized.bin'), /Multiple locale/);
    const removed = reader.remove(['LOCALIZED.BIN']), fresh = openMap(removed);
    assert(!fresh.has('localized.bin'));
    assert.deepEqual(fresh.read('alias.bin'), Buffer.from('neutral'));
    assert(reader.has('localized.bin'), 'A new archive must not change an existing reader');
    assert(reader.verifyPreserved(removed, { changedNames: ['(listfile)'], removedNames: ['localized.bin'] }));
});

test('raw encoding remains identical when level zero is the only or an extra candidate', () => {
    const source = createTestMap([['file.bin', Buffer.from('original')]], { attributes: true });
    for (const contents of [Buffer.alloc(0), Buffer.alloc(513, 65), Buffer.from('incompressible short')]) {
        const raw = openMap(source).replace([['file.bin', contents]], { levels: [0], strategies: ALL_STRATEGIES });
        const rawMap = openMap(raw);
        assert.deepEqual(rawMap.read('file.bin'), contents);
        assert.equal(rawMap.inspect().blocks[0].flags, 0x80000000);
        const compressed = openMap(source).replace([['file.bin', contents]], { levels: [6, 9] });
        assert.deepEqual(openMap(source).replace([['file.bin', contents]], { levels: [0, 6, 9] }), compressed);
    }
});

test('explicit deletion preserves aliases, locale slots, unknown blocks and attribute indices', () => {
    const shared = Buffer.from('alias contents'), orphan = Buffer.from('unknown live bytes');
    const source = createTestMap([
        ['war3map.lua', Buffer.from('function main() end')],
        ['war3map.wtg', Buffer.from('editor trigger data')],
        ['shared.bin', shared],
        ['localized.bin', Buffer.from('neutral')],
    ], { attributes: true, gap: 40, aliases: [{ name: 'alias.bin', target: 'shared.bin' }], records: [
        { name: 'localized.bin', data: Buffer.from('Korean'), locale: 0x01000412 },
        { data: orphan },
    ] });
    const before = openMap(source), result = before.remove(['WAR3MAP.WTG', 'shared.bin']), after = openMap(result);
    assert(!after.has('war3map.wtg'));
    assert(!after.has('shared.bin'));
    assert.deepEqual(after.read('alias.bin'), shared);
    assert(after.has('localized.bin'));
    assert.throws(() => after.read('localized.bin'), /Multiple locale/);
    assert.equal(after.inspect().blockCount, before.inspect().blockCount);
    assert(after.inspect().blocks[2].live, 'A block with an alias stays live');
    assert(after.inspect().blocks[5].live, 'Original orphan stays live');
    assert(before.verifyPreserved(result, { changedNames: ['(listfile)'], removedNames: ['war3map.wtg', 'shared.bin'] }));
    const listed = after.listNames();
    assert(!listed.includes('war3map.wtg') && !listed.includes('shared.bin') && listed.includes('alias.bin'));
    const tables = inspectTestTables(result);
    for (let p = 0; p < tables.hashes.length; p += 16) {
        if (tables.hashes.readUInt32LE(p) === fixtureHash('war3map.wtg', 1) && tables.hashes.readUInt32LE(p + 4) === fixtureHash('war3map.wtg', 2)) {
            assert.equal(tables.hashes.readUInt32LE(p + 12), 0xfffffffe);
        }
    }
    assert.deepEqual(after.remove(['war3map.wtg', 'shared.bin']), result, 'Deletion is bytewise idempotent');
    const allLocales = after.remove(['localized.bin']);
    assert(!openMap(allLocales).has('localized.bin'), 'Explicit deletion removes every locale for that name');
    assert.equal(openMap(allLocales).inspect().blockCount, before.inspect().blockCount);
});

test('deletion works without listfile and never reclaims unnamed live blocks', () => {
    const source = createTestMap([['delete.bin', Buffer.from('remove')]], { listfile: false, records: [{ data: Buffer.from('unnamed') }] });
    const map = openMap(source), result = map.remove(['delete.bin']);
    assert.deepEqual(openMap(result).listNames(), []);
    assert(openMap(result).inspect().blocks[1].live);
    assert(map.verifyPreserved(result, { removedNames: ['delete.bin'] }));
});

test('deletion does not grow an archive when a pinned empty block prevents compaction', () => {
    const fixture = createTestMap([['delete.bin', Buffer.from('remove')], ['fixed-empty.bin', { data: Buffer.alloc(0), flags: 0x80030000 }]], { listfile: false });
    const source = mutateTestMap(fixture, ({ header, blocks }) => blocks.writeUInt32LE(header.readUInt32LE(8), 16));
    const result = openMap(source).remove(['delete.bin']);
    assert.equal(result.length, source.length);
    assert(!openMap(result).has('delete.bin'));
    assert(openMap(source).verifyPreserved(result, { removedNames: ['delete.bin'] }));
});

test('preservation verification supports compaction followed by deletion without renumbering blocks', () => {
    const source = createTestMap([['delete.bin', Buffer.from('remove')], ['keep.bin', Buffer.from('preserve')]], { gap: 64, attributes: true });
    const before = openMap(source), compacted = before.compact(), after = openMap(compacted).remove(['delete.bin']);
    assert(before.verifyPreserved(after, { changedNames: ['(listfile)'], removedNames: ['delete.bin'] }));
    assert.equal(openMap(after).inspect().blockCount, before.inspect().blockCount);
    assert.deepEqual(openMap(after).read('keep.bin'), Buffer.from('preserve'));
});

test('listfile deletion preserves unrelated legacy bytes, mixed line endings, blank lines and final rows', () => {
    const legacy = Buffer.from([0xff, 0xfe, 0xc3, 0x28]);
    const maskedLookalike = Buffer.from('war3map.wtg');
    maskedLookalike[0] |= 0x80; // ASCII decoding would falsely turn this byte into w.
    const retained = Buffer.concat([
        Buffer.from('keep.bin\n\r\n'), legacy, Buffer.from('.bin\r\n'), maskedLookalike,
        Buffer.from('\nlast.bin'),
    ]);
    const list = Buffer.concat([
        Buffer.from('keep.bin\n\r\nWAR3MAP.WTG\r\n'), legacy, Buffer.from('.bin\r\n'), maskedLookalike,
        Buffer.from('\nlast.bin\nwar3map.wtg'),
    ]);
    // The surviving last.bin row originally has a newline before the final
    // deleted row; preserve that newline as part of the surviving row.
    const expected = Buffer.concat([retained, Buffer.from('\n')]);
    const source = createTestMap([
        ['keep.bin', Buffer.from('keep')], ['war3map.wtg', Buffer.from('delete')],
        ['last.bin', Buffer.from('last')], ['(listfile)', list],
    ], { attributes: true });
    const map = openMap(source), result = map.remove(['war3map.wtg']);
    assert.deepEqual(openMap(result).read('(listfile)'), expected);
    assert(map.verifyPreserved(result, { changedNames: ['(listfile)'], removedNames: ['war3map.wtg'] }));
    assert.deepEqual(openMap(result).remove(['war3map.wtg']), result);
    const noFinalNewline = createTestMap([['war3map.wtg', Buffer.from('delete')], ['(listfile)', Buffer.from('war3map.wtg\r\nkeep.bin')]]);
    assert.deepEqual(openMap(openMap(noFinalNewline).remove(['war3map.wtg'])).read('(listfile)'), Buffer.from('keep.bin'));
});

test('replacement updates listfile and checksums while preserving timestamps', () => {
    const source = createTestMap([['war3map.lua', Buffer.from('old script')], ['keep.bin', Buffer.from('preserved')]], { attributes: true });
    const map = openMap(source), replacement = Buffer.from('local a=1\n'.repeat(400));
    const result = map.replace([['war3map.lua', replacement], ['new.bin', Buffer.from('asset')], ['(LISTFILE)', Buffer.from('war3map.lua\r\nkeep.bin\r\n(listfile)\r\n(attributes)\r\n')]]);
    const updated = openMap(result), oldAttributes = map.read('(attributes)'), attributes = updated.read('(attributes)');
    assert.deepEqual(updated.read('war3map.lua'), replacement);
    assert(updated.listNames().includes('new.bin'));
    assert.equal(attributes.readUInt32LE(8), crc32(replacement));
    const count = updated.inspect().blockCount;
    assert.deepEqual(attributes.subarray(8 + count * 12, 24 + count * 12), createHash('md5').update(replacement).digest());
    assert.equal(attributes.readBigUInt64LE(8 + count * 4), oldAttributes.readBigUInt64LE(8 + map.inspect().blockCount * 4));
    assert(map.verifyPreserved(result, { changedNames: ['war3map.lua', '(listfile)', 'new.bin'] }));
});

test('replacement bytes own their storage without copying or mutating the supplied input chunks', () => {
    const source = createTestMap([['large.bin', Buffer.alloc(128 * 1024, 65)], ['keep.bin', Buffer.from('keep')]]);
    const sourceSnapshot = Buffer.from(source), replacement = Buffer.from('new bytes '.repeat(7000)), replacementSnapshot = Buffer.from(replacement);
    const result = openMap(source).replace([['large.bin', replacement]]);
    assert.deepEqual(openMap(result).read('large.bin'), replacement);
    assert.deepEqual(source, sourceSnapshot);
    assert.deepEqual(replacement, replacementSnapshot);
    result.fill(0);
    assert.deepEqual(source, sourceSnapshot, 'Mutating the returned archive cannot mutate its input');
    assert.deepEqual(replacement, replacementSnapshot, 'Mutating the returned archive cannot mutate replacement contents');
});

test('strategy candidates reduce mixed sectors while retaining the legacy default stream and exact decoded bytes', () => {
    let state = 0x12345678;
    const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state >>> 24; };
    const parts = [Buffer.from(Array.from({ length: 512 }, () => 65 + random() % 4)),
        Buffer.concat(Array.from({ length: 32 }, () => Buffer.alloc(16, random()))),
        Buffer.from('Warcraft III Lua map protection '.repeat(20)).subarray(0, 512)];
    const contents = Buffer.concat(parts), source = createTestMap([['mixed.bin', Buffer.from('original')]], { attributes: true });
    const original = Buffer.from(source), map = openMap(source);
    const legacy = map.replace([['mixed.bin', contents]], { levels: [6] });
    assert.deepEqual(map.replace([['mixed.bin', contents]], { levels: [6], strategies: ['default'] }), legacy);
    const expanded = map.replace([['mixed.bin', contents]], { levels: [6], strategies: ALL_STRATEGIES });
    assert(expanded.length < legacy.length, 'Additional strategies must produce a real reduction on mixed sectors');
    assert.deepEqual(map.replace([['mixed.bin', contents]], { levels: [6], strategies: [...ALL_STRATEGIES].reverse().concat('rle') }), expanded);
    const legacyMap = openMap(legacy), expandedMap = openMap(expanded);
    const sectorPayload = (bytes, archive) => {
        const metadata = archive.inspect(), entry = metadata.blocks[0], start = metadata.archiveOffset + entry.offset;
        assert.equal(entry.flags, 0x80000200, 'Only standard MPQ zlib sectors may be emitted');
        assert.equal(metadata.sectorSize, 512);
        return bytes.subarray(start, start + entry.packedSize);
    };
    const oldPayload = sectorPayload(legacy, legacyMap), newPayload = sectorPayload(expanded, expandedMap);
    for (let index = 0; index < parts.length; index++) {
        const oldSector = oldPayload.subarray(oldPayload.readUInt32LE(index * 4), oldPayload.readUInt32LE(index * 4 + 4));
        const newSector = newPayload.subarray(newPayload.readUInt32LE(index * 4), newPayload.readUInt32LE(index * 4 + 4));
        assert.deepEqual(oldSector, Buffer.concat([Buffer.from([2]), zlib.deflateSync(parts[index], { level: 6 })]), 'Default strategy must retain the old stream bytes');
        assert(newSector.length <= oldSector.length);
        assert.equal(newSector[0], 2);
        assert.deepEqual(zlib.inflateSync(newSector.subarray(1)), parts[index]);
    }
    for (const strategy of ALL_STRATEGIES) {
        const output = map.replace([['mixed.bin', contents]], { levels: [6, 9], strategies: [strategy] });
        assert.deepEqual(openMap(output).read('mixed.bin'), contents);
        assert(map.verifyPreserved(output, { changedNames: ['mixed.bin'] }));
    }
    assert.deepEqual(expandedMap.read('mixed.bin'), contents);
    assert.deepEqual(expandedMap.optimize({ levels: [6], strategies: ALL_STRATEGIES }), expanded, 'Equal-size candidates must retain existing payload bytes');
    assert.deepEqual(expandedMap.optimize({ levels: [6], strategies: ['fixed'] }), expanded, 'A larger strategy candidate must retain the smaller existing payload');
    assert.deepEqual(source, original);
});

test('optimization compares sector compression candidates and preserves encrypted, aliased and unsupported payloads', () => {
    const compressible = Buffer.from('Warcraft III Lua map protection '.repeat(500));
    const source = createTestMap([
        ['raw.bin', compressible],
        ['low.bin', { data: compressible, flags: 0x80000200, level: 0 }],
        ['vault.bin', { data: compressible, flags: 0x80030200 }],
        ['opaque.bin', { data: Buffer.from('unsupported bytes'), flags: 0x80000100, length: 100 }],
        ['alias-target.bin', compressible],
        ['localized.bin', compressible],
    ], { attributes: true, aliases: [{ name: 'alias.bin', target: 'alias-target.bin' }], records: [
        { name: 'localized.bin', data: Buffer.from('another locale'), locale: 0x412 },
        { data: Buffer.from('unknown') },
    ] });
    const before = openMap(source), result = before.optimize(), after = openMap(result);
    assert(result.length < source.length);
    assert.deepEqual(after.read('raw.bin'), compressible);
    assert.deepEqual(after.read('low.bin'), compressible);
    assert.deepEqual(after.read('vault.bin'), compressible);
    assert(before.verifyPreserved(result, { changedNames: ['raw.bin', 'low.bin', '(listfile)'] }));
    assert.deepEqual(after.optimize(), result, 'Repeated optimization is bytewise idempotent');
    assert.throws(() => after.replace([['alias-target.bin', Buffer.from('changed')]]), /Aliased/);
    assert.deepEqual(after.replace([['alias-target.bin', compressible]]), result, 'Identical alias replacement remains a no-op');
    const expanded = before.optimize({ strategies: ALL_STRATEGIES });
    assert(before.verifyPreserved(expanded, { changedNames: ['raw.bin', 'low.bin', '(listfile)'] }));
    assert.deepEqual(openMap(expanded).read('vault.bin'), compressible);
    assert.deepEqual(openMap(expanded).read('(attributes)'), before.read('(attributes)'), 'Recompression must preserve logical checksums and timestamps');
});

test('optimization is optional per named entry and preserves unsupported compression masks', () => {
    const opaque = Buffer.alloc(9); opaque.writeUInt32LE(8, 0); opaque.writeUInt32LE(9, 4); opaque[8] = 8;
    const source = createTestMap([
        ['compress.bin', Buffer.alloc(4096, 65)],
        ['mask.bin', { data: opaque, decoded: Buffer.alloc(32), flags: 0x80000200 }],
        ['keep.bin', Buffer.alloc(2048, 66)],
    ]);
    const map = openMap(source), result = map.optimize({ names: ['compress.bin', 'mask.bin'] });
    assert(map.verifyPreserved(result, { changedNames: ['compress.bin'] }));
    assert(openMap(result).inspect().blocks[0].packedSize < map.inspect().blocks[0].packedSize);
    assert.equal(openMap(result).inspect().blocks[2].packedSize, map.inspect().blocks[2].packedSize);
});

test('incompressible replacement is stored raw without a larger sector table', () => {
    const entropy = Buffer.concat(Array.from({ length: 64 }, (_, i) => createHash('sha256').update(String(i)).digest()));
    const source = createTestMap([['raw.bin', Buffer.from('old')]]);
    const result = openMap(source).replace([['raw.bin', entropy]], { strategies: ALL_STRATEGIES }), map = openMap(result);
    assert.deepEqual(map.read('raw.bin'), entropy);
    assert.equal(map.inspect().blocks[0].flags, 0x80000000);
    assert.equal(map.inspect().blocks[0].packedSize, entropy.length);
});

test('malformed compressed sectors fail rather than silently falling back', () => {
    const broken = Buffer.alloc(12); broken.writeUInt32LE(8, 0); broken.writeUInt32LE(12, 4); broken.set([2, 255, 255, 255], 8);
    const source = createTestMap([['broken.bin', { data: broken, decoded: Buffer.alloc(32), flags: 0x80000200 }]]);
    assert.throws(() => openMap(source).optimize());
    assert.throws(() => openMap(source).replace([['broken.bin', Buffer.from('replacement')]]));
});

test('preservation verification detects unexpected changes to unknown payloads and metadata', () => {
    const source = createTestMap([['war3map.lua', Buffer.from('script')]], { records: [{ data: Buffer.from('unknown payload') }] });
    const changedPayload = mutateTestMap(source, ({ offset, blocks }, bytes) => bytes[offset + blocks.readUInt32LE(16)] ^= 1);
    assert.throws(() => openMap(source).verifyPreserved(changedPayload), /packed payload/);
    const changedFlags = mutateTestMap(source, ({ blocks }) => blocks.writeUInt32LE(0x80000100, 28));
    assert.throws(() => openMap(source).verifyPreserved(changedFlags), /block metadata/);
});

test('signed maps, reserved removal targets and invalid compression options are rejected', () => {
    const signed = createTestMap([['(signature)', Buffer.from('signature')]]);
    assert.throws(() => openMap(signed).remove(['(signature)']), /Signed maps/);
    assert.throws(() => openMap(signed).optimize(), /Signed maps/);
    const source = createTestMap([['war3map.lua', Buffer.from('script')]], { attributes: true });
    assert.throws(() => openMap(source).remove(['(ATTRIBUTES)']), /Cannot remove/);
    assert.throws(() => openMap(source).replace([['(ATTRIBUTES)', Buffer.alloc(0)]]), /automatically/);
    assert.throws(() => openMap(source).optimize({ levels: [10] }), /Invalid zlib/);
    for (const strategies of [null, [], 'default', [0], ['DEFAULT'], ['unknown'], ['default', null], new Array(1)]) {
        assert.throws(() => openMap(source).optimize({ strategies }), /compression\.strategies/);
        assert.throws(() => openMap(source).replace([], { strategies }), /compression\.strategies/);
    }
    assert.throws(() => openMap(source).replace([['war3map.lua', Buffer.from('a')], ['WAR3MAP.LUA', Buffer.from('b')]]), /Duplicate MPQ/);
});

test('automatic metadata updates cannot overwrite aliased listfile or attributes blocks', () => {
    const source = createTestMap([['script.bin', Buffer.from('original')]], { aliases: [{ name: 'list-alias.bin', target: '(listfile)' }] });
    assert.throws(() => openMap(source).replace([['new.bin', Buffer.from('new')]]), /Aliased/);
    assert.throws(() => openMap(source).remove(['script.bin']), /Aliased/);
    const attributesAlias = createTestMap([['script.bin', Buffer.from('original')]], { attributes: true, aliases: [{ name: 'attrs-alias.bin', target: '(attributes)' }] });
    assert.throws(() => openMap(attributesAlias).replace([['script.bin', Buffer.from('changed')]]), /Aliased/);
});

test('archive headers are recognized only at Storm-aligned offsets with readable table sizes', () => {
    const source = createTestMap([['file.bin', Buffer.from('aligned')]]);
    assert.equal(openMap(source).inspect().archiveOffset, 512);
    const unaligned = Buffer.concat([Buffer.from('HM3W'), source.subarray(512)]);
    assert.throws(() => openMap(unaligned), /512-byte aligned/);
    const shifted = Buffer.from(source); shifted.writeUInt16LE(24, 512 + 14);
    assert.throws(() => openMap(shifted), /sector size shift/);
    const oddHash = Buffer.from(source); oddHash.writeUInt32LE(48, 512 + 24);
    assert.throws(() => openMap(oddHash), /power of two/);
    const truncated = mutateTestMap(createTestMap([['file.bin', { data: Buffer.alloc(2000, 7), flags: 0x80000200 }]]), ({ blocks }) => {
        blocks.writeUInt32LE(4000, 8);
    });
    assert.throws(() => openMap(truncated).read('file.bin'), /length mismatch|sector/);
});

test('a sector size change re-encodes every live block and keeps slots, sizes, encryption and attributes', () => {
    const text = Buffer.from('local value = "repeated text block" -- '.repeat(400));
    const source = createTestMap([
        ['war3map.lua', { data: text, flags: 0x80000200 }],
        ['vault\fixed.bin', { data: Buffer.from('fixed key '.repeat(300)), flags: 0x80030200 }],
        ['plain.bin', { data: Buffer.from('encrypted plain key '.repeat(90)), flags: 0x80010200 }],
        ['empty.bin', Buffer.alloc(0)],
        ['shared.bin', Buffer.from('alias contents')],
    ], { attributes: true, aliases: [{ name: 'alias.bin', target: 'shared.bin' }], records: [
        { data: Buffer.from('unnamed unencrypted payload '.repeat(50)), flags: 0x80000200 },
        { data: Buffer.from('gone'), flags: 0 },
    ] });
    const before = openMap(source), beforeInfo = before.inspect({ includeHashes: true });
    const output = before.resector({ shift: 3, levels: [9] }), after = openMap(output), info = after.inspect({ includeHashes: true });
    assert.equal(info.sectorSize, 4096);
    assert.deepEqual(info.hashes, beforeInfo.hashes);
    assert.equal(info.blockCount, beforeInfo.blockCount);
    for (const name of ['war3map.lua', 'vault\fixed.bin', 'plain.bin', 'empty.bin', 'shared.bin', 'alias.bin', '(listfile)', '(attributes)']) {
        assert.deepEqual(after.read(name), before.read(name), name);
    }
    beforeInfo.blocks.forEach((block, index) => {
        const next = info.blocks[index];
        assert.equal(next.size, block.size);
        assert.equal(next.flags | 0x200, block.flags | 0x200);
        if (!block.live) assert.deepEqual(next, block);
    });
    assert(info.blocks[1].flags & 0x30000, 'Fixed-key encryption must remain');
    assert(output.length < source.length, 'Larger sectors must compress the repeated script better');
    assert.deepEqual(openMap(output).resector({ shift: 3, levels: [9] }), output, 'Rebuilding with the same settings is reproducible');
});

test('a sector size change refuses unsupported shifts, encrypted unnamed blocks and opaque compression', () => {
    const source = createTestMap([['file.bin', Buffer.from('content')]]);
    assert.throws(() => openMap(source).resector({ shift: 2 }), /sector size shift/);
    assert.throws(() => openMap(source).resector({ shift: 9 }), /sector size shift/);
    const unnamed = createTestMap([['file.bin', Buffer.from('content')]], { records: [{ name: 'secret.bin', data: Buffer.from('secret data'), flags: 0x80010200 }] });
    const withoutListing = mutateTestMap(unnamed, () => {});
    const listless = createTestMap([['file.bin', Buffer.from('content')]], { listfile: false, records: [{ name: 'secret.bin', data: Buffer.from('secret data'), flags: 0x80010200 }] });
    assert.ok(openMap(withoutListing).resector({ shift: 4 }));
    assert.throws(() => openMap(listless).resector({ shift: 4 }), /known name/);
    const opaque = createTestMap([['file.bin', { data: Buffer.from('opaque'), flags: 0x80000100 }]]);
    assert.throws(() => openMap(opaque).resector({ shift: 4 }), /PKWARE|Unsupported MPQ block flags/);
});

test('optional Zopfli candidates never enlarge sectors and stay readable with zlib', () => {
    const text = Buffer.from(Array.from({ length: 600 }, (_, index) => 'local value' + (index % 37) + ' = "entry ' + (index * 7 % 101) + '"\n').join(''));
    const random = Buffer.from(Array.from({ length: 3000 }, (_, index) => (index * 2654435761 >>> 13) & 255));
    const source = createTestMap([['script.lua', text], ['noise.bin', random]], { attributes: true, sectorShift: 3 });
    const plain = openMap(source).optimize({ levels: [9] }), better = openMap(source).optimize({ levels: [9], zopfli: true });
    for (const name of ['script.lua', 'noise.bin']) assert.deepEqual(openMap(better).read(name), openMap(source).read(name));
    const size = (bytes, index) => openMap(bytes).inspect().blocks[index].packedSize;
    assert(size(better, 0) < size(plain, 0), 'Zopfli finds a smaller stream for repetitive text');
    assert(size(better, 1) <= size(plain, 1));
    assert.deepEqual(openMap(source).optimize({ levels: [9], zopfli: true }), better, 'Zopfli output is reproducible');
    const rebuilt = openMap(source).resector({ shift: 4, levels: [9], zopfli: true });
    assert.deepEqual(openMap(rebuilt).read('script.lua'), text);
    assert.throws(() => openMap(source).optimize({ zopfli: 'yes' }), /zopfli must be boolean/);
});
