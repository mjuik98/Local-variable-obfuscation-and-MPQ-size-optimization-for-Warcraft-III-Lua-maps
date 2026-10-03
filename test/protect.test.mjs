import test from 'node:test';
import assert from 'node:assert/strict';
import fengari from 'fengari';
import { protectMap } from '../src/protect.mjs';
import { openMap } from '../src/mpq.mjs';
import { parseLua } from '../src/lua.mjs';
import { resolveConfig } from '../src/config.mjs';
import { readScriptLanguage } from '../src/map-info.mjs';
import { createLuaMap, createMapInfo, createImports } from './map-fixture.mjs';
import { createTestMap } from './mpq-fixture.mjs';

function luaResultBytes(code) {
    const { lua, lauxlib, lualib, to_luastring } = fengari;
    const state = lauxlib.luaL_newstate();
    try {
        lualib.luaL_openlibs(state);
        const status = lauxlib.luaL_dostring(state, to_luastring(code + '\nreturn main()'));
        assert.equal(status, lua.LUA_OK, 'Lua fixture should execute');
        return Array.from({ length: lua.lua_gettop(state) }, (_, index) => Buffer.from(lua.lua_tolstring(state, index + 1)));
    } finally { lua.lua_close(state); }
}

test('map info independently identifies Lua in formats 28..33 and 39', () => {
    for (const version of [28, 29, 30, 31, 32, 33, 39]) {
        assert.deepEqual(readScriptLanguage(createMapInfo({ version })), { version, language: 1 });
        assert.deepEqual(readScriptLanguage(createMapInfo({ version, language: 0 })), { version, language: 0 });
        const source = createLuaMap({ version }), before = Buffer.from(source), result = protectMap(source);
        assert.equal(result.summary.mapInfoVersion, version);
        assert.deepEqual(source, before, 'Map input is immutable');
        for (const name of ['war3map.w3i', 'war3map.w3e']) assert.deepEqual(openMap(result.bytes).read(name), openMap(source).read(name));
    }
});

test('default protection is deterministic and preserves editor and development files', () => {
    const source = createLuaMap({ extraEntries: [
        ['war3map.wtg', Buffer.from('editor triggers')], ['war3map.wct', Buffer.from('custom editor script')],
        ['lotkt-object-history.json', Buffer.from('{"history":1}')], ['lotkt-object-receipt.json', Buffer.from('{"receipt":1}')],
        ['model.mdx', Buffer.from('model bytes')],
    ], mpq: { attributes: true, gap: 32 } });
    const before = Buffer.from(source), first = protectMap(source), second = protectMap(source), output = openMap(first.bytes);
    assert.deepEqual(first, second);
    assert.deepEqual(source, before);
    assert.equal(first.summary.inputBytes, source.length);
    assert.equal(first.summary.outputBytes, first.bytes.length);
    assert.deepEqual(first.summary.removedFiles, []);
    assert(first.summary.lua.renamedLocals > 0);
    assert(first.summary.lua.commentsRemoved > 0);
    const ast = parseLua(output.read('war3map.lua').toString('utf8'));
    assert.deepEqual(ast.body.filter(node => node.type === 'FunctionDeclaration').map(node => node.identifier.name), ['config', 'main']);
    for (const name of ['war3map.wtg', 'war3map.wct', 'lotkt-object-history.json', 'lotkt-object-receipt.json', 'model.mdx']) {
        assert.deepEqual(output.read(name), openMap(source).read(name));
    }
});

test('explicit cleanup removes only selected files and preserves locale, orphan and attribute block indices', () => {
    const source = createLuaMap({ extraEntries: [
        ['war3map.wtg', Buffer.from('editor triggers')], ['war3map.wct', Buffer.from('editor script')],
        ['lotkt-object-history.json', Buffer.from('{"history":1}')], ['lotkt-object-receipt.json', Buffer.from('{"receipt":1}')],
        ['localized.bin', Buffer.from('neutral')], ['keep.bin', Buffer.from('resource')],
    ], mpq: { attributes: true, records: [
        { name: 'localized.bin', locale: 0x412, data: Buffer.from('localized payload') },
        { data: Buffer.from('unlisted live payload') },
    ] } });
    const before = openMap(source), result = protectMap(source, { cleanup: { editor: true, development: true, keepFiles: ['WAR3MAP.WCT'] }, compression: { enabled: false } }), after = openMap(result.bytes);
    assert.deepEqual(result.summary.removedFiles, ['war3map.wtg', 'lotkt-object-history.json', 'lotkt-object-receipt.json']);
    assert(after.has('war3map.wct') && after.has('localized.bin'));
    assert.throws(() => after.read('localized.bin'), /Multiple locale/);
    assert.equal(after.inspect().blockCount, before.inspect().blockCount);
    assert.equal(after.read('(attributes)').length, before.read('(attributes)').length);
    assert(before.verifyPreserved(result.bytes, { changedNames: ['war3map.lua', '(listfile)'], removedNames: result.summary.removedFiles }));
    assert.deepEqual(after.read('keep.bin'), Buffer.from('resource'));
});

