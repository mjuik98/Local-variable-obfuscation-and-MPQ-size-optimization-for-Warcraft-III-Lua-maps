import assert from 'node:assert/strict';
import luaparse from 'luaparse';
import { canonicalPath } from './config.mjs';

const EDITOR_FILES = ['war3map.wtg', 'war3map.wct'];
const DEVELOPMENT_FILES = ['lotkt-object-history.json', 'lotkt-object-receipt.json'];
const FILE_APIS = new Set(['io', 'require', 'load', 'loadfile', 'dofile', 'Preloader', 'debug', 'package']);
const ENVIRONMENTS = new Set(['_G', '_ENV']);

function decodedString(node) {
    if (node.type !== 'StringLiteral') return null;
    // Parse bytes as Latin-1 so escapes and UTF-8 bytes have Lua's byte-string
    // semantics; this never changes or re-encodes the actual map script.
    const raw = Buffer.from(node.raw, 'utf8').toString('latin1');
    const ast = luaparse.parse('return ' + raw, { luaVersion: '5.3', encodingMode: 'pseudo-latin1' });
    return ast.body[0].arguments[0].value;
}

function constantString(node) {
    if (!node) return null;
    if (node.type === 'StringLiteral') return decodedString(node);
    if (node.type === 'BinaryExpression' && node.operator === '..') {
        const left = constantString(node.left), right = constantString(node.right);
        if (left !== null && right !== null) return left + right;
    }
    return null;
}

function walk(node, visit, parent = null) {
    if (!node || typeof node !== 'object') return;
    if (node.type) visit(node, parent);
    for (const [key, value] of Object.entries(node)) {
        if (['comments', 'globals', 'loc', 'range'].includes(key)) continue;
        if (Array.isArray(value)) value.forEach(child => walk(child, visit, node));
        else walk(value, visit, node);
    }
}

function validateReferences(ast, names) {
    const paths = names.map(canonicalPath);
    for (const global of ast.globals ?? []) {
        assert(!FILE_APIS.has(global.name), 'File cleanup cannot prove runtime file references for ' + global.name + '; use --no-cleanup or preserve the candidates');
    }
    walk(ast, (node, parent) => {
        const text = constantString(node);
        if (text !== null) {
            const normalized = canonicalPath(text);
            for (const name of paths) assert(!normalized.includes(name), 'Script references cleanup candidate ' + name + '; preserve it with --keep-file');
        }
        if (node.type === 'Identifier' && ENVIRONMENTS.has(node.name)) {
            const direct = parent?.base === node;
            const key = direct && parent.type === 'MemberExpression' ? parent.identifier.name
                : direct && parent.type === 'IndexExpression' ? constantString(parent.index) : null;
            assert(key !== null && !FILE_APIS.has(key) && !ENVIRONMENTS.has(key), 'File cleanup encountered unresolved environment access or a file API; use --no-cleanup');
        }
    });
}

function cleanImports(bytes, removedNames) {
    if (!bytes) return null;
    assert(bytes.length >= 8 && bytes.readUInt32LE(0) === 1, 'Unsupported import manifest');
    const removed = new Set(removedNames.map(canonicalPath));
    const count = bytes.readUInt32LE(4), entries = [];
    assert(count <= bytes.length - 8, 'Invalid import count');
    let cursor = 8;
    for (let index = 0; index < count; index++) {
        const start = cursor;
        assert(cursor < bytes.length, 'Truncated import manifest');
        const flag = bytes[cursor++], end = bytes.indexOf(0, cursor);
        assert([0, 5, 8, 10, 13].includes(flag), 'Unsupported import path flag: ' + flag);
        assert(end >= cursor, 'Unterminated import path');
        const rawName = bytes.toString('latin1', cursor, end);
        cursor = end + 1;
        const custom = flag === 10 || flag === 13;
        const actual = custom ? rawName : 'war3mapImported\\' + rawName;
        if (!removed.has(canonicalPath(actual))) entries.push(bytes.subarray(start, cursor));
    }
    assert(cursor === bytes.length, 'Trailing import data');
    if (entries.length === count) return bytes;
    const header = Buffer.from(bytes.subarray(0, 8));
    header.writeUInt32LE(entries.length, 4);
    return Buffer.concat([header, ...entries]);
}

export function planCleanup(map, ast, options) {
    const keep = new Set(options.keepFiles.map(canonicalPath));
    const names = [...(options.editor ? EDITOR_FILES : []), ...(options.development ? DEVELOPMENT_FILES : [])]
        .filter(name => !keep.has(canonicalPath(name)) && map.has(name));
    if (!names.length) return { names, imports: null };
    validateReferences(ast, names);
    const before = map.read('war3map.imp');
    const after = cleanImports(before, names);
    return { names, imports: after && !after.equals(before) ? after : null };
}
