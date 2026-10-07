import assert from 'node:assert/strict';
import luaparse from 'luaparse';
import { createSeededRandom, validateSeed } from './seed.mjs';
import { ENGINE_GLOBALS } from './engine-names.mjs';
import { firstCause, ignoredKeys, literalString, loaderRoles, riskCause } from './lua-syntax.mjs';
import { analyzeClosedTables, analyzeGlobalNames } from './lua-names.mjs';

// luaparse's scope option searches a list of every global name for each
// global reference, which is quadratic on large map scripts. Bindings and
// globals are resolved by resolveBindings instead.
const parseOptions = {luaVersion: '5.3', ranges: true, locations: true, comments: true};
const keywords = new Set('and break do else elseif end false for function goto if in local nil not or repeat return then true until while'.split(' '));
const reflectiveNames = new Set(['getlocal', 'setlocal', 'getupvalue', 'setupvalue', 'upvalueid', 'upvaluejoin', 'getinfo']);
const sourceLocationNames = new Set(['getinfo', 'traceback']);
const firstAlphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const laterAlphabet = firstAlphabet + '0123456789';
const mergedPunctuators = new Set(['--', '==', '~=', '<=', '>=', '<<', '>>', '//', '::']);
const preparedStages = new WeakMap();
const frozenTrees = new WeakSet();

export function parseLua(code, label = 'Lua') {
    assert.equal(typeof code, 'string', 'Lua source must be a string');
    try { return luaparse.parse(code, parseOptions); }
    catch (cause) { throw new Error(label + ': ' + cause.message, {cause}); }
}

function eachNode(node, visit) {
    if (!node || typeof node !== 'object') return;
    if (typeof node.type === 'string') visit(node);
    // for...in avoids allocating key/value arrays for every node of large scripts.
    for (const key in node) {
        if (ignoredKeys.has(key)) continue;
        const value = node[key];
        if (Array.isArray(value)) { for (const child of value) eachNode(child, visit); }
        else if (value && typeof value === 'object') eachNode(value, visit);
    }
}

function refusal(message, risk, kinds, label, recommendations) {
    const candidates = kinds.map(kind => risk.causes[kind]).filter(Boolean);
    const cause = candidates.reduce((first, current) => firstCause(first, current), null);
    const location = cause ? label + ':' + cause.line + ':' + cause.column : label;
    return new Error(message + ' Cause: ' + (cause?.reason ?? 'unverified reflection path') +
        ' at ' + location + '. Recommended options: ' + recommendations.join(' ') + '.');
}

function scope(parent = null) { return {parent, bindings: new Map()}; }
function lookup(current, name) {
    for (; current; current = current.parent) {
        if (current.bindings.has(name)) return current.bindings.get(name);
    }
    return null;
}

// Only the final call/vararg initializer may supply additional values. The
// alias analysis joins possible return values instead of assigning a precise
// result position, so each receiving binding or exported field keeps it.
function assignedValue(values, index) {
    return values[index] ??
        (['CallExpression', 'StringCallExpression', 'TableCallExpression', 'VarargLiteral'].includes(values.at(-1)?.type) ? values.at(-1) : undefined);
}