test('editor and development cleanup are independent opt-ins', () => {
    const source = createLuaMap({ extraEntries: [['war3map.wtg', Buffer.from('editor')], ['lotkt-object-history.json', Buffer.from('{}')]] });
    const editor = protectMap(source, { cleanup: { editor: true } }), development = protectMap(source, { cleanup: { development: true } });
    assert.deepEqual(editor.summary.removedFiles, ['war3map.wtg']);
    assert(openMap(editor.bytes).has('lotkt-object-history.json'));
    assert.deepEqual(development.summary.removedFiles, ['lotkt-object-history.json']);
    assert(openMap(development.bytes).has('war3map.wtg'));
});

test('import cleanup removes matching custom paths and preserves other manifest entries bytewise', () => {
    const retained = [{ flag: 0, path: 'zero.blp' }, { flag: 5, path: 'textures\\keep.blp' }, { flag: 8, path: 'eight.blp' }, { flag: 13, path: 'textures\\한글.blp' }];
    const manifest = createImports([{ flag: 13, path: 'WAR3MAP.WTG' }, { flag: 10, path: 'lotkt-object-history.json' }, ...retained]);
    const source = createLuaMap({ extraEntries: [
        ['war3map.imp', manifest], ['war3map.wtg', Buffer.from('editor')], ['lotkt-object-history.json', Buffer.from('{}')],
        ['war3mapImported\\textures\\keep.blp', Buffer.from('texture')],
    ], mpq: { attributes: true } });
    const result = protectMap(source, { cleanup: { editor: true, development: true }, compression: { enabled: false } });
    assert.deepEqual(openMap(result.bytes).read('war3map.imp'), createImports(retained));
    assert(openMap(source).verifyPreserved(result.bytes, { changedNames: ['war3map.lua', 'war3map.imp', '(listfile)'], removedNames: result.summary.removedFiles }));
});

test('cleanup rejects direct, escaped, concatenated and UTF-8-adjacent references to selected files', () => {
    for (const expression of [
        '"war3map.wtg"', String.raw`"war3map.wt\103"`, '"war3map." .. "wtg"',
        String.raw`"war3map." .. "w\116g"`, '"한글 war3map.wtg"', '[==[war3map.wtg]==]',
    ]) {
        const script = 'function config() end\nfunction main() local filename = ' + expression + '; return filename end';
        const source = createLuaMap({ script, extraEntries: [['war3map.wtg', Buffer.from('editor')]] });
        assert.throws(() => protectMap(source, { cleanup: { editor: true } }), /references cleanup candidate/);
        const kept = protectMap(source, { cleanup: { editor: true, keepFiles: ['war3map.wtg'] } });
        assert(openMap(kept.bytes).has('war3map.wtg'));
    }
});

test('cleanup rejects unresolved environment, file loading and reflection access while defaults preserve candidates', () => {
    for (const statement of [
        'local api = _G[dynamicName]', 'local api = _ENV[dynamicName]', 'local environment = _G', 'local environment = _ENV',
        'Preloader(dynamicPath)', 'local api = _G["Pre" .. "loader"]', 'local api = _ENV.Preloader',
        'load(dynamicCode)', 'local loader = loadfile', 'dofile(dynamicPath)', 'require(dynamicModule)',
        'local inspector = debug', 'local api = io.open',
    ]) {
        const source = createLuaMap({ script: 'function config() end\nfunction main() ' + statement + ' end', extraEntries: [['war3map.wtg', Buffer.from('editor')]] });
        assert.throws(() => protectMap(source, { cleanup: { editor: true }, lua: { renameLocals: false } }), /cleanup/i, statement);
        assert(openMap(protectMap(source, { lua: { renameLocals: false, minify: false } }).bytes).has('war3map.wtg'), 'Disabled cleanup and Lua transformations preserve opaque candidates');
    }
});

test('protected map strings retain Lua runtime bytes for UTF-8, rawcode text, escapes and long brackets', () => {
    const script = String.raw`-- removable comment
function config() end
function main()
    local message = "한글|cffff0000A0EG|r\\Models\\Effect.mdx"
    local binary = "\000\255\x41\z   B"
    local long = [==[첫 줄
-- literal comment
last line]==]
    return message, binary, long
end`;
    const source = createLuaMap({ script }), result = protectMap(source), protectedCode = openMap(result.bytes).read('war3map.lua').toString('utf8');
    assert.deepEqual(luaResultBytes(protectedCode), luaResultBytes(script));
    assert.deepEqual(luaResultBytes(protectedCode)[1], Buffer.from([0, 255, 65, 66]));
    assert(protectedCode.includes('한글') && protectedCode.includes('A0EG') && protectedCode.includes('-- literal comment'));
});

