import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { reviewCleanupContract } from '../src/cleanup-review.mjs';
import { planCleanup, validateCleanupContract } from '../src/cleanup.mjs';
import { parseLua } from '../src/lua.mjs';
import { openMap } from '../src/mpq.mjs';
import { createLuaMap, createImports, DEFAULT_LUA } from './map-fixture.mjs';
import { mutateTestMap } from './mpq-fixture.mjs';

// The editor and development candidates; editor data has its own tests.
const CLEANUP_CANDIDATES = ['war3map.wtg', 'war3map.wct', 'lotkt-object-history.json', 'lotkt-object-receipt.json'];

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture({ script = DEFAULT_LUA, level = 6, asset = Buffer.from('repeated resource '.repeat(200)), extraEntries = [], ...mpq } = {}) {
    return createLuaMap({ script, extraEntries: [
        ...CLEANUP_CANDIDATES.map(name => [name, Buffer.from('non-runtime ' + name)]),
        ['asset.bin', { data: asset, flags: 0x80000200, level }],
        ['war3map.imp', createImports([{ path: 'asset.bin' }])],
        ...extraEntries,
    ], mpq });
}

function contractFor(input, files = CLEANUP_CANDIDATES) {
    return {
        version: 1, inputMapSha256: digest(input), scriptSha256: digest(openMap(input).read('war3map.lua')),
        review: {
            dynamicFileAccess: 'The synthetic fixture has no runtime reads of cleanup candidates.',
            objectAndImportReferences: 'The synthetic resource and import dependencies do not use the candidates.',
            limitations: 'This fixture review is not a proof for another map or actual game execution.',
        },
        files: files.map(path => ({ path, reason: 'Reviewed synthetic editor/build metadata.', evidence: ['Exact in-memory fixture contents.'] })),
    };
}

function expectReReview(before, after, pattern) {
    const result = reviewCleanupContract(before, after, contractFor(before));
    assert.equal(result.repackOnly, false);
    assert.equal(result.candidate, null);
    assert(result.reReviewReasons.some(reason => pattern.test(reason)), JSON.stringify(result));
    return result;
}

test('packing-only review returns an explicit v1 proposal without mutating inputs or review evidence', () => {
    const before = fixture({ gap: 40, level: 1, attributes: true }), after = fixture({ gap: 12, level: 9, attributes: true });
    const contract = contractFor(before), original = structuredClone(contract), beforeCopy = Buffer.from(before), afterCopy = Buffer.from(after);
    const result = reviewCleanupContract(before, after, contract);
    assert.equal(result.repackOnly, true);
    assert.equal(result.inputIdentical, false);
    assert.deepEqual(result.reReviewReasons, []);
    assert(result.changes.some(change => change.kind === 'packing' && !change.requiresReview));
    assert.equal(result.candidate.version, 1);
    assert.equal(result.candidate.inputMapSha256, digest(after));
    assert.equal(result.candidate.scriptSha256, contract.scriptSha256);
    assert.deepEqual(result.candidate.review, contract.review);
    assert.deepEqual(result.candidate.files, contract.files);
    assert.deepEqual(contract, original);
    assert.deepEqual(before, beforeCopy); assert.deepEqual(after, afterCopy);
    const map = openMap(after), scriptBytes = map.read('war3map.lua');
    assert.doesNotThrow(() => validateCleanupContract(map, result.candidate, { inputBytes: after, scriptBytes }));
    assert.deepEqual(planCleanup(map, parseLua(scriptBytes.toString('utf8')), { editor: true, development: true, keepFiles: [] }, {
        cleanupContract: result.candidate, inputBytes: after, scriptBytes,
    }).names, CLEANUP_CANDIDATES);
});

test('identical inputs still return a separate proposal and preserve partial candidate selection', () => {
    const input = fixture(), contract = contractFor(input, ['war3map.wtg']);
    const result = reviewCleanupContract(input, input, contract);
    assert.equal(result.repackOnly, true); assert.equal(result.inputIdentical, true);
    assert.deepEqual(result.changes, []);
    assert.deepEqual(result.candidate, contract);
    assert.notEqual(result.candidate, contract);
    assert.notEqual(result.candidate.files, contract.files);
});

