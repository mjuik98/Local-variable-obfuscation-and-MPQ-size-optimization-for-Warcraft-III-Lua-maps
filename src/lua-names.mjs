import { ENGINE_GLOBALS } from './engine-names.mjs';
import { firstCause, ignoredKeys, literalString, loaderRoles, riskCause } from './lua-syntax.mjs';

const loaderGlobals = new Set([...loaderRoles, 'debug', 'package']);
// Engine natives that resolve a Lua global from a string name.
const nameLookupNatives = new Map([['ExecuteFunc', 0], ['TriggerRegisterVariableEvent', 1]]);
const fixedGlobals = new Set(['main', 'config', '_G', '_ENV', 'self']);

function syntaxIndex(ast) {
    const parents = new Map(), strings = [];
    const walk = (node, parent) => {
        if (Array.isArray(node)) { for (const child of node) if (child && typeof child === 'object') walk(child, parent); return; }
        if (typeof node.type === 'string') {
            parents.set(node, parent);
            if (node.type === 'StringLiteral') strings.push(node);
            parent = node;
        }
        for (const key in node) {
            const value = node[key];
            if (value && typeof value === 'object' && !ignoredKeys.has(key)) walk(value, parent);
        }
    };
    walk(ast, null);
    return {parents, strings};
}

function identifierString(node) {
    const raw = node.raw;
    const value = (raw[0] === '"' || raw[0] === '\'') && !raw.includes('\\') ? raw.slice(1, -1) : literalString(node);
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? value : null;
}

function argumentList(call) {
    if (call?.type === 'CallExpression') return call.arguments;
    if (call?.type === 'StringCallExpression') return [call.argument];
    if (call?.type === 'TableCallExpression') return [call.arguments];
    return null;
}

const multipleValues = node => ['CallExpression', 'StringCallExpression', 'TableCallExpression', 'VarargLiteral'].includes(node?.type);

// Assignment targets and global function names, with their value position.
function assignmentTarget(node, parents) {
    const parent = parents.get(node);
    if (parent?.type === 'AssignmentStatement') {
        const index = parent.variables.indexOf(node);
        if (index >= 0) return {statement: parent, index};
    }
    if (parent?.type === 'FunctionDeclaration' && parent.identifier === node) return {statement: parent, index: -1};
    return null;
}

// The read `Name` in `Name = Name or {...}`, assigning the same global.
function selfDefault(node, parents, resolved) {
    const logical = parents.get(node), statement = parents.get(logical);
    if (logical?.type !== 'LogicalExpression' || logical.operator !== 'or' || logical.left !== node ||
        logical.right.type !== 'TableConstructorExpression' || statement?.type !== 'AssignmentStatement') return false;
    const target = statement.variables[statement.init.indexOf(logical)];
    return target?.type === 'Identifier' && target.name === node.name && !resolved.references.has(target);
}

