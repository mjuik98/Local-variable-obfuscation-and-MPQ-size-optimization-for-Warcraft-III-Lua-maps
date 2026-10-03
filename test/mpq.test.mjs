import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openMap, runMpqTests, crc32 } from '../src/mpq.mjs';
import { createTestMap, inspectTestTables, mutateTestMap, fixtureHash } from './mpq-fixture.mjs';

test('original MPQ regressions remain intact', () => runMpqTests());

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
    assert.throws(() => openMap(source).replace([['war3map.lua', Buffer.from('a')], ['WAR3MAP.LUA', Buffer.from('b')]]), /Duplicate MPQ/);
});

test('automatic metadata updates cannot overwrite aliased listfile or attributes blocks', () => {
    const source = createTestMap([['script.bin', Buffer.from('original')]], { aliases: [{ name: 'list-alias.bin', target: '(listfile)' }] });
    assert.throws(() => openMap(source).replace([['new.bin', Buffer.from('new')]]), /Aliased/);
    assert.throws(() => openMap(source).remove(['script.bin']), /Aliased/);
    const attributesAlias = createTestMap([['script.bin', Buffer.from('original')]], { attributes: true, aliases: [{ name: 'attrs-alias.bin', target: '(attributes)' }] });
    assert.throws(() => openMap(attributesAlias).replace([['script.bin', Buffer.from('changed')]]), /Aliased/);
});
