import test from 'node:test';
import assert from 'node:assert/strict';
import fengari from 'fengari';
import {parseLua, transformLua} from '../src/lua.mjs';

function identifierNames(node, result = []) {
    if (!node || typeof node !== 'object') return result;
    if (node.type === 'Identifier') result.push(node.name);
    for (const [key, value] of Object.entries(node)) {
        if (['comments', 'globals', 'range', 'loc'].includes(key)) continue;
        if (Array.isArray(value)) value.forEach(child => identifierNames(child, result));
        else identifierNames(value, result);
    }
    return result;
}

test('renames lexical locals deterministically and preserves public/native names', () => {
    const source = 'local count = 2\nlocal function sum(value) return value + count end\nfunction main() config(); UnitAlive(gg_unit_Boss); udg_Value = sum(3) end';
    const result = transformLua(source);
    assert.deepEqual(transformLua(source), result);
    assert.equal(result.stats.renamedLocals, 3);
    const names = identifierNames(parseLua(result.code));
    for (const original of ['count', 'sum', 'value']) assert(!names.includes(original));
    for (const original of ['main', 'config', 'UnitAlive', 'gg_unit_Boss', 'udg_Value']) assert(names.includes(original));
});

test('local initializer sees outer declaration and local functions recurse', () => {
    const ast = parseLua(transformLua('local value = 1; do local value = value + 1; local function run() return value, run end; Result = run() end; Result2 = value').code);
    const outer = ast.body[0].variables[0].name, inner = ast.body[1].body[0].variables[0].name;
    assert.notEqual(outer, inner);
    assert.equal(ast.body[1].body[0].init[0].left.name, outer);
    const run = ast.body[1].body[1];
    assert.equal(run.body[0].arguments[0].name, inner);
    assert.equal(run.body[0].arguments[1].name, run.identifier.name);
    assert.equal(ast.body.at(-1).init[0].name, outer);
});

test('anonymous local initializer captures the outer name rather than the new local', () => {
    const ast = parseLua(transformLua('local callback = outer; do local callback = function() return callback() end; Result = callback() end').code);
    assert.equal(ast.body[1].body[0].init[0].body[0].arguments[0].base.name, ast.body[0].variables[0].name);
    assert.equal(ast.body[1].body[1].init[0].base.name, ast.body[1].body[0].variables[0].name);
});

test('repeat condition uses body locals, while and if locals stay within their blocks', () => {
    const ast = parseLua(transformLua('local limit = 0; repeat local remaining = limit + 1; limit = remaining until remaining > 3; while limit < 5 do local limit = 7 end; if limit > 2 then local limit = 4 else local limit = 9 end; Result = limit').code);
    const repeat = ast.body[1], outer = ast.body[0].variables[0].name;
    assert.equal(repeat.condition.left.name, repeat.body[0].variables[0].name);
    assert.equal(ast.body[2].condition.left.name, outer);
    assert.equal(ast.body[3].clauses[0].condition.left.name, outer);
    assert.equal(ast.body[4].init[0].name, outer);
});

test('numeric and generic for initializers refer to outer variables', () => {
    const ast = parseLua(transformLua('local index = 3; for index = index, index + 2, index do Result = index end; local key = items; for key, value in pairs(key) do Result = key .. value end; Result2 = index').code);
    const outer = ast.body[0].variables[0].name, loop = ast.body[1];
    assert.equal(loop.start.name, outer);
    assert.equal(loop.end.left.name, outer);
    assert.equal(loop.step.name, outer);
    assert.notEqual(loop.variable.name, outer);
    assert.equal(loop.body[0].init[0].name, loop.variable.name);
    const generic = ast.body[3];
    assert.equal(generic.iterators[0].arguments[0].name, ast.body[2].variables[0].name);
    assert.equal(generic.body[0].init[0].left.name, generic.variables[0].name);
    assert.equal(generic.body[0].init[0].right.name, generic.variables[1].name);
});

