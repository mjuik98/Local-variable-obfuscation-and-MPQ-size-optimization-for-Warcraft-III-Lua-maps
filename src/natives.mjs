import assert from 'node:assert/strict';
import { analyzeGlobalNames, assertLuaResourceLimits, assertRuntimeRewriteSafe, getPreparedLuaAnalysis, isLuaKeyword, parseLua, prepareLua,
    resolveLuaBindings, shortLuaName } from './lua.mjs';
import { ENGINE_FUNCTIONS } from './engine-names.mjs';
import { ignoredKeys as ignored, literalString } from './lua-syntax.mjs';
import { createSeededRandom, validateSeed } from './seed.mjs';

// Lua base functions with fixed behavior. Loaders and memory control stay
// direct; analysis already refuses loaders.
const BASE_FUNCTIONS = new Set(['assert', 'error', 'getmetatable', 'ipairs', 'next', 'pairs', 'pcall', 'print', 'rawequal', 'rawget', 'rawlen',
    'rawset', 'select', 'setmetatable', 'tonumber', 'tostring', 'type', 'xpcall']);
const LIBRARIES = new Set(['coroutine', 'math', 'os', 'string', 'table', 'utf8']);
const callTypes = new Set(['CallExpression', 'StringCallExpression']);

function identifierNames(node, names = new Set()) {
    if (!node || typeof node !== 'object') return names;
    if (Array.isArray(node)) { for (const child of node) identifierNames(child, names); return names; }
    if (node.type === 'Identifier') names.add(node.name);
    for (const key in node) if (!ignored.has(key)) identifierNames(node[key], names);
    return names;
}

const rangeKey = node => node.range[0] + ':' + node.range[1];

