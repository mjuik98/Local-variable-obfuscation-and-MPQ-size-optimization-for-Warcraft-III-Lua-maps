import test from 'node:test';
import assert from 'node:assert/strict';
import fengari from 'fengari';
import { transformVm } from '../src/vm.mjs';
import { parseLua, prepareLua, transformLua } from '../src/lua.mjs';

function execute(code) {
    const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;
    const state = lauxlib.luaL_newstate();
    try {
        lualib.luaL_openlibs(state);
        const status = lauxlib.luaL_dostring(state, to_luastring(code));
        assert.equal(status, lua.LUA_OK, status === lua.LUA_OK ? undefined : to_jsstring(lua.lua_tostring(state, -1)));
        return Array.from({ length: lua.lua_gettop(state) }, (_, index) => {
            const at = index + 1, type = lua.lua_type(state, at);
            if (type === lua.LUA_TNIL) return { type, value: null };
            if (type === lua.LUA_TBOOLEAN) return { type, value: lua.lua_toboolean(state, at) };
            if (type === lua.LUA_TNUMBER) return { type, value: lua.lua_tonumber(state, at), integer: lua.lua_isinteger(state, at) };
            assert.equal(type, lua.LUA_TSTRING, 'Test result must be a scalar');
            return { type, value: Buffer.from(lua.lua_tolstring(state, at)) };
        });
    } finally { lua.lua_close(state); }
}

function equivalent(source, functions, seed) {
    const result = transformVm(source, { functions, seed });
    assert.deepEqual(execute(result.code), execute(source));
    assert.deepEqual(execute(transformLua(result.code, { nameMode: 'seeded', seed }).code), execute(source));
    return result;
}

test('selected local arithmetic and conditional functions execute through deterministic VM instructions', () => {
    const source = `local function Calculate(value, scale)
        local result = value * scale
        if result < 0 then return -result, nil, true
        elseif result == 0 then return 0, false, nil
        else return result + 3, true, 7.0 end
    end
    local function Unselected(value) return value + 2 end
    return Calculate(-4, 2)`;
    const first = equivalent(source, ['Calculate'], 'first'), second = equivalent(source, ['Calculate'], 'second');
    assert.deepEqual(first, transformVm(source, { functions: ['Calculate'], seed: 'first' }));
    assert.notEqual(first.code, second.code);
    assert.equal(first.stats.virtualizedFunctions, 1);
    assert.deepEqual(first.stats.selectedFunctions, ['Calculate']);
    assert(first.stats.instructions > 10);
    assert(first.code.includes('local function Unselected(value) return value + 2 end'));
    assert(!first.code.includes('value * scale'));
    const ast = parseLua(first.code);
    const globals = ast.globals.map(node => node.name);
    assert.deepEqual(globals, [], 'VM has no standard library, load, native or RNG dependencies');
});

test('lexical block shadowing, simultaneous assignment and extra RHS evaluation remain equivalent', () => {
    equivalent(`local function Swap(a,b)
        local original = a
        do local a = a + 4; b = b + a end
        a,b = b,a
        local x,y,z = b,a
        x,y,z = y,x
        return a,b,x,y,z,original
    end
    return Swap(3,8)`, ['Swap'], 'scope');
    equivalent(`local trace = ''
    local value=setmetatable({}, {__add=function(a,b) trace=trace..b; return b end})
    local function SideEffects(a)
        local x = a+1, a+2
        x = a+3, a+4
        return x
    end
    local result=SideEffects(value)
    return result, trace`, ['SideEffects'], 'effects');
});

test('logical jumps preserve operand values, nil, false and metamethod short circuiting', () => {
    equivalent(`local function Choose(a,b,c) return a and b or c, a or b, not a end
    local x,y,z=Choose(false,12,8)
    local p,q,r=Choose(0,false,7)
    return x,y,z,p,q,r`, ['Choose'], 'logic');
    equivalent(`local trace=''
    local a=setmetatable({}, {__add=function(x,y) trace=trace..y; return y end})
    local function Select(value, first)
        return first and (value+1) or (value+2)
    end
    local x=Select(a,true)
    local y=Select(a,false)
    return x,y,trace`, ['Select'], 'short');
});

test('operators preserve original Lua types, coercion, metamethod results and literal spelling', () => {
    equivalent(`local function Operators(a,b)
        return a//b, a%b, a^b, a/b, a<<b, a>>b, ~a, a~b
    end
    return Operators(19,2)`, ['Operators'], 'operators');
    equivalent(`local function Types(a) return 1.0, 1, 0x7fffffffffffffff, a+2 end
    return Types('8')`, ['Types'], 'types');
    equivalent(`local trace=''
    local a=setmetatable({}, {__add=function(x,y) trace=trace..'add'; return 9,nil end,
        __unm=function(x,y) trace=trace..'neg'; return x==y and 4 or 5 end,
        __lt=function(x,y) trace=trace..'less'; return true end})
    local function Meta(value) return value+2, -value, value<3 end
    local x,y,z=Meta(a)
    return x,y,z,trace`, ['Meta'], 'meta');
});

test('multiple selections, no-return and eight-value return preserve nil holes and arity', () => {
    equivalent(`local function None(a) local x=a end
    local function Eight(a) return a,nil,false,0,1,2,3,4 end
    local count=select('#',None(9))
    local x,y,z,p,q,r,s,t=Eight(7)
    return count,x,y,z,p,q,r,s,t`, ['None', 'Eight'], 'arity');
    equivalent(`do
        local function InsideBlock(a) if a then return nil,false else return end end
        Exported=InsideBlock
    end
    return select('#',Exported(true)),select('#',Exported(false))`, ['InsideBlock'], 'block');
});

