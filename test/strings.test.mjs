import test from 'node:test';
import assert from 'node:assert/strict';
import fengari from 'fengari';
import { transformStrings } from '../src/strings.mjs';
import { prepareLua } from '../src/lua.mjs';

function returnedBytes(code) {
    const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;
    const state = lauxlib.luaL_newstate();
    try {
        lualib.luaL_openlibs(state);
        const status = lauxlib.luaL_dostring(state, to_luastring(code));
        assert.equal(status, lua.LUA_OK, status === lua.LUA_OK ? undefined : to_jsstring(lua.lua_tostring(state, -1)));
        return Array.from({ length: lua.lua_gettop(state) }, (_, index) => Buffer.from(lua.lua_tolstring(state, index + 1)));
    } finally { lua.lua_close(state); }
}

test('optional string encoding preserves every returned byte without runtime helpers', () => {
    const source = String.raw`local message = "secret message 한글"
local unicode = "\u{D55C}\u{AE00} message"
local escaped = "quote\" text\x20and digits123"
local long = [==[long bracket text]==]
return message, unicode, escaped, long`;
    const first = transformStrings(source, { enabled: true }), second = transformStrings(source, { enabled: true });
    assert.deepEqual(first, second);
    assert.equal(first.stats.encodedLiterals, 4);
    assert(!first.code.includes('secret message') && !first.code.includes('한글'));
    assert(!first.code.includes('string.char') && !first.code.includes('function'));
    assert.deepEqual(returnedBytes(first.code), returnedBytes(source));
    assert.equal(transformStrings(first.code, { enabled: true }).code, first.code);
});

test('runtime strings preserve token boundaries beside minified Lua keywords', () => {
    const source='local function choose(value) if value then return"first message"end return false or"second message"end;return choose(true),choose(false),not"third message"and"fourth message"or"fifth message"';
    const result=transformStrings(source,{enabled:true,mode:'runtime'});
    assert.deepEqual(returnedBytes(result.code),returnedBytes(source));
    assert.equal(result.stats.encodedLiterals,5);
});

test('critical paths, rawcodes, orders, callbacks and tooltip format keep their source spelling', () => {
    const source = String.raw`return "A0EG", "attack", "PublicCallback", "TRIGSTR_123", "Models\\Effect.mdx", "File.txt", "|cffff0000level %d|r", "line\nsecond", "\000\255\x41", "", [==[first
second]==]`;
    const result = transformStrings(source, { enabled: true });
    assert.equal(result.code, source);
    assert.equal(result.stats.encodedLiterals, 0);
    assert.deepEqual(returnedBytes(result.code), returnedBytes(source));
});

test('keep values compare decoded bytes across Unicode and escape spellings', () => {
    const source = String.raw`return "keep this 한글", "keep\x20this 한글", [=[keep this 한글]=], "encode this text"`;
    const result = transformStrings(source, { enabled: true, keep: ['keep this 한글'] });
    assert.equal(result.stats.encodedLiterals, 1);
    assert(result.code.includes('keep\\x20this 한글'));
    assert.deepEqual(returnedBytes(result.code), returnedBytes(source));
});

test('string-call syntax, table keys and concatenation retain evaluation order', () => {
    const source = `local calls = {}
local function record(value) calls[#calls+1] = value; return value end
local table = {["key with spaces"] = record "first message"}
return record("second message") .. table["key with spaces"], table.concat and "unexpected" or calls[1], calls[2]`;
    const result = transformStrings(source, { enabled: true });
    assert.equal(result.stats.encodedLiterals, 4);
    assert.deepEqual(returnedBytes(result.code), returnedBytes(source));
});

test('multiline literals and comments retain physical source line locations', () => {
    const source = `-- original comment
local message = "one line message"
local lines = [==[first line\r\nsecond line]==]
return message, lines`;
    const result = transformStrings(source, { enabled: true });
    assert.equal(result.stats.encodedLiterals, 1);
    assert(result.code.startsWith('-- original comment\n'));
    assert.equal(result.code.split('\n').length, source.split('\n').length);
    assert.deepEqual(returnedBytes(result.code), returnedBytes(source));
});

test('source observers and opaque loaded code refuse string rewrites while identity remains allowed', () => {
    for (const expression of ['debug.getinfo(1, "S").source', 'debug.traceback()', 'load(externalCode)()', 'require("external")']) {
        const source = 'local message="hidden text"; return message, ' + expression;
        assert.throws(() => transformStrings(source, { enabled: true }), /source-location|opaque loaded code/);
        assert.equal(transformStrings(source, { enabled: true, keep: ['hidden text'] }).code, source);
        assert.equal(transformStrings(source, { enabled: false }).code, source);
    }
    const source = 'local message="hidden text"; local chunk = "return debug.getinfo(2).source"; return load(chunk)()';
    assert.throws(() => transformStrings(source, { enabled: true }), /source-location/);
});

