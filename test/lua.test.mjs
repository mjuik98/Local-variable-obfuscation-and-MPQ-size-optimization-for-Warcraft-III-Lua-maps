import test from 'node:test';
import assert from 'node:assert/strict';
import fengari from 'fengari';
import {assertLuaResourceLimits, assertRuntimeRewriteSafe, assertSourceRewriteSafe, getPreparedLuaAst, parseLua, prepareLua, transformLua} from '../src/lua.mjs';

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
    // Lua evaluates control expressions before introducing the loop variable,
    // so a generated spelling may safely be reused here.
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

test('source rewrite safety rejects source observers and opaque chunks but permits name-only reflection', () => {
    const source = 'local observed = 2; return debug.getinfo(1, "S").source';
    const rewritten = source.replace('"S"', String.raw`"\x53"`);
    assert.notDeepEqual(runLua(source), runLua(rewritten));
    const ast = parseLua(source), before = JSON.stringify(ast);
    assert.throws(() => assertSourceRewriteSafe(ast), /source-location introspection/);
    assert.equal(JSON.stringify(ast), before);
    assert.throws(() => assertSourceRewriteSafe(parseLua('return load(reader)')), /opaque loaded code/);
    assert.throws(() => assertSourceRewriteSafe(parseLua('local module = require("external"); return module')), /opaque loaded code/);
    assert.doesNotThrow(() => assertSourceRewriteSafe(parseLua('local observed = 2; return debug.getlocal(1, 1)')));
    assert.doesNotThrow(() => assertSourceRewriteSafe(parseLua('local name = "UnitAlive"; return _G[name]')));
    assert.throws(() => assertSourceRewriteSafe(null), /parsed Chunk/);
});

test('actual local renames refuse source observation while unchanged allocated names remain safe', () => {
    assert.throws(() => transformLua('local observed = 2; return debug.getinfo(1, "S").source', {minify: false}), /Local renaming/);
    assert.throws(() => transformLua('local observed = 2; return traceback()', {minify: false}), /Local renaming/);
    const alreadyShort = 'local a = 2; return debug.getinfo(1, "S").source';
    const result = transformLua(alreadyShort, {minify: false});
    assert.equal(result.stats.renamedLocals, 0);
    assert.equal(result.code, alreadyShort);
    assert.deepEqual(runLua(result.code), runLua(alreadyShort));
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
    assert.throws(() => prepareLua('local =', 'war3map.lua'), /^Error: war3map\.lua:/);
    assert.throws(() => transformLua('return 1', {minify: 'yes'}), /boolean/);
    assert.throws(() => transformLua('return 1', {keepLocals: ['not a name']}), /identifier/);
});

test('reuses names across sibling and unused outer scopes while protecting captured bindings', () => {
    const source = 'local outer = 7; do local first = 3; Result1 = first end; do local second = 4; Result2 = second end; return outer, Result1, Result2';
    const result = transformLua(source), ast = parseLua(result.code);
    const outer = ast.body[0].variables[0].name;
    assert.equal(ast.body[1].body[0].variables[0].name, outer);
    assert.equal(ast.body[2].body[0].variables[0].name, outer);
    assert.deepEqual(runLua(result.code), runLua(source));
    const capture = 'local outer = 5; do local inner = 3; local function read() return outer, inner end; return read() end';
    const transformed = transformLua(capture), captureAst = parseLua(transformed.code);
    assert.notEqual(captureAst.body[0].variables[0].name, captureAst.body[1].body[0].variables[0].name);
    assert.deepEqual(runLua(transformed.code), runLua(capture));
});

test('frequently referenced locals receive the shortest available names deterministically', () => {
    const declarations = Array.from({length: 60}, (_, index) => 'local binding' + index + ' = ' + index).join(';');
    const source = declarations + '; Result = ' + Array(80).fill('binding59').join(' + ') + '; return Result, ' + Array.from({length: 60}, (_, index) => 'binding' + index).join(', ');
    const result = transformLua(source), ast = parseLua(result.code);
    assert.equal(ast.body[59].variables[0].name.length, 1);
    assert.equal(ast.body[58].variables[0].name.length, 2);
    assert.deepEqual(transformLua(source), result);
    assert.deepEqual(runLua(result.code), runLua(source));
});