// luaparse's isLocal metadata places for variables in scope too early for
// control expressions. Resolve bindings ourselves using Lua's lexical rules.
function resolveBindings(ast, {trackResources = false, resourcesOnly = false} = {}) {
    const bindings = [], references = new Map(), definitions = new Map(), globalDefinitions = new Map();
    const scopes = [], globalNames = new Set(), globalReferences = new Set();
    const resources = [], implicitEnvironment = {}, globalScopes = new Map();
    const enterScope = (parent, functionNode = null) => {
        const current = scope(parent);
        if (!resourcesOnly) {
            scopes.push(current);
            // Chunk statements outside every function body run while loading.
            current.functionNode = functionNode ?? parent.functionNode;
            current.loadTime = parent ? !functionNode && parent.loadTime : true;
        }
        if (trackResources) {
            current.localCount = 0; current.hiddenLocals = 0;
            if (functionNode) {
                current.owner = {node: functionNode, parent: parent?.owner ?? null,
                    maxActiveLocals: 0, localCause: null, upvalues: new Set(), upvalueCause: null};
                resources.push(current.owner);
                // A loaded chunk always has its implicit environment upvalue.
                if (!parent) current.owner.upvalues.add(implicitEnvironment);
            } else current.owner = parent.owner;
            current.activeBase = functionNode ? 0 : parent.activeBase + parent.localCount + parent.hiddenLocals;
        }
        return current;
    };
    const countActive = (current, node) => {
        const count = current.activeBase + current.localCount + current.hiddenLocals;
        if (count > current.owner.maxActiveLocals) {
            current.owner.maxActiveLocals = count;
        }
        if (count > 200 && !current.owner.localCause) current.owner.localCause =
            riskCause(node?.loc ? node : current.owner.node, 'more than 200 active Lua locals');
    };
    const capture = (current, binding, node) => {
        const owner = binding === implicitEnvironment ? null : binding.scope.owner;
        // Intermediate closures forward upvalues even without directly using
        // them. Count binding identities rather than names shadowed elsewhere.
        for (let fn = current.owner; fn && fn !== owner; fn = fn.parent) {
            fn.upvalues.add(binding);
            if (fn.upvalues.size > 255 && !fn.upvalueCause) fn.upvalueCause = riskCause(node, 'more than 255 Lua upvalues');
        }
    };
    let reflectsNames = false, reflectionCause = null;
    const markReflection = (node, reason) => {
        reflectsNames = true;
        reflectionCause = firstCause(reflectionCause, riskCause(node, reason));
    };
    const declare = (current, node, implicit = false) => {
        const binding = resourcesOnly ? {scope: current} : {name: node.name, nodes: implicit ? [] : [node], implicit, scope: current,
            interferenceScopes: new Set([current]), index: bindings.length};
        if (!resourcesOnly) bindings.push(binding);
        current.bindings.set(node.name, binding);
        if (trackResources) { current.localCount++; countActive(current, node); }
        return binding;
    };
    const assign = (binding, value) => {
        if (!value || resourcesOnly) return;
        const sources = definitions.get(binding) ?? [];
        sources.push(value); definitions.set(binding, sources);
    };
    const reference = (current, node) => {
        const binding = lookup(current, node.name);
        if (binding) {
            if (trackResources) capture(current, binding, node);
            if (resourcesOnly) return;
            binding.nodes.push(node);
            references.set(node, binding);
            // Only scopes between a reference and its declaration can capture
            // it accidentally. Sibling scopes and unused outer bindings need
            // no interference edge or globally unique generated name.
            for (let visible = current; visible !== binding.scope; visible = visible.parent) binding.interferenceScopes.add(visible);
        } else {
            if (trackResources) capture(current, lookup(current, '_ENV') ?? implicitEnvironment, node);
            if (resourcesOnly) return;
            globalNames.add(node.name);
            globalReferences.add(node);
            globalScopes.set(node, current);
            if (node.name === 'debug' || reflectiveNames.has(node.name)) markReflection(node,
                node.name === 'debug' ? 'debug namespace can inspect local/upvalue names' : node.name + ' global can inspect local/upvalue names');
        }
    };
    const block = (body, current) => { for (const statement of body) visit(statement, current); };
    const visit = (node, current) => {
        if (!node) return;
        switch (node.type) {
        case 'Identifier': reference(current, node); return;
        case 'Chunk': block(node.body, current); return;
        case 'LocalStatement':
            node.init.forEach(value => visit(value, current));
            node.variables.forEach((variable, index) => assign(declare(current, variable), assignedValue(node.init, index)));
            return;
        case 'AssignmentStatement':
            node.variables.forEach(variable => visit(variable, current));
            node.init.forEach(value => visit(value, current));
            if (resourcesOnly) return;
            node.variables.forEach((variable, index) => {
                const value = assignedValue(node.init, index);
                if (variable.type !== 'Identifier' || !value) return;
                const binding = lookup(current, variable.name);
                if (binding) assign(binding, value);
                else {
                    const sources = globalDefinitions.get(variable.name) ?? [];
                    sources.push(value); globalDefinitions.set(variable.name, sources);
                }
            });
            return;
        case 'FunctionDeclaration': {
            if (node.isLocal) declare(current, node.identifier);
            else {
                visit(node.identifier, current);
                if (!resourcesOnly && node.identifier?.type === 'Identifier') {
                    const binding = lookup(current, node.identifier.name);
                    if (binding) assign(binding, node);
                    else {
                        const sources = globalDefinitions.get(node.identifier.name) ?? [];
                        sources.push(node); globalDefinitions.set(node.identifier.name, sources);
                    }
                }
            }
            const inner = enterScope(current, node);
            if (node.identifier?.type === 'MemberExpression' && node.identifier.indexer === ':') {
                declare(inner, {name: 'self'}, true);
            }
            node.parameters.filter(parameter => parameter.type === 'Identifier').forEach(parameter => declare(inner, parameter));
            block(node.body, inner);
            return;
        }
        case 'MemberExpression':
            if (resourcesOnly) { visit(node.base, current); return; }
            if (reflectiveNames.has(node.identifier.name)) markReflection(node, node.identifier.name + ' property can inspect local/upvalue names');
            if (node.identifier.name === 'debug' &&
                node.base.type === 'Identifier' && ['_G', '_ENV'].includes(node.base.name)) markReflection(node, 'debug namespace lookup');
            visit(node.base, current);
            return;
        case 'IndexExpression': {
            if (resourcesOnly) { visit(node.base, current); visit(node.index, current); return; }
            const key = literalString(node.index);
            if (reflectiveNames.has(key) || (key === 'debug' && node.base.type === 'Identifier' &&
                ['_G', '_ENV'].includes(node.base.name))) markReflection(node, key + ' property can inspect local/upvalue names');
            visit(node.base, current); visit(node.index, current);
            return;
        }
        case 'TableKeyString': visit(node.value, current); return;
        case 'DoStatement': block(node.body, enterScope(current)); return;
        case 'WhileStatement': visit(node.condition, current); block(node.body, enterScope(current)); return;
        case 'RepeatStatement': {
            const inner = enterScope(current);
            block(node.body, inner); visit(node.condition, inner);
            return;
        }
        case 'IfStatement':
            node.clauses.forEach(clause => { visit(clause.condition, current); block(clause.body, enterScope(current)); });
            return;
        case 'ForNumericStatement': {
            visit(node.start, current); visit(node.end, current); visit(node.step, current);
            const inner = enterScope(current);
            if (trackResources) inner.hiddenLocals = 3;
            declare(inner, node.variable); block(node.body, inner);
            return;
        }
        case 'ForGenericStatement': {
            node.iterators.forEach(iterator => visit(iterator, current));
            const inner = enterScope(current);
            if (trackResources) inner.hiddenLocals = 3;
            node.variables.forEach(variable => declare(inner, variable)); block(node.body, inner);
            return;
        }
        case 'LabelStatement': case 'GotoStatement': return;
        default:
            for (const key in node) {
                if (ignoredKeys.has(key)) continue;
                const value = node[key];
                if (Array.isArray(value)) { for (const child of value) if (child?.type) visit(child, current); }
                else if (value?.type) visit(value, current);
            }
        }
    };
    visit(ast, enterScope(null, ast));
    return {bindings, references, definitions, globalDefinitions, reflectsNames, reflectionCause, scopes, globalNames, globalReferences, globalScopes,
        ...(trackResources ? {resources} : {})};
}

