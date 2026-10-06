import assert from 'node:assert/strict';
import { analyzeGlobalNames, assertLuaResourceLimits, assertRuntimeRewriteSafe, getPreparedLuaAnalysis, isLuaKeyword, parseLua, prepareLua,
    resolveLuaBindings, shortLuaName } from './lua.mjs';
import { ENGINE_FUNCTIONS } from './engine-names.mjs';

const ignored = new Set(['range', 'loc', 'comments', 'globals']);

function identifierNames(node, names = new Set()) {
    if (!node || typeof node !== 'object') return names;
    if (Array.isArray(node)) { for (const child of node) identifierNames(child, names); return names; }
    if (node.type === 'Identifier') names.add(node.name);
    for (const key in node) if (!ignored.has(key)) identifierNames(node[key], names);
    return names;
}

function sameStructure(before, after, replaced, table, sites) {
    const message = 'Native call hiding changed syntax outside native references';
    if (!before || typeof before !== 'object') { assert.equal(after, before, message); return; }
    assert(after && typeof after === 'object', message);
    if (Array.isArray(before)) {
        assert(Array.isArray(after) && after.length === before.length, message);
        for (let index = 0; index < before.length; index++) sameStructure(before[index], after[index], replaced, table, sites);
        return;
    }
    if (before.type === 'Identifier' && replaced.has(before.range[0])) {
        assert(after.type === 'IndexExpression' && after.base.type === 'Identifier' && after.base.name === table &&
            after.index.type === 'NumericLiteral' && after.index.value === replaced.get(before.range[0]), message);
        sites.push(after.base);
        return;
    }
    const skip = key => ignored.has(key) || (before.type === 'Identifier' && key === 'isLocal');
    let beforeCount = 0, afterCount = 0;
    for (const key of Object.keys(before)) {
        if (skip(key)) continue;
        beforeCount++;
        assert(Object.hasOwn(after, key), message);
        sameStructure(before[key], after[key], replaced, table, sites);
    }
    for (const key of Object.keys(after)) if (!skip(key)) afterCount++;
    assert.equal(afterCount, beforeCount, message);
}

// Replace references to engine natives and Blizzard functions with entries of
// one local table. Each entry resolves its global on first use, so engine
// initialization order is unchanged, and caches the fixed function value.
// Names the script assigns, writes through _G or that are declared engine
// variables (bj_* and constants) stay direct global reads.
export function transformNatives(code, { enabled = false, encryptNames = false } = {}, { prepared, prepareOutput = false } = {}) {
    assert.equal(typeof enabled, 'boolean', 'lua.hideNatives must be boolean');
    assert.equal(typeof encryptNames, 'boolean', 'encryptNames must be boolean');
    assert.equal(typeof prepareOutput, 'boolean', 'prepareOutput must be a boolean');
    const unchanged = { code, stats: { inputBytes: Buffer.byteLength(code), outputBytes: Buffer.byteLength(code), hiddenNatives: 0, hiddenReferences: 0 }, forcedLiterals: [] };
    if (!enabled) {
        if (prepareOutput && prepared !== undefined) Object.defineProperty(unchanged, 'prepared', { value: prepared, enumerable: false });
        return unchanged;
    }
    const stage = prepared ?? prepareLua(code, 'Native input Lua');
    const { ast, resolved } = getPreparedLuaAnalysis(stage, code);
    assertRuntimeRewriteSafe(ast, { prepared: stage, label: 'Native input Lua' });
    const globals = analyzeGlobalNames(ast, resolved);
    if (globals.cause) {
        throw new Error('Native call hiding cannot verify every dynamic global lookup; preserve native calls. Cause: ' + globals.cause.reason +
            ' at Native input Lua:' + globals.cause.line + ':' + globals.cause.column + '. Recommended options: --no-hide-natives.');
    }
    const selected = [...globals.references]
        .filter(([name]) => ENGINE_FUNCTIONS.has(name) && !globals.definitions.has(name) && !globals.environmentWrites.has(name))
        .sort((a, b) => b[1].length - a[1].length || a[1][0].range[0] - b[1][0].range[0]);
    if (!selected.length) {
        if (prepareOutput) Object.defineProperty(unchanged, 'prepared', { value: stage, enumerable: false });
        return unchanged;
    }
    const used = identifierNames(ast);
    let table, next = 0;
    do table = shortLuaName(next++); while (used.has(table) || isLuaKeyword(table));
    const replaced = new Map(), edits = [];
    selected.forEach(([, nodes], position) => {
        for (const node of nodes) {
            assert(code.slice(...node.range) === node.name, 'Ambiguous native identifier range');
            replaced.set(node.range[0], position + 1);
            edits.push({ start: node.range[0], end: node.range[1], replacement: table + '[' + (position + 1) + ']' });
        }
    });
    const head = 'local ' + table + '=(function(s)return setmetatable({},{__index=function(t,i)local v=_ENV[s[i]];t[i]=v;return v end})end)({';
    const literals = [], parts = [];
    let length = head.length;
    for (const [name] of selected) {
        if (parts.length) { parts.push(','); length++; }
        const literal = '"' + name + '"';
        literals.push(length);
        parts.push(literal);
        length += literal.length;
    }
    const prelude = head + parts.join('') + '});\n';
    const shebang = code.startsWith('#!') ? code.search(/[\r\n]/) : 0;
    assert(shebang >= 0, 'Native table cannot follow an unterminated shebang');
    const insertion = shebang > 0 ? shebang + (code[shebang] === '\r' && code[shebang + 1] === '\n' ? 2 : 1) : 0;
    const pieces = [code.slice(0, insertion), prelude];
    let cursor = insertion;
    for (const edit of edits.sort((a, b) => a.start - b.start)) {
        assert(edit.start >= cursor, 'Overlapping native references');
        pieces.push(code.slice(cursor, edit.start), edit.replacement);
        cursor = edit.end;
    }
    pieces.push(code.slice(cursor));
    const output = pieces.join(''), outputStage = prepareOutput ? prepareLua(output, 'Native output Lua') : null;
    const result = outputStage ? outputStage.ast : parseLua(output, 'Native output Lua');
    assertLuaResourceLimits(result, 'Native output Lua');
    assert(result.body.length === ast.body.length + 1, 'Unexpected native table statements');
    const expected = parseLua(prelude, 'Native table').body[0], sites = [];
    sameStructure(expected, result.body[0], new Map(), table, sites);
    sameStructure(ast.body, result.body.slice(1), replaced, table, sites);
    assert.equal(sites.length, replaced.size, 'Native reference count changed');
    // Every replacement must read the table local, never a shadowing name.
    const outputBindings = resolveLuaBindings(result), binding = outputBindings.references.get(sites[0]);
    assert(binding && binding.nodes[0] === result.body[0].variables[0] && sites.every(site => outputBindings.references.get(site) === binding),
        'Native table reference is shadowed');
    const transformed = { code: output, stats: { inputBytes: Buffer.byteLength(code), outputBytes: Buffer.byteLength(output), hiddenNatives: selected.length,
        hiddenReferences: replaced.size }, forcedLiterals: encryptNames ? literals.map(offset => insertion + offset) : [] };
    if (prepareOutput) Object.defineProperty(transformed, 'prepared', { value: outputStage, enumerable: false });
    return transformed;
}