function sameStructure(before, after, replaced, table, sites) {
    const message = 'Native call hiding changed syntax outside native references';
    if (!before || typeof before !== 'object') { assert.equal(after, before, message); return; }
    assert(after && typeof after === 'object', message);
    if (Array.isArray(before)) {
        assert(Array.isArray(after) && after.length === before.length, message);
        for (let index = 0; index < before.length; index++) sameStructure(before[index], after[index], replaced, table, sites);
        return;
    }
    const entry = before.range ? replaced.get(rangeKey(before)) : undefined;
    if (entry?.kind === 'fold' && callTypes.has(before.type)) {
        assert(after.type === 'NumericLiteral' && after.value === entry.value && Number.isInteger(after.value), message);
        sites.folded++;
        return;
    }
    if ((entry?.kind === 'name' && before.type === 'Identifier') || (entry?.kind === 'member' && before.type === 'MemberExpression')) {
        assert(after.type === 'IndexExpression' && after.base.type === 'Identifier' && after.base.name === table &&
            after.index.type === 'NumericLiteral' && after.index.value === entry.value, message);
        sites.bases.push(after.base);
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

// A Warcraft rawcode of four printable ASCII bytes, read big-endian as FourCC does.
function rawcodeValue(argument) {
    if (argument?.type !== 'StringLiteral') return null;
    const bytes = Buffer.from(literalString(argument), 'latin1');
    return bytes.length === 4 && bytes.every(byte => byte >= 0x20 && byte <= 0x7e) ? bytes.readUInt32BE(0) : null;
}

// Replace references to engine natives, Blizzard functions, fixed Lua base
// functions and static Lua library members with entries of one local table.
// Each entry resolves its global (and field) on first use, so engine
// initialization order is unchanged, and caches the fixed function value.
// Names the script assigns or writes through _G, declared engine variables
// (bj_* and constants) and libraries used other than by static reads stay
// direct. Optionally FourCC calls with a literal rawcode become integers.
export function transformNatives(code, { enabled = false, encryptNames = false, foldFourCC = false, seed = 'warcraft-lua-protector' } = {}, { prepared, prepareOutput = false } = {}) {
    validateSeed(seed);
    assert.equal(typeof enabled, 'boolean', 'lua.hideNatives must be boolean');
    assert.equal(typeof encryptNames, 'boolean', 'encryptNames must be boolean');
    assert.equal(typeof foldFourCC, 'boolean', 'lua.foldFourCC must be boolean');
    assert.equal(typeof prepareOutput, 'boolean', 'prepareOutput must be a boolean');
    const unchanged = { code, stats: { inputBytes: Buffer.byteLength(code), outputBytes: Buffer.byteLength(code), hiddenNatives: 0,
        hiddenLibraryFunctions: 0, hiddenReferences: 0, foldedFourCC: 0 }, forcedLiterals: [] };
    const keep = stage => {
        if (prepareOutput && stage !== undefined) Object.defineProperty(unchanged, 'prepared', { value: stage, enumerable: false });
        return unchanged;
    };
    if (!enabled && !foldFourCC) return keep(prepared);
    const stage = prepared ?? prepareLua(code, 'Native input Lua');
    const { ast, resolved } = getPreparedLuaAnalysis(stage, code);
    assertRuntimeRewriteSafe(ast, { prepared: stage, label: 'Native input Lua' });
    const globals = analyzeGlobalNames(ast, resolved), { parents } = globals;
    if (globals.cause) {
        throw new Error('Native call hiding and FourCC folding cannot verify every dynamic global lookup; preserve engine calls. Cause: ' + globals.cause.reason +
            ' at Native input Lua:' + globals.cause.line + ':' + globals.cause.column + '. Recommended options: --no-hide-natives --no-fold-fourcc.');
    }
    const fixed = name => !globals.definitions.has(name) && !globals.environmentWrites.has(name);
    const replaced = new Map(), edits = [];
    let folded = 0;
    const foldedBases = new Set();
    if (foldFourCC && fixed('FourCC')) {
        for (const node of globals.references.get('FourCC') ?? []) {
            const call = parents.get(node);
            if (!callTypes.has(call?.type) || call.base !== node) continue;
            const value = rawcodeValue(call.type === 'StringCallExpression' ? call.argument : call.arguments.length === 1 ? call.arguments[0] : null);
            const owner = parents.get(call);
            // A number literal can be neither a base nor a call statement.
            if (value === null || owner?.base === call || owner?.type === 'CallStatement') continue;
            const before = /[A-Za-z0-9_]/.test(code[call.range[0] - 1] ?? '') ? ' ' : '', after = /[A-Za-z0-9_.]/.test(code[call.range[1]] ?? '') ? ' ' : '';
            replaced.set(rangeKey(call), { kind: 'fold', value });
            edits.push({ start: call.range[0], end: call.range[1], replacement: before + '0x' + value.toString(16) + after });
            foldedBases.add(node);
            folded++;
        }
    }
    const entries = [];
    if (enabled) {
        for (const [name, nodes] of globals.references) {
            const remaining = nodes.filter(node => !foldedBases.has(node));
            if (remaining.length && (ENGINE_FUNCTIONS.has(name) || BASE_FUNCTIONS.has(name)) && fixed(name)) {
                entries.push({ name, field: null, nodes: remaining, library: BASE_FUNCTIONS.has(name) });
            }
            // A library qualifies only when every reference is a static field
            // read; _G access could replace one of its fields.
            if (!LIBRARIES.has(name) || !fixed(name) || globals.environmentKeys.has(name)) continue;
            const members = nodes.map(node => parents.get(node));
            if (!members.every((member, index) => member?.type === 'MemberExpression' && member.base === nodes[index] && member.indexer === '.' &&
                !globals.isAssignmentTarget(member))) continue;
            const fields = new Map();
            members.forEach(member => {
                const list = fields.get(member.identifier.name);
                if (list) list.push(member); else fields.set(member.identifier.name, [member]);
            });
            for (const [field, list] of fields) entries.push({ name, field, nodes: list, library: true });
        }
        entries.sort((a, b) => b.nodes.length - a.nodes.length || a.nodes[0].range[0] - b.nodes[0].range[0]);
    }
    if (!edits.length && !entries.length) return keep(stage);
    const used = identifierNames(ast);
    let table = null, next = 0, prelude = '';
    const literals = [];
    if (entries.length) {
        do table = shortLuaName(next++); while (used.has(table) || isLuaKeyword(table));
        entries.forEach((entry, position) => {
            for (const node of entry.nodes) {
                assert(code.slice(...node.range) === (entry.field === null ? entry.name : entry.name + '.' + entry.field), 'Ambiguous engine reference range');
                replaced.set(rangeKey(node), { kind: entry.field === null ? 'name' : 'member', value: position + 1 });
                edits.push({ start: node.range[0], end: node.range[1], replacement: table + '[' + (position + 1) + ']' });
            }
        });
        const withFields = entries.some(entry => entry.field !== null);
        // The table's inner names follow the seed, leaving no fixed signature.
        const random = createSeededRandom(seed), letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
        for (let index = letters.length - 1; index > 0; index--) {
            const other = random() % (index + 1);
            [letters[index], letters[other]] = [letters[other], letters[index]];
        }
        const [s, f, t, i, v] = letters;
        const head = 'local ' + table + '=(function(' + s + (withFields ? ',' + f : '') + ')return setmetatable({},{__index=function(' + t + ',' + i + ')local ' + v + '=_ENV[' + s + '[' + i + ']];' +
            (withFields ? 'if ' + f + '[' + i + '] then ' + v + '=' + v + '[' + f + '[' + i + ']] end;' : '') + t + '[' + i + ']=' + v + ';return ' + v + ' end})end)(';
        let text = head;
        const list = values => {
            text += '{';
            values.forEach((value, index) => {
                if (index) text += ',';
                if (value === null) { text += 'false'; return; }
                literals.push(text.length);
                text += '"' + value + '"';
            });
            text += '}';
        };
        list(entries.map(entry => entry.name));
        if (withFields) { text += ','; list(entries.map(entry => entry.field)); }
        prelude = text + ');\n';
    }
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
    const offset = prelude ? 1 : 0, sites = { bases: [], folded: 0 };
    assert(result.body.length === ast.body.length + offset, 'Unexpected native table statements');
    if (prelude) sameStructure(parseLua(prelude, 'Native table').body[0], result.body[0], new Map(), table, sites);
    sameStructure(ast.body, result.body.slice(offset), replaced, table, sites);
    assert.equal(sites.bases.length + sites.folded, replaced.size, 'Native reference count changed');
    if (sites.bases.length) {
        // Every replacement must read the table local, never a shadowing name.
        const outputBindings = resolveLuaBindings(result), binding = outputBindings.references.get(sites.bases[0]);
        assert(binding && binding.nodes[0] === result.body[0].variables[0] && sites.bases.every(site => outputBindings.references.get(site) === binding),
            'Native table reference is shadowed');
    }
    const transformed = { code: output, stats: { inputBytes: Buffer.byteLength(code), outputBytes: Buffer.byteLength(output),
        hiddenNatives: entries.filter(entry => !entry.library).length, hiddenLibraryFunctions: entries.filter(entry => entry.library).length,
        hiddenReferences: sites.bases.length, foldedFourCC: folded }, forcedLiterals: encryptNames ? literals.map(position => insertion + position) : [] };
    if (prepareOutput) Object.defineProperty(transformed, 'prepared', { value: outputStage, enumerable: false });
    return transformed;
}