export function assertLuaResourceLimits(ast, label = 'Lua') {
    assert(ast?.type === 'Chunk' && Array.isArray(ast.body), 'Lua resource limits require a parsed Chunk');
    // Resource checks need binding identities and closure ownership, but not
    // rename interference sets, reference lists or reflection alias analysis.
    const {resources} = resolveBindings(ast, {trackResources: true, resourcesOnly: true});
    const causes = resources.flatMap(fn => [fn.maxActiveLocals > 200 ? fn.localCause : null, fn.upvalueCause].filter(Boolean));
    if (causes.length) {
        const cause = causes.reduce((first, current) => firstCause(first, current), null);
        throw new Error('Lua resource limits exceeded: ' + cause.reason + ' at ' + label + ':' + cause.line + ':' + cause.column +
            '. Recommended options: --no-runtime-strings --no-vm.');
    }
}

// Track known loaders and environment aliases without treating ordinary dynamic
// native lookups as access to lexical locals. Writes are joined conservatively
// across branches and closures; a possible loader cannot disappear by traversal
// order. Unknown source passed to a known loader needs names preserved.
function reflectionRisk(ast, resolved, depth = 0) {
    let reflected = resolved.reflectsNames, opaque = false, sourceLocation = false, runtimeObserved = false;
    const causes = {reflected: resolved.reflectionCause, opaque: null, sourceLocation: null, runtimeObserved: null};
    const mark = (kind, node, reason) => {
        if (kind === 'reflected') reflected = true;
        else if (kind === 'opaque') opaque = true;
        else if (kind === 'runtimeObserved') runtimeObserved = true;
        else sourceLocation = true;
        causes[kind] = firstCause(causes[kind], riskCause(node, reason));
    };
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
    const overriddenGlobals = new Set(resolved.globalDefinitions.keys());
    const overriddenFields = new Map();
    let unknownEnvironmentWrite = false;
    const builtin = name => {
        const result = empty();
        if (['_G', '_ENV'].includes(name)) result.roles.add('environment');
        else if (name === 'package') result.roles.add('package');
        else if (name === 'debug') result.roles.add('debug');
        else if (name === 'string') result.roles.add('stringLibrary');
        else if (name === 'dump') result.roles.add('bytecodeObserver');
        else if (['collectgarbage', 'gcinfo'].includes(name)) result.roles.add('memoryObserver');
        else if ([...loaderRoles, 'rawget', 'assert', 'pcall', 'xpcall'].includes(name)) result.roles.add(name);
        else result.unknown = true;
        // Keep capabilities as possible risks, but a script-written name no
        // longer proves the built-in's forwarding or lookup contract.
        result.unknown ||= overriddenGlobals.has(name) || unknownEnvironmentWrite;
        return result;
    };
    const argumentsOf = node => node.type === 'StringCallExpression' ? [node.argument] :
        (Array.isArray(node.arguments) ? node.arguments : [node.arguments]);
    const sourcesValue = (key, sources, trail) => {
        if (trail.has(key)) return empty(true);
        const inner = new Set(trail); inner.add(key);
        return sources?.length ? merge(sources.map(source => valueOf(source, inner))) : empty(true);
    };
    const propertyValue = (base, key, trail, node) => {
        if (base.roles.has('debug')) mark('reflected', node, 'debug.' + key + ' can inspect local/upvalue names');
        if (key === 'debug' || reflectiveNames.has(key)) mark('reflected', node, key + ' property can inspect local/upvalue names');
        if (sourceLocationNames.has(key)) mark('sourceLocation', node, key + ' observes source text or line locations');
        if (base.roles.has('stringLibrary') && key === 'dump') mark('runtimeObserved', node, 'string.dump observes function bytecode');
        if (base.roles.has('environment') && ['dump', 'collectgarbage', 'gcinfo'].includes(key)) mark('runtimeObserved', node,
            key === 'dump' ? 'dump observes function bytecode' : key + ' observes or controls Lua memory');
        const values = [];
        let changedField = false;
        if (base.roles.has('environment') && key !== null) values.push(builtin(key));
        for (const table of base.tables) {
            const fields = table.fields.filter(field => (field.type === 'TableKeyString' ? field.key.name : literalString(field.key)) === key);
            values.push(...fields.map(field => valueOf(field.value, trail)));
            const changed = overriddenFields.get(table);
            changedField ||= changed?.has(key) || changed?.has(null) || false;
        }
        const result = values.length ? merge(values) : empty(true);
        result.unknown ||= changedField;
        if (result.roles.has('debug')) mark('reflected', node, 'debug namespace lookup');
        if (result.roles.has('package')) mark('opaque', node, 'package exposes external modules and environments');
        return result;
    };
    const inspectLoader = (loader, args, trail, node) => {
        const external = ['loadfile', 'dofile', 'require'].find(role => loader.roles.has(role));
        if (external) mark('opaque', node, external + ' loads external code');
        if (!loader.roles.has('load')) return;
        const source = valueOf(args[0], trail);
        if (source.unknown || !source.strings.size || source.roles.size || source.tables.size || depth >= 8) {
            mark('opaque', node, depth >= 8 ? 'load nesting exceeds the safe analysis depth' : 'load source cannot be resolved statically');
            return;
        }
        for (const code of source.strings) {
            if (code.startsWith('\x1b')) { mark('opaque', node, 'load accepts opaque bytecode'); continue; }
            let nested;
            try { nested = parseLua(code, 'Loaded Lua'); }
            catch { continue; } // Invalid text cannot execute; its bytes stay unchanged.
            const risk = reflectionRisk(nested, resolveBindings(nested), depth + 1);
            for (const kind of ['reflected', 'opaque', 'sourceLocation', 'runtimeObserved']) if (risk[kind]) {
                const nestedCause = risk.causes[kind];
                mark(kind, node, 'load contains ' + (nestedCause?.reason ?? 'unverified reflection') +
                    (nestedCause ? ' (loaded chunk ' + nestedCause.line + ':' + nestedCause.column + ')' : ''));
            }
        }
    };
    const rootValues = new Map();
    const valueOf = (node, trail = new Set()) => {
        if (!node) return empty(true);
        // A result reached through an alias cycle depends on the current trail.
        // Cache only complete root evaluations, never intermediate cycle cuts.
        const key = node.type === 'Identifier' ? resolved.references.get(node) ?? 'global:' + node.name : node;
        if (!trail.size && rootValues.has(key)) return rootValues.get(key);
        const value = evaluateValue(node, trail);
        if (!trail.size) rootValues.set(key, value);
        return value;
    };
    const evaluateValue = (node, trail) => {
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
        case 'MemberExpression': return propertyValue(valueOf(node.base, trail), node.identifier.name, trail, node);
        case 'IndexExpression': {
            const base = valueOf(node.base, trail), keys = valueOf(node.index, trail);
            if (base.roles.has('debug')) mark('reflected', node, 'dynamic debug lookup can inspect local/upvalue names');
            if (base.roles.has('debug') && (keys.unknown || !keys.strings.size)) mark('sourceLocation', node, 'dynamic debug lookup may observe source locations');
            if (base.roles.has('stringLibrary') && (keys.unknown || !keys.strings.size)) mark('runtimeObserved', node,
                'dynamic string library lookup may observe function bytecode');
            return keys.strings.size ? merge([...keys.strings].map(key => propertyValue(base, key, trail, node))) : empty(true);
        }
        case 'CallExpression': case 'StringCallExpression': case 'TableCallExpression': {
            const callee = valueOf(node.base, trail), args = argumentsOf(node);
            const fixedRole = !callee.unknown && !callee.strings.size && !callee.tables.size && callee.roles.size === 1 ?
                callee.roles.values().next().value : null;
            const argumentValues = new Map();
            const argumentValue = argument => {
                if (!argumentValues.has(argument)) argumentValues.set(argument, valueOf(argument, trail));
                return argumentValues.get(argument);
            };
            inspectLoader(callee, args, trail, node);
            // A loader passed to an unanalysed function can later execute code
            // supplied there. Do not infer that the eventual source is harmless.
            if (args.some((argument, index) => loaderRoles.some(role => argumentValue(argument).roles.has(role)) &&
                fixedRole !== 'assert' && !(index === 0 && ['pcall', 'xpcall'].includes(fixedRole)))) {
                mark('opaque', node, 'loader passed to an unanalysed function');
            }
            // An environment can expose debug/load through a returned proxy,
            // metatable, or callback. Only direct lookup/assert and a verified
            // literal load's explicit environment have a known local contract.
            if (!['rawget', 'assert', 'load'].includes(fixedRole) &&
                args.some(argument => argumentValue(argument).roles.has('environment'))) mark('opaque', node, 'environment passed to an unanalysed function');
            if (!['rawget', 'assert'].includes(fixedRole) &&
                args.some(argument => argumentValue(argument).roles.has('debug'))) mark('sourceLocation', node, 'debug namespace passed to an unanalysed function');
            if (!['rawget', 'assert'].includes(fixedRole) &&
                args.some(argument => argumentValue(argument).roles.has('stringLibrary'))) mark('runtimeObserved', node,
                'string library passed to an unanalysed function may expose function bytecode');
            if (callee.roles.has('rawget')) {
                const base = argumentValue(args[0]), keys = argumentValue(args[1]);
                if (base.roles.has('debug') && (keys.unknown || !keys.strings.size)) mark('sourceLocation', node, 'rawget uses a dynamic debug key');
                if (base.roles.has('stringLibrary') && (keys.unknown || !keys.strings.size)) mark('runtimeObserved', node,
                    'rawget uses a dynamic string key that may expose function bytecode');
                return keys.strings.size ? merge([...keys.strings].map(key => propertyValue(base, key, trail, node))) : empty(true);
            }
            // assert returns every argument. Joining them also preserves a
            // loader/environment carried in its second or later result, or
            // forwarded by another assert call, return or argument list.
            if (callee.roles.has('assert')) return merge(args.map(argumentValue));
            if (callee.roles.has('pcall') || callee.roles.has('xpcall')) {
                inspectLoader(argumentValue(args[0]), args.slice(callee.roles.has('xpcall') ? 2 : 1), trail, node);
            }
            return empty(true);
        }
        default: return empty(true);
        }
    };
    // Environment aliases and table fields can replace the same built-ins as
    // direct assignments, including `function holder.member()` declarations.
    // Discover writes before applying any built-in argument-safety exception.
    eachNode(ast, node => {
        const variables = node.type === 'AssignmentStatement' ? node.variables :
            node.type === 'FunctionDeclaration' && !node.isLocal ? [node.identifier] : [];
        for (const variable of variables) {
            if (!['MemberExpression', 'IndexExpression'].includes(variable?.type)) continue;
            const base = valueOf(variable.base);
            const keys = variable.type === 'MemberExpression' ? {strings: new Set([variable.identifier.name]), unknown: false} : valueOf(variable.index);
            if (base.roles.has('environment')) {
                keys.strings.forEach(key => overriddenGlobals.add(key));
                unknownEnvironmentWrite ||= keys.unknown || !keys.strings.size;
            }
            for (const table of base.tables) {
                const changed = overriddenFields.get(table) ?? new Set();
                keys.strings.forEach(key => changed.add(key));
                if (keys.unknown || !keys.strings.size) changed.add(null);
                overriddenFields.set(table, changed);
            }
        }
    });
    rootValues.clear();
    eachNode(ast, node => {
        if (node.type === 'Identifier' && resolved.globalReferences.has(node) && node.name === 'package') mark('opaque', node, 'package exposes external modules and environments');
        if (node.type === 'Identifier' && resolved.globalReferences.has(node) && sourceLocationNames.has(node.name)) mark('sourceLocation', node, node.name + ' observes source text or line locations');
        if (node.type === 'Identifier' && resolved.globalReferences.has(node) && ['dump', 'collectgarbage', 'gcinfo'].includes(node.name)) mark('runtimeObserved', node,
            node.name === 'dump' ? 'dump observes function bytecode' : node.name + ' observes or controls Lua memory');
        if (['MemberExpression', 'IndexExpression', 'CallExpression', 'StringCallExpression', 'TableCallExpression'].includes(node.type)) valueOf(node);
        if (node.type === 'ReturnStatement' && node.arguments.some(argument =>
            loaderRoles.some(role => valueOf(argument).roles.has(role)) || valueOf(argument).roles.has('environment'))) mark('opaque', node, 'loader or environment returned beyond its local alias');
        if (node.type === 'ReturnStatement' && node.arguments.some(argument => valueOf(argument).roles.has('debug'))) mark('sourceLocation', node, 'debug namespace returned to an unanalysed caller');
        if (node.type === 'ReturnStatement' && node.arguments.some(argument => valueOf(argument).roles.has('stringLibrary'))) mark('runtimeObserved', node,
            'string library returned to an unanalysed caller may expose function bytecode');
        if (node.type === 'AssignmentStatement' && node.variables.some((variable, index) =>
            (variable.type !== 'Identifier' || !resolved.references.has(variable)) &&
                (loaderRoles.some(role => valueOf(assignedValue(node.init, index)).roles.has(role)) ||
                ['environment', 'package', 'debug'].some(role => valueOf(assignedValue(node.init, index)).roles.has(role))))) mark('opaque', node, 'environment or loader exported to a global or field');
        if (['TableValue', 'TableKey', 'TableKeyString'].includes(node.type) &&
            (loaderRoles.some(role => valueOf(node.value).roles.has(role)) || valueOf(node.value).roles.has('environment'))) mark('opaque', node, 'loader or environment stored in a table or metatable');
        if (['TableValue', 'TableKey', 'TableKeyString'].includes(node.type) && valueOf(node.value).roles.has('stringLibrary')) mark('runtimeObserved', node,
            'string library stored in a table or metatable may expose function bytecode');
        if (node.type === 'AssignmentStatement' && node.variables.some((variable, index) =>
            (variable.type !== 'Identifier' || !resolved.references.has(variable)) && valueOf(assignedValue(node.init, index)).roles.has('stringLibrary'))) mark('runtimeObserved', node,
            'string library exported to a global or field may expose function bytecode');
    });
    return {reflected, opaque, sourceLocation, runtimeObserved, causes};
}

