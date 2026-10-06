import luaparse from 'luaparse';

// Helpers shared by Lua analyses: refusal causes and literal decoding.
export const ignoredKeys = new Set(['comments', 'globals', 'range', 'loc']);
export const loaderRoles = ['load', 'loadfile', 'dofile', 'require'];

export function riskCause(node, reason) {
    return {offset: node?.range?.[0] ?? Infinity, line: node?.loc?.start.line ?? 1,
        column: (node?.loc?.start.column ?? 0) + 1, reason};
}

export function firstCause(before, after) { return !before || after.offset < before.offset ? after : before; }

export function literalString(node) {
    if (node?.type === 'BinaryExpression' && node.operator === '..') {
        const left = literalString(node.left), right = literalString(node.right);
        return left === null || right === null ? null : left + right;
    }
    if (node?.type !== 'StringLiteral') return null;
    // Decode a copy as Lua bytes for analysis only. Source literals are emitted
    // with their original raw text, including UTF-8 and escaped byte values.
    const byteSource = Buffer.from(node.raw, 'utf8').toString('latin1');
    return luaparse.parse('return ' + byteSource, {luaVersion: '5.3', encodingMode: 'pseudo-latin1'}).body[0].arguments[0].value;
}
