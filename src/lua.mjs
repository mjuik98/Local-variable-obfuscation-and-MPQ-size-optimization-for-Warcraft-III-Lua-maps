import assert from 'node:assert/strict';
import luaparse from 'luaparse';

const parseOptions = {luaVersion: '5.3', scope: true, ranges: true, locations: true, comments: true};
const keywords = new Set('and break do else elseif end false for function goto if in local nil not or repeat return then true until while'.split(' '));
const reflectiveNames = new Set(['getlocal', 'setlocal', 'getupvalue', 'setupvalue', 'upvalueid', 'upvaluejoin', 'getinfo']);
const sourceLocationNames = new Set(['getinfo', 'traceback']);
const loaderRoles = ['load', 'loadfile', 'dofile', 'require'];
const firstAlphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const laterAlphabet = firstAlphabet + '0123456789';
const mergedPunctuators = new Set(['--', '==', '~=', '<=', '>=', '<<', '>>', '//', '::']);

export function parseLua(code, label = 'Lua') {
    assert.equal(typeof code, 'string', 'Lua source must be a string');
    try { return luaparse.parse(code, parseOptions); }
    catch (cause) { throw new Error(label + ': ' + cause.message, {cause}); }
}

function eachNode(node, visit) {
    if (!node || typeof node !== 'object') return;
    if (typeof node.type === 'string') visit(node);
    for (const [key, value] of Object.entries(node)) {
        if (['comments', 'globals', 'range', 'loc'].includes(key)) continue;
        if (Array.isArray(value)) value.forEach(child => eachNode(child, visit));
        else if (value && typeof value === 'object') eachNode(value, visit);
    }
}

