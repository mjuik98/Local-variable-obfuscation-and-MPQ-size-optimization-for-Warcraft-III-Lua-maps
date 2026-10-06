import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { openMap, crc32 } from '../src/mpq.mjs';
import { createTestMap, inspectTestTables, mutateTestMap, fixtureHash, fixtureTransform } from './mpq-fixture.mjs';

test('original MPQ regressions remain intact', () => {
    const exists = 0x80000000, fixedEncrypted = 0x80030200;
    const prefix = Buffer.from('HM3W: preserve the editor map prefix\0');
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
            let slot = fixtureHash(entry.name, 0) % 32;
            while (hashes.readUInt32LE(slot * 16 + 12) !== 0xffffffff) slot = (slot + 1) % 32;
            hashes.writeUInt32LE(fixtureHash(entry.name, 1), slot * 16);
            hashes.writeUInt32LE(fixtureHash(entry.name, 2), slot * 16 + 4);
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
        fixtureTransform(hashes, fixtureHash('(hash table)', 3), true).copy(bytes, prefix.length + hashOffset);
        fixtureTransform(blocks, fixtureHash('(block table)', 3), true).copy(bytes, prefix.length + blockOffset);
        return bytes;
    }
    function packed(bytes, index) {
        const state = inspectTestTables(bytes), p = index * 16;
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
        const key = ((fixtureHash(name.split(/[\\/]/).pop(), 3) + start) ^ raw.length) >>> 0;
        let cursor = offsets.length;
        for (let index = 0; index < count; index++) {
            offsets.writeUInt32LE(cursor, index * 4);
            const sector = Buffer.concat([Buffer.from([2]), zlib.deflateSync(raw.subarray(index * 512, (index + 1) * 512))]);
            chunks.push(fixtureTransform(sector, (key + index) >>> 0, true));
            cursor += sector.length;
        }
        offsets.writeUInt32LE(cursor, count * 4);
        return Buffer.concat([fixtureTransform(offsets, (key - 1) >>> 0, true), ...chunks]);
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
    const original = inspectTestTables(source), originalCount = original.header.readUInt32LE(28);
    assert.deepEqual(openMap(source).read(fixedName), secret, 'Encrypted fixture must really decode');
    assert.throws(() => openMap(source).read('localized.bin'), /Multiple locale/);
    assert.throws(() => openMap(source).read('opaque.bin'), /PKWARE/);
    const compacted = openMap(source).compact(), compactState = inspectTestTables(compacted);
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
    const replaced = openMap(source).replace(requested), replacedMap = openMap(replaced), replacementState = inspectTestTables(replaced);
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
    const highEmpty = mutateTestMap(source, ({ header, blocks }) => blocks.writeUInt32LE(header.readUInt32LE(8), 7 * 16));
    assert.deepEqual(openMap(highEmpty).compact(), highEmpty, 'A larger candidate caused by a high pinned offset must keep the original archive');

    assert.throws(() => openMap(mutateTestMap(source, ({ blocks }) => blocks.writeUInt32LE(31, 0))).compact(), /Invalid live MPQ payload range/);
    assert.throws(() => openMap(mutateTestMap(source, ({ header, blocks }) => blocks.writeUInt32LE(header.readUInt32LE(8), 4))).compact(), /Invalid live MPQ payload range/);
    assert.throws(() => openMap(mutateTestMap(source, ({ header, blocks }) => blocks.writeUInt32LE(header.readUInt32LE(16), 0))).compact(), /Overlapping/);
    assert.throws(() => openMap(mutateTestMap(source, ({ hashes }) => hashes.writeUInt32LE(originalCount, 12))).compact(), /Invalid MPQ block reference/);
    assert.throws(() => openMap(mutateTestMap(source, ({ blocks }) => blocks.writeUInt32LE(0, 12))).compact(), /inactive block/);
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
    const result = openMap(source).replace([['raw.bin', entropy]]), map = openMap(result);
    assert.deepEqual(map.read('raw.bin'), entropy);
    assert.equal(map.inspect().blocks[0].flags, 0x80000000);
    assert.equal(map.inspect().blocks[0].packedSize, entropy.length);
});

test('malformed compressed sectors fail rather than silently falling back', () => {
    const broken = Buffer.alloc(12); broken.writeUInt32LE(8, 0); broken.writeUInt32LE(12, 4); broken.set([2, 255, 255, 255], 8);
    const source = createTestMap([['broken.bin', { data: broken, decoded: Buffer.alloc(32), flags: 0x80000200 }]]);
    assert.throws(() => openMap(source).optimize(), /^Error: Corrupt zlib sector in broken\.bin: /);
    assert.throws(() => openMap(source).replace([['broken.bin', Buffer.from('replacement')]]), /Corrupt zlib sector in broken\.bin/);
});

test('preservation verification detects unexpected changes to unknown payloads and metadata', () => {
    const source = createTestMap([['war3map.lua', Buffer.from('script')]], { records: [{ data: Buffer.from('unknown payload') }] });
    const changedPayload = mutateTestMap(source, ({ offset, blocks }, bytes) => bytes[offset + blocks.readUInt32LE(16)] ^= 1);
    assert.throws(() => openMap(source).verifyPreserved(changedPayload), /^AssertionError.*: Unchanged MPQ packed payload changed: block 1$/);
    const changedScript = mutateTestMap(source, ({ offset, blocks }, bytes) => bytes[offset + blocks.readUInt32LE(0)] ^= 1);
    assert.throws(() => openMap(source).verifyPreserved(changedScript), /packed payload changed: block 0 \(war3map\.lua\)$/);
    const changedFlags = mutateTestMap(source, ({ blocks }) => blocks.writeUInt32LE(0x80000100, 28));
    assert.throws(() => openMap(source).verifyPreserved(changedFlags), /block metadata changed: block 1$/);
});