test('method self, fields, computed table keys, varargs and labels are preserved', () => {
    const ast = parseLua(transformLua('local object = {}; local key = "value"; function object:run(extra, ...) local result = {run = self.run, [key] = extra}; ::done:: if result then goto done end; return self, result, ... end').code);
    const method = ast.body[2];
    assert.equal(method.identifier.base.name, ast.body[0].variables[0].name);
    assert.equal(method.identifier.identifier.name, 'run');
    assert.equal(method.identifier.indexer, ':');
    assert.equal(method.body[0].init[0].fields[0].key.name, 'run');
    assert.equal(method.body[0].init[0].fields[0].value.base.name, 'self');
    assert.equal(method.body[0].init[0].fields[1].key.name, ast.body[1].variables[0].name);
    assert.equal(method.body[1].label.name, 'done');
    assert.equal(method.body[2].clauses[0].body[0].label.name, 'done');
    assert.equal(method.body[3].arguments[2].type, 'VarargLiteral');
});

test('preserves protected local names and requested keepLocals', () => {
    const source = 'local _ENV = environment; local self, main, config, gg_keep, udg_keep, explicit = nil; local changed = 1; return _ENV, self, main, config, gg_keep, udg_keep, explicit, changed';
    const names = identifierNames(parseLua(transformLua(source, {keepLocals: ['explicit']}).code));
    for (const name of ['_ENV', 'self', 'main', 'config', 'gg_keep', 'udg_keep', 'explicit']) assert(names.includes(name));
    assert(!names.includes('changed'));
});

test('preserves strings, escaped bytes, Korean, rawcode text and long brackets exactly', () => {
    const source = String.raw`-- remove this
local value = "한글|cffff0000A0EG\\Models\\Effect.mdx\000\255\x41\z   B" -- trailing
local other = [==[line one
-- literal comment
line two]==]
return FourCC('A0EG'), value, other`;
    const original = parseLua(source), transformed = parseLua(transformLua(source).code);
    const strings = ast => { const result = []; const walk = node => { if (!node || typeof node !== 'object') return; if (node.type === 'StringLiteral') result.push(node.raw); for (const [key, value] of Object.entries(node)) if (!['comments', 'globals', 'loc', 'range'].includes(key)) { if (Array.isArray(value)) value.forEach(walk); else walk(value); } }; walk(ast); return result; };
    assert.deepEqual(strings(transformed), strings(original));
    assert.equal(transformLua(source).stats.commentsRemoved, 2);
});

test('minification keeps lexical boundaries around numbers, comments and brackets', () => {
    const source = 'local value = 1 .. "a"; local negative = value - -2; local nested = {[ [=[x]=] ] = 1}; local quotient = 4 // 2; local mask = 1 << 2; return value, negative, nested, quotient, mask';
    assert.doesNotThrow(() => transformLua(source));
    const compact = transformLua(source, {renameLocals: false}).code;
    assert(compact.includes('1 ..'));
    assert(compact.includes('- -2'));
    assert(compact.includes('[ [=[x]=]'));
});

test('minify and rename options are independent and identity preserves source bytes', () => {
    const source = '-- comment\r\nlocal longName = 2  -- second\r\nreturn longName\r\n';
    assert.equal(transformLua(source, {minify: false, renameLocals: false}).code, source);
    const renamed = transformLua(source, {minify: false}).code;
    assert(renamed.startsWith('-- comment\r\n'));
    assert(renamed.endsWith('\r\n'));
    assert(!renamed.includes('longName'));
    const compact = transformLua(source, {renameLocals: false}).code;
    assert(compact.includes('longName'));
    assert(!compact.includes('--'));
});

test('allows dynamic global natives, separate load chunks and string callbacks unchanged', () => {
    const source = 'local name = "UnitAlive"; local native = _G["Blz" .. name] or _G[name]; local chunk = load("return publicGlobal"); ExecuteFunc("PublicCallback"); return native, chunk';
    const result = transformLua(source);
    assert(result.code.includes('"UnitAlive"'));
    assert(result.code.includes('"PublicCallback"'));
    assert(result.code.includes('"return publicGlobal"'));
    assert(result.code.includes('_G['));
});