test('disabled string encoding is bytewise identity and invalid settings are refused', () => {
    const source = '-- comment\nreturn "readable message"';
    assert.equal(transformStrings(source).code, source);
    assert.equal(transformStrings(source, { enabled: false }).stats.encodedLiterals, 0);
    assert.throws(() => transformStrings(source, { enabled: 'yes' }), /boolean/);
    assert.throws(() => transformStrings(source, { keep: [1] }), /Unicode/);
    assert.throws(() => transformStrings(source, { keep: ['\ud800'] }), /Unicode/);
});

test('strings reuse a validated prepared AST with unchanged bytes and public results', () => {
    const source = 'local message = "first message 한글"; local other = "second message"; return message, other';
    const transformed = prepareLua(source, 'war3map.lua').transform({}, {prepareOutput: true});
    const result = transformStrings(transformed.code, {enabled: true}, {prepared: transformed.prepared});
    assert.deepEqual(result, transformStrings(transformed.code, {enabled: true}));
    assert.deepEqual(returnedBytes(result.code), returnedBytes(source));
    assert(Object.isFrozen(transformed.prepared.ast.body));
    assert.throws(() => transformStrings(transformed.code + ' ', {enabled: true}, {prepared: transformed.prepared}), /source does not match/);
    assert.throws(() => transformStrings(transformed.code, {enabled: true}, {prepared: {ast: transformed.prepared.ast}}), /prepared Lua stage/);
});

test('prepared string guard reports the original source observer location and remedy', () => {
    const source = '-- original line\nlocal message = "hidden text"\nreturn message, debug.getinfo(1).source';
    const transformed = prepareLua(source, 'war3map.lua').transform({minify: false, renameLocals: false}, {prepareOutput: true});
    assert.throws(() => transformStrings(transformed.code, {enabled: true}, {prepared: transformed.prepared}), error => {
        assert(error.message.includes('getinfo observes source text'));
        assert(error.message.includes('war3map.lua:3:17'));
        assert(error.message.includes('Recommended options: --no-hide-strings.'));
        return true;
    });
    assert.equal(transformStrings(transformed.code, {enabled: true, keep: ['hidden text']}, {prepared: transformed.prepared}).code, source);
});

test('runtime mode deterministically decodes Unicode, high bytes and duplicate literals without library helpers', () => {
    const source = String.raw`local a="secret message 한글"
local b="\u{D55C}\u{AE00} message"
local c="\255\254\128 high bytes"
local d=[==[long bracket text]==]
return a,b,c,d,"secret message 한글"`;
    const first = transformStrings(source, { enabled: true, mode: 'runtime' }, { seed: 'first seed' });
    assert.deepEqual(transformStrings(source, { enabled: true, mode: 'runtime' }, { seed: 'first seed' }), first);
    const other = transformStrings(source, { enabled: true, mode: 'runtime' }, { seed: 'another seed' });
    assert.notEqual(other.code, first.code);
    assert.equal(first.stats.encodedLiterals, 5);
    assert.equal(first.stats.uniqueRuntimeLiterals, 4);
    assert(first.stats.runtimeCipherBytes > 0 && first.stats.runtimeHelperBytes > 0);
    assert.equal(first.stats.mode, 'runtime');
    assert(!first.code.includes('secret message') && !first.code.includes('한글'));
    assert(!/\b(?:string|table|load|debug|io|package|require|math)\b/.test(first.code));
    assert.deepEqual(returnedBytes(first.code), returnedBytes(source));
    assert.deepEqual(returnedBytes(other.code), returnedBytes(source));
    assert.equal(transformStrings(first.code, { enabled: true, mode: 'runtime' }, { seed: 'first seed' }).code, first.code);
});

test('runtime decoding joins long literals without string library dependence', () => {
    const value = 'long hidden text '.repeat(1500), source = 'return "' + value + '"';
    const result = transformStrings(source, { enabled: true, mode: 'runtime' });
    assert.deepEqual(returnedBytes(result.code), [Buffer.from(value)]);
});

