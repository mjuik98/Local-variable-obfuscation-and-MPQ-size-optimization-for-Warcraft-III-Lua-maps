import luaparse from 'luaparse';

// Helpers shared by Lua analyses: refusal causes and literal decoding.
export const ignoredKeys = new Set(['comments', 'globals', 'range', 'loc']);
export const loaderRoles = ['load', 'loadfile', 'dofile', 'require'];

export function riskCause(node, reason) {
    return {offset: node?.range?.[0] ?? Infinity, line: node?.loc?.start.line ?? 1,
        column: (node?.loc?.start.column ?? 0) + 1, reason};
}

export function firstCause(before, after) { return !before || after.offset < before.offset ? after : before; }

// Offset where a generated chunk prelude starts: after a leading shebang line
// and its line break, which must stay the first line, or 0.
export function chunkInsertionOffset(code, label) {
    if (!code.startsWith('#!')) return 0;
    const end = code.search(/[\r\n]/);
    if (end < 0) throw new Error(label + ' cannot follow an unterminated shebang');
    return end + (code[end] === '\r' && code[end + 1] === '\n' ? 2 : 1);
}

// The Lua bytes of a parsed string literal's raw text, one character per byte.
// Decode a copy for analysis only. Source literals are emitted with their
// original raw text, including UTF-8 and escaped byte values. Escape-free
// quoted text is its own value (a parsed one has no line break); escapes,
// \u{} and long-bracket newline rules use the parser itself.
export function decodeLuaString(raw) {
    if ((raw[0] === '"' || raw[0] === '\'') && !raw.includes('\\')) return Buffer.from(raw.slice(1, -1), 'utf8').toString('latin1');
    const byteSource = Buffer.from(raw, 'utf8').toString('latin1');
    return luaparse.parse('return ' + byteSource, {luaVersion: '5.3', encodingMode: 'pseudo-latin1'}).body[0].arguments[0].value;
}

export function literalString(node) {
    if (node?.type === 'BinaryExpression' && node.operator === '..') {
        const left = literalString(node.left), right = literalString(node.right);
        return left === null || right === null ? null : left + right;
    }
    return node?.type === 'StringLiteral' ? decodeLuaString(node.raw) : null;
}