test('a frequent child binding is prioritized ahead of conflicting low-frequency captures', () => {
    const declarations = Array.from({length: 55}, (_, index) => 'local outer' + index + ' = ' + index).join(';');
    const captures = Array.from({length: 55}, (_, index) => 'outer' + index).join(' + ');
    const source = declarations + '; local function run() local frequent = 3; return ' + Array(80).fill('frequent').join(' + ') + ' + ' + captures + ' end; return run()';
    const result = transformLua(source), ast = parseLua(result.code);
    const child = ast.body[55].body[0].variables[0].name;
    assert.equal(child.length, 1);
    assert(ast.body.slice(0, 55).some(statement => statement.variables[0].name.length === 2));
    assert(ast.body.slice(0, 55).every(statement => statement.variables[0].name !== child));
    assert.deepEqual(runLua(result.code), runLua(source));
});

test('reused parameter names do not alter identically spelled method fields or implicit self', () => {
    const source = 'local object = {value = 5}; function object:a(argument) local result = argument + self.value; return result end; return object:a(2)';
    const result = transformLua(source), ast = parseLua(result.code), method = ast.body[1];
    assert.equal(method.identifier.identifier.name, 'a');
    assert.equal(method.parameters[0].name, 'a');
    assert.equal(ast.body[0].variables[0].name, 'a');
    assert.equal(method.body[0].init[0].right.base.name, 'self');
    assert.deepEqual(runLua(result.code), runLua(source));
});

test('loop closures retain separate captured values after local name reuse', () => {
    const source = 'local callbacks = {}; for index = 1, 200 do local outer = index; do local inner = index + 1; callbacks[index] = function() return outer + inner end end end; local total = 0; for index = 1, 200 do total = total + callbacks[index]() end; return total';
    assert.deepEqual(runLua(transformLua(source).code), runLua(source));
});

test('prepared AST is reusable and no-minify rewrites preserve every nonidentifier byte', () => {
    const source = '-- keep\r\nlocal longName = 2\r\ndo local otherName = longName + 1; Result = otherName end\r\nreturn longName, Result\r\n';
    const prepared = prepareLua(source), treeBefore = JSON.stringify(prepared.ast);
    const renamed = prepared.transform({minify: false});
    const compact = prepared.transform({keepLocals: ['longName']});
    assert.deepEqual(renamed, transformLua(source, {minify: false}));
    assert.deepEqual(compact, transformLua(source, {keepLocals: ['longName']}));
    assert.equal(prepared.transform({minify: false, renameLocals: false}).code, source);
    assert.equal(JSON.stringify(prepared.ast), treeBefore);
    const maskIdentifiers = code => {
        const ranges = [], collect = node => {
            if (!node || typeof node !== 'object') return;
            if (node.type === 'Identifier') ranges.push(node.range);
            for (const [key, value] of Object.entries(node)) {
                if (['comments', 'globals', 'loc', 'range'].includes(key)) continue;
                if (Array.isArray(value)) value.forEach(collect); else collect(value);
            }
        };
        collect(parseLua(code));
        const parts = []; let cursor = 0;
        for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) { parts.push(code.slice(cursor, start), '#identifier'); cursor = end; }
        parts.push(code.slice(cursor)); return parts.join('');
    };
    assert.equal(maskIdentifiers(renamed.code), maskIdentifiers(source));
    assert(renamed.code.startsWith('-- keep\r\n'));
    assert.deepEqual(runLua(renamed.code), runLua(source));
});

