import assert from 'node:assert/strict';
import luaparse from 'luaparse';
import { assertLuaResourceLimits, assertRuntimeRewriteSafe, assertSourceRewriteSafe, getPreparedLuaAst, isLuaKeyword, parseLua, shortLuaName } from './lua.mjs';
import { buildRuntimeStringHelper, cryptRuntimeString, deriveRuntimeStringKey, runtimeStringNonce } from './string-codec.mjs';

const ignoredAstFields = new Set(['comments', 'globals', 'range', 'loc']);

function visit(node, callback) {
    if (!node || typeof node !== 'object') return;
    if (node.type) callback(node);
    for (const key in node) {
        if (!Object.hasOwn(node, key) || ignoredAstFields.has(key)) continue;
        const value = node[key];
        if (Array.isArray(value)) value.forEach(child => visit(child, callback));
        else if (value && typeof value === 'object') visit(value, callback);
    }
}

function literalBytes(raw) {
    // Decode UTF-8 source as Lua byte strings, including \u{} and long-bracket
    // newline rules. The actual source never passes through Latin-1 encoding.
    const source = Buffer.from(raw).toString('latin1');
    const parsed = luaparse.parse('return ' + source, { luaVersion: '5.3', encodingMode: 'pseudo-latin1' });
    return Buffer.from(parsed.body[0].arguments[0].value, 'latin1');
}

function verifySame(before, after, values, runtime) {
    const message = 'String transformation changed syntax or runtime bytes';
    if (!before || typeof before !== 'object') { assert.equal(after, before, message); return; }
    assert(after && typeof after === 'object', message);
    if (Array.isArray(before)) {
        assert(Array.isArray(after) && before.length === after.length, message);
        before.forEach((value, index) => verifySame(value, after[index], values, runtime));
        return;
    }
    if (before.type === 'StringLiteral') {
        const id = runtime?.replacements.get(before.range[0]);
        if (id !== undefined) {
            assert(after.type === 'CallExpression' && after.base.type === 'Identifier' && after.base.name === runtime.helper &&
                after.arguments.length === 1 && after.arguments[0].type === 'NumericLiteral' && after.arguments[0].value === id, message);
            return;
        }
        assert(after.type === before.type && values.get(before.raw).equals(values.get(after.raw)), message);
        return;
    }
    if (before.type === 'StringCallExpression' && runtime?.replacements.has(before.argument.range[0])) {
        assert(after.type === 'CallExpression' && after.arguments.length === 1, message);
        verifySame(before.base, after.base, values, runtime);
        verifySame(before.argument, after.arguments[0], values, runtime);
        return;
    }
    let beforeCount = 0, afterCount = 0;
    for (const key in before) {
        if (!Object.hasOwn(before, key) || ignoredAstFields.has(key)) continue;
        beforeCount++;
        assert(Object.hasOwn(after, key), message);
        verifySame(before[key], after[key], values, runtime);
    }
    for (const key in after) if (Object.hasOwn(after, key) && !ignoredAstFields.has(key)) afterCount++;
    assert.equal(beforeCount, afterCount, message);
}

function eligible(node, bytes, keep) {
    if (bytes.length <= 4 || keep.has(bytes.toString('hex'))) return false;
    // Preserve identifiers/callbacks/orders, rawcodes, paths, WTS references,
    // formatted tooltips and multiline literals in both supported modes.
    if (/[\r\n]/.test(node.raw)) return false;
    const value = bytes.toString('latin1');
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return false;
    // The value is latin1-decoded bytes: reject ASCII control bytes and path/format characters.
    // eslint-disable-next-line no-control-regex
    return !/[\x00-\x1f\x7f\\/%.|]/.test(value);
}

function prepareRuntime(names, seed, code) {
    // The shortest name unused anywhere in the chunk cannot be shadowed and
    // carries no fixed tool signature.
    let helper, next = 0;
    do helper = shortLuaName(next++); while (names.has(helper) || isLuaKeyword(helper));
    return { helper, records: [], byValue: new Map(), replacements: new Map(), ...deriveRuntimeStringKey(seed, code) };
}

function runtimeRecord(runtime, bytes) {
    const value = bytes.toString('hex');
    if (runtime.byValue.has(value)) return runtime.byValue.get(value);
    const id = runtime.records.length + 1;
    const nonce = runtimeStringNonce(runtime.noncePrefix, id);
    const cipher = cryptRuntimeString(bytes, runtime.key, nonce);
    assert(cryptRuntimeString(cipher, runtime.key, nonce).equals(bytes), 'Runtime string ciphertext did not preserve literal bytes');
    runtime.records.push({ cipher });
    runtime.byValue.set(value, id);
    return id;
}