export function assertSourceRewriteSafe(ast, {prepared, label = 'Lua'} = {}) {
    assert(ast?.type === 'Chunk' && Array.isArray(ast.body), 'Lua source rewrite requires a parsed Chunk');
    const metadata = prepared === undefined ? null : stageMetadata(prepared);
    if (metadata) assert.equal(metadata.ast, ast, 'Prepared Lua AST does not match source rewrite input');
    const risk = metadata ? stageRisk(metadata) : reflectionRisk(ast, resolveBindings(ast));
    if (risk.sourceLocation || risk.opaque) {
        throw refusal('Lua source rewriting cannot preserve source-location introspection or verify opaque loaded code; preserve the original source.',
            risk, ['sourceLocation', 'opaque'], metadata?.label ?? label, ['--no-hide-strings']);
    }
}

export function assertRuntimeRewriteSafe(ast, {prepared, label = 'Lua'} = {}) {
    assert(ast?.type === 'Chunk' && Array.isArray(ast.body), 'Lua runtime rewrite requires a parsed Chunk');
    const metadata = prepared === undefined ? null : stageMetadata(prepared);
    if (metadata) assert.equal(metadata.ast, ast, 'Prepared Lua AST does not match runtime rewrite input');
    const risk = metadata ? stageRisk(metadata) : reflectionRisk(ast, resolveBindings(ast));
    if (risk.reflected || risk.sourceLocation || risk.opaque || risk.runtimeObserved) {
        throw refusal('Lua runtime rewriting cannot preserve local/function/source introspection, bytecode or memory observations, or verify opaque loaded code; preserve the original runtime.',
            risk, ['reflected', 'sourceLocation', 'opaque', 'runtimeObserved'], metadata?.label ?? label, ['--no-runtime-strings', '--no-vm']);
    }
}

