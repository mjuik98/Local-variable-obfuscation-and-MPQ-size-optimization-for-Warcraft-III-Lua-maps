import test from 'node:test';
import assert from 'node:assert/strict';
import fengari from 'fengari';
import { protectMap } from '../src/protect.mjs';
import { openMap } from '../src/mpq.mjs';
import { parseLua, transformLua } from '../src/lua.mjs';
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

test('recompression still optimizes an unchanged script and changed payloads already use all candidates', () => {
    const script = '-- keep this source unchanged\n' + 'local meaningfulName=42\n'.repeat(120) +
        'function config() end\nfunction main() return meaningfulName end';
    const source = createLuaMap({ script, extraEntries: [['model.mdx', Buffer.from('preserve model '.repeat(1000))]] });
    const original = openMap(source), plain = protectMap(source, { lua: { renameLocals: false, minify: false } });
    const plainMap = openMap(plain.bytes);
    assert.deepEqual(plainMap.read('war3map.lua'), original.read('war3map.lua'));
    const scriptSize = map => map.inspect().blocks[0].packedSize;
    assert(scriptSize(plainMap) < scriptSize(original), 'An identical replacement must still receive compression');
    for (const strategies of [['default'], ['default', 'filtered', 'huffman-only', 'rle', 'fixed']]) {
        const config = { compression: { strategies } }, result = protectMap(source, config), map = openMap(result.bytes);
        assert(!map.read('war3map.lua').equals(original.read('war3map.lua')));
        assert.deepEqual(map.optimize({ levels: [6, 9], strategies }), result.bytes,
            'Recompressing the changed script again must find no better candidate');
        for (const name of original.listNames().filter(name => name !== 'war3map.lua')) {
            assert.deepEqual(map.read(name), original.read(name), 'Recompression must preserve logical file bytes: ' + name);
        }
        assert(original.verifyPreserved(result.bytes, { changedNames: original.listNames() }));
    }
});

test('hardened transforms compose with VM and preserve non-script MPQ contracts', () => {
    const script = `do
    local function ReviewedCalculation(value, scale)
        local result=value*scale
        if result<0 then return -result,nil else return result+4,false end
    end
    local function Run()
        local result,flag=ReviewedCalculation(3,2)
        local message='보호된 테스트 메시지'
        return tostring(result),tostring(flag),message
    end
    PublicRun=Run
    end
    function config() end
    function main() return PublicRun() end`;
    const source=createLuaMap({script, extraEntries:[
        ['war3map.wtg',Buffer.from('editor must stay')],
        ['encrypted.bin',{data:Buffer.from('encrypted resource'),flags:0x80030200}],
        ['opaque.bin',{data:Buffer.from([0x10,1,2,3,4]),decoded:Buffer.from('opaque'),flags:0x81000200}],
    ],mpq:{attributes:true,records:[{data:Buffer.from('unlisted live block')},{name:'localized.bin',locale:0x412,data:Buffer.from('localized resource')}]}});
    const before=Buffer.from(source), options={lua:{nameMode:'seeded',seed:'composed',vmFunctions:['ReviewedCalculation']},strings:{enabled:true,mode:'runtime'}};
    const result=protectMap(source,options), reread=openMap(result.bytes), code=reread.read('war3map.lua').toString('utf8');
    assert.deepEqual(source,before);
    assert.deepEqual(result.bytes,protectMap(source,options).bytes);
    assert.equal(result.summary.vm.virtualizedFunctions,1);
    assert.equal(result.summary.strings.mode,'runtime');
    assert(result.summary.strings.encodedLiterals>0);
    assert.deepEqual(luaResultBytes(code),luaResultBytes(script));
    assert(openMap(source).verifyPreserved(result.bytes,{changedNames:['war3map.lua']}));
    assert.deepEqual(reread.read('war3map.wtg'),Buffer.from('editor must stay'));
    assert.deepEqual(reread.read('encrypted.bin'),Buffer.from('encrypted resource'));
});

