import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalPath } from './config.mjs';
import { ignoredKeys, literalString as constantString } from './lua-syntax.mjs';

const EDITOR_FILES = ['war3map.wtg', 'war3map.wct'];
const DEVELOPMENT_FILES = ['lotkt-object-history.json', 'lotkt-object-receipt.json'];
// Editor placement data and the import manifest. A Lua map script creates
// regions, cameras and sounds itself; imported files are read by MPQ path.
const EDITOR_DATA_FILES = ['war3map.w3r', 'war3map.w3c', 'war3map.w3s', 'war3map.imp'];
const FILE_APIS = new Set(['io', 'require', 'load', 'loadfile', 'dofile', 'Preloader', 'debug', 'package']);
const ENVIRONMENTS = new Set(['_G', '_ENV']);
// war3map.imp path flags; 10 and 13 store the full MPQ path instead of a
// path relative to war3mapImported.
const IMPORT_FLAGS = new Set([0, 5, 8, 10, 13]), CUSTOM_IMPORT_FLAGS = new Set([10, 13]);
export const CLEANUP_CANDIDATES = Object.freeze([...EDITOR_FILES, ...DEVELOPMENT_FILES, ...EDITOR_DATA_FILES]);
const CANDIDATES = new Set(CLEANUP_CANDIDATES.map(canonicalPath));
// Experimental editor blocking. Warcraft III never reads the editor trigger
// files; World Editor needs them to load a map. Each is replaced with a valid
// file header followed by a format version no editor release writes, so the
// editor's loader rejects it. The game behaviour of the map is unchanged; an
// MPQ editor can still remove the files, so this is a deterrent only.
export function editorBlockContents(name) {
    assert(EDITOR_FILES.some(file => canonicalPath(file) === canonicalPath(name)), 'Not an editor trigger file: ' + name);
    const version = Buffer.alloc(4);
    version.writeUInt32LE(0xffffffff);
    return canonicalPath(name) === 'WAR3MAP.WTG' ? Buffer.concat([Buffer.from('WTG!'), version]) : version;
}

function contractRecord(value, keys, label) {
    assert(value !== null && typeof value === 'object' && !Array.isArray(value), label + ' must be an object');
    assert(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, label + ' must be a plain object');
    assert(Object.keys(value).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(value, key)), 'Unknown or missing ' + label + ' field');
}

function reviewText(value, label) {
    assert(typeof value === 'string' && value.trim().length > 0 && value.length <= 16384 && !value.includes('\0'), label + ' must contain review evidence');
}

// A contract is a caller's explicit dependency review for one exact input. It
// grants no new deletion targets and is not a proof produced by this tool.
export function validateCleanupContract(map, contract, { scriptBytes, inputBytes } = {}) {
    contractRecord(contract, ['version', 'inputMapSha256', 'scriptSha256', 'review', 'files'], 'cleanup contract');
    assert.equal(contract.version, 1, 'Unsupported cleanup contract version');
    for (const key of ['inputMapSha256', 'scriptSha256']) assert(typeof contract[key] === 'string' && /^[a-f0-9]{64}$/.test(contract[key]), 'Invalid cleanup contract ' + key);
    contractRecord(contract.review, ['dynamicFileAccess', 'objectAndImportReferences', 'limitations'], 'cleanup contract review');
    for (const [key, value] of Object.entries(contract.review)) reviewText(value, 'cleanup contract review.' + key);
    assert(Array.isArray(contract.files) && contract.files.length > 0 && contract.files.length <= CANDIDATES.size, 'Cleanup contract files must list fixed cleanup candidates');
    const reviewed = new Set();
    for (const file of contract.files) {
        contractRecord(file, ['path', 'reason', 'evidence'], 'cleanup contract file');
        assert(typeof file.path === 'string' && CANDIDATES.has(canonicalPath(file.path)), 'Cleanup contract contains an unsupported file');
        const name = canonicalPath(file.path);
        assert(!reviewed.has(name), 'Duplicate cleanup contract file');
        assert(map.has(file.path), 'Cleanup contract file is absent from the input map: ' + file.path);
        reviewed.add(name);
        reviewText(file.reason, 'cleanup contract file reason');
        assert(Array.isArray(file.evidence) && file.evidence.length > 0 && file.evidence.length <= 32, 'Cleanup contract file evidence must be a nonempty array');
        for (const evidence of file.evidence) reviewText(evidence, 'cleanup contract file evidence');
    }
    assert(Buffer.isBuffer(scriptBytes) && Buffer.isBuffer(inputBytes), 'Cleanup contract requires the original map and Lua bytes');
    const digest = bytes => createHash('sha256').update(bytes).digest('hex');
    assert.equal(digest(inputBytes), contract.inputMapSha256,
        '선택한 검토 계약이 현재 입력 맵과 일치하지 않습니다. 맵을 새로 빌드하거나 이미 보호했다면 해당 입력을 다시 검토해야 합니다. 계약의 해시만 바꾸지 마세요.\n' +
        'Cleanup contract input map SHA-256 mismatch; review this exact input again');
    assert.equal(digest(scriptBytes), contract.scriptSha256,
        '선택한 검토 계약이 현재 Lua 스크립트와 일치하지 않습니다. 해당 입력을 다시 검토하거나 고급 설정의 에디터 파일 정리·개발 파일 정리를 해제하세요.\n' +
        'Cleanup contract Lua SHA-256 mismatch; review this exact script again');
    return reviewed;
}

