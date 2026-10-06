import assert from 'node:assert/strict';
import { assertLuaResourceLimits, assertRuntimeRewriteSafe, getPreparedLuaAst, isLuaKeyword, parseLua, prepareLua, shortLuaName } from './lua.mjs';
import { createSeededRandom, validateSeed } from './seed.mjs';

const binary = new Set(['+', '-', '*', '/', '//', '%', '^', '&', '|', '~', '<<', '>>', '==', '~=', '<', '<=', '>', '>=']);
const unary = new Set(['-', '~', 'not']);
const ignored = new Set(['range', 'loc', 'comments', 'globals']);

function walk(node, visit, functionDepth = 0) {
    if (!node || typeof node !== 'object') return;
    if (node.type) visit(node, functionDepth);
    const depth = functionDepth + Number(node.type === 'FunctionDeclaration');
    for (const key in node) {
        if (ignored.has(key)) continue;
        const value = node[key];
        if (Array.isArray(value)) { for (const child of value) walk(child, visit, depth); }
        else if (value?.type) walk(value, visit, depth);
    }
}

function unsupported(node, name, reason) {
    throw new Error('VM function ' + name + ' at ' + (node.loc?.start.line ?? 1) + ':' +
        ((node.loc?.start.column ?? 0) + 1) + ': ' + reason + '; remove this --vm-function selection or use --no-vm.');
}

// The supported language has no calls, globals, upvalues, closures, varargs or
// loops. Each source expression produces one value; multiple assignment takes
// snapshots before any store, and conditional jumps preserve short circuiting.
function compile(fn) {
    const name = fn.identifier.name, program = [], parameters = new Map();
    let nextRegister = 1;
    const allocate = () => nextRegister++;
    const emit = (...instruction) => { program.push(instruction); return program.length - 1; };
    const lookup = (node, environment) => {
        if (node.name === '_ENV' || !environment.has(node.name)) unsupported(node, name, 'external or environment reference ' + node.name);
        return environment.get(node.name);
    };
    fn.parameters.forEach(parameter => {
        if (parameter.type !== 'Identifier' || parameter.name === '_ENV') unsupported(parameter, name, 'only fixed identifier parameters are supported');
        parameters.set(parameter.name, allocate());
    });
    const expression = (node, environment) => {
        const target = allocate();
        switch (node.type) {
        case 'NumericLiteral': case 'BooleanLiteral': case 'NilLiteral':
            // Keep the spelling: JS numbers must not round Lua integers or
            // replace float literals with integer literals.
            emit('constant', target, node.raw); break;
        case 'Identifier': emit('move', target, lookup(node, environment)); break;
        case 'UnaryExpression': {
            if (!unary.has(node.operator)) unsupported(node, name, 'unsupported unary operator ' + node.operator);
            emit('unary:' + node.operator, target, expression(node.argument, environment)); break;
        }
        case 'BinaryExpression': {
            if (!binary.has(node.operator)) unsupported(node, name, 'unsupported binary operator ' + node.operator);
            const left = expression(node.left, environment), right = expression(node.right, environment);
            emit('binary:' + node.operator, target, left, right); break;
        }
        case 'LogicalExpression': {
            assert(['and', 'or'].includes(node.operator), 'Unknown logical operator');
            const left = expression(node.left, environment);
            emit('move', target, left);
            const jump = emit(node.operator === 'and' ? 'unless' : 'when', left, 0);
            emit('move', target, expression(node.right, environment));
            program[jump][2] = program.length + 1;
            break;
        }
        default: unsupported(node, name, 'unsupported expression ' + node.type);
        }
        return target;
    };
    const statements = (body, environment) => {
        for (const node of body) {
            switch (node.type) {
            case 'LocalStatement': {
                const values = node.init.map(value => expression(value, environment));
                node.variables.forEach((variable, index) => {
                    if (variable.name === '_ENV') unsupported(variable, name, 'local environment changes are unsupported');
                    const slot = allocate();
                    environment.set(variable.name, slot);
                    if (index < values.length) emit('move', slot, values[index]);
                    else emit('constant', slot, 'nil');
                });
                break;
            }
            case 'AssignmentStatement': {
                const slots = node.variables.map(variable => {
                    if (variable.type !== 'Identifier') unsupported(variable, name, 'only assignments to local variables are supported');
                    return lookup(variable, environment);
                });
                if (new Set(slots).size !== slots.length) unsupported(node, name, 'repeated assignment targets have implementation-dependent store order');
                const values = node.init.map(value => expression(value, environment));
                slots.forEach((slot, index) => {
                    if (index < values.length) emit('move', slot, values[index]);
                    else emit('constant', slot, 'nil');
                });
                break;
            }
            case 'ReturnStatement': {
                if (node.arguments.length > 8) unsupported(node, name, 'at most eight return values are supported');
                emit('return:' + node.arguments.length, ...node.arguments.map(value => expression(value, environment)));
                break;
            }
            case 'DoStatement': statements(node.body, new Map(environment)); break;
            case 'IfStatement': {
                const exits = [];
                for (const clause of node.clauses) {
                    const skip = clause.condition ? emit('unless', expression(clause.condition, environment), 0) : null;
                    statements(clause.body, new Map(environment));
                    exits.push(emit('jump', 0));
                    if (skip !== null) program[skip][2] = program.length + 1;
                }
                exits.forEach(index => { program[index][1] = program.length + 1; });
                break;
            }
            default: unsupported(node, name, 'unsupported statement ' + node.type);
            }
        }
    };
    statements(fn.body, parameters);
    emit('return:0');
    assert(program.length <= 10000 && nextRegister <= 4096, 'VM selection exceeds program limits: ' + name);
    for (const instruction of program) {
        const target = instruction[0] === 'jump' ? instruction[1] : ['unless', 'when'].includes(instruction[0]) ? instruction[2] : null;
        if (target !== null) assert(Number.isInteger(target) && target >= 1 && target <= program.length, 'Invalid VM jump');
    }
    return program;
}