test('rejects name reflection through debug aliases and introspection fields', () => {
    for (const source of [
        'local value = 1; return debug.getlocal(1, 1)',
        'local d = debug; local value = 1; return d.getupvalue(function() return value end, 1)',
        'local d = _G["de" .. "bug"]; return d["getlocal"](1, 1)',
        'local d = _G[name]; return d.getupvalue(callback, 1)',
        'local d = _G[name]; return d["get" .. "local"](1, 1)',
    ]) {
        assert.throws(() => transformLua(source), /introspection/);
        assert.doesNotThrow(() => transformLua(source, {renameLocals: false}));
    }
});

test('tracks environment aliases and constant introspection keys without blocking natives', () => {
    for (const source of [
        'local env = _G; local library = env.debug; local key = "get" .. "local"; return library[key](1, 1)',
        'local env = _ENV; local name = "debug"; local library = env[name]; return library[property](1, 1)',
        'local get = rawget; local library = get(_G, "debug"); return library[property](1, 1)',
        'local library = _G[unknown]; local key = "getupvalue"; return library[key](callback, 1)',
        'local env = setmetatable({}, {__index = _G}); local library = env.debug; return library[property](1, 1)',
    ]) assert.throws(() => transformLua(source), /introspection/);
    assert.doesNotThrow(() => transformLua('local env = _G; local name = "Blz" .. suffix; local native = env[name]; return native'));
});

test('finds reflection in loaded source, aliases, concatenation and nested literal chunks', () => {
    for (const source of [
        'local value = 1; return load("return debug.getlocal(2, 1)")()',
        'local compile = load; local source = "return debug.getupvalue(callback, 1)"; return compile(source)()',
        'local env = _G; local compile = env["load"]; local part = "debug"; local source = "return " .. part .. ".getlocal(2, 1)"; return compile(source)()',
        'local compile; local function run() return compile("return debug.getlocal(2, 1)")() end; compile = load; return run()',
        'local value = 1; return load([=[return load("return debug.getlocal(2, 1)")()]=])()',
        'local value = 1; return pcall(load, "return debug.getlocal(2, 1)")',
        'local tools = {compile = load}; local value = 1; return tools.compile("return debug.getlocal(2, 1)")()',
    ]) assert.throws(() => transformLua(source), /introspection/);
    const harmless = 'local env = _G; local compile = env.load; local text = "return \'한글\'"; local run = compile(text); return run()';
    assert.deepEqual(runLua(transformLua(harmless).code), runLua(harmless));
});

test('rejects opaque loader inputs, loader escapes and external chunks when names change', () => {
    for (const source of [
        'local value = 1; return load(reader)',
        'local compile = load; return compile(source)',
        'local value = 1; return loadfile("external.lua")',
        'local value = 1; return dofile("external.lua")',
        'local compile = load; return execute(compile)',
        'local value = 1; local function compiler() return load end; return compiler()(source)',
        'local value = 1; destination.compile = load; return destination.compile(source)',
        'local tools = {load}; local value = 1; return tools[1](source)',
        String.raw`local value = 1; return load("\x1bLua")`,
    ]) {
        assert.throws(() => transformLua(source), /opaque loaded code/);
        assert.throws(() => transformLua(source, {renameLocals: false}), /source-location.*opaque loaded code/);
        assert.doesNotThrow(() => transformLua(source, {minify: false, renameLocals: false}));
    }
    // A literal compile error stays a compile error and never executes.
    assert.doesNotThrow(() => transformLua('local value = 1; return load("invalid ???")'));
});

test('allows reflection when keepLocals preserves every candidate binding', () => {
    const source = 'local observed = 4; local inspect = load("return debug.getlocal(2, 1)"); local name, value = inspect(); return name, value';
    const options = {keepLocals: ['observed', 'inspect', 'name', 'value']};
    const result = transformLua(source, options);
    assert.equal(result.stats.renamedLocals, 0);
    assert.deepEqual(runLua(result.code), runLua(source));
    assert.throws(() => transformLua(source, {keepLocals: ['observed']}), /introspection/);
    assert.doesNotThrow(() => transformLua('return debug.getlocal(1, 1)'));
});