function shuffledAlphabet(alphabet, random) {
    const result = [...alphabet];
    for (let index = result.length - 1; index > 0; index--) {
        // Rejection avoids bias without changing the deterministic sequence.
        const range = index + 1, limit = 0x100000000 - (0x100000000 % range);
        let value;
        do { value = random(); } while (value >= limit);
        const other = value % range;
        [result[index], result[other]] = [result[other], result[index]];
    }
    return result.join('');
}

function shortName(index, first = firstAlphabet, later = laterAlphabet) {
    let name = first[index % first.length];
    index = Math.floor(index / first.length);
    while (index > 0) {
        index--;
        name += later[index % later.length];
        index = Math.floor(index / later.length);
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

function assertSameAst(before, after, replacements) {
    const message = 'Lua structure changed outside local names';
    if (!before || typeof before !== 'object') { assert.equal(after, before, message); return; }
    assert(after && typeof after === 'object', message);
    if (Array.isArray(before)) {
        assert(Array.isArray(after) && after.length === before.length, message);
        for (let index = 0; index < before.length; index++) assertSameAst(before[index], after[index], replacements);
        return;
    }
    const ignored = key => ignoredKeys.has(key) ||
        (key === 'isLocal' && before.type === 'Identifier');
    let beforeCount = 0, afterCount = 0;
    for (const key of Object.keys(before)) {
        if (ignored(key)) continue;
        beforeCount++;
        assert(Object.hasOwn(after, key), message);
        if (key === 'name' && before.type === 'Identifier') assert.equal(after[key], replacements.get(before.range[0]) ?? before[key], message);
        else assertSameAst(before[key], after[key], replacements);
    }
    for (const key of Object.keys(after)) if (!ignored(key)) afterCount++;
    assert.equal(afterCount, beforeCount, message);
}

function transformPrepared(code, ast, originalBindings, {minify = true, renameLocals = true, keepLocals = [],
    nameMode = 'compact', seed = 'warcraft-lua-protector', renameGlobals = false, renameFields = false, keepGlobals = []} = {},
    {prepareOutput = false} = {}, metadata) {
    assert.equal(typeof minify, 'boolean', 'minify must be a boolean');
    assert.equal(typeof renameLocals, 'boolean', 'renameLocals must be a boolean');
    assert.equal(typeof renameGlobals, 'boolean', 'renameGlobals must be a boolean');
    assert.equal(typeof renameFields, 'boolean', 'renameFields must be a boolean');
    assert(Array.isArray(keepLocals) && keepLocals.every(name => typeof name === 'string' && /^[A-Za-z_]\w*$/.test(name)), 'keepLocals must contain Lua identifier names');
    assert(Array.isArray(keepGlobals) && keepGlobals.every(name => typeof name === 'string' && /^[A-Za-z_]\w*$/.test(name)), 'keepGlobals must contain Lua identifier names');
    assert.equal(typeof prepareOutput, 'boolean', 'prepareOutput must be a boolean');
    assert(['compact', 'seeded'].includes(nameMode), 'lua.nameMode must be compact or seeded');
    validateSeed(seed, 'lua.seed');
    const {bindings} = originalBindings;
    const occupied = new Set([...keywords, ...originalBindings.globalNames, '_ENV', 'self', 'main', 'config']);
    const preserved = new Set(keepLocals);
    // Preserved names may be absent from this chunk but must stay unavailable.
    for (const name of preserved) occupied.add(name);
    let globals = null, tables = [];
    if (renameGlobals || renameFields) {
        globals = analyzeGlobalNames(ast, originalBindings, {keepGlobals});
        if (globals.cause) {
            throw new Error('Global and field renaming cannot verify every dynamic global lookup; preserve global names. Cause: ' + globals.cause.reason +
                ' at ' + metadata.label + ':' + globals.cause.line + ':' + globals.cause.column + '. Recommended options: --no-rename-globals --no-rename-fields.');
        }
        if (renameFields) tables = analyzeClosedTables(originalBindings, globals);
    }
    if (renameGlobals) {
        // New global names must not meet engine globals, kept names or any
        // name a string can look up, even when this chunk never reads them.
        for (const name of [...ENGINE_GLOBALS, ...globals.excluded, ...keepGlobals]) occupied.add(name);
    }
    const replacements = new Map(), edits = [];
    const canRename = binding => renameLocals && !binding.implicit && !preserved.has(binding.name) &&
        !['_ENV', 'self', 'main', 'config'].includes(binding.name) && !/^(gg_|udg_)/.test(binding.name);
    for (const binding of bindings) if (!canRename(binding)) occupied.add(binding.name);
    // A global is visible from every scope between a reference and the chunk,
    // so a local declared on that path would capture it.
    const globalBindings = renameGlobals ? [...globals.candidates].map(([name, nodes], order) => {
        const interferenceScopes = new Set();
        for (const node of nodes) {
            for (let current = originalBindings.globalScopes.get(node); current && !interferenceScopes.has(current); current = current.parent) interferenceScopes.add(current);
        }
        return {name, nodes, interferenceScopes, index: bindings.length + order, global: true};
    }) : [];
    let candidate = 0, renamedLocals = 0, renamedGlobals = 0, renamedFields = 0;
    let first = firstAlphabet, later = laterAlphabet;
    if ((renameLocals || renameGlobals || renameFields) && nameMode === 'seeded') {
        const random = createSeededRandom(seed);
        first = shuffledAlphabet(firstAlphabet, random);
        later = shuffledAlphabet(laterAlphabet, random);
    }
    const candidateNames = [];
    const candidateAt = index => {
        while (candidateNames.length <= index) {
            const name = shortName(candidate++, first, later);
            if (!occupied.has(name)) candidateNames.push(name);
        }
        return candidateNames[index];
    };
    if (renameLocals || globalBindings.length) {
        // A scope is a compact shared conflict set, not a graph containing all
        // binding pairs. Prefix hints avoid rescanning densely occupied names.
        const scopeNames = new Map(originalBindings.scopes.map(current => [current, {used: new Set(), firstFree: 0}]));
        const locals = [...bindings.filter(canRename), ...globalBindings].sort((a, b) => b.nodes.length - a.nodes.length || a.index - b.index);
        for (const binding of locals) {
            const interference = [...binding.interferenceScopes].map(current => scopeNames.get(current));
            let index = 0;
            for (const state of interference) index = Math.max(index, state.firstFree);
            while (interference.some(state => state.used.has(index))) index++;
            const replacement = candidateAt(index);
            for (const state of interference) {
                state.used.add(index);
                while (state.used.has(state.firstFree)) state.firstFree++;
            }
            if (replacement === binding.name) continue;
            for (const node of binding.nodes) {
                assert(node.range && code.slice(...node.range) === binding.name, 'Ambiguous local identifier range');
                assert(!replacements.has(node.range[0]), 'Local identifier resolved more than once');
                replacements.set(node.range[0], replacement);
                edits.push({start: node.range[0], end: node.range[1], replacement});
            }
            if (binding.global) renamedGlobals++;
            else renamedLocals++;
        }
        const assigned = globalBindings.map(binding => replacements.get(binding.nodes[0].range[0]) ?? binding.name);
        assert.equal(new Set(assigned).size, assigned.length, 'Renamed globals must remain distinct');
        assert(globalBindings.every((binding, index) => assigned[index] === binding.name || !occupied.has(assigned[index])), 'Renamed global reached a reserved name');
    }
    for (const fields of tables) {
        // Fields of one closed table need distinct names; tables are independent.
        const entries = [...fields].sort((a, b) => b[1].length - a[1].length || a[1][0].range[0] - b[1][0].range[0]);
        let next = 0;
        for (const [name, nodes] of entries) {
            let replacement;
            do replacement = shortName(next++, first, later); while (keywords.has(replacement));
            if (replacement === name) continue;
            for (const node of nodes) {
                assert(node.range && code.slice(...node.range) === name, 'Ambiguous field identifier range');
                assert(!replacements.has(node.range[0]), 'Field identifier resolved more than once');
                replacements.set(node.range[0], replacement);
                edits.push({start: node.range[0], end: node.range[1], replacement});
            }
            renamedFields++;
        }
    }
    if (minify || edits.length) {
        const risk = stageRisk(metadata);
        if (minify && (risk.sourceLocation || risk.opaque)) {
            throw refusal('Lua minification cannot preserve source-location introspection or verify opaque loaded code; use minify: false and preserve local names when needed.',
                risk, ['sourceLocation', 'opaque'], metadata.label, ['--no-minify', ...(edits.length ? ['--no-rename'] : [])]);
        }
        if (edits.length && (risk.reflected || risk.sourceLocation || risk.opaque)) {
            throw refusal('Local renaming cannot preserve introspection or verify opaque loaded code; use renameLocals: false or preserve every local with keepLocals.',
                risk, ['reflected', 'sourceLocation', 'opaque'], metadata.label, ['--no-rename']);
        }
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
        const parts = [];
        let cursor = 0;
        for (const edit of edits.sort((a, b) => a.start - b.start)) {
            parts.push(code.slice(cursor, edit.start), edit.replacement);
            cursor = edit.end;
        }
        parts.push(code.slice(cursor));
        output = parts.join('');
    }
    const transformed = parseLua(output, 'Transformed Lua');
    assertSameAst(ast, transformed, replacements);
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
    const result = {code: output, stats: {
        inputBytes: Buffer.byteLength(code), outputBytes: Buffer.byteLength(output),
        localBindings: bindings.length, renamedLocals, renamedIdentifiers: edits.length,
        ...(renameGlobals ? {globalCandidates: globalBindings.length, renamedGlobals} : {}),
        ...(renameFields ? {closedTables: tables.length, renamedFields} : {}),
        commentsRemoved: minify ? ast.comments.length : 0,
    }};
    if (prepareOutput) Object.defineProperty(result, 'prepared', {
        value: createPreparedStage(output, transformed, outputBindings, metadata.label, metadata.risk), enumerable: false,
    });
    return result;
}

function freezeAst(ast) {
    if (frozenTrees.has(ast)) return ast;
    // A frozen object was already visited, including nodes shared by globals.
    const pending = [ast];
    while (pending.length) {
        const current = pending.pop();
        if (Object.isFrozen(current)) continue;
        for (const key in current) {
            const value = current[key];
            if (value !== null && typeof value === 'object') pending.push(value);
        }
        Object.freeze(current);
    }
    frozenTrees.add(ast);
    return ast;
}

function stageMetadata(stage) {
    const metadata = preparedStages.get(stage);
    assert(metadata, 'Expected a prepared Lua stage');
    return metadata;
}

function stageRisk(metadata) {
    if (metadata.risk) return metadata.risk;
    metadata.resolved ??= resolveBindings(metadata.ast);
    return metadata.risk ??= reflectionRisk(metadata.ast, metadata.resolved);
}

function createPreparedStage(code, ast, resolved, label, risk = null) {
    const metadata = {code, ast, resolved, label, risk};
    const stage = {};
    Object.defineProperties(stage, {
        ast: {enumerable: true, get: () => freezeAst(ast)},
        transform: {enumerable: true, value: (options, preparation) => {
            metadata.resolved ??= resolveBindings(ast);
            return transformPrepared(code, ast, metadata.resolved, options, preparation, metadata);
        }},
    });
    preparedStages.set(stage, metadata);
    return Object.freeze(stage);
}

// Prepared AST, binding resolution and reflection risk for a guarded stage.
export { analyzeGlobalNames };

export function getPreparedLuaAnalysis(prepared, code) {
    const metadata = stageMetadata(prepared);
    assert.equal(metadata.code, code, 'Prepared Lua source does not match');
    metadata.resolved ??= resolveBindings(metadata.ast);
    return {ast: prepared.ast, resolved: metadata.resolved, risk: stageRisk(metadata)};
}

export function resolveLuaBindings(ast) { return resolveBindings(ast); }

// Binding resolution cached on a prepared stage, shared with later guards of
// the same stage instead of resolving its AST again.
export function getPreparedLuaBindings(prepared, code) {
    const metadata = stageMetadata(prepared);
    assert.equal(metadata.code, code, 'Prepared Lua source does not match');
    return metadata.resolved ??= resolveBindings(metadata.ast);
}

// The index-th short identifier; callers skip names that are keywords or in use.
export function shortLuaName(index) { return shortName(index); }

export function isLuaKeyword(name) { return keywords.has(name); }

export function getPreparedLuaAst(prepared, code) {
    const metadata = stageMetadata(prepared);
    assert.equal(metadata.code, code, 'Prepared Lua source does not match');
    return prepared.ast;
}

export function prepareLua(code, label = 'Lua') {
    const ast = parseLua(code, label);
    // AST-only consumers should not allocate full rename/alias metadata. The
    // branded stage resolves lazily when transformation or a guard needs it.
    return createPreparedStage(code, ast, null, label);
}

export function transformLua(code, options) { return prepareLua(code).transform(options); }