function literalString(node) {
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

function scope(parent = null) { return {parent, bindings: new Map()}; }
function lookup(current, name) {
    for (; current; current = current.parent) {
        if (current.bindings.has(name)) return current.bindings.get(name);
    }
    return null;
}

// luaparse's isLocal metadata places for variables in scope too early for
// control expressions. Resolve bindings ourselves using Lua's lexical rules.
function resolveBindings(ast) {
    const bindings = [], references = new Map(), definitions = new Map(), globalDefinitions = new Map();
    let reflectsNames = false;
    const markReflection = () => { reflectsNames = true; };
    const declare = (current, node, implicit = false) => {
        const binding = {name: node.name, nodes: implicit ? [] : [node], implicit};
        bindings.push(binding);
        current.bindings.set(node.name, binding);
        return binding;
    };
    const assign = (binding, value) => {
        if (!value) return;
        const sources = definitions.get(binding) ?? [];
        sources.push(value); definitions.set(binding, sources);
    };
    const reference = (current, node) => {
        const binding = lookup(current, node.name);
        if (binding) {
            binding.nodes.push(node);
            references.set(node, binding);
        } else if (node.name === 'debug' || reflectiveNames.has(node.name)) markReflection();
    };
    const block = (body, current) => { for (const statement of body) visit(statement, current); };
    const visit = (node, current) => {
        if (!node) return;
        switch (node.type) {
        case 'Identifier': reference(current, node); return;
        case 'Chunk': block(node.body, current); return;
        case 'LocalStatement':
            node.init.forEach(value => visit(value, current));
            node.variables.forEach((variable, index) => assign(declare(current, variable), node.init[index]));
            return;
        case 'AssignmentStatement':
            node.variables.forEach(variable => visit(variable, current));
            node.init.forEach(value => visit(value, current));
            node.variables.forEach((variable, index) => {
                if (variable.type !== 'Identifier' || !node.init[index]) return;
                const binding = lookup(current, variable.name);
                if (binding) assign(binding, node.init[index]);
                else {
                    const sources = globalDefinitions.get(variable.name) ?? [];
                    sources.push(node.init[index]); globalDefinitions.set(variable.name, sources);
                }
            });
            return;
        case 'FunctionDeclaration': {
            if (node.isLocal) declare(current, node.identifier);
            else visit(node.identifier, current);
            const inner = scope(current);
            if (node.identifier?.type === 'MemberExpression' && node.identifier.indexer === ':') {
                declare(inner, {name: 'self'}, true);
            }
            node.parameters.filter(parameter => parameter.type === 'Identifier').forEach(parameter => declare(inner, parameter));
            block(node.body, inner);
            return;
        }
        case 'MemberExpression':
            if (reflectiveNames.has(node.identifier.name)) markReflection();
            if (node.identifier.name === 'debug' &&
                node.base.type === 'Identifier' && ['_G', '_ENV'].includes(node.base.name)) markReflection();
            visit(node.base, current);
            return;
        case 'IndexExpression': {
            const key = literalString(node.index);
            if (reflectiveNames.has(key) || (key === 'debug' && node.base.type === 'Identifier' &&
                ['_G', '_ENV'].includes(node.base.name))) markReflection();
            visit(node.base, current); visit(node.index, current);
            return;
        }
        case 'TableKeyString': visit(node.value, current); return;
        case 'DoStatement': block(node.body, scope(current)); return;
        case 'WhileStatement': visit(node.condition, current); block(node.body, scope(current)); return;
        case 'RepeatStatement': {
            const inner = scope(current);
            block(node.body, inner); visit(node.condition, inner);
            return;
        }
        case 'IfStatement':
            node.clauses.forEach(clause => { visit(clause.condition, current); block(clause.body, scope(current)); });
            return;
        case 'ForNumericStatement': {
            visit(node.start, current); visit(node.end, current); visit(node.step, current);
            const inner = scope(current);
            declare(inner, node.variable); block(node.body, inner);
            return;
        }
        case 'ForGenericStatement': {
            node.iterators.forEach(iterator => visit(iterator, current));
            const inner = scope(current);
            node.variables.forEach(variable => declare(inner, variable)); block(node.body, inner);
            return;
        }
        case 'LabelStatement': case 'GotoStatement': return;
        default:
            for (const [key, value] of Object.entries(node)) {
                if (['comments', 'globals', 'range', 'loc'].includes(key)) continue;
                if (Array.isArray(value)) value.forEach(child => { if (child?.type) visit(child, current); });
                else if (value?.type) visit(value, current);
            }
        }
    };
    visit(ast, scope());
    return {bindings, references, definitions, globalDefinitions, reflectsNames};
}

// Track known loaders and environment aliases without treating ordinary dynamic
// native lookups as access to lexical locals. Writes are joined conservatively
// across branches and closures; a possible loader cannot disappear by traversal
// order. Unknown source passed to a known loader needs names preserved.
function reflectionRisk(ast, resolved, depth = 0) {
    let reflected = resolved.reflectsNames, opaque = false, sourceLocation = false;
    const empty = (unknown = false) => ({roles: new Set(), strings: new Set(), tables: new Set(), unknown});
    const merge = values => {
        const result = empty();
        for (const value of values) {
            value.roles.forEach(role => result.roles.add(role));
            value.strings.forEach(string => result.strings.add(string));
            value.tables.forEach(table => result.tables.add(table));
            result.unknown ||= value.unknown;
        }
        return result;
    };
    const builtin = name => {
        const result = empty();
        if (['_G', '_ENV'].includes(name)) result.roles.add('environment');
        else if (name === 'package') result.roles.add('package');
        else if (name === 'debug') result.roles.add('debug');
        else if ([...loaderRoles, 'rawget', 'assert', 'pcall', 'xpcall'].includes(name)) result.roles.add(name);
        else result.unknown = true;
        return result;
    };
    const argumentsOf = node => node.type === 'StringCallExpression' ? [node.argument] :
        (Array.isArray(node.arguments) ? node.arguments : [node.arguments]);
    const sourcesValue = (key, sources, trail) => {
        if (trail.has(key)) return empty(true);
        const inner = new Set(trail); inner.add(key);
        return sources?.length ? merge(sources.map(source => valueOf(source, inner))) : empty(true);
    };
    const propertyValue = (base, key, trail) => {
        if (base.roles.has('debug')) reflected = true;
        if (key === 'debug' || reflectiveNames.has(key)) reflected = true;
        if (sourceLocationNames.has(key)) sourceLocation = true;
        const values = [];
        if (base.roles.has('environment') && key !== null) values.push(builtin(key));
        for (const table of base.tables) {
            const fields = table.fields.filter(field => (field.type === 'TableKeyString' ? field.key.name : literalString(field.key)) === key);
            values.push(...fields.map(field => valueOf(field.value, trail)));
        }
        const result = values.length ? merge(values) : empty(true);
        if (result.roles.has('debug')) reflected = true;
        if (result.roles.has('package')) opaque = true;
        return result;
    };
    const inspectLoader = (loader, args, trail) => {
        if (['loadfile', 'dofile', 'require'].some(role => loader.roles.has(role))) opaque = true;
        if (!loader.roles.has('load')) return;
        const source = valueOf(args[0], trail);
        if (source.unknown || !source.strings.size || source.roles.size || source.tables.size || depth >= 8) { opaque = true; return; }
        for (const code of source.strings) {
            if (code.startsWith('\x1b')) { opaque = true; continue; }
            let nested;
            try { nested = parseLua(code, 'Loaded Lua'); }
            catch { continue; } // Invalid text cannot execute; its bytes stay unchanged.
            const risk = reflectionRisk(nested, resolveBindings(nested), depth + 1);
            reflected ||= risk.reflected; opaque ||= risk.opaque; sourceLocation ||= risk.sourceLocation;
        }
    };
    const valueOf = (node, trail = new Set()) => {
        if (!node) return empty(true);
        switch (node.type) {
        case 'Identifier': {
            const binding = resolved.references.get(node);
            if (binding) return sourcesValue(binding, resolved.definitions.get(binding), trail);
            const known = builtin(node.name), sources = resolved.globalDefinitions.get(node.name);
            return sources ? merge([known, sourcesValue('global:' + node.name, sources, trail)]) : known;
        }
        case 'StringLiteral': {
            const result = empty(); result.strings.add(literalString(node)); return result;
        }
        case 'NilLiteral': case 'NumericLiteral': case 'BooleanLiteral': return empty();
        case 'TableConstructorExpression': { const result = empty(); result.tables.add(node); return result; }
        case 'LogicalExpression': return merge([valueOf(node.left, trail), valueOf(node.right, trail)]);
        case 'BinaryExpression': {
            if (node.operator !== '..') return empty(true);
            const left = valueOf(node.left, trail), right = valueOf(node.right, trail), result = empty();
            if (left.unknown || right.unknown || !left.strings.size || !right.strings.size || left.strings.size * right.strings.size > 16) return empty(true);
            for (const a of left.strings) for (const b of right.strings) result.strings.add(a + b);
            return result;
        }
        case 'MemberExpression': return propertyValue(valueOf(node.base, trail), node.identifier.name, trail);
        case 'IndexExpression': {
            const base = valueOf(node.base, trail), keys = valueOf(node.index, trail);
            if (base.roles.has('debug')) reflected = true;
            if (base.roles.has('debug') && (keys.unknown || !keys.strings.size)) sourceLocation = true;
            return keys.strings.size ? merge([...keys.strings].map(key => propertyValue(base, key, trail))) : empty(true);
        }
        case 'CallExpression': case 'StringCallExpression': case 'TableCallExpression': {
            const callee = valueOf(node.base, trail), args = argumentsOf(node);
            inspectLoader(callee, args, trail);
            // A loader passed to an unanalysed function can later execute code
            // supplied there. Do not infer that the eventual source is harmless.
            if (!['assert', 'pcall', 'xpcall'].some(role => callee.roles.has(role)) &&
                args.some(argument => loaderRoles.some(role => valueOf(argument, trail).roles.has(role)))) opaque = true;
            // An environment can expose debug/load through a returned proxy,
            // metatable, or callback. Only direct lookup/assert and a verified
            // literal load's explicit environment have a known local contract.
            if (!['rawget', 'assert', 'load'].some(role => callee.roles.has(role)) &&
                args.some(argument => valueOf(argument, trail).roles.has('environment'))) opaque = true;
            if (!['rawget', 'assert'].some(role => callee.roles.has(role)) &&
                args.some(argument => valueOf(argument, trail).roles.has('debug'))) sourceLocation = true;
            if (callee.roles.has('rawget')) {
                const base = valueOf(args[0], trail), keys = valueOf(args[1], trail);
                if (base.roles.has('debug') && (keys.unknown || !keys.strings.size)) sourceLocation = true;
                return keys.strings.size ? merge([...keys.strings].map(key => propertyValue(base, key, trail))) : empty(true);
            }
            if (callee.roles.has('assert')) return valueOf(args[0], trail);
            if (callee.roles.has('pcall') || callee.roles.has('xpcall')) {
                inspectLoader(valueOf(args[0], trail), args.slice(callee.roles.has('xpcall') ? 2 : 1), trail);
            }
            return empty(true);
        }
        default: return empty(true);
        }
    };
    eachNode(ast, node => {
        if (node.type === 'Identifier' && node.isLocal === false && node.name === 'package') opaque = true;
        if (node.type === 'Identifier' && node.isLocal === false && sourceLocationNames.has(node.name)) sourceLocation = true;
        if (['MemberExpression', 'IndexExpression', 'CallExpression', 'StringCallExpression', 'TableCallExpression'].includes(node.type)) valueOf(node);
        if (node.type === 'ReturnStatement' && node.arguments.some(argument =>
            loaderRoles.some(role => valueOf(argument).roles.has(role)) || valueOf(argument).roles.has('environment'))) opaque = true;
        if (node.type === 'ReturnStatement' && node.arguments.some(argument => valueOf(argument).roles.has('debug'))) sourceLocation = true;
        if (node.type === 'AssignmentStatement' && node.variables.some((variable, index) =>
            (variable.type !== 'Identifier' || !resolved.references.has(variable)) &&
                (loaderRoles.some(role => valueOf(node.init[index]).roles.has(role)) ||
                ['environment', 'package', 'debug'].some(role => valueOf(node.init[index]).roles.has(role))))) opaque = true;
        if (['TableValue', 'TableKey', 'TableKeyString'].includes(node.type) &&
            (loaderRoles.some(role => valueOf(node.value).roles.has(role)) || valueOf(node.value).roles.has('environment'))) opaque = true;
    });
    return {reflected, opaque, sourceLocation};
}

function shortName(index) {
    let name = firstAlphabet[index % firstAlphabet.length];
    index = Math.floor(index / firstAlphabet.length);
    while (index > 0) {
        index--;
        name += laterAlphabet[index % laterAlphabet.length];
        index = Math.floor(index / laterAlphabet.length);
    }
    return name;
}

function tokenize(code) {
    // The lexer does not apply the parser's shebang handling itself.
    const lexicalCode = code.startsWith('#!') ? code.replace(/^[^\r\n]*/, line => ' '.repeat(line.length)) : code;
    luaparse.parse(lexicalCode, {...parseOptions, wait: true});
    const tokens = [];
    for (;;) {
        const token = luaparse.lex();
        if (token.type === luaparse.tokenTypes.EOF) break;
        tokens.push({type: token.type, range: token.range, raw: code.slice(...token.range)});
    }
    return tokens;
}

function needsSpace(previous, next) {
    if (!previous) return false;
    const last = previous.raw.at(-1), first = next.raw[0];
    if (/[A-Za-z0-9_]/.test(last) && /[A-Za-z0-9_]/.test(first)) return true;
    if (previous.type === luaparse.tokenTypes.NumericLiteral && (first === '.' || /[A-Za-z0-9_]/.test(first))) return true;
    if (last === '.' && (first === '.' || /[0-9]/.test(first))) return true;
    if (last === '[' && (first === '[' || first === '=')) return true;
    if (mergedPunctuators.has(last + first)) return true;
    return false;
}

function shape(node, replacements) {
    if (Array.isArray(node)) return node.map(value => shape(value, replacements));
    if (!node || typeof node !== 'object') return node;
    const result = {};
    for (const [key, value] of Object.entries(node)) {
        if (['comments', 'globals', 'range', 'loc'].includes(key)) continue;
        if (key === 'isLocal' && node.type === 'Identifier') continue;
        result[key] = key === 'name' && node.type === 'Identifier' ?
            (replacements.get(node.range?.[0]) ?? value) : shape(value, replacements);
    }
    return result;
}

export function transformLua(code, {minify = true, renameLocals = true, keepLocals = []} = {}) {
    assert.equal(typeof minify, 'boolean', 'minify must be a boolean');
    assert.equal(typeof renameLocals, 'boolean', 'renameLocals must be a boolean');
    assert(Array.isArray(keepLocals) && keepLocals.every(name => typeof name === 'string' && /^[A-Za-z_]\w*$/.test(name)), 'keepLocals must contain Lua identifier names');
    const ast = parseLua(code), originalBindings = resolveBindings(ast);
    const {bindings} = originalBindings;
    const occupied = new Set(keywords), preserved = new Set(keepLocals);
    eachNode(ast, node => { if (node.type === 'Identifier') occupied.add(node.name); });
    // Preserved names may be absent from this chunk but must stay unavailable.
    for (const name of preserved) occupied.add(name);
    const replacements = new Map(), edits = [];
    const canRename = binding => !binding.implicit && !preserved.has(binding.name) &&
        !['_ENV', 'self', 'main', 'config'].includes(binding.name) && !/^(gg_|udg_)/.test(binding.name);
    const hasRenameCandidates = renameLocals && bindings.some(canRename);
    if (minify || hasRenameCandidates) {
        const risk = reflectionRisk(ast, originalBindings);
        if (minify && (risk.sourceLocation || risk.opaque)) {
            throw new Error('Lua minification cannot preserve source-location introspection or verify opaque loaded code; use minify: false and preserve local names when needed.');
        }
        if (hasRenameCandidates && (risk.reflected || risk.opaque)) {
            throw new Error('Local renaming cannot preserve introspection or verify opaque loaded code; use renameLocals: false or preserve every local with keepLocals.');
        }
    }
    let candidate = 0, renamedLocals = 0;
    if (renameLocals) for (const binding of bindings) {
        if (!canRename(binding)) continue;
        let replacement;
        do { replacement = shortName(candidate++); } while (occupied.has(replacement));
        occupied.add(replacement);
        for (const node of binding.nodes) {
            assert(node.range && code.slice(...node.range) === binding.name, 'Ambiguous local identifier range');
            assert(!replacements.has(node.range[0]), 'Local identifier resolved more than once');
            replacements.set(node.range[0], replacement);
            edits.push({start: node.range[0], end: node.range[1], replacement});
        }
        renamedLocals++;
    }
    let output;
    if (minify) {
        const tokens = tokenize(code);
        let previous;
        const parts = [];
        for (const token of tokens) {
            if (replacements.has(token.range[0])) token.raw = replacements.get(token.range[0]);
            if (needsSpace(previous, token)) parts.push(' ');
            parts.push(token.raw);
            previous = token;
        }
        output = parts.join('');
    } else {
        output = code;
        for (const edit of edits.sort((a, b) => b.start - a.start)) {
            output = output.slice(0, edit.start) + edit.replacement + output.slice(edit.end);
        }
    }
    const transformed = parseLua(output, 'Transformed Lua');
    assert.deepEqual(shape(transformed, new Map()), shape(ast, replacements), 'Lua structure changed outside local names');
    // Check lexical binding equivalence as well as syntax: a captured/global
    // reference must still point to the same declaration after name changes.
    const outputBindings = resolveBindings(transformed);
    assert.equal(outputBindings.bindings.length, originalBindings.bindings.length, 'Lua binding count changed');
    originalBindings.bindings.forEach((binding, index) => {
        assert.equal(outputBindings.bindings[index].nodes.length, binding.nodes.length, 'Lua local references changed');
    });
    const referenceSignature = (tree, resolved) => {
        const indices = new Map(resolved.bindings.map((binding, index) => [binding, index]));
        const result = [];
        eachNode(tree, node => {
            if (node.type === 'Identifier') result.push(indices.get(resolved.references.get(node)) ?? null);
        });
        return result;
    };
    assert.deepEqual(referenceSignature(transformed, outputBindings), referenceSignature(ast, originalBindings), 'Lua lexical references changed');
    return {code: output, stats: {
        inputBytes: Buffer.byteLength(code), outputBytes: Buffer.byteLength(output),
        localBindings: bindings.length, renamedLocals, renamedIdentifiers: edits.length,
        commentsRemoved: minify ? ast.comments.length : 0,
    }};
}