test('optional prepared output preserves public results and exposes an immutable validated AST', () => {
    const source = 'local message = "hidden text"; return message';
    const prepared = prepareLua(source, 'war3map.lua');
    const normal = prepared.transform(), result = prepared.transform({}, {prepareOutput: true});
    assert.deepEqual(result, normal);
    assert.deepEqual(Object.keys(result), ['code', 'stats']);
    assert(!Object.hasOwn(normal, 'prepared'));
    const descriptor = Object.getOwnPropertyDescriptor(result, 'prepared');
    assert.equal(descriptor.enumerable, false);
    assert.equal(descriptor.writable, false);
    assert.equal(getPreparedLuaAst(result.prepared, result.code), result.prepared.ast);
    assert(Object.isFrozen(result.prepared));
    assert(Object.isFrozen(result.prepared.ast.body));
    assert(Object.isFrozen(result.prepared.ast.body[0].variables[0]));
    assert.throws(() => { result.prepared = {}; }, TypeError);
    assert.throws(() => { result.prepared.ast.body[0].variables[0].name = 'changed'; }, TypeError);
    assert.throws(() => getPreparedLuaAst(result.prepared, result.code + ' '), /source does not match/);
    assert.throws(() => getPreparedLuaAst({ast: parseLua(result.code)}, result.code), /prepared Lua stage/);
    assert.throws(() => prepared.transform({}, {prepareOutput: 'yes'}), /boolean/);
});

test('guard failures include the earliest original cause, one-based location and needed options', () => {
    const source = '-- first line\nlocal observed = 2\n\nreturn debug.getlocal(1, 1)';
    const result = prepareLua(source, 'war3map.lua').transform({renameLocals: false}, {prepareOutput: true});
    assert(!result.code.includes('\n'));
    assert.throws(() => result.prepared.transform({minify: false}), error => {
        assert(error.message.includes('getlocal property'));
        assert(error.message.includes('war3map.lua:4:8'));
        assert(error.message.includes('Recommended options: --no-rename.'));
        return true;
    });
    const observers = '-- original\nlocal observed = 2\n return debug.getinfo(1).currentline, debug.traceback()';
    assert.throws(() => prepareLua(observers, 'war3map.lua').transform({renameLocals: false}), error => {
        assert(error.message.includes('getinfo observes source text'));
        assert(error.message.includes('war3map.lua:3:9'));
        assert(error.message.includes('Recommended options: --no-minify.'));
        return true;
    });
    const loaded = '-- original\nlocal observed = 2\nreturn load("return debug.getinfo(2).source")()';
    assert.throws(() => prepareLua(loaded, 'war3map.lua').transform(), error => {
        assert(error.message.includes('load contains getinfo observes source text'));
        assert(error.message.includes('loaded chunk 1:8'));
        assert(error.message.includes('war3map.lua:3:8'));
        assert(error.message.includes('--no-minify --no-rename'));
        return true;
    });
});

test('nested repeat, method, environment and loop captures remain equivalent independently', () => {
    const source = `local root = 4
local callbacks = {}
local function build(outer)
    local _ENV = {base = outer}
    for outer = outer, outer + 2 do
        local remember = outer
        repeat
            local root = root + remember
            do
                local remember = root + base
                callbacks[#callbacks + 1] = function(extra)
                    local root = remember + extra
                    return root, base
                end
            end
            remember = 0
        until remember == 0
    end
    local object = {value = base}
    function object:a(argument)
        local root = argument + self.value
        return root
    end
    return object:a(3)
end
local value = build(2)
local total = 0
for index = 1, #callbacks do
    local first, second = callbacks[index](index)
    total = total + first + second
end
local counter = 0
::again:: counter = counter + 1
if counter < 2 then goto again end
return total, value, counter, root`;
    const expected = runLua(source), prepared = prepareLua(source);
    for (const options of [{}, {minify: false}, {renameLocals: false}, {keepLocals: ['root', 'remember']},
        {nameMode: 'seeded', seed: 'alpha'}, {nameMode: 'seeded', seed: '다른 seed', minify: false}]) {
        const result = prepared.transform(options, {prepareOutput: true});
        assert.deepEqual(runLua(result.code), expected);
        assert.deepEqual(parseLua(result.code), result.prepared.ast);
    }
});

test('47000 independent bindings reuse short names with one-pass no-minify assembly', {timeout: 60_000}, () => {
    const count = 47_000;
    const source = 'globalSum = 0\n' + Array.from({length: count}, (_, index) =>
        'do local synthetic_' + index + ' = ' + index + '; globalSum = globalSum + synthetic_' + index + ' end\n').join('') + 'return globalSum';
    const prepared = prepareLua(source), result = prepared.transform({minify: false});
    assert.equal(result.stats.localBindings, count);
    assert.equal(result.stats.renamedLocals, count);
    assert.equal(result.stats.renamedIdentifiers, count * 2);
    assert.equal((result.code.match(/local a = /g) ?? []).length, count);
    assert.equal(result.code.split('\n').length, source.split('\n').length);
    assert(result.stats.outputBytes < result.stats.inputBytes - count * 10);
    assert.doesNotThrow(() => assertLuaResourceLimits(prepared.ast));
});