test('fixed known paths can prove supported recompression without a listfile while other blocks stay opaque', () => {
    const before = fixture({ listfile: false, script: DEFAULT_LUA + '\n-- ' + 'comment '.repeat(1000) + '\n' });
    const map = openMap(before), after = map.replace([['war3map.lua', map.read('war3map.lua')]], { levels: [9], recompress: true });
    assert(!before.equals(after));
    const result = reviewCleanupContract(before, after, contractFor(before));
    assert(result.repackOnly && result.candidate);
    assert(result.changes.some(change => change.entry === 'war3map.lua' && change.kind === 'packing'));
    const changedUnknown = map.replace([['asset.bin', Buffer.from('modified unnamed resource')]]);
    expectReReview(before, changedUnknown, /Opaque or unresolved payload/);
});

test('old contract schema, exact hashes and runtime reference restrictions are validated first', () => {
    const before = fixture(), after = fixture({ gap: 10 }), stale = contractFor(before);
    stale.inputMapSha256 = '0'.repeat(64);
    assert.throws(() => reviewCleanupContract(before, after, stale), /input map SHA-256 mismatch/);
    assert.throws(() => reviewCleanupContract(before, after, { ...contractFor(before), unexpected: true }), /Unknown or missing/);
    const referenced = fixture({ script: DEFAULT_LUA + '\nlocal candidate = "war3map.wtg"' });
    assert.throws(() => reviewCleanupContract(referenced, referenced, contractFor(referenced)), /references cleanup candidate/);
    const loader = fixture({ script: DEFAULT_LUA + '\nlocal external = load' });
    assert.throws(() => reviewCleanupContract(loader, loader, contractFor(loader)), /cleanup cannot prove/);
});

test('Lua, imports, resources, objects, skins and cleanup payload changes require a fresh review', () => {
    const before = fixture({ extraEntries: [['war3map.w3u', Buffer.from('object fields')], ['war3mapSkin.w3u', Buffer.from('skin fields')]] });
    const original = openMap(before);
    for (const [name, payload] of [
        ['war3map.lua', Buffer.from(DEFAULT_LUA.replace('counter = 7', 'counter = 8'))],
        ['war3map.imp', createImports([{ path: 'another.bin' }])],
        ['asset.bin', Buffer.from('different resource')],
        ['war3map.w3u', Buffer.from('changed object fields')],
        ['war3mapSkin.w3u', Buffer.from('changed skin fields')],
        ['war3map.wtg', Buffer.from('changed editor trigger data')],
        ['lotkt-object-history.json', Buffer.from('changed build history')],
    ]) {
        const result = expectReReview(before, original.replace([[name, payload]]), /Decoded file bytes changed/);
        assert(result.changes.some(change => change.entry.includes(name) && change.kind === 'content'));
    }
});

test('unchanged locale entries, aliases, unsupported payloads and unnamed live blocks remain covered', () => {
    const common = {
        aliases: [{ name: 'asset-alias.bin', target: 'asset.bin' }],
        extraEntries: [['opaque.bin', { data: Buffer.from('unchanged opaque payload'), flags: 0x80000100, length: 500 }]],
        records: [
            { name: 'localized.bin', locale: 0, data: Buffer.from('neutral') },
            { name: 'localized.bin', locale: 0x412, data: Buffer.from('localized') },
            { data: Buffer.from('unlisted live payload') },
        ],
    };
    const before = fixture({ ...common, gap: 18, level: 1 }), after = fixture({ ...common, gap: 30, level: 9 });
    const result = reviewCleanupContract(before, after, contractFor(before));
    assert.equal(result.repackOnly, true);
    assert(result.changes.some(change => change.entry.includes('asset-alias.bin') && change.kind === 'packing'));
    assert(result.changes.some(change => change.entry.includes('localized.bin') && change.kind === 'packing'));
    assert(result.changes.some(change => change.entry.startsWith('MPQ block #') && change.kind === 'packing'));
});