function interpreter(helper, programs, seed) {
    const random = createSeededRandom(seed), operations = [...new Set(programs.flatMap(program => program.map(row => row[0])))].sort();
    const ids = new Map(), used = new Set();
    for (const operation of operations) {
        let id;
        do { id = 1 + random() % 0x3fffffff; } while (used.has(id));
        used.add(id); ids.set(operation, id);
    }
    // Vary dispatch order as well as opcode numbers, without runtime randomness.
    for (let index = operations.length - 1; index > 0; index--) {
        const other = random() % (index + 1);
        [operations[index], operations[other]] = [operations[other], operations[index]];
    }
    const payloads = programs.map(program => '{' + program.map(row => '{' + [ids.get(row[0]), ...row.slice(1)].join(',') + '}').join(',') + '}').join(',');
    const dispatch = operations.map((operation, index) => {
        let statement;
        if (operation === 'constant') statement = 'r[i[2]]=i[3]';
        else if (operation === 'move') statement = 'r[i[2]]=r[i[3]]';
        else if (operation === 'jump') statement = 'pc=i[2]';
        else if (operation === 'unless') statement = 'if not r[i[2]] then pc=i[3] end';
        else if (operation === 'when') statement = 'if r[i[2]] then pc=i[3] end';
        else if (operation.startsWith('unary:')) statement = 'r[i[2]]=' + operation.slice(6) + ' r[i[3]]';
        else if (operation.startsWith('binary:')) statement = 'r[i[2]]=r[i[3]]' + operation.slice(7) + 'r[i[4]]';
        else {
            assert(operation.startsWith('return:'), 'Unknown VM operation');
            const count = Number(operation.slice(7));
            statement = 'return ' + Array.from({ length: count }, (_, item) => 'r[i[' + (item + 2) + ']]').join(',');
        }
        return (index ? 'elseif' : 'if') + ' o==' + ids.get(operation) + ' then ' + statement;
    }).join('\n');
    return 'local ' + helper + '=(function()\nlocal p={' + payloads + '}\nreturn function(id,r)\nlocal pc=1\nwhile true do\nlocal i=p[id][pc]\nlocal o=i[1]\npc=pc+1\n' + dispatch + '\nend\nend\nend\nend)()\n';
}

function sameAst(before, after, selected, wrappers) {
    if (!before || typeof before !== 'object') { assert.equal(after, before, 'VM changed unselected syntax'); return; }
    if (selected.has(before)) { sameAst(wrappers.get(before), after, new Set(), new Map()); return; }
    assert(after && typeof after === 'object', 'VM changed unselected syntax');
    if (Array.isArray(before)) {
        assert(Array.isArray(after) && after.length === before.length, 'VM changed unselected statements');
        before.forEach((node, index) => sameAst(node, after[index], selected, wrappers)); return;
    }
    const skip = key => ignored.has(key) || (before.type === 'Identifier' && key === 'isLocal');
    let beforeCount = 0, afterCount = 0;
    for (const key of Object.keys(before)) {
        if (skip(key)) continue;
        beforeCount++;
        assert(Object.hasOwn(after,key),'VM changed unselected syntax');
        sameAst(before[key],after[key],selected,wrappers);
    }
    for (const key of Object.keys(after)) if (!skip(key)) afterCount++;
    assert.equal(afterCount,beforeCount,'VM changed unselected syntax');
}