// Find script-defined globals whose every name lookup is static. Engine
// declarations, names in exact identifier strings (ExecuteFunc, _G["x"],
// variable events), resolved dynamic _G keys and globals possibly read
// before their first load-time definition (hooks) stay unchanged. Unknown
// environment, loader or name-lookup access refuses the whole analysis.
export function analyzeGlobalNames(ast, resolved, {keepGlobals = []} = {}) {
    const {parents, strings} = syntaxIndex(ast);
    let cause = null;
    const refuse = (node, reason) => { cause = firstCause(cause, riskCause(node, reason)); };
    const excluded = new Set(keepGlobals), environmentWrites = new Set(), environmentKeys = new Set(), references = new Map();
    for (const node of strings) {
        const value = identifierString(node);
        if (value !== null) excluded.add(value);
    }
    for (const node of resolved.globalReferences) {
        const nodes = references.get(node.name);
        if (nodes) nodes.push(node);
        else references.set(node.name, [node]);
    }
    const declarations = new Map();
    for (const binding of resolved.bindings) if (!binding.implicit) declarations.set(binding.nodes[0], binding);
    // A parameter of a local function that is only ever called directly
    // receives exactly the argument expressions at those call sites.
    const parameterArguments = binding => {
        const declaration = binding.nodes[0], fn = parents.get(declaration);
        if (fn?.type !== 'FunctionDeclaration' || !fn.isLocal || fn.identifier?.type !== 'Identifier') return null;
        const position = fn.parameters.indexOf(declaration), callee = declarations.get(fn.identifier);
        if (position < 0 || resolved.definitions.has(binding) || !callee) return null;
        const values = [];
        for (const node of callee.nodes.slice(1)) {
            const call = parents.get(node), args = call?.base === node ? argumentList(call) : null;
            if (!args || position >= args.length) return null;
            values.push(args[position]);
        }
        return values;
    };
    const stringValues = (node, trail = new Set()) => {
        if (node?.type === 'StringLiteral') return new Set([literalString(node)]);
        if (node?.type === 'BinaryExpression' && node.operator === '..') {
            const left = stringValues(node.left, trail), right = stringValues(node.right, trail);
            if (!left || !right || left.size * right.size > 256) return null;
            const result = new Set();
            for (const a of left) for (const b of right) result.add(a + b);
            return result;
        }
        if (node?.type !== 'Identifier') return null;
        const binding = resolved.references.get(node);
        if (!binding || binding.implicit || trail.has(binding)) return null;
        const sources = parameterArguments(binding) ?? resolved.definitions.get(binding);
        if (!sources?.length) return null;
        const inner = new Set(trail).add(binding), result = new Set();
        for (const source of sources) {
            const values = stringValues(source, inner);
            if (!values) return null;
            values.forEach(value => result.add(value));
        }
        return result.size <= 256 ? result : null;
    };
    for (const node of references.get('_ENV') ?? []) refuse(node, '_ENV can expose every global name');
    for (const binding of resolved.bindings) if (binding.name === '_ENV') refuse(binding.nodes[0], 'a local _ENV changes global lookup');
    for (const node of references.get('_G') ?? []) {
        const parent = parents.get(node);
        let keys = null;
        if (parent?.type === 'MemberExpression' && parent.base === node) keys = new Set([parent.identifier.name]);
        else if (parent?.type === 'IndexExpression' && parent.base === node) keys = stringValues(parent.index);
        if (!keys) { refuse(node, parent?.type === 'IndexExpression' ? 'a dynamic _G key cannot be resolved' : '_G is used as a value'); continue; }
        for (const key of keys) {
            excluded.add(key);
            if (loaderGlobals.has(key) || nameLookupNatives.has(key)) refuse(node, '_G.' + key + ' can reach globals by name');
        }
        keys.forEach(key => environmentKeys.add(key));
        if (assignmentTarget(parent, parents)) keys.forEach(key => environmentWrites.add(key));
    }
    for (const name of loaderGlobals) for (const node of references.get(name) ?? []) refuse(node, name + ' can load code or inspect names');
    for (const [name, position] of nameLookupNatives) for (const node of references.get(name) ?? []) {
        const call = parents.get(node), args = call?.base === node ? argumentList(call) : null;
        const keys = args && position < args.length ? stringValues(args[position]) : null;
        if (!keys) { refuse(node, name + ' needs a statically known global name'); continue; }
        keys.forEach(key => excluded.add(key));
    }
    const candidates = new Map(), definitions = new Map();
    for (const [name, nodes] of references) {
        const targets = nodes.filter(node => assignmentTarget(node, parents));
        if (targets.length) definitions.set(name, targets);
        if (!targets.length || excluded.has(name) || fixedGlobals.has(name) || ENGINE_GLOBALS.has(name) || /^(gg_|udg_)/.test(name)) continue;
        // A load-time read that precedes every completed load-time definition
        // observes an engine value or nil, as hook installation does. The
        // module default `Name = Name or {...}` of a non-engine name reads nil
        // or its own earlier table either way.
        let defined = Infinity;
        for (const node of targets) {
            if (resolved.globalScopes.get(node).loadTime) defined = Math.min(defined, assignmentTarget(node, parents).statement.range[1]);
        }
        if (nodes.some(node => resolved.globalScopes.get(node).loadTime && !assignmentTarget(node, parents) && node.range[0] < defined &&
            !selfDefault(node, parents, resolved))) continue;
        candidates.set(name, nodes);
    }
    return {cause, candidates, definitions, excluded, environmentWrites, environmentKeys, references, parents,
        isAssignmentTarget: node => Boolean(assignmentTarget(node, parents))};
}