test('configuration is validated and fresh defaults remain unchanged after caller mutations', () => {
    const resolved = resolveConfig({ compression: { levels: [9, 6, 9] }, cleanup: { keepFiles: ['war3map.wtg'] } });
    assert.deepEqual(resolved.compression.levels, [6, 9]);
    resolved.cleanup.keepFiles.push('other.bin'); resolved.lua.keepLocals.push('counter');
    assert.deepEqual(resolveConfig().cleanup, { editor: false, development: false, keepFiles: [] });
    assert.deepEqual(resolveConfig().lua.keepLocals, []);
    for (const value of [null, [], { unknown: true }, { lua: { typo: true } }, { cleanup: { editor: 1 } }, { compression: { levels: [] } }, { compression: { levels: [10] } }, { cleanup: { keepFiles: ['bad\0path'] } }]) {
        assert.throws(() => resolveConfig(value));
    }
});

test('disabled Lua transformations preserve script bytes and compression exclusions preserve packed resources', () => {
    const source = createLuaMap({ extraEntries: [['keep.bin', Buffer.alloc(4096, 65)]] });
    const result = protectMap(source, { lua: { minify: false, renameLocals: false }, compression: { excludeFiles: ['KEEP.BIN'] } });
    const before = openMap(source), after = openMap(result.bytes);
    assert.deepEqual(after.read('war3map.lua'), before.read('war3map.lua'));
    assert.equal(after.inspect().blocks[3].packedSize, before.inspect().blocks[3].packedSize);
    assert.equal(after.inspect().blocks[3].flags, before.inspect().blocks[3].flags);
    assert.deepEqual(after.read('keep.bin'), before.read('keep.bin'));
});

test('unsupported info versions, invalid language and truncated metadata are rejected', () => {
    for (const version of [27, 34, 38, 40]) assert.throws(() => protectMap(createLuaMap({ version })), /Unsupported war3map.w3i/);
    assert.throws(() => protectMap(createLuaMap({ language: 0 })), /selects JASS/);
    assert.throws(() => protectMap(createLuaMap({ language: 2 })), /Invalid map scripting language/);
    const info = createMapInfo();
    for (const length of [0, 3, 20, 29, 90]) assert.throws(() => readScriptLanguage(info.subarray(0, length)));
});

test('mixed scripts, missing required files and unsuitable map headers are rejected', () => {
    for (const name of ['war3map.j', 'Scripts\\war3map.j', 'Scripts\\war3map.lua']) {
        assert.throws(() => protectMap(createLuaMap({ extraEntries: [[name, Buffer.from('alternate script')]] })), /mixed map scripts/);
    }
    const source = createLuaMap();
    for (const name of ['war3map.lua', 'war3map.w3i', 'war3map.w3e']) assert.throws(() => protectMap(openMap(source).remove([name])));
    assert.throws(() => protectMap(createTestMap([], { prefix: Buffer.from('OTHER-header') })), /MPQ.*HM3W|map header/);
});

test('raw MPQ maps are protected with no prefix added and the input remains unchanged', () => {
    const source = createLuaMap({ mpq: { prefix: Buffer.alloc(0), attributes: true } }), snapshot = Buffer.from(source);
    assert.deepEqual(source.subarray(0, 4), Buffer.from([77, 80, 81, 26]));
    const result = protectMap(source), after = openMap(result.bytes);
    assert.equal(after.inspect().archiveOffset, 0);
    assert.deepEqual(source, snapshot);
    for (const name of ['war3map.w3i', 'war3map.w3e']) assert.deepEqual(after.read(name), openMap(source).read(name));
});

test('malformed UTF-8, Lua syntax and missing or duplicated top-level entry points are rejected', () => {
    const invalid = Buffer.concat([Buffer.from('function config() end\nfunction main() end\n--'), Buffer.from([0xc3, 0x28])]);
    assert.throws(() => protectMap(createLuaMap({ script: invalid })), /encoded data|UTF-8/);
    for (const script of [
        'function config() end', 'function main() end', 'function config() end\nfunction main() end\nfunction main() end',
        'function config() end\nlocal function main() end', 'function config() end\nmain = function() end',
    ]) assert.throws(() => protectMap(createLuaMap({ script })), /top-level .* function/);
    assert.throws(() => protectMap(createLuaMap({ script: 'function config() end\nfunction main(' })), /war3map.lua/);
});

test('cleanup rejects malformed import manifests without modifying the input', () => {
    for (const manifest of [Buffer.alloc(7), Buffer.from([1, 0, 0, 0, 1, 0, 0, 0, 13, 65]), Buffer.concat([createImports([]), Buffer.from([1])]), createImports([{ flag: 99, path: 'unknown.bin' }])]) {
        const source = createLuaMap({ extraEntries: [['war3map.wtg', Buffer.from('editor')], ['war3map.imp', manifest]] }), before = Buffer.from(source);
        assert.throws(() => protectMap(source, { cleanup: { editor: true } }), /import/i);
        assert.deepEqual(source, before);
    }
});