function walk(node, visit, parent = null) {
    if (!node || typeof node !== 'object') return;
    if (node.type) visit(node, parent);
    for (const key in node) {
        if (ignoredKeys.has(key)) continue;
        const value = node[key];
        if (Array.isArray(value)) { for (const child of value) walk(child, visit, node); }
        else walk(value, visit, node);
    }
}

function validateReferences(ast, names, reviewed = false) {
    const paths = names.map(canonicalPath);
    const forbiddenApi = name => FILE_APIS.has(name) && !(reviewed && name === 'Preloader');
    for (const global of ast.globals ?? []) {
        const detail = 'File cleanup cannot prove runtime file references for ' + global.name + '; use --no-cleanup or preserve the candidates';
        const message = global.name === 'Preloader' ?
            '파일 정리를 중단했습니다. Preloader가 있어 정리 대상의 실행 중 사용 여부를 확인할 수 없습니다.\n' +
            '정리 대상: ' + names.join(', ') + '\n' +
            '정리하려면 메인 작업 화면의 검토 계약 → 찾아보기에서 현재 입력 맵을 검토한 JSON을 선택하세요.\n' +
            '계약이 없으면 고급 설정의 에디터 파일 정리·개발 파일 정리를 모두 해제하고 다시 검사하세요. Lua 보호·재압축은 계속 사용할 수 있습니다.\n' +
            'CLI: --cleanup-contract <검토계약.json> 또는 --no-cleanup\n' + detail : detail;
        assert(!forbiddenApi(global.name), message);
    }
    walk(ast, (node, parent) => {
        const text = constantString(node);
        if (text !== null) {
            const normalized = canonicalPath(text);
            for (const name of paths) assert(!normalized.includes(name), 'Script references cleanup candidate ' + name + '; preserve it with --keep-file');
        }
        if (reviewed) {
            const key = node.type === 'MemberExpression' ? node.identifier.name
                : node.type === 'IndexExpression' ? constantString(node.index) : null;
            assert(key === null || !forbiddenApi(key), 'File cleanup contract cannot permit external loaders or reflection APIs; use --no-cleanup');
            if (node.type === 'CallExpression' && node.base.type === 'Identifier' && node.base.name === 'rawget') {
                const lookupKey = constantString(node.arguments[1]);
                assert(lookupKey === null || !forbiddenApi(lookupKey), 'File cleanup contract cannot permit external loaders or reflection APIs; use --no-cleanup');
            }
        }
        if (node.type === 'Identifier' && ENVIRONMENTS.has(node.name)) {
            const direct = parent?.base === node;
            const key = direct && parent.type === 'MemberExpression' ? parent.identifier.name
                : direct && parent.type === 'IndexExpression' ? constantString(parent.index) : null;
            if (reviewed) assert(key === null || !forbiddenApi(key), 'File cleanup contract cannot permit external loaders or reflection APIs; use --no-cleanup');
            else assert(key !== null && !FILE_APIS.has(key) && !ENVIRONMENTS.has(key), 'File cleanup encountered unresolved environment access or a file API; use --no-cleanup');
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

export function planCleanup(map, ast, options, context = {}) {
    const reviewed = context.cleanupContract === undefined ? null : validateCleanupContract(map, context.cleanupContract, context);
    const keep = new Set(options.keepFiles.map(canonicalPath));
    const names = [...(options.editor ? EDITOR_FILES : []), ...(options.development ? DEVELOPMENT_FILES : []), ...(options.editorData ? EDITOR_DATA_FILES : [])]
        .filter(name => !keep.has(canonicalPath(name)) && map.has(name));
    // Blocking rewrites the existing trigger files and never adds files. The
    // script must not reference either name, as for deletion.
    if (options.editorBlock) for (const name of EDITOR_FILES) assert(map.has(name), 'Editor blocking requires ' + name + ' in the input map');
    const blocked = options.editorBlock ? EDITOR_FILES.map(name => [name, editorBlockContents(name)]) : [];
    const targets = [...names, ...blocked.map(([name]) => name)];
    if (!targets.length) return { names, imports: null, blocked };
    if (reviewed) {
        for (const name of names) assert(reviewed.has(canonicalPath(name)), 'Cleanup contract does not review selected candidate ' + name);
        for (const [name] of blocked) assert(reviewed.has(canonicalPath(name)), 'Cleanup contract does not review editor-blocked file ' + name);
    }
    validateReferences(ast, targets, reviewed !== null);
    if (!names.length) return { names, imports: null, blocked };
    // A removed manifest needs no row updates.
    if (names.some(name => canonicalPath(name) === 'WAR3MAP.IMP')) return { names, imports: null, blocked };
    const before = map.read('war3map.imp');
    const after = cleanImports(before, names);
    return { names, imports: after && !after.equals(before) ? after : null, blocked };
}