test('compact mode retains the existing exact bytes while seeded mode changes only name spelling', () => {
    const source = 'local amount=2; local function sum(value) return amount + value end; return sum(3)';
    const compact = transformLua(source);
    assert.equal(compact.code, 'local a=2;local function b(b)return a+b end;return b(3)');
    assert.deepEqual(transformLua(source, {nameMode: 'compact', seed: 'unused seed'}), compact);
    const seeded = transformLua(source, {nameMode: 'seeded', seed: 'release one'});
    assert.deepEqual(transformLua(source, {nameMode: 'seeded', seed: 'release one'}), seeded);
    assert.notEqual(transformLua(source, {nameMode: 'seeded', seed: 'release two'}).code, seeded.code);
    assert.deepEqual(runLua(seeded.code), runLua(source));
    assert.equal(seeded.code.length, compact.code.length);
    assert.equal(transformLua(source, {minify: false, renameLocals: false, nameMode: 'seeded'}).code, source);
    assert.deepEqual(transformLua(source, {vmFunctions: ['sum']}), compact);
});

test('seeded names preserve length classes, global reservations, fields, labels and keep contracts', () => {
    const declarations = Array.from({length: 120}, (_, index) => 'local original_' + index + '=' + index).join(';');
    const source = 'a=1;b=2;local kept=5;' + declarations + ';return ' +
        Array.from({length: 120}, (_, index) => 'original_' + index).join('+') + '+kept+a+b';
    const result = transformLua(source, {nameMode: 'seeded', seed: '길이 seed', keepLocals: ['kept']});
    assert.deepEqual(runLua(result.code), runLua(source));
    const ast = parseLua(result.code), names = ast.body.filter(node => node.type === 'LocalStatement').map(node => node.variables[0].name).slice(1);
    assert(names.every(name => /^[A-Za-z][A-Za-z0-9]*$/.test(name) && !['a', 'b', 'kept'].includes(name)));
    assert.equal(new Set(names).size, 120);
    assert.equal(names.filter(name => name.length === 1).length, 50);
    assert(names.every(name => name.length <= 2));
    const fields = 'local self, main, config, gg_keep, udg_keep = 1,2,3,4,5; local object={value=7}; function object:a(value) return self.value+value end; ::again:: local observed=object:a(2); return observed,main,config,gg_keep,udg_keep';
    const rewritten = transformLua(fields, {nameMode: 'seeded', seed: 'other'}).code;
    assert.deepEqual(runLua(rewritten), runLua(fields));
    const identifiers = identifierNames(parseLua(rewritten));
    for (const name of ['self', 'main', 'config', 'gg_keep', 'udg_keep', 'a', 'again']) assert(identifiers.includes(name));
});

test('name settings fail strictly even when renaming is disabled', () => {
    for (const nameMode of [null, '', 'random', 1]) assert.throws(() => transformLua('return 1', {nameMode, renameLocals: false}), /nameMode/);
    for (const seed of [null, '', 'x'.repeat(129), '\ud800', '\u0085']) assert.throws(() => transformLua('return 1', {seed, renameLocals: false}), /lua.seed/);
});

