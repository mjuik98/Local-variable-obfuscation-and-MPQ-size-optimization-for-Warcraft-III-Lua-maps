import test from 'node:test';
import assert from 'node:assert/strict';
import fengari from 'fengari';
import { transformNatives } from '../src/natives.mjs';
import { transformStrings } from '../src/strings.mjs';
import { prepareLua } from '../src/lua.mjs';

// Stand-ins for engine functions, defined only after the map chunk has loaded
// to show that the table resolves a global on first use, not at load time.
const ENGINE = 'function GetUnitX(u) return u * 2 end function GetUnitY(u) return u * 3 end function CreateUnit(p, id) return p + id end ' +
    'function I2S(value) return "n" .. value end bj_lastCreatedUnit = 11';

function runMain(source, setup = ENGINE) {
    const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;
    const state = lauxlib.luaL_newstate();
    const check = status => assert.equal(status, lua.LUA_OK, status === lua.LUA_OK ? undefined : to_jsstring(lua.lua_tostring(state, -1)));
    try {
        lualib.luaL_openlibs(state);
        check(lauxlib.luaL_loadstring(state, to_luastring(source)));
        check(lua.lua_pcall(state, 0, 0, 0));
        check(lauxlib.luaL_dostring(state, to_luastring(setup)));
        lua.lua_getglobal(state, to_luastring('main'));
        check(lua.lua_pcall(state, 0, lua.LUA_MULTRET, 0));
        return Array.from({ length: lua.lua_gettop(state) }, (_, index) => Buffer.from(lua.lua_tolstring(state, index + 1)).toString());
    } finally { lua.lua_close(state); }
}

const SCRIPT = `
local Hooked = CreateUnit
function main()
    local x, y = GetUnitX(2), GetUnitY(2)
    local same = GetUnitX == GetUnitX
    return x, y, I2S(x + y), tostring(same), tostring(bj_lastCreatedUnit), tostring(Hooked)
end
function config() end
`;