test('unsupported selections explicitly refuse instead of silently protecting different code', () => {
    for (const [source, pattern] of [
        ['function Target(a) return a end', /only unprotected local/],
        ['local function Target(...) return ... end', /fixed identifier/],
        ['local function Target(a) return Native(a) end', /CallExpression/],
        ['local outer=2; local function Target(a) return a+outer end', /external/],
        ['local function Target(a) while a do a=a-1 end end', /WhileStatement/],
        ['local function Target(a) return a.field end', /MemberExpression/],
        ['local function Target(a) return "critical value" end', /StringLiteral/],
        ['local function Target(a) return a..2 end', /binary operator/],
        ['local function Target(a) _ENV=a end', /environment/],
        ['local function Target(a) return function() end end', /FunctionDeclaration/],
        ['local function Target(a) a,a=1,2; return a end', /repeated assignment targets/],
        ['local function Target(a,b) a,b,a=1,2,3; return a end', /repeated assignment targets/],
        ['local function main(a) return a end', /unprotected local/],
    ]) assert.throws(() => transformVm(source, { functions: [source.includes('local function main') ? 'main' : 'Target'] }), pattern);
    assert.throws(() => transformVm('local function Same() end; do local function Same() end end', { functions: ['Same'] }), /exactly one/);
    assert.throws(() => transformVm('local function Present() end', { functions: ['Absent'] }), /exactly one/);
});

test('reflection, opaque loading and source observers refuse VM rewriting', () => {
    for (const observer of ['debug.getupvalue(Target,1)', 'debug.traceback()', 'load(unknownCode)()', 'string.dump(Target)']) {
        const source='local function Target(a) return a+1 end; '+observer;
        assert.throws(() => transformVm(source, { functions: ['Target'] }), /Runtime|runtime|introspection|bytecode|source|opaque/);
        assert.equal(transformVm(source).code, source);
    }
});

test('VM helper avoids user names and accepts only matching prepared input', () => {
    const source='local a=1; local function Target(b) return b+2 end; return Target(3),a';
    const prepared=prepareLua(source);
    const result=transformVm(source, { functions: ['Target'] }, { prepared });
    assert(result.code.startsWith('local c='));
    assert.deepEqual(execute(result.code), execute(source));
    assert.throws(() => transformVm(source+' ', { functions: ['Target'] }, { prepared }), /source does not match/);
    assert.throws(() => transformVm(source, { functions: ['Target'] }, { prepared: { ast: prepared.ast } }), /prepared Lua stage/);
    assert.throws(() => transformVm(source, { functions: ['Target'], seed: '' }), /seed/);
});

test('validated VM output is reused through an immutable source-matching prepared stage', () => {
    const source='local function Target(a,b) if a then return b+2 else return b-1 end end; return Target(true,3)';
    const options={functions:['Target'],seed:'prepared-vm'}, input=prepareLua(source);
    const result=transformVm(source,options,{prepared:input,prepareOutput:true});
    assert.deepEqual(result,transformVm(source,options,{prepared:input}));
    assert(!Object.keys(result).includes('prepared'));
    assert(Object.isFrozen(result.prepared));
    assert(Object.isFrozen(result.prepared.ast.body));
    assert.deepEqual(result.prepared.ast,parseLua(result.code));
    assert.throws(()=>{result.prepared.ast.body[0].variables[0].name='forged';},TypeError);
    assert.throws(()=>transformVm(result.code+' ',{functions:['Target']},{prepared:result.prepared}),/source does not match/);
    assert.throws(()=>transformVm(source,options,{prepareOutput:'yes'}),/boolean/);
    const renamed=result.prepared.transform({nameMode:'seeded',seed:'prepared-vm'},{prepareOutput:true});
    assert.deepEqual(renamed,transformLua(result.code,{nameMode:'seeded',seed:'prepared-vm'}));
    assert.deepEqual(execute(renamed.code),execute(source));
});

test('pure nested functions receive the VM helper without capturing outside game state', () => {
    equivalent(`local function Initialize()
        local state={}
        local function ItemSortGrid_ClampReal(value,minValue,maxValue)
            if minValue>maxValue then return value end
            if value<minValue then return minValue end
            if value>maxValue then return maxValue end
            return value
        end
        state.clamp=ItemSortGrid_ClampReal
        return state
    end
    local state=Initialize()
    return state.clamp(-3.5,0.0,1.0),state.clamp(2.0,0.0,1.0),state.clamp(0.5,0.0,1.0),state.clamp(4.0,8.0,2.0)`, ['ItemSortGrid_ClampReal'], 'nested');
    assert.throws(()=>transformVm('local function Initialize() local outside=9;local function Target(a) return a+outside end end',{functions:['Target']}),/external/);
});

test('adding a VM helper respects Lua active-local limits', () => {
    const declarations=Array.from({length:199}, (_,index)=>'v'+index).join(',');
    const source='local '+declarations+'; local function Target(a) return a+1 end; return Target(3)';
    assert.throws(() => transformVm(source, { functions: ['Target'] }), /local.*200|200.*local/i);
    const separate=Array.from({length:250},()=> 'do local a=1 end').join('\n')+'\nlocal function Target(a) return a end; return Target(7)';
    equivalent(separate, ['Target'], 'limits');
});
