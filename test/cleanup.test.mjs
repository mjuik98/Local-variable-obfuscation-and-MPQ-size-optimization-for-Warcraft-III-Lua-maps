import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { planCleanup } from '../src/cleanup.mjs';
import { parseLua } from '../src/lua.mjs';
import { openMap } from '../src/mpq.mjs';
import { resolveConfig } from '../src/config.mjs';
import { createLuaMap, createImports } from './map-fixture.mjs';

const CANDIDATES = ['war3map.wtg', 'war3map.wct', 'lotkt-object-history.json', 'lotkt-object-receipt.json'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(statement = 'Preloader(savePath); local native = _G[nativeName]', extraEntries = []) {
    const script = 'function config() end\nfunction main() ' + statement + ' end';
    const inputBytes = createLuaMap({ script, extraEntries: [...CANDIDATES.map(name => [name, Buffer.from('candidate')]), ...extraEntries] });
    const map = openMap(inputBytes), scriptBytes = map.read('war3map.lua');
    const cleanupContract = {
        version: 1, inputMapSha256: digest(inputBytes), scriptSha256: digest(scriptBytes),
        review: {
            dynamicFileAccess: 'Fixture caller attests that savePath never selects any cleanup candidate.',
            objectAndImportReferences: 'Fixture dependencies contain no runtime use of the selected files.',
            limitations: 'This supplied dependency review is an assertion for this exact fixture, not a static proof.',
        },
        files: CANDIDATES.map(path => ({ path, reason: 'Fixture editor or build-only data.', evidence: ['The exact synthetic fixture dependency review.'] })),
    };
    return { map, ast: parseLua(script), context: { inputBytes, scriptBytes, cleanupContract } };
}

const options = overrides => resolveConfig({ cleanup: { editor: true, development: true, ...overrides } }).cleanup;
const plan = (value, selected = options()) => planCleanup(value.map, value.ast, selected, value.context);

test('explicit dependency contracts permit reviewed dynamic file access only for the exact input', () => {
    const value = fixture(), before = Buffer.from(value.context.inputBytes);
    assert.throws(() => planCleanup(value.map, value.ast, options()), /cleanup cannot prove/);
    assert.deepEqual(plan(value), { names: CANDIDATES, imports: null, blocked: [] });
    assert.deepEqual(value.context.inputBytes, before);
    assert.deepEqual(planCleanup(value.map, value.ast, resolveConfig().cleanup, value.context), { names: [], imports: null, blocked: [] }, 'A supplied contract never enables cleanup itself');
});

test('Preloader refusal explains the desktop contract remedy without allowing unreviewed deletion', () => {
    const value = fixture(), selected = options({ development: false, keepFiles: ['war3map.wct'] });
    assert.throws(() => planCleanup(value.map, value.ast, selected), error => {
        assert.match(error.message, /파일 정리를 중단했습니다/);
        assert.match(error.message, /Preloader/);
        assert.match(error.message, /정리 대상: war3map\.wtg\n/);
        assert.match(error.message, /검토 계약 → 찾아보기/);
        assert.match(error.message, /에디터 파일 정리·개발 파일 정리를 모두 해제/);
        assert.match(error.message, /--cleanup-contract/);
        return true;
    });
    assert.deepEqual(plan(value, selected).names, ['war3map.wtg']);
    assert.deepEqual(planCleanup(value.map, value.ast, options({ keepFiles: CANDIDATES })), { names: [], imports: null, blocked: [] });
});

test('contracts require exact map and Lua hashes even when cleanup is disabled', () => {
    for (const key of ['inputMapSha256', 'scriptSha256']) {
        const value = fixture();
        value.context.cleanupContract[key] = '0'.repeat(64);
        assert.throws(() => planCleanup(value.map, value.ast, resolveConfig().cleanup, value.context), /SHA-256 mismatch/);
    }
    const first = fixture(), changed = fixture(undefined, [['model.mdx', Buffer.from('different dependency')]]);
    changed.context.cleanupContract = first.context.cleanupContract;
    assert.equal(digest(first.context.scriptBytes), digest(changed.context.scriptBytes));
    assert.throws(() => plan(changed), /input map SHA-256 mismatch/);
    assert.throws(() => planCleanup(first.map, first.ast, options(), { cleanupContract: first.context.cleanupContract }), /requires the original/);
});

test('strict contract schema rejects unknown fields, unsupported targets and missing review evidence', () => {
    const mutations = [
        value => { value.context.cleanupContract.version = 2; },
        value => { value.context.cleanupContract.extra = true; },
        value => { delete value.context.cleanupContract.scriptSha256; },
        value => { value.context.cleanupContract.scriptSha256 = 'invalid'; },
        value => { value.context.cleanupContract.files = []; },
        value => { value.context.cleanupContract.files[0].path = 'model.mdx'; },
        value => { value.context.cleanupContract.files[0].path = '../war3map.wtg'; },
        value => { value.context.cleanupContract.files[1].path = 'WAR3MAP.WTG'; },
        value => { value.context.cleanupContract.files[0].reason = ' '; },
        value => { value.context.cleanupContract.files[0].evidence = []; },
        value => { value.context.cleanupContract.files[0].evidence = ['']; },
        value => { value.context.cleanupContract.files[0].extra = 'new deletion permission'; },
        value => { delete value.context.cleanupContract.review.dynamicFileAccess; },
        value => { value.context.cleanupContract.review.objectAndImportReferences = ''; },
        value => { value.context.cleanupContract.review.limitations = null; },
        value => { value.context.cleanupContract.review.extra = true; },
        value => { value.context.cleanupContract = null; },
    ];
    for (const mutate of mutations) {
        const value = fixture(); mutate(value);
        assert.throws(() => plan(value), /[Cc]leanup contract/);
    }
});

test('contracts review every selected candidate and keep-files remains authoritative', () => {
    const value = fixture();
    value.context.cleanupContract.files = [value.context.cleanupContract.files[0]];
    assert.throws(() => plan(value), /does not review selected candidate war3map.wct/);
    assert.deepEqual(plan(value, options({ keepFiles: ['WAR3MAP.WCT', 'lotkt-object-history.json', 'lotkt-object-receipt.json'] })).names, ['war3map.wtg']);
    value.context.cleanupContract.files[0].path = 'WAR3MAP.WTG';
    assert.deepEqual(plan(value, options({ development: false, keepFiles: ['war3map.wct'] })).names, ['war3map.wtg']);
});

test('matching contracts cannot override literal, escaped or concatenated candidate references', () => {
    for (const expression of ['"war3map.wtg"', String.raw`"war3map.wt\103"`, '"war3map." .. "wtg"', '"한글 WAR3MAP.WTG"', '[==[war3map.wtg]==]']) {
        const value = fixture('Preloader(savePath); local referenced = ' + expression);
        assert.throws(() => plan(value), /references cleanup candidate/);
        assert(!plan(value, options({ keepFiles: ['WAR3MAP.WTG'] })).names.includes('war3map.wtg'));
    }
});

test('contracts permit reviewed preload and native lookup but never direct external loaders or reflection', () => {
    for (const statement of [
        'Preloader(savePath)', 'local api = _G["Pre" .. "loader"]', 'local native = _ENV[nativeName]',
        'local environment = _G', 'local environment = _G._G',
    ]) assert.doesNotThrow(() => plan(fixture(statement)));
    for (const name of ['io', 'require', 'load', 'loadfile', 'dofile', 'debug', 'package']) {
        for (const statement of ['local forbidden = ' + name, 'local forbidden = _G.' + name, 'local forbidden = _ENV["' + name + '"]']) {
            assert.throws(() => plan(fixture(statement)), /[Cc]leanup.*(cannot prove|cannot permit)/, statement);
        }
    }
    assert.throws(() => plan(fixture('local loader = _G["lo" .. "ad"]')), /cannot permit/);
    assert.throws(() => plan(fixture(String.raw`local loader = _ENV["load\102ile"]`)), /cannot permit/);
    for (const statement of ['local loader = _G._G.load', 'local environment = _G; local loader = environment.load', 'local loader = rawget(_G, "load")']) {
        assert.throws(() => plan(fixture(statement)), /cannot permit/);
    }
});

test('contract cleanup still validates import data and removes only matching manifest records', () => {
    const imports = createImports([{ path: 'lotkt-object-history.json' }, { path: 'model.mdx' }]);
    const value = fixture(undefined, [['war3map.imp', imports]]);
    assert.deepEqual(plan(value).imports, createImports([{ path: 'model.mdx' }]));
    const malformed = fixture(undefined, [['war3map.imp', Buffer.from('unsupported imports')]]);
    assert.throws(() => plan(malformed), /Unsupported import manifest/);
    const invalidFlag = fixture(undefined, [['war3map.imp', createImports([{ flag: 99, path: 'lotkt-object-history.json' }])]]);
    assert.throws(() => plan(invalidFlag), /Unsupported import path flag/);
});

test('editor data cleanup removes region, camera, sound data and the import manifest only when selected and reviewed', async () => {
    const { protectMap } = await import('../src/protect.mjs');
    const editorData = ['war3map.w3r', 'war3map.w3c', 'war3map.w3s', 'war3map.imp'];
    const script = 'function config() end\nfunction main() return "ok" end\n';
    const source = createLuaMap({ script, extraEntries: [
        ['war3map.w3r', Buffer.from('regions')], ['war3map.w3c', Buffer.from('cameras')], ['war3map.w3s', Buffer.from('sounds')],
        ['war3map.imp', createImports([{ path: 'asset.bin' }])], ['war3mapImported\\asset.bin', Buffer.from('asset')],
    ] });
    const kept = openMap(protectMap(source).bytes);
    for (const name of editorData) assert(kept.has(name), name + ' is kept by default');
    const result = protectMap(source, { cleanup: { editorData: true } }), output = openMap(result.bytes);
    assert.deepEqual(result.summary.removedFiles, editorData);
    for (const name of editorData) assert(!output.has(name), name + ' is removed');
    assert.deepEqual(output.read('war3mapImported\\asset.bin'), Buffer.from('asset'), 'Imported files stay readable by path');
    assert(!output.read('(listfile)').toString().includes('war3map.w3r'));
    const partial = openMap(protectMap(source, { cleanup: { editorData: true, keepFiles: ['WAR3MAP.IMP'] } }).bytes);
    assert(partial.has('war3map.imp') && !partial.has('war3map.w3s'));
    const referencing = createLuaMap({ script: 'function config() end\nfunction main() return "war3map.w3c" end\n', extraEntries: [['war3map.w3c', Buffer.from('cameras')]] });
    assert.throws(() => protectMap(referencing, { cleanup: { editorData: true } }), /references cleanup candidate/);
    const preloader = createLuaMap({ script: 'function config() end\nfunction main() Preloader("x") end\n', extraEntries: [['war3map.w3r', Buffer.from('regions')]] });
    assert.throws(() => protectMap(preloader, { cleanup: { editorData: true } }), /Preloader/);
});

test('listfile removal runs after every stage and keeps all entries readable by name', async () => {
    const { protectMap } = await import('../src/protect.mjs');
    const source = createLuaMap({ extraEntries: [['war3mapImported\\model.mdx', Buffer.from('model bytes')]], mpq: { attributes: true } });
    const result = protectMap(source, { cleanup: { listfile: true }, compression: { sectorSizeShift: 3 } }), output = openMap(result.bytes);
    assert(!output.has('(listfile)'));
    assert.deepEqual(output.listNames(), []);
    for (const name of ['war3map.lua', 'war3map.w3i', 'war3map.w3e', 'war3mapImported\\model.mdx', '(attributes)']) assert(output.read(name), name);
    assert(result.summary.removedFiles.includes('(listfile)'));
    assert.deepEqual(result.summary.savings.stages.map(stage => stage.id).slice(-2), ['sectors', 'listfile']);
    assert.equal(output.inspect().sectorSize, 4096, 'The sector rebuild used the listfile before removal');
});

test('editor blocking replaces only the two trigger files with unsupported data when selected', async () => {
    const { protectMap } = await import('../src/protect.mjs');
    const { editorBlockContents } = await import('../src/cleanup.mjs');
    const script = 'function config() end\nfunction main() return "ok" end\n';
    const source = createLuaMap({ script, extraEntries: [['war3map.wtg', Buffer.from('WTG!\x07\0\0\0triggers')], ['war3map.wct', Buffer.from('custom text')],
        ['war3mapImported\\asset.bin', Buffer.from('asset')]], mpq: { attributes: true } });
    const original = openMap(source);
    const unchanged = openMap(protectMap(source).bytes);
    assert.deepEqual(unchanged.read('war3map.wtg'), original.read('war3map.wtg'), 'Editor blocking is off by default');
    const result = protectMap(source, { cleanup: { editorBlock: true } }), output = openMap(result.bytes);
    assert.deepEqual(result.summary.editorBlockedFiles, ['war3map.wtg', 'war3map.wct']);
    assert.deepEqual(result.summary.removedFiles, []);
    assert.deepEqual(output.read('war3map.wtg'), Buffer.from([0x57, 0x54, 0x47, 0x21, 0xff, 0xff, 0xff, 0xff]));
    assert.deepEqual(output.read('war3map.wct'), Buffer.from([0xff, 0xff, 0xff, 0xff]));
    assert.deepEqual(output.read('war3map.wtg'), editorBlockContents('WAR3MAP.WTG'));
    for (const name of ['war3map.w3i', 'war3map.w3e', 'war3mapImported\\asset.bin']) assert.deepEqual(output.read(name), original.read(name), name);
    // Without recompression, every other packed payload and its metadata is kept.
    const plain = protectMap(source, { cleanup: { editorBlock: true }, compression: { enabled: false } });
    assert(original.verifyPreserved(plain.bytes, { changedNames: ['war3map.lua', 'war3map.wtg', 'war3map.wct'] }));
    assert.match(result.summary.savings.stages[0].label, /에디터 차단/);
    const repeated = protectMap(result.bytes, { cleanup: { editorBlock: true } });
    assert.deepEqual(openMap(repeated.bytes).read('war3map.wtg'), editorBlockContents('war3map.wtg'), 'Blocking an already blocked map is stable');
    const listless = protectMap(source, { cleanup: { editorBlock: true, listfile: true } });
    assert.deepEqual(openMap(listless.bytes).read('war3map.wct'), editorBlockContents('war3map.wct'));
});

test('editor blocking refuses missing trigger files, conflicting cleanup and unverified references', async () => {
    const { protectMap } = await import('../src/protect.mjs');
    const { editorBlockContents } = await import('../src/cleanup.mjs');
    const triggers = [['war3map.wtg', Buffer.from('triggers')], ['war3map.wct', Buffer.from('text')]];
    assert.throws(() => protectMap(createLuaMap({ extraEntries: [triggers[0]] }), { cleanup: { editorBlock: true } }), /requires war3map\.wct/);
    assert.throws(() => protectMap(createLuaMap(), { cleanup: { editorBlock: true } }), /requires war3map\.wtg/);
    assert.throws(() => resolveConfig({ cleanup: { editorBlock: true, editor: true } }), /turn off cleanup\.editor/);
    assert.throws(() => resolveConfig({ cleanup: { editorBlock: true, keepFiles: ['War3Map.Wct'] } }), /cannot keep/);
    assert.throws(() => resolveConfig({ cleanup: { editorBlock: 'yes' } }), /editorBlock must be boolean/);
    const referencing = createLuaMap({ script: 'function config() end\nfunction main() return "war3map.wtg" end\n', extraEntries: triggers });
    assert.throws(() => protectMap(referencing, { cleanup: { editorBlock: true } }), /references cleanup candidate/);
    const preloader = createLuaMap({ script: 'function config() end\nfunction main() Preloader("x") end\n', extraEntries: triggers });
    assert.throws(() => protectMap(preloader, { cleanup: { editorBlock: true } }), /Preloader/);
    assert.throws(() => editorBlockContents('war3map.w3i'), /Not an editor trigger file/);
});