test('signed maps, reserved removal targets and invalid compression options are rejected', () => {
    const signed = createTestMap([['(signature)', Buffer.from('signature')]]);
    assert.throws(() => openMap(signed).remove(['(signature)']), /Signed maps/);
    assert.throws(() => openMap(signed).optimize(), /Signed maps/);
    const source = createTestMap([['war3map.lua', Buffer.from('script')]], { attributes: true });
    assert.throws(() => openMap(source).remove(['(ATTRIBUTES)']), /Cannot remove/);
    assert.throws(() => openMap(source).replace([['(ATTRIBUTES)', Buffer.alloc(0)]]), /automatically/);
    assert.throws(() => openMap(source).optimize({ levels: [10] }), /Invalid zlib/);
    assert.throws(() => openMap(source).replace([['war3map.lua', Buffer.from('a')], ['WAR3MAP.LUA', Buffer.from('b')]]), /Duplicate MPQ/);
});

test('automatic metadata updates cannot overwrite aliased listfile or attributes blocks', () => {
    const source = createTestMap([['script.bin', Buffer.from('original')]], { aliases: [{ name: 'list-alias.bin', target: '(listfile)' }] });
    assert.throws(() => openMap(source).replace([['new.bin', Buffer.from('new')]]), /Aliased/);
    assert.throws(() => openMap(source).remove(['script.bin']), /Aliased/);
    const attributesAlias = createTestMap([['script.bin', Buffer.from('original')]], { attributes: true, aliases: [{ name: 'attrs-alias.bin', target: '(attributes)' }] });
    assert.throws(() => openMap(attributesAlias).replace([['script.bin', Buffer.from('changed')]]), /Aliased/);
});

test('UTF-8 entry names are hashed as Warcraft III bytes, listed and optimized', () => {
    const korean = 'war3mapImported\\한글.blp', compressible = Buffer.alloc(4096, 65);
    const source = createTestMap([[korean, compressible], ['ascii.bin', compressible]], { attributes: true });
    const map = openMap(source);
    assert(map.has(korean) && map.has('WAR3MAPIMPORTED/한글.BLP'));
    assert.deepEqual(map.read(korean), compressible);
    assert(map.listNames().includes(korean));
    const result = map.optimize(), after = openMap(result);
    assert(after.inspect().blocks[0].packedSize < compressible.length, 'UTF-8 named entries must be recompressed');
    assert.deepEqual(after.read(korean), compressible);
    assert(map.verifyPreserved(result, { changedNames: [korean, 'ascii.bin'] }));
});

test('listfile rows keep legacy bytes when assets are added and are never transcoded', () => {
    const legacy = Buffer.from([0xc7, 0xd1, 0x2e, 0x62, 0x6c, 0x70]); // CP949 bytes, invalid UTF-8.
    const list = Buffer.concat([Buffer.from('keep.bin\n'), legacy, Buffer.from('\r\n\r\n(listfile)')]);
    const source = createTestMap([['keep.bin', Buffer.from('keep')], ['(listfile)', list]]);
    assert.deepEqual(openMap(source).listNames(), ['keep.bin', '(listfile)'], 'Rows that are not UTF-8 are not guessed');
    const added = 'new\\한글.bin', result = openMap(source).replace([[added, Buffer.from('asset')]]);
    assert.deepEqual(openMap(result).read('(listfile)'), Buffer.concat([list, Buffer.from('\r\n' + added + '\r\n')]));
    assert.deepEqual(openMap(result).replace([[added, Buffer.from('asset')]]), result, 'A listed addition is not appended again');
});

test('replacement around a pinned block at the archive end keeps it pinned and falls back to the appended layout', () => {
    const fixture = createTestMap([['a.bin', Buffer.from('aaaa')], ['pin.bin', { data: Buffer.alloc(0), flags: 0x80030000 }]], { attributes: true });
    const source = mutateTestMap(fixture, ({ header, blocks }) => blocks.writeUInt32LE(header.readUInt32LE(8), 16));
    const map = openMap(source), pinned = map.inspect().blocks[1].offset;
    for (const contents of [Buffer.from('changed contents'), Buffer.alloc(0)]) {
        const result = map.replace([['a.bin', contents]]), after = openMap(result);
        assert.deepEqual(after.read('a.bin'), contents);
        assert.equal(after.inspect().blocks[1].offset, pinned, 'FIX_KEY blocks never move');
        assert(map.verifyPreserved(result, { changedNames: ['a.bin'] }));
        assert.deepEqual(after.replace([['a.bin', contents]]), result, 'Repeated replacement is a bytewise no-op');
    }
    // Without attributes an empty payload makes compaction no smaller than
    // appending, so the original archive body stays in place before the tables.
    const plain = mutateTestMap(createTestMap([['a.bin', Buffer.from('aaaa')], ['pin.bin', { data: Buffer.alloc(0), flags: 0x80030000 }]]),
        ({ header, blocks }) => blocks.writeUInt32LE(header.readUInt32LE(8), 16));
    const appended = openMap(plain).replace([['a.bin', Buffer.alloc(0)]]), headerEnd = openMap(plain).inspect().archiveOffset + 32;
    assert.deepEqual(appended.subarray(headerEnd, plain.length), plain.subarray(headerEnd));
    assert.deepEqual(openMap(appended).read('a.bin'), Buffer.alloc(0));
    assert(openMap(plain).verifyPreserved(appended, { changedNames: ['a.bin'] }));
});