export function transformVm(code, { functions = [], seed = 'warcraft-lua-protector' } = {}, { prepared, prepareOutput = false } = {}) {
    assert(Array.isArray(functions) && functions.every(name => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)), 'VM functions must contain Lua identifiers');
    validateSeed(seed);
    assert.equal(typeof prepareOutput, 'boolean', 'prepareOutput must be a boolean');
    const names = [...new Set(functions)];
    const stats = { inputBytes: Buffer.byteLength(code), outputBytes: Buffer.byteLength(code), virtualizedFunctions: 0, selectedFunctions: [], instructions: 0 };
    if (!names.length) return { code, stats };
    const ast = prepared === undefined ? parseLua(code, 'VM input Lua') : getPreparedLuaAst(prepared, code);
    assertRuntimeRewriteSafe(ast, { prepared, label: 'VM input Lua' });
    const candidates = new Map(), identifiers = new Set();
    walk(ast, (node, depth) => {
        if (node.type === 'Identifier') identifiers.add(node.name);
        if (node.type === 'FunctionDeclaration' && node.identifier?.type === 'Identifier' && names.includes(node.identifier.name)) {
            const matches = candidates.get(node.identifier.name) ?? [];
            matches.push({ node, depth }); candidates.set(node.identifier.name, matches);
        }
    });
    // The shortest unused name cannot be shadowed and has no tool signature.
    let counter = 0, helper;
    do { helper = shortLuaName(counter++); } while (identifiers.has(helper) || isLuaKeyword(helper));
    const selected = new Set(), wrappers = new Map(), edits = [], programs = [];
    for (const name of names) {
        const matches = candidates.get(name) ?? [];
        assert(matches.length === 1, 'VM function must identify exactly one declaration: ' + name + '; use --no-vm to disable.');
        const { node } = matches[0];
        if (!node.isLocal || ['main', 'config'].includes(name) || /^(gg_|udg_)/.test(name)) unsupported(node, name, 'only unprotected local functions are supported');
        programs.push(compile(node)); selected.add(node);
        const parameters = node.parameters.map(parameter => parameter.name);
        const replacement = 'local function ' + name + '(' + parameters.join(',') + ')\nreturn ' + helper + '(' + programs.length + ',{' + parameters.map((parameter, index) => '[' + (index + 1) + ']=' + parameter).join(',') + '})\nend';
        wrappers.set(node, parseLua(replacement).body[0]);
        edits.push({ start: node.range[0], end: node.range[1], replacement });
    }
    const prelude = interpreter(helper, programs, seed), pieces = [];
    // Keep a leading shebang in its original position. No engine or standard
    // library calls occur in the helper or its initialization.
    let cursor = code.startsWith('#!') ? (code.search(/[\r\n]/) < 0 ? code.length : code.search(/[\r\n]/)) : 0;
    pieces.push(code.slice(0, cursor), cursor ? '\n' : '', prelude);
    for (const edit of edits.sort((a, b) => a.start - b.start)) {
        assert(edit.start >= cursor, 'Overlapping VM selections');
        pieces.push(code.slice(cursor, edit.start), edit.replacement); cursor = edit.end;
    }
    pieces.push(code.slice(cursor));
    const output = pieces.join(''), outputStage = prepareOutput ? prepareLua(output, 'VM output Lua') : null;
    const result = outputStage ? outputStage.ast : parseLua(output, 'VM output Lua');
    assertLuaResourceLimits(result, 'VM output Lua');
    sameAst(parseLua(prelude).body[0], result.body[0], new Set(), new Map());
    sameAst(ast.body, result.body.slice(1), selected, wrappers);
    const transformed = { code: output, stats: { ...stats, outputBytes: Buffer.byteLength(output), virtualizedFunctions: selected.size, selectedFunctions: names, instructions: programs.reduce((total, program) => total + program.length, 0) } };
    if (prepareOutput) Object.defineProperty(transformed, 'prepared', {value: outputStage, enumerable: false});
    return transformed;
}