test('VM and runtime hiding stay explicit and unsupported map functions fail before output', () => {
    const source=createLuaMap({script:'local function Unsafe(a) return Native(a) end\nfunction config() end\nfunction main() return Unsafe(7) end'});
    assert.equal(protectMap(source).summary.vm.virtualizedFunctions,0);
    assert.throws(()=>protectMap(source,{lua:{vmFunctions:['Unsafe']}}),/CallExpression/);
    assert.throws(()=>protectMap(source,{lua:{vmFunctions:['Missing']}}),/exactly one/);
});

test('strengthened compile-only validation catches temporary register overflow without executing the map', () => {
    const locals=Array.from({length:197},(_,index)=>'v'+index).join(','), values=Array.from({length:49},()=>1).join(',');
    const script='local '+locals+';local function Target(a) return a+1 end;function config() end;function main() end;return {'+values+',{1,2,3,4,5}}';
    const state=fengari.lauxlib.luaL_newstate();
    try { assert.equal(fengari.lauxlib.luaL_loadstring(state,fengari.to_luastring(script)),fengari.lua.LUA_OK); }
    finally { fengari.lua.lua_close(state); }
    const source=createLuaMap({script});
    assert.throws(()=>protectMap(source,{lua:{vmFunctions:['Target']}}),/compilation failed.*too many registers/);
    const runtimeSource=createLuaMap({script:script.replace('return {','local message="readable message";return {')});
    assert.throws(()=>protectMap(runtimeSource,{strings:{enabled:true,mode:'runtime'}}),/too many registers|resource limits/);
    const neverExecute=createLuaMap({script:'error("must never execute")\nfunction config() end\nfunction main() return "hidden message" end'});
    assert.equal(protectMap(neverExecute,{strings:{enabled:true,mode:'runtime'}}).summary.strings.mode,'runtime');
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
    assert.deepEqual(resolveConfig().cleanup, { editor: false, development: false, editorData: false, listfile: false, editorBlock: false, editorBlockFormat: 'empty', editorBlockFiles: 'both', editorBlockAcceptDynamic: false, keepFiles: [] });
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

test('optional string encoding composes with local renaming and MPQ preservation', () => {
    const script = 'function config() end\nfunction main() local message="secret message 한글"; return message, "A0EG", "|cffff0000level %d|r" end';
    const source = createLuaMap({ script, extraEntries: [['resource.bin', Buffer.from('preserved bytes')]], mpq: { attributes: true } }), before = Buffer.from(source);
    const result = protectMap(source, { strings: { enabled: true }, compression: { enabled: false } }), protectedCode = openMap(result.bytes).read('war3map.lua').toString();
    assert.equal(result.summary.strings.encodedLiterals, 1);
    assert(!protectedCode.includes('secret message'));
    assert.deepEqual(luaResultBytes(protectedCode), luaResultBytes(script));
    assert.equal(result.summary.lua.outputBytes, Buffer.byteLength(protectedCode));
    assert(openMap(source).verifyPreserved(result.bytes, { changedNames: ['war3map.lua'] }));
    assert.deepEqual(source, before);
});

test('string encoding cannot bypass source observation when naming and minification are disabled', () => {
    const script = 'function config() end\nfunction main() local message="hidden text"; return message, debug.getinfo(1, "S").source end';
    const source = createLuaMap({ script }), before = Buffer.from(source);
    assert.throws(() => protectMap(source, { lua: { renameLocals: false, minify: false }, strings: { enabled: true } }), /source-location/);
    const identity = protectMap(source, { lua: { renameLocals: false, minify: false }, strings: { enabled: true, keep: ['hidden text'] } });
    assert.deepEqual(openMap(identity.bytes).read('war3map.lua'), Buffer.from(script));
    assert.deepEqual(source, before);
});

test('map savings reconcile packed blocks and chained archive stages without changing preservation', () => {
    const source = createLuaMap({ extraEntries: [
        ['war3map.wtg', Buffer.from('editor payload to remove')],
        ['war3map.imp', createImports([{ path: 'war3map.wtg' }, { path: 'resource.bin' }])],
        ['resource.bin', { data: Buffer.alloc(9000, 65), flags: 0x80000200 }],
        ['opaque.bin', { data: Buffer.from('opaque compressed payload'), flags: 0x80000100 }],
    ], mpq: { attributes: true, gap: 17, records: [{ data: Buffer.from('orphan payload') }] } });
    const snapshot = Buffer.from(source);
    const result = protectMap(source, { cleanup: { editor: true } });
    const { savings } = result.summary;
    assert.equal(savings.savedBytes, source.length - result.bytes.length);
    assert.equal(savings.files.reduce((sum, file) => sum + file.savedBytes, 0) + savings.storage.savedOtherBytes, savings.savedBytes);
    assert.equal(savings.storage.beforePayloadBytes + savings.storage.beforeOtherBytes, source.length);
    assert.equal(savings.storage.afterPayloadBytes + savings.storage.afterOtherBytes, result.bytes.length);
    assert.deepEqual(savings.stages.map(stage => stage.id), ['lua', 'cleanup', 'recompression']);
    assert.match(savings.stages[0].label, /Lua.*import.*공간 회수/);
    let previous = source.length;
    for (const stage of savings.stages) { assert.equal(stage.beforeBytes, previous); previous = stage.afterBytes; }
    assert.equal(previous, result.bytes.length);
    assert.equal(savings.stages.reduce((sum, stage) => sum + stage.savedBytes, 0), savings.savedBytes);
    const resource = savings.files.find(file => file.names.includes('resource.bin'));
    assert.equal(resource.beforeBytes, openMap(source).inspect().blocks[resource.blockIndex].packedSize);
    assert(resource.beforeBytes < 9000, 'Savings must report packed size, not decoded size');
    assert.equal(savings.files.find(file => file.names.includes('war3map.wtg')).kind, 'removed');
    assert.equal(savings.files.find(file => file.names.includes('war3map.imp')).kind, 'rewrite');
    assert.equal(savings.files.find(file => file.names.includes('opaque.bin')).kind, 'unchanged');
    assert.deepEqual(source, snapshot);
    assert(openMap(source).verifyPreserved(result.bytes, {
        changedNames: ['war3map.lua', 'war3map.imp', '(listfile)', 'resource.bin', 'war3map.w3i', 'war3map.w3e'],
        removedNames: ['war3map.wtg'],
    }));
});

test('compression strategies reach script replacement and subsequent file optimization', () => {
    const source = createLuaMap({ script: '-- comments '.repeat(100) + '\nfunction config() end\nfunction main() local longName=12; return longName end',
        extraEntries: [['resource.bin', Buffer.alloc(20000, 65)]] });
    const configuration = { compression: { levels: [6], strategies: ['rle'] } };
    const result = protectMap(source, configuration);
    const script = Buffer.from(transformLua(openMap(source).read('war3map.lua').toString()).code);
    const replaced = openMap(source).replace([['war3map.lua', script]], { levels: [6], strategies: ['rle'] });
    const current = openMap(replaced);
    const expected = current.optimize({ names: current.listNames(), levels: [6], strategies: ['rle'] });
    assert.deepEqual(result.bytes, expected);
    assert.notDeepEqual(result.bytes, protectMap(source, { compression: { levels: [6], strategies: ['default'] } }).bytes);
});

test('savings preserves unreadable listfiles when compression and cleanup are disabled', () => {
    const source = createLuaMap({ extraEntries: [['(listfile)', { data: Buffer.from('opaque listfile'), flags: 0x80000100 }]] });
    const result = protectMap(source, { compression: { enabled: false } });
    const list = result.summary.savings.files.find(file => file.names.includes('(listfile)'));
    assert.equal(list.kind, 'unchanged');
    assert.match(list.label, /읽기 미지원.*보존/);
    assert.deepEqual(openMap(source).read('war3map.w3e'), openMap(result.bytes).read('war3map.w3e'));
});

test('maximum protection with a sector size change keeps results, metadata and the required entries', async () => {
    const { resolveSettings } = await import('../src/presets.mjs');
    const script = 'QuestState = { count = 0 }\nfunction QuestState.add(step) QuestState.count = QuestState.count + step; return QuestState.count end\n' +
        'function config() end\nfunction main() local total = QuestState.add(2) + QuestState.add(3); return I2S(total) .. " units", "hidden message text" end\n';
    const source = createLuaMap({ script, extraEntries: [['war3map.wts', Buffer.from('STRING 1\r\n{\r\nTooltip text\r\n}\r\n'.repeat(80))]], mpq: { attributes: true } });
    const { config } = resolveSettings({ preset: 'maximum', overrides: { compression: { sectorSizeShift: 3 } } });
    const result = protectMap(source, config), output = openMap(result.bytes), before = openMap(source);
    assert.equal(output.inspect().sectorSize, 4096);
    assert.equal(result.summary.sectorSize, 4096);
    assert(result.summary.savings.stages.some(stage => stage.id === 'sectors'));
    for (const name of ['war3map.w3i', 'war3map.w3e', 'war3map.wts']) assert.deepEqual(output.read(name), before.read(name));
    const finalScript = output.read('war3map.lua').toString();
    assert(!/QuestState|hidden message|I2S\(/.test(finalScript));
    assert.equal(result.summary.natives.hiddenNatives, 1);
    assert.equal(result.summary.lua.renamedGlobals, 1);
    const { lua, lauxlib, lualib, to_luastring } = fengari, state = lauxlib.luaL_newstate();
    try {
        lualib.luaL_openlibs(state);
        assert.equal(lauxlib.luaL_dostring(state, to_luastring(finalScript + '\nfunction I2S(value) return tostring(value) end\nreturn main()')), lua.LUA_OK);
        assert.deepEqual([1, 2].map(index => Buffer.from(lua.lua_tolstring(state, index)).toString()), ['7 units', 'hidden message text']);
    } finally { lua.lua_close(state); }
    assert.deepEqual(protectMap(source, config).bytes, result.bytes, 'Maximum protection is reproducible');
});

test('UTF-8 import paths are recompressed and can be excluded by name', () => {
    const korean = 'war3mapImported\\텍스처\\한글.blp', compressible = Buffer.alloc(8192, 67);
    const source = createLuaMap({ extraEntries: [[korean, compressible]], mpq: { attributes: true } });
    const index = openMap(source).inspect().blocks.findIndex(block => block.size === compressible.length);
    const optimized = openMap(protectMap(source).bytes);
    assert(optimized.inspect().blocks[index].packedSize < compressible.length);
    assert.deepEqual(optimized.read(korean), compressible);
    const excluded = openMap(protectMap(source, { compression: { excludeFiles: ['WAR3MAPIMPORTED/텍스처/한글.BLP'] } }).bytes);
    assert.equal(excluded.inspect().blocks[index].packedSize, compressible.length);
    assert.deepEqual(excluded.read(korean), compressible);
});

test('all-literal runtime strings combine with the maximum preset and keep callback lookups', async () => {
    const { resolveSettings } = await import('../src/presets.mjs');
    const script = String.raw`function config() end
function Callback() return "callback ran" end
function main()
    local id = FourCC("A0EG")
    local result = ExecuteFunc("Callback")
    local path = "Models\\Effect.mdx"
    return id, result, path, string.format("%d|r", 7)
end
`;
    const { config } = resolveSettings({ preset: 'maximum', overrides: { strings: { allLiterals: true }, lua: { foldFourCC: false } } });
    const result = protectMap(createLuaMap({ script }), config);
    const output = openMap(result.bytes).read('war3map.lua').toString();
    for (const hidden of ['A0EG', '"Callback"', 'Effect.mdx', '%d|r', 'callback ran']) assert(!output.includes(hidden), hidden + ' is hidden');
    // Engine stubs stand in for the natives; the protected chunk runs unchanged after them.
    const stubs = 'function FourCC(value) return string.unpack(">I4", value) end function ExecuteFunc(name) return _G[name]() end\n';
    assert.deepEqual(luaResultBytes(stubs + output), luaResultBytes(stubs + script));
    const standard = protectMap(createLuaMap({ script }), resolveSettings({ preset: 'maximum', overrides: { lua: { foldFourCC: false } } }).config);
    assert(result.summary.strings.encodedLiterals > standard.summary.strings.encodedLiterals, 'The experimental scope hides more literals');
});
