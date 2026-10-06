import assert from 'node:assert/strict';
import { constantString, eachNode } from './lua.mjs';
import { canonicalPath } from './mpq.mjs';

const EDITOR_FILES = ['war3map.wtg', 'war3map.wct'];
const DEVELOPMENT_FILES = ['lotkt-object-history.json', 'lotkt-object-receipt.json'];
const FILE_APIS = new Set(['io', 'require', 'load', 'loadfile', 'dofile', 'Preloader', 'debug', 'package']);
const ENVIRONMENTS = new Set(['_G', '_ENV']);
// war3map.imp path flags; 10 and 13 store the full MPQ path instead of a
// path relative to war3mapImported.
const IMPORT_FLAGS = new Set([0, 5, 8, 10, 13]), CUSTOM_IMPORT_FLAGS = new Set([10, 13]);

function validateReferences(ast, names) {
    const paths = names.map(canonicalPath);
    for (const global of ast.globals ?? []) {
        assert(!FILE_APIS.has(global.name), 'File cleanup cannot prove runtime file references for ' + global.name + '; use --no-cleanup or preserve the candidates');
    }
    eachNode(ast, (node, parent) => {
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
    assert(bytes.length >= 8 && bytes.readUInt32LE(0) === 1, 'war3map.imp: Unsupported import manifest');
    const removed = new Set(removedNames.map(canonicalPath));
    const count = bytes.readUInt32LE(4), entries = [];
    assert(count <= bytes.length - 8, 'war3map.imp: Invalid import count');
    let cursor = 8;
    for (let index = 0; index < count; index++) {
        const start = cursor;
        assert(cursor < bytes.length, 'war3map.imp: Truncated import manifest at entry ' + index);
        const flag = bytes[cursor++], end = bytes.indexOf(0, cursor);
        assert(IMPORT_FLAGS.has(flag), 'war3map.imp: Unsupported import path flag: ' + flag);
        assert(end >= cursor, 'war3map.imp: Unterminated import path at entry ' + index);
        const rawName = bytes.toString('latin1', cursor, end);
        cursor = end + 1;
        const actual = CUSTOM_IMPORT_FLAGS.has(flag) ? rawName : 'war3mapImported\\' + rawName;
        if (!removed.has(canonicalPath(actual))) entries.push(bytes.subarray(start, cursor));
    }
    assert(cursor === bytes.length, 'war3map.imp: Trailing import data');
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