test('runtime rewrite guard rejects name/source/bytecode/memory and indirect observers', () => {
    const sources = [
        'local observed=2; return debug.getlocal(1,1)',
        'return debug.getinfo(1).source', 'return load(reader)', 'return require("external")',
        'return string.dump(function() return 1 end)',
        'local library=string; local key="du".."mp"; return library[key](function() end)',
        'local env=_G; local library=env.string; return library.dump(function() end)',
        'return rawget(string, "dump")(function() end)',
        'local library=string; return library[unknownKey](function() end)',
        'return rawget(string, unknownKey)',
        'return dump(function() end)', 'return _G["dump"]',
        'return collectgarbage("count")', 'local env=_G; return env["collectgarbage"]',
        'return load("return string.dump(function() end)")()',
        'return load("return collectgarbage(\'count\')")()',
        'return unknown(string)', 'return string', 'local boxed={library=string}; return boxed',
    ];
    for (const source of sources) assert.throws(() => assertRuntimeRewriteSafe(parseLua(source)), /--no-runtime-strings --no-vm/);
    assert.doesNotThrow(() => transformLua('local observed=2; return string.dump(function() return observed end)'));
    assert.doesNotThrow(() => assertSourceRewriteSafe(parseLua('return string.dump(function() end)')));
    for (const source of [
        'local library=string; return library.char(65)',
        'local string={dump=function() return 1 end}; return string.dump()',
        'local dump=2; local collectgarbage=function() return 4 end; return dump+collectgarbage()',
        'local env=_G; local name="Blz"..suffix; return env[name]',
    ]) assert.doesNotThrow(() => assertRuntimeRewriteSafe(parseLua(source)));
    assert.throws(() => assertRuntimeRewriteSafe(null), /parsed Chunk/);
});

test('runtime guards reuse the earliest original location through prepared minified code', () => {
    const source = '-- original line\nlocal library=string\n\nreturn library.dump(function() end)';
    const prepared = prepareLua(source, 'war3map.lua');
    const output = prepared.transform({}, {prepareOutput: true});
    assert.throws(() => assertRuntimeRewriteSafe(output.prepared.ast, {prepared: output.prepared}), error => {
        assert(error.message.includes('string.dump observes function bytecode'));
        assert(error.message.includes('war3map.lua:4:8'));
        assert(error.message.includes('--no-runtime-strings --no-vm'));
        return true;
    });
    assert.throws(() => assertRuntimeRewriteSafe(parseLua(output.code), {prepared: output.prepared}), /AST does not match/);
    assert.throws(() => assertRuntimeRewriteSafe(output.prepared.ast, {prepared: {}}), /prepared Lua stage/);
});

test('repeated alias evaluations retain cyclic capabilities, later assignments and earliest causes', () => {
    const refused = [
        ['local first,second\nfirst=second\nsecond=first\nsecond=string\nlocal again=first\nreturn again.dump(function() end)',6],
        ['local library={}\nlocal harmless=library.any\nlibrary=string\nlocal observed=library.dump\nreturn observed(function() end)',4],
        ['local library=string\ndo local library={dump=function() return 1 end}; Result=library.dump() end\nreturn library.dump(function() end)',3],
        ['local first,second\nfirst=second\nsecond=first\nsecond=_G\nlocal loader=first["load"]\nreturn loader(unknownSource)',6],
        ['local source="return debug.getinfo(1)"\nlocal alias=source\nlocal harmless=alias\nreturn load(alias)()',4],
        ['local library=string\nUnknown(library)\nUnknown(library)',2],
    ];
    for (const [source,line] of refused) {
        const prepared=prepareLua(source,'aliases.lua');
        assert.throws(()=>assertRuntimeRewriteSafe(prepared.ast,{prepared}),error=>{
            assert(error.message.includes('aliases.lua:'+line+':'));
            assert(error.message.includes('--no-runtime-strings --no-vm'));
            return true;
        });
    }
    for (const source of [
        'local first,second; first=second; second=first; second={safe=2}; return first.safe',
        'local library={dump=function() return 1 end}; local early=library.dump; library={dump=function() return 2 end}; return library.dump()',
        'do local library=string; Result=library.char(65) end; do local library={dump=function() return 3 end}; Result=library.dump() end',
    ]) assert.doesNotThrow(()=>assertRuntimeRewriteSafe(parseLua(source)));
});