test('source-location reflection requires no-minify in addition to preserved local names', () => {
    const fixtures = [
        'local function observe()\n local info = debug.getinfo(1, "S")\n return info.linedefined, info.lastlinedefined\nend\nreturn observe()',
        'local info = debug.getinfo(1, "l"); return info.currentline',
        'local trace = debug.traceback(); return trace',
        'local env = _G; local library = env.debug; local key = "get" .. "info"; return library[key](1).currentline',
        'local value = 1; return load("return debug.getinfo(2).currentline")()',
        'local library = debug; return library[unknown](1)',
        'local library = debug; local get = rawget; return get(library, unknown)(1)',
    ];
    for (const source of fixtures) {
        assert.throws(() => transformLua(source, {renameLocals: false}), /source-location introspection/);
        assert.equal(transformLua(source, {minify: false, renameLocals: false}).code, source);
    }
    const source = fixtures[0];
    assert.deepEqual(runLua(transformLua(source, {minify: false, renameLocals: false}).code), runLua(source));
    assert.throws(() => transformLua(source, {keepLocals: ['observe', 'info']}), /source-location introspection/);
    // Local/upvalue names do not depend on whitespace or line locations.
    assert.doesNotThrow(() => transformLua('local observed = 2; return debug.getlocal(1, 1)', {renameLocals: false}));
    assert.doesNotThrow(() => transformLua('local getinfo = 2; return getinfo'));
});

test('environment escape and external require are refused while direct native aliases work', () => {
    const escapeSources = [
        'local function environment() return _G end; local observed = 7; local compile = environment().load; local inspect = compile("return debug.getlocal(2, 2)"); local name, value = inspect(); return name, value',
        'local env = setmetatable({}, {__index = _G}); local observed = 7; local compile = env.load; local inspect = compile("return debug.getlocal(2, 2)"); local name, value = inspect(); return name, value',
    ];
    for (const source of escapeSources) {
        assert.deepEqual(runLua(source), [{bytes: Buffer.from('observed').toString('hex')}, 7]);
        assert.throws(() => transformLua(source), /opaque loaded code/);
        assert.throws(() => transformLua(source, {renameLocals: false}), /opaque loaded code/);
        assert.equal(transformLua(source, {minify: false, renameLocals: false}).code, source);
    }
    for (const source of [
        'local env = _G; local copy = unknown(env); return copy',
        'local env = _G; destination.environment = env; return destination',
        'local env = _G; local holder = {environment = env}; return holder',
        'local module = require("external.module"); return module',
        'local reader = require; local module = reader("external.module"); return module',
    ]) assert.throws(() => transformLua(source), /opaque loaded code/);
    const native = 'local env = _G; local name = "math"; local native = env[name].abs; return native(-4)';
    assert.deepEqual(runLua(transformLua(native).code), runLua(native));
});

test('package environment lookup and global capability exports cannot bypass refusal', () => {
    const sources = [
        'local observed = 7; local compile = package.loaded["_G"].load; local inspect = compile("return debug.getlocal(2, 1)"); local name, value = inspect(); return name, value',
        'OtherEnvironment = _G; local observed = 7; local compile = _G.OtherEnvironment.load; local inspect = compile("return debug.getlocal(2, 1)"); local name, value = inspect(); return name, value',
    ];
    for (const source of sources) {
        assert.deepEqual(runLua(source), [{bytes: Buffer.from('observed').toString('hex')}, 7]);
        assert.throws(() => transformLua(source), /opaque loaded code/);
        assert.throws(() => transformLua(source, {renameLocals: false}), /opaque loaded code/);
        assert.equal(transformLua(source, {minify: false, renameLocals: false}).code, source);
    }
    for (const source of [
        'local env = _G; GlobalLoader = env.load; local observed = 1; return GlobalLoader(source)',
        'local modules = _G["package"]; local observed = 1; return modules.loaded["_G"]',
        'local key = "pack" .. "age"; local modules = rawget(_G, key); return modules',
    ]) assert.throws(() => transformLua(source), /opaque loaded code/);
    // A local variable with this spelling does not expose Lua's package table.
    assert.doesNotThrow(() => transformLua('local package = {value = 3}; return package.value'));
    assert.doesNotThrow(() => transformLua('local env; env = _G; local name = "Blz" .. suffix; local native = env[name]; return native'));
});

