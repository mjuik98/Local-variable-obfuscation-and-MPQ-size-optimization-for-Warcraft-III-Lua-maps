import test from 'node:test';
import assert from 'node:assert/strict';
import fengari from 'fengari';
import { parseLua, transformLua } from '../src/lua.mjs';

function runLua(source) {
    const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;
    const state = lauxlib.luaL_newstate();
    try {
        lualib.luaL_openlibs(state);
        const status = lauxlib.luaL_dostring(state, to_luastring(source));
        assert.equal(status, lua.LUA_OK, status === lua.LUA_OK ? undefined : to_jsstring(lua.lua_tostring(state, -1)));
        return Array.from({ length: lua.lua_gettop(state) }, (_, index) => {
            const type = lua.lua_type(state, index + 1);
            if (type === lua.LUA_TNUMBER) return lua.lua_tonumber(state, index + 1);
            if (type === lua.LUA_TNIL) return null;
            if (type === lua.LUA_TTABLE) return '<table>';
            return Buffer.from(lua.lua_tolstring(state, index + 1)).toString();
        });
    } finally { lua.lua_close(state); }
}

const MODULES = `
function GetUnitX(u) return u * 2 end
QuestRuntime = {}
local Helper = { count = 0, label = "helper" }
function QuestRuntime.getLimit() return 5 end
function QuestRuntime.start(unit) Helper.count = Helper.count + 1; return QuestRuntime.getLimit() + GetUnitX(unit) end
Counter = { value = 1 }
function Counter:inc(step) self.value = self.value + step; return self.value end
Escaping = { value = 3 }
function Escaping:get() return self end
Named = function() return "named" end
local dynamicName = "Named"
function main()
    local a = QuestRuntime.start(4)
    local b, c = Counter:inc(2), Counter:inc(3)
    return a, b, c, Helper.count, _G[dynamicName](), Escaping:get().value, Helper.label
end
return main()
`;

test('global and closed-table field renaming keeps results and every dynamic or engine name', () => {
    const expected = runLua(MODULES);
    for (const options of [{ renameGlobals: true }, { renameGlobals: true, renameFields: true }, { renameGlobals: true, renameFields: true, minify: false },
        { renameGlobals: true, renameFields: true, renameLocals: false }, { renameGlobals: true, renameFields: true, nameMode: 'seeded', seed: 'globals' }]) {
        const result = transformLua(MODULES, options);
        assert.deepEqual(runLua(result.code), expected, JSON.stringify(options));
        assert(!result.code.includes('QuestRuntime') && !result.code.includes('Counter') && !result.code.includes('Escaping'), 'Script globals are renamed');
        for (const kept of ['GetUnitX', 'Named', 'main', '_G']) assert(result.code.includes(kept), kept + ' must be kept');
        if (options.renameFields) {
            assert(!result.code.includes('getLimit') && !result.code.includes('label'), 'Closed table fields are renamed');
            assert(result.code.includes('value'), 'A table whose self escapes keeps its fields');
            assert.equal(result.stats.closedTables, 3);
        }
    }
    const seeded = transformLua(MODULES, { renameGlobals: true, renameFields: true, nameMode: 'seeded', seed: 'one' });
    assert.deepEqual(transformLua(MODULES, { renameGlobals: true, renameFields: true, nameMode: 'seeded', seed: 'one' }), seeded);
    assert.notEqual(transformLua(MODULES, { renameGlobals: true, renameFields: true, nameMode: 'seeded', seed: 'two' }).code, seeded.code);
});