test('resource limits count active lexical locals, hidden loop controls and method self', () => {
    const locals = count => Array.from({length: count}, (_, index) => 'local variable_' + index + '=0').join('\n');
    const boundary = locals(200) + '\nreturn 1';
    assert.doesNotThrow(() => assertLuaResourceLimits(parseLua(boundary)));
    assert.deepEqual(runLua(boundary), [1]);
    assert.throws(() => assertLuaResourceLimits(parseLua('local helper\n' + boundary), 'Runtime output Lua'), /200 active Lua locals.*Runtime output Lua/);
    const numeric = locals(196) + '\nfor index=1,1 do end\nreturn 1';
    assert.doesNotThrow(() => assertLuaResourceLimits(parseLua(numeric)));
    assert.deepEqual(runLua(numeric), [1]);
    assert.throws(() => assertLuaResourceLimits(parseLua('local helper\n' + numeric)), /200 active Lua locals/);
    const generic = locals(195) + '\nfor key,value in pairs({}) do end\nreturn 1';
    assert.doesNotThrow(() => assertLuaResourceLimits(parseLua(generic)));
    assert.deepEqual(runLua(generic), [1]);
    assert.throws(() => assertLuaResourceLimits(parseLua('local helper\n' + generic)), /200 active Lua locals/);
    const parameters = count => Array.from({length: count}, (_, index) => 'argument_' + index).join(',');
    const method = count => 'local object={}; function object:method(' + parameters(count) + ') return 1 end; return object:method()';
    assert.doesNotThrow(() => assertLuaResourceLimits(parseLua(method(199))));
    assert.deepEqual(runLua(method(199)), [1]);
    assert.throws(() => assertLuaResourceLimits(parseLua(method(200))), /200 active Lua locals/);
});

test('upvalue limits include forwarding through closures and only the actual lexical environment', () => {
    const root = Array.from({length: 180}, (_, index) => 'local root_' + index + '=' + index).join('\n');
    const mid = Array.from({length: 75}, (_, index) => 'local mid_' + index + '=' + (index + 1000)).join('\n');
    const values = [...Array.from({length: 180}, (_, index) => 'root_' + index),
        ...Array.from({length: 75}, (_, index) => 'mid_' + index)].join(',');
    const source = (extra = '') => root + '\nlocal function outer()\n' + mid +
        '\nreturn function() return function()\nlocal values={' + values + '}\n' + extra +
        '\nreturn #values end end end\nreturn outer()()()';
    assert.doesNotThrow(() => assertLuaResourceLimits(parseLua(source())));
    assert.deepEqual(runLua(source()), [255]);
    assert.throws(() => assertLuaResourceLimits(parseLua('local helper=function() return 1 end\n' + source('helper()'))), /255 Lua upvalues/);
    assert.throws(() => assertLuaResourceLimits(parseLua(source('native()'))), /255 Lua upvalues/);
    const localEnvironment = source('local _ENV={native=function() return 1 end}; native()');
    assert.doesNotThrow(() => assertLuaResourceLimits(parseLua(localEnvironment)));
    assert.deepEqual(runLua(localEnvironment), [255]);
    assert.throws(() => assertLuaResourceLimits(null), /parsed Chunk/);
});

test('resource checks release block locals, reset function locals and retain repeat/loop lexical captures', () => {
    const locals = count => Array.from({length:count},(_,index)=>'local value_'+index+'=0').join('\n');
    const siblings = 'do\n'+locals(200)+'\nend\ndo\n'+locals(200)+'\nend\nreturn 1';
    assert.doesNotThrow(()=>assertLuaResourceLimits(parseLua(siblings)));
    assert.deepEqual(runLua(siblings),[1]);
    const nested = locals(198)+'\nlocal function target(a,b)\n'+locals(198)+'\nreturn a,b end\nreturn target(3,4)';
    assert.doesNotThrow(()=>assertLuaResourceLimits(parseLua(nested)));
    assert.deepEqual(runLua(nested),[3,4]);
    assert.throws(()=>assertLuaResourceLimits(parseLua('do\n'+locals(197)+'\nfor index=1,1 do local extra end end')),/200 active Lua locals/);
    const repeat = 'local result; repeat local scoped=7; result=function() return scoped end until scoped==7; return result()';
    assert.doesNotThrow(()=>assertLuaResourceLimits(parseLua(repeat)));
    assert.deepEqual(runLua(repeat),[7]);
    const controls='local index=2; for index=index,index do local f=function() return index end; Result=f() end; return index,Result';
    assert.doesNotThrow(()=>assertLuaResourceLimits(parseLua(controls)));
    assert.deepEqual(runLua(controls),[2,2]);
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