test('runtime helpers preserve side effects, table keys, string-call chains and multi-return positions', () => {
    const source = `local events={}
local function record(value) events[#events+1]=value;return value,"second result" end
local function chain(value) return function(nextValue) return value..nextValue end end
local t={["key with spaces"]=record "first message"}
local values={record("second message"),record("third message")}
local joined=chain "chain first" "chain second"
return t["key with spaces"],values[1],values[2],values[3],events[1]..events[2]..events[3],joined,record "final message"`;
    const result = transformStrings(source, { enabled: true, mode: 'runtime' });
    assert.deepEqual(returnedBytes(result.code), returnedBytes(source));
});

test('runtime decoding uses private primitive tables despite shadowed and replaced standard libraries', () => {
    const source = `local string={char=function() return "wrong char" end}
local table={concat=function() return "wrong concat" end}
_G.string=nil;_G.table=nil
return "hidden actual bytes",string.char(),table.concat()`;
    const result = transformStrings(source, { enabled: true, mode: 'runtime' });
    assert.deepEqual(returnedBytes(result.code), returnedBytes(source));
});

test('runtime helper identifiers avoid original locals, globals and parameter names', () => {
    const preliminary = transformStrings('return "hidden message"', { enabled: true, mode: 'runtime' }, { seed: 'collision seed' });
    const name = preliminary.code.match(/^local ([A-Za-z_]\w*)=/)[1];
    const source = 'local ' + name + '="original local";local function f(' + name + ')return ' + name + ' end;return f(' + name + '),"hidden message"';
    const result = transformStrings(source, { enabled: true, mode: 'runtime' }, { seed: 'collision seed' });
    assert.notEqual(result.code.match(/^local ([A-Za-z_]\w*)=/)[1], name);
    assert.deepEqual(returnedBytes(result.code), returnedBytes(source));
    const globalSource = name + '="original global";return ' + name + ',"hidden message"';
    const globalResult = transformStrings(globalSource, { enabled: true, mode: 'runtime' }, { seed: 'collision seed' });
    assert.notEqual(globalResult.code.match(/^local ([A-Za-z_]\w*)=/)[1], name);
    assert.deepEqual(returnedBytes(globalResult.code), returnedBytes(globalSource));
});

test('runtime mode preserves eligible exclusions, keep values and disabled identity', () => {
    const source = String.raw`return "A0EG","attack","PublicCallback","TRIGSTR_123","Models\\Effect.mdx","File.txt","|cffff0000level %d|r","line\nsecond","\000\255\x41",[=[first
second]=],"keep this 한글","keep\x20this 한글","hide this text"`;
    const result = transformStrings(source, { enabled: true, mode: 'runtime', keep: ['keep this 한글'] });
    assert.equal(result.stats.encodedLiterals, 1);
    assert.deepEqual(returnedBytes(result.code), returnedBytes(source));
    assert(result.code.includes('Models\\\\Effect.mdx') && result.code.includes('keep\\x20this 한글'));
    assert.equal(transformStrings(source, { enabled: false, mode: 'runtime' }).code, source);
    assert.equal(transformStrings('return "A0EG"', { enabled: true, mode: 'runtime' }).code, 'return "A0EG"');
    assert.throws(() => transformStrings(source, { mode: 'unknown' }), /strings\.mode/);
});

test('runtime helpers compose with prepared renaming and preserve a leading shebang', () => {
    const source = '#!/usr/bin/lua\nlocal message="hidden message 한글";return message';
    const transformed = prepareLua(source, 'map.lua').transform({ minify: false }, { prepareOutput: true });
    const result = transformStrings(transformed.code, { enabled: true, mode: 'runtime' }, { prepared: transformed.prepared, seed: 'prepared seed' });
    assert(result.code.startsWith('#!/usr/bin/lua\nlocal '));
    assert.deepEqual(result, transformStrings(transformed.code, { enabled: true, mode: 'runtime' }, { seed: 'prepared seed' }));
    // Fengari's in-memory load does not accept file shebangs; compare the Lua
    // bodies after their unchanged first line.
    assert.deepEqual(returnedBytes(result.code.slice(result.code.indexOf('\n') + 1)), returnedBytes(source.slice(source.indexOf('\n') + 1)));
});