test('renamed globals never meet locals on their lookup path, kept names or string lookups', () => {
    const source = `
Alpha = 1; Beta = 2
local function outer(a, b)
    local c = a + b
    local function inner(d) local e = d + Alpha; return e + c end
    return inner(Beta)
end
Gamma = function(x) local y = x; for i = 1, 3 do y = y + i + Beta end; return y end
Kept = 7
function main() return outer(3, 4), Gamma(1), Kept, rawget(_G, "Kept") end
return main()
`;
    // _G as a value prevents renaming; a direct rawget is not analysed.
    assert.throws(() => transformLua(source, { renameGlobals: true }), /_G is used as a value.*Recommended options: --no-rename-globals/);
    const literal = source.replace('rawget(_G, "Kept")', '_G["Kept"]');
    const expected = runLua(literal);
    for (const keepLocals of [[], ['c']]) {
        const result = transformLua(literal, { renameGlobals: true, keepLocals, keepGlobals: ['Alpha'] });
        assert.deepEqual(runLua(result.code), expected);
        assert(result.code.includes('Alpha') && result.code.includes('Kept') && !result.code.includes('Gamma'));
        const names = parseLua(result.code).globals.map(node => node.name);
        assert(!names.includes('Beta'));
    }
});

test('global renaming refuses unresolved environment, loader and name-lookup access', () => {
    const cases = [
        ['Value = 1; local function read(name) return _G[name] end; return read(GetName())', /dynamic _G key/],
        ['Value = 1; local env = _G; return env.Value', /_G is used as a value/],
        ['Value = 1; return load("return Value")()', /load can load code/],
        ['Value = 1; local name = GetName(); ExecuteFunc(name)', /ExecuteFunc needs a statically known/],
        ['Value = 1; local run = ExecuteFunc; run("Value")', /ExecuteFunc needs a statically known/],
        ['Value = 1; return _ENV.Value', /_ENV/],
        ['Value = 1; return _G.load("x")', /_G.load can reach globals/],
    ];
    for (const [source, pattern] of cases) {
        assert.throws(() => transformLua(source, { renameGlobals: true }), pattern, source);
        assert.throws(() => transformLua(source, { renameFields: true }), pattern, source);
        assert.doesNotThrow(() => transformLua(source), source);
    }
});

test('statically resolved dynamic keys, ExecuteFunc names and hooks keep their globals', () => {
    const source = `
local function Resolve(name) local native = _G["Blz" .. name]; if native then return native end; return _G[name] end
BlzFeature = function() return 1 end
Feature = function() return 2 end
Callback = function() return 3 end
LaterNative = function() return 4 end
local previous = PatchedNative
PatchedNative = function() return previous end
Renamed = function() return 5 end
function main() ExecuteFunc("Callback"); return Resolve("Feature")(), Renamed() end
`;
    const result = transformLua(source, { renameGlobals: true });
    for (const kept of ['BlzFeature', 'Feature', 'Callback', 'PatchedNative']) assert(result.code.includes(kept + '='), kept + ' is looked up by a string or read before definition');
    assert(!result.code.includes('Renamed') && !result.code.includes('LaterNative'));
});

test('closed tables reject escapes, dynamic access, metatables and non-method colon calls', () => {
    const open = [
        'T = {a = 1}; return T',
        'T = {a = 1}; local k = "a"; return T[k]',
        'T = {a = 1}; setmetatable(T, {}); return T.a',
        'T = {a = 1}; for k in pairs(T) do end; return T.a',
        'T = {a = 1}; function T.f(x) return x end; return T:f()',
        'T = {a = 1}; function T:m() return self.a end; local f = T.m; return f(T)',
        'T = {1, 2}; return T[1]',
        'T = {a = 1}; function T:m() return self end; return T:m().a',
    ];
    for (const source of open) {
        const result = transformLua(source, { renameFields: true });
        assert.equal(result.stats.closedTables, 0, source);
        assert.deepEqual(runLua(result.code), runLua(source), source);
    }
    const closed = 'local T = {alpha = 1, beta = 2}; function T:sum(extra) return self.alpha + self.beta + extra end; T.gamma = T:sum(3); return T.gamma, T.alpha';
    const result = transformLua(closed, { renameFields: true });
    assert.equal(result.stats.closedTables, 1);
    assert(!/alpha|beta|gamma|sum/.test(result.code));
    assert.deepEqual(runLua(result.code), runLua(closed));
});