// Forced literal offsets name tool-generated literals (native names) that are
// encrypted in runtime mode even though they look like identifiers.
export function transformStrings(code, { enabled = false, mode = 'escape', keep = [] } = {}, {prepared, seed = 'warcraft-lua-protector', forced = []} = {}) {
    assert(typeof enabled === 'boolean', 'strings.enabled must be boolean');
    assert(mode === 'escape' || mode === 'runtime', 'strings.mode must be escape or runtime');
    assert(Array.isArray(keep) && keep.every(value => typeof value === 'string' && value.isWellFormed()), 'strings.keep must contain well-formed Unicode strings');
    assert(Array.isArray(forced) && forced.every(Number.isInteger), 'Forced string literals must be source offsets');
    if (!enabled) return { code, stats: { inputBytes: Buffer.byteLength(code), outputBytes: Buffer.byteLength(code), encodedLiterals: 0 } };
    const ast = prepared === undefined ? parseLua(code, 'String input Lua') : getPreparedLuaAst(prepared, code);
    const values = new Map(), edits = [];
    const runtimeMode = mode === 'runtime', forcedOffsets = new Set(runtimeMode ? forced : []), found = new Set();
    const names = runtimeMode ? new Set() : null, candidates = [], stringCalls = new Set();
    const preserved = new Set(keep.map(value => Buffer.from(value).toString('hex')));
    const decoded = raw => {
        if (!values.has(raw)) values.set(raw, literalBytes(raw));
        return values.get(raw);
    };
    visit(ast, node => {
        if (names && node.type === 'Identifier') names.add(node.name);
        if (names && node.type === 'StringCallExpression') stringCalls.add(node.argument.range[0]);
        if (node.type !== 'StringLiteral') return;
        const bytes = decoded(node.raw);
        if (forcedOffsets.has(node.range[0])) found.add(node.range[0]);
        else if (!eligible(node, bytes, preserved)) return;
        candidates.push({ node, bytes });
    });
    assert.equal(found.size, forcedOffsets.size, 'Forced string literal offsets do not match the Lua source');
    const runtime = runtimeMode && candidates.length ? prepareRuntime(names, seed, code) : null;
    for (const { node, bytes } of candidates) {
        let replacement;
        if (runtime) {
            const id = runtimeRecord(runtime, bytes);
            runtime.replacements.set(node.range[0], id);
            // The helper returns exactly one value, like the literal. Minified
            // Lua may put a keyword directly before a quoted literal (or"text"),
            // and a string call argument (f"text") needs call parentheses.
            replacement = runtime.helper + '(' + id + ')';
            if (stringCalls.has(node.range[0])) replacement = '(' + replacement + ')';
            else if (/[A-Za-z0-9_]/.test(code[node.range[0] - 1] ?? '')) replacement = ' ' + replacement;
        } else replacement = '"' + [...bytes].map(value => '\\' + String(value).padStart(3, '0')).join('') + '"';
        if (replacement !== node.raw) edits.push({ start: node.range[0], end: node.range[1], replacement });
    }
    if (!edits.length) return { code, stats: { inputBytes: Buffer.byteLength(code), outputBytes: Buffer.byteLength(code), encodedLiterals: 0 } };
    if (runtime) {
        assertRuntimeRewriteSafe(ast, {prepared, label: 'String input Lua'});
    } else assertSourceRewriteSafe(ast, {prepared, label: 'String input Lua'});
    const pieces = [];
    let cursor = 0;
    for (const edit of edits.sort((a, b) => a.start - b.start)) {
        assert(edit.start >= cursor, 'Overlapping string literals');
        pieces.push(code.slice(cursor, edit.start), edit.replacement);
        cursor = edit.end;
    }
    pieces.push(code.slice(cursor));
    let output = pieces.join(''), helperSource = '';
    if (runtime) {
        helperSource = buildRuntimeStringHelper(runtime.helper, runtime.records, runtime);
        const prefix = code.startsWith('#!') ? code.search(/[\r\n]/) : 0;
        assert(prefix >= 0, 'Runtime helper cannot follow an unterminated shebang');
        // Preserve a shebang as the first line. Normal comments may follow the
        // helper, since source-location observers were rejected above.
        const insertion = prefix > 0 ? prefix + (code[prefix] === '\r' && code[prefix + 1] === '\n' ? 2 : 1) : 0;
        output = output.slice(0, insertion) + helperSource + output.slice(insertion);
    }
    const result = parseLua(output, 'String output Lua');
    if (runtime) assertLuaResourceLimits(result, 'Runtime string output Lua');
    visit(result, node => { if (node.type === 'StringLiteral') decoded(node.raw); });
    // Compare in place instead of cloning two full ASTs for large map scripts.
    if (runtime) {
        const expectedHelper = parseLua(helperSource, 'Runtime string helper');
        visit(expectedHelper, node => { if (node.type === 'StringLiteral') decoded(node.raw); });
        assert(expectedHelper.body.length === 1 && result.body.length === ast.body.length + 1, 'Unexpected runtime helper statements');
        verifySame(expectedHelper.body[0], result.body[0], values);
        verifySame(ast, { ...result, body: result.body.slice(1) }, values, runtime);
    } else verifySame(ast, result, values);
    return { code: output, stats: { inputBytes: Buffer.byteLength(code), outputBytes: Buffer.byteLength(output), encodedLiterals: edits.length,
        ...(runtime ? { mode: 'runtime', uniqueRuntimeLiterals: runtime.records.length,
            runtimeCipherBytes: runtime.records.reduce((sum, record) => sum + record.cipher.length, 0), runtimeHelperBytes: Buffer.byteLength(helperSource) } : {}) } };
}