test('duplicate locals, parameter shadowing and global avoidance stay unambiguous', () => {
    const source = 'local value, value = 1, 2; local function run(value) return function(value) return value end, value end; a = value; b = run(value)';
    const ast = parseLua(transformLua(source).code);
    assert.notEqual(ast.body[0].variables[0].name, ast.body[0].variables[1].name);
    assert.equal(ast.body[2].init[0].name, ast.body[0].variables[1].name);
    assert.equal(ast.body[2].variables[0].name, 'a');
    assert.equal(ast.body[3].variables[0].name, 'b');
    assert.notEqual(ast.body[0].variables[0].name, 'a');
    assert.notEqual(ast.body[0].variables[0].name, 'b');
});

test('reports labeled syntax errors and rejects invalid options', () => {
    assert.throws(() => parseLua('local =', 'Fixture'), /^Error: Fixture:/);
    assert.throws(() => transformLua('return 1', {minify: 'yes'}), /boolean/);
    assert.throws(() => transformLua('return 1', {keepLocals: ['not a name']}), /identifier/);
});

function runLua(source) {
    const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
    const state = lauxlib.luaL_newstate();
    try {
        lualib.luaL_openlibs(state);
        const loaded = lauxlib.luaL_loadstring(state, to_luastring(source));
        assert.equal(loaded, lua.LUA_OK, loaded === lua.LUA_OK ? undefined : to_jsstring(lua.lua_tostring(state, -1)));
        const status = lua.lua_pcall(state, 0, lua.LUA_MULTRET, 0);
        assert.equal(status, lua.LUA_OK, status === lua.LUA_OK ? undefined : to_jsstring(lua.lua_tostring(state, -1)));
        const result = [];
        for (let index = 1; index <= lua.lua_gettop(state); index++) {
            switch (lua.lua_type(state, index)) {
            case lua.LUA_TNIL: result.push(null); break;
            case lua.LUA_TBOOLEAN: result.push(lua.lua_toboolean(state, index)); break;
            case lua.LUA_TNUMBER: result.push(lua.lua_tonumber(state, index)); break;
            case lua.LUA_TSTRING: result.push({bytes: Buffer.from(lua.lua_tolstring(state, index)).toString('hex')}); break;
            default: assert.fail('Runtime fixture must return primitive observable values');
            }
        }
        return result;
    } finally { lua.lua_close(state); }
}

test('original and transformed chunks return identical values in a Lua 5.3 semantic VM', () => {
    // Fengari checks lexical behavior here; it does not emulate Warcraft III
    // natives, multiplayer synchronization, or Warcraft's integer implementation.
    const fixtures = [
        'local value = 3; local function make(delta) local value = value + delta; return function(extra) return value + extra end end; local closure = make(2); do local value = function() return value end; Result = value() end; return closure(4), Result, value',
        'local index = 2; local total = 0; for index = index, index + 2, index do total = total + index end; local key = {3, 5}; for key, value in ipairs(key) do total = total + key + value end; return total, index',
        'local count = 0; repeat local step = count + 1; count = step until step == 3; if count > 1 then local count = 10; Result = count else Result = -1 end; while count < 4 do local step = 1; count = count + step end; return count, Result',
        'local object = {value = 5}; function object:run(extra, ...) local result = self.value + extra; return result, select("#", ...), ... end; return object:run(2, "first", nil, "last")',
        'local object = {}; function object:run(self, extra) return self + extra end; return object:run(3, 4)',
        'local _ENV = {external = 4}; local amount = 3; local function run() return external + amount end; return run(), _ENV.external',
        'local value, value = 1, 2; local function run(value) return function(value) return value end, value end; local callback, outer = run(5); return value, outer, callback(7)',
        String.raw`local value = "한글\000\255\x41\z   B"; local other = [==[line
-- string content
]==]; return value, other, "A0EG", "|cffff0000%d|r"`,
        'local count = 0; ::again:: count = count + 1; if count < 3 then goto again end; return count',
        'local nativeName = "abs"; local native = _G["math"][nativeName]; local chunk = load("return 2 + 3"); return native(-4), chunk()',
    ];
    for (const source of fixtures) {
        const expected = runLua(source);
        for (const options of [{}, {minify: false}, {renameLocals: false}]) {
            assert.deepEqual(runLua(transformLua(source, options).code), expected);
        }
    }
});