test('engine functions resolve through one local table on first use with identical results', () => {
    const expected = runMain(SCRIPT);
    const result = transformNatives(SCRIPT, { enabled: true });
    assert.deepEqual(runMain(result.code), expected);
    assert.equal(result.stats.hiddenNatives, 4);
    assert.equal(result.stats.hiddenLibraryFunctions, 1, 'tostring is a fixed Lua base function');
    assert(/^local [A-Za-z]+=\(function\(s\)return setmetatable/.test(result.code));
    assert(!/GetUnitX\(|I2S\(/.test(result.code.split('\n').slice(1).join('\n')), 'Call sites no longer name engine functions');
    assert(result.code.includes('bj_lastCreatedUnit'), 'Engine variables remain direct global reads');
    assert.deepEqual(transformNatives(SCRIPT, { enabled: true }), result, 'Native hiding is deterministic');
    assert.deepEqual(transformNatives(SCRIPT), { code: SCRIPT, stats: { inputBytes: Buffer.byteLength(SCRIPT), outputBytes: Buffer.byteLength(SCRIPT), hiddenNatives: 0, hiddenLibraryFunctions: 0, hiddenReferences: 0, foldedFourCC: 0 }, forcedLiterals: [] });
});

test('runtime strings encrypt the native name table only through forced literal offsets', () => {
    const natives = transformNatives(SCRIPT, { enabled: true, encryptNames: true }, { prepareOutput: true });
    assert.equal(natives.forcedLiterals.length, 5);
    const strings = transformStrings(natives.code, { enabled: true, mode: 'runtime' }, { prepared: natives.prepared, forced: natives.forcedLiterals });
    assert(!/"(GetUnitX|GetUnitY|I2S|CreateUnit)"/.test(strings.code));
    assert(!strings.code.includes('__w3p_s_'));
    assert.deepEqual(runMain(strings.code), runMain(SCRIPT));
    assert.throws(() => transformStrings(natives.code, { enabled: true, mode: 'runtime' }, { forced: [natives.forcedLiterals[0] + 1] }), /Forced string literal offsets/);
    const plain = transformStrings(natives.code, { enabled: true, mode: 'runtime' });
    assert(plain.code.includes('"GetUnitX"'), 'Identifier-like literals stay plain unless forced');
});

test('script-assigned, environment-written and shadowed names stay direct; dynamic writes refuse', () => {
    const source = `
function GetUnitY(u) return u end
_G.I2S = function(value) return value end
function main() local GetUnitX = function(u) return -u end; return tostring(GetUnitX(1)), tostring(GetUnitY(2)), tostring(I2S(3)), tostring(CreateUnit(1, 2)) end
`;
    const result = transformNatives(source, { enabled: true });
    assert.equal(result.stats.hiddenNatives, 1, 'Only CreateUnit is a fixed engine function here');
    assert.equal(result.stats.hiddenLibraryFunctions, 1);
    assert.deepEqual(runMain(result.code), runMain(source));
    assert.throws(() => transformNatives('local k = GetKey(); _G[k] = 1; return GetUnitX(1)', { enabled: true }), /dynamic _G key.*--no-hide-natives/);
    assert.throws(() => transformNatives('return debug.getinfo(GetUnitX)', { enabled: true }), /runtime|introspection/);
});

test('the native table name avoids every identifier and accepts only matching prepared input', () => {
    const source = 'local a, b, c = 1, 2, 3; local function d(e) return e end; function main() return tostring(d(GetUnitX(a + b + c))) end';
    const prepared = prepareLua(source), result = transformNatives(source, { enabled: true }, { prepared });
    assert(result.code.startsWith('local f='));
    assert.deepEqual(runMain(result.code), runMain(source));
    assert.throws(() => transformNatives(source + ' ', { enabled: true }, { prepared }), /source does not match/);
});

test('static Lua library reads and base functions share the table; patched libraries stay direct', () => {
    const source = `
function main()
    local values = {}
    for index, value in ipairs({3, 1, 2}) do table.insert(values, math.floor(value * 1.5)) end
    table.sort(values)
    return string.format("%d-%d-%d", values[1], values[2], values[3]), tostring(select("#", 1, 2)), string.rep("a", 2), utf8.char(72)
end
`;
    const result = transformNatives(source, { enabled: true });
    assert.equal(result.stats.hiddenLibraryFunctions, 9);
    assert(!/table\.|math\.|string\.|utf8\./.test(result.code.split('\n').slice(1).join('\n')));
    assert.deepEqual(runMain(result.code), runMain(source));
    const patched = 'math.floor = function(value) return value end\nfunction main() return tostring(math.floor(2.5)), string.rep("b", 2) end';
    const direct = transformNatives(patched, { enabled: true });
    assert(direct.code.includes('math.floor(2.5)') && !direct.code.includes('string.rep('), 'A written library stays direct, others are hidden');
    assert.deepEqual(runMain(direct.code), runMain(patched));
    for (const escaping of ['local m = math\nfunction main() return tostring(m.floor(2.5)) end', '_G.math.floor = nil\nfunction main() return tostring(math.abs(-1)) end']) {
        assert(transformNatives(escaping, { enabled: true }).code.includes('math'), escaping);
    }
});

test('FourCC calls with printable literal rawcodes fold to identical integers', () => {
    const source = String.raw`
function main()
    local ids = { FourCC("A000"), FourCC'hfoo', FourCC("\65\48\48\49") }
    local dynamic = "Hpal"
    local id = FourCC("A0B1")..""
    return tostring(ids[1]), tostring(ids[2]), tostring(ids[3]), id, tostring(FourCC(dynamic)), tostring(-FourCC("A000"))
end
local function short() return FourCC("AB") end
`;
    const setup = 'function FourCC(id) return string.unpack(">I4", id) end';
    const folded = transformNatives(source, { foldFourCC: true });
    assert.equal(folded.stats.foldedFourCC, 5);
    assert(!/"A000"|'hfoo'|"A0B1"/.test(folded.code) && folded.code.includes('FourCC(dynamic)') && folded.code.includes('FourCC("AB")'));
    assert.deepEqual(runMain(folded.code, setup), runMain(source, setup));
    const both = transformNatives(source, { enabled: true, foldFourCC: true });
    assert.equal(both.stats.foldedFourCC, 5);
    assert.deepEqual(runMain(both.code, setup), runMain(source, setup));
    const redefined = 'function FourCC(id) return 1 end\nfunction main() return tostring(FourCC("A000")) end';
    assert.equal(transformNatives(redefined, { foldFourCC: true }).stats.foldedFourCC, 0, 'A script-defined FourCC is not folded');
    assert.equal(transformNatives('FourCC("A000")\nfunction main() return "x" end', { foldFourCC: true }).stats.foldedFourCC, 0, 'A call statement stays a call');
});