test('runtime mode refuses helper-observing reflection and added-local overflow', () => {
    for (const expression of ['debug.getlocal(1,1)', 'debug.getupvalue(f,1)', 'string.dump(f)', 'collectgarbage("count")', 'load(externalCode)()']) {
        const source = 'local function f()return "hidden message" end;return f(), ' + expression;
        assert.throws(() => transformStrings(source, { enabled: true, mode: 'runtime' }), /runtime|reflection|source|opaque|observer|introspection/i);
        assert.equal(transformStrings(source, { enabled: false, mode: 'runtime' }).code, source);
    }
    const names = Array.from({ length: 200 }, (_, index) => 'v' + index);
    const source = 'local ' + names.join(',') + ';return "hidden message"';
    assert.throws(() => transformStrings(source, { enabled: true, mode: 'runtime' }), /local|resource/i);
    const boundary = 'local ' + names.slice(0, 199).join(',') + ';return "hidden message"';
    assert.deepEqual(returnedBytes(transformStrings(boundary, { enabled: true, mode: 'runtime' }).code), returnedBytes(boundary));
});

test('runtime strings use the shortest unused helper name and separate keyword-adjacent literals', () => {
    const source = 'local a, b = "first value", 2; local function c(d) return d end; if b then return"second value", c"third value" end';
    const result = transformStrings(source, { enabled: true, mode: 'runtime' });
    assert(result.code.startsWith('local e=(function()'), 'The helper takes the first name absent from the chunk');
    assert(!result.code.includes('__w3p_s_') && !/value/.test(result.code));
    assert(/return e\(\d+\)/.test(result.code) && /c\(e\(\d+\)\)/.test(result.code));
    assert.deepEqual(returnedBytes(result.code), returnedBytes(source));
});

test('experimental all-literal scope hides rawcodes, orders, callbacks, paths and formats at runtime', () => {
    const source = String.raw`local calls = {}
local function call(name) calls[#calls + 1] = name; return name end
return "A0EG", "attack", call "PublicCallback", "TRIGSTR_123", "Models\\Effect.mdx", "File.txt", "|cffff0000level %d|r", "line\nsecond", "\000\255\x41", "", [==[first
second]==], "kept value", calls[1], ("%d|r"):format(3), ({["key"] = "value"}).key`;
    const result = transformStrings(source, { enabled: true, mode: 'runtime', allLiterals: true, keep: ['kept value'] });
    assert.deepEqual(returnedBytes(result.code), returnedBytes(source));
    for (const hidden of ['A0EG', 'attack', 'PublicCallback', 'Effect.mdx', 'File.txt', 'cffff0000', 'line\\nsecond', String.raw`"\000\255\x41"`, '%d|r', '"key"', '"value"']) {
        assert(!result.code.includes(hidden), hidden + ' is hidden');
    }
    for (const kept of ['"TRIGSTR_123"', '""', '[==[first\nsecond]==]', '"kept value"']) assert(result.code.includes(kept), kept + ' keeps its source');
    assert.equal(result.stats.encodedLiterals, 11);
    const standard = transformStrings(source, { enabled: true, mode: 'runtime' });
    assert(standard.stats.encodedLiterals < result.stats.encodedLiterals, 'The default scope is unchanged');
    assert.deepEqual(transformStrings(source, { enabled: true, mode: 'runtime', allLiterals: false }), standard);
    assert.throws(() => transformStrings(source, { enabled: true, mode: 'escape', allLiterals: true }), /requires runtime mode/);
});

test('preloaded runtime strings decode every literal while the chunk loads and keep the default helper unchanged', () => {
    const source = `local function late() return "decoded later" end
return "first message", late(), "first message", "another literal"`;
    const lazy = transformStrings(source, { enabled: true, mode: 'runtime' });
    const eager = transformStrings(source, { enabled: true, mode: 'runtime', preload: true });
    assert.deepEqual(returnedBytes(eager.code), returnedBytes(source));
    assert.equal(eager.stats.preloaded, true);
    assert.equal(lazy.stats.preloaded, undefined);
    assert.equal(eager.stats.uniqueRuntimeLiterals, lazy.stats.uniqueRuntimeLiterals);
    assert.equal(transformStrings(source, { enabled: true, mode: 'runtime', preload: false }).code, lazy.code, 'Preload off keeps the previous output');
    // The helper's decoder is the same; only its last statement changes.
    const helperOf = result => result.code.slice(0, result.code.indexOf('\n'));
    const loop = helperOf(eager).match(/local ([A-Za-z])=function\(.*;for ([A-Za-z])=1,(\d+) do \1\(\2\) end;return \1 end\)\(\);$/);
    assert(loop, 'The helper decodes each literal ID once at load');
    assert.equal(Number(loop[3]), eager.stats.uniqueRuntimeLiterals);
    assert(helperOf(lazy).endsWith(' end end)();'));
    assert.throws(() => transformStrings(source, { enabled: true, mode: 'escape', preload: true }), /requires runtime mode/);
});