test('opaque, localized and unnamed payload changes never receive a proposal', () => {
    const scenarios = [
        { extraEntries: [['opaque.bin', { data: Buffer.from('old opaque'), flags: 0x80000100, length: 99 }]] },
        { records: [{ name: 'localized.bin', data: Buffer.from('neutral') }, { name: 'localized.bin', locale: 0x412, data: Buffer.from('old localized') }] },
        { records: [{ data: Buffer.from('old unlisted live') }] },
    ];
    for (const scenario of scenarios) {
        const before = fixture(scenario), next = structuredClone(scenario);
        if (next.extraEntries) next.extraEntries[0][1].data = Buffer.from('new opaque');
        else next.records.at(-1).data = Buffer.from('new content');
        expectReReview(before, fixture(next), /Opaque or unresolved payload/);
    }
});

test('locale/platform and alias mapping changes invalidate review even with identical data', () => {
    const before = fixture({ extraEntries: [['other.bin', Buffer.from('repeated resource '.repeat(200))]], aliases: [{ name: 'asset-alias.bin', target: 'asset.bin' }] });
    const metadata = openMap(before).inspect({ includeHashes: true }), slot = metadata.namedEntries.find(entry => entry.name === 'asset-alias.bin').slots[0];
    const locale = mutateTestMap(before, ({ hashes }) => hashes.writeUInt32LE(0x412, slot * 16 + 8));
    expectReReview(before, locale, /locale\/platform/);
    const otherSlot = metadata.namedEntries.find(entry => entry.name === 'other.bin').slots[0], otherIndex = metadata.hashes[otherSlot].blockIndex;
    const alias = mutateTestMap(before, ({ hashes }) => hashes.writeUInt32LE(otherIndex, slot * 16 + 12));
    expectReReview(before, alias, /alias mapping/);
});

test('prefix and directory inventory changes require review', () => {
    const before = fixture();
    expectReReview(before, fixture({ prefix: Buffer.from('HM3W-different-prefix\0') }), /Map prefix bytes changed/);
    expectReReview(before, fixture({ extraEntries: [['new.bin', Buffer.from('new live resource')]] }), /blockCount changed/);
    expectReReview(before, fixture({ hashCount: 128 }), /hashCount changed/);
});

test('FIX_KEY ciphertext placement cannot be inferred equivalent from decoded filenames', () => {
    const encrypted = start => fixture({ extraEntries: [['encrypted.bin', { data: Buffer.from('encrypted content '.repeat(50)), flags: 0x80030200, start }]] });
    expectReReview(encrypted(4096), encrypted(4128), /FIX_KEY placement/);
    const stable = encrypted(4096), compacted = openMap(stable).compact();
    assert.equal(reviewCleanupContract(stable, compacted, contractFor(stable)).repackOnly, true);
});

test('unsupported attributes, corruption and invalid map inputs stop review', () => {
    const before = fixture({ attributes: true }), metadata = openMap(before).inspect({ includeHashes: true });
    const attrSlot = metadata.namedEntries.find(entry => entry.name === '(attributes)').slots[0], attr = metadata.blocks[metadata.hashes[attrSlot].blockIndex];
    const unsupported = Buffer.from(before); unsupported.writeUInt32LE(101, metadata.archiveOffset + attr.offset);
    assert.throws(() => reviewCleanupContract(before, unsupported, contractFor(before)), /Unsupported attributes version/);
    const assetSlot = metadata.namedEntries.find(entry => entry.name === 'asset.bin').slots[0], asset = metadata.blocks[metadata.hashes[assetSlot].blockIndex];
    const corrupt = Buffer.from(before), begin = metadata.archiveOffset + asset.offset;
    const sectorStart = corrupt.readUInt32LE(begin); corrupt[begin + sectorStart + 1] ^= 0xff;
    assert.throws(() => reviewCleanupContract(before, corrupt, contractFor(before)));
    assert.throws(() => reviewCleanupContract('not bytes', before, contractFor(before)), /must be a Buffer/);
    assert.throws(() => reviewCleanupContract(before, Buffer.from('invalid'), contractFor(before)), /must be a raw MPQ/);
});