// A closed table is only ever built from string-keyed constructors and read
// through static fields. It is never passed, stored, returned, iterated,
// indexed dynamically or given a metatable, so its field names are private.
// Colon calls pass the table as self, so they are allowed only for fields
// defined solely as colon methods whose self is equally closed.
export function analyzeClosedTables(resolved, globals) {
    const {parents} = globals, tables = [], selfNodes = new Map();
    for (const binding of resolved.bindings) if (binding.implicit && binding.name === 'self') selfNodes.set(binding.scope.functionNode, binding.nodes);
    const variables = [...globals.candidates.values()].map(nodes => ({nodes, declaration: null}));
    for (const binding of resolved.bindings) if (!binding.implicit) variables.push({nodes: binding.nodes, declaration: binding.nodes[0]});
    for (const variable of variables) {
        const fields = new Map();
        let methodCount = 0;
        const field = name => {
            let entry = fields.get(name);
            if (!entry) fields.set(name, entry = {nodes: [], methods: [], plain: false, colonCalls: false});
            return entry;
        };
        // `Name = Name or {...}` keeps the same closed table or builds one.
        const defaults = new Set(variable.declaration ? [] : variable.nodes.filter(node => selfDefault(node, parents, resolved)));
        const constructor = value => {
            if (value?.type === 'LogicalExpression' && defaults.has(value.left)) value = value.right;
            if (value?.type !== 'TableConstructorExpression' || !value.fields.every(item => item.type === 'TableKeyString')) return false;
            for (const item of value.fields) { const entry = field(item.key.name); entry.nodes.push(item.key); entry.plain = true; }
            return true;
        };
        const member = node => {
            const parent = parents.get(node);
            if (parent?.type !== 'MemberExpression' || parent.base !== node) return false;
            const entry = field(parent.identifier.name), owner = parents.get(parent);
            entry.nodes.push(parent.identifier);
            if (parent.indexer !== ':') entry.plain = true;
            else if (owner?.type === 'FunctionDeclaration' && owner.identifier === parent) { entry.methods.push(owner); methodCount++; }
            else entry.colonCalls = true;
            return true;
        };
        let closed = true;
        for (const node of variable.nodes) {
            if (defaults.has(node)) continue;
            if (node === variable.declaration) {
                const statement = parents.get(node), index = statement?.type === 'LocalStatement' ? statement.variables.indexOf(node) : -1;
                closed = index >= 0 && (index < statement.init.length ? constructor(statement.init[index]) : !multipleValues(statement.init.at(-1)));
            } else {
                const target = assignmentTarget(node, parents);
                closed = target ? target.index >= 0 && target.index < target.statement.init.length && constructor(target.statement.init[target.index]) : member(node);
            }
            if (!closed) break;
        }
        const visited = new Set();
        let queuedMethods = methodCount;
        for (let pending = closed ? [...fields.values()].flatMap(entry => entry.methods) : []; closed && pending.length;) {
            const method = pending.pop();
            if (visited.has(method)) continue;
            visited.add(method);
            for (const node of selfNodes.get(method) ?? []) if (!(closed = member(node))) break;
            // Ordinary methods are all known before checking self. Rebuild
            // only if a nested `function self:method()` discovered another,
            // retaining field order without scanning every field per method.
            if (methodCount !== queuedMethods) {
                pending = [...fields.values()].flatMap(entry => entry.methods).filter(item => !visited.has(item));
                queuedMethods = methodCount;
            }
        }
        if (closed && [...fields.values()].every(entry => entry.methods.length ? !entry.plain : !entry.colonCalls) && fields.size) {
            tables.push(new Map([...fields].map(([name, entry]) => [name, entry.nodes])));
        }
    }
    return tables;
}
