import test from 'node:test';
import assert from 'node:assert/strict';
import fengari from 'fengari';
import { buildRuntimeStringHelper, cryptRuntimeString, deriveRuntimeStringKey, runtimeStringNonce } from '../src/string-codec.mjs';

function decodeWithLua(source) {
    const { lua, lauxlib, to_luastring, to_jsstring } = fengari;
    const state = lauxlib.luaL_newstate();
    try {
        // No libraries or game APIs: exercise the actual decoder's complete
        // dependency contract, including all 256 byte values.
        const status = lauxlib.luaL_dostring(state, to_luastring(source));
        assert.equal(status, lua.LUA_OK, status === lua.LUA_OK ? undefined : to_jsstring(lua.lua_tostring(state, -1)));
        return Array.from({ length: lua.lua_gettop(state) }, (_, index) => Buffer.from(lua.lua_tolstring(state, index + 1)));
    } finally { lua.lua_close(state); }
}

test('native encryption and library-free Lua decode match RFC 8439 section 2.3.2', () => {
    const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
    const nonce = Buffer.from('000000090000004a00000000', 'hex');
    const stream = Buffer.from('10f1e7e4d13b5915500fdd1fa32071c4c7d1f4c733c068030422aa9ac3d46c4e' +
        'd2826446079faa0914c2d705d98b02a2b5129cd1de164eb9cbd083e8a2503c4e', 'hex');
    assert.deepEqual(cryptRuntimeString(Buffer.alloc(64), key, nonce), stream);
    assert.deepEqual(cryptRuntimeString(stream, key, nonce), Buffer.alloc(64));
    const source = buildRuntimeStringHelper('decode', [{ cipher: stream }], { key, noncePrefix: nonce.subarray(0, 8) });
    assert.deepEqual(decodeWithLua(source + 'return decode(1),decode(1)'), [Buffer.alloc(64), Buffer.alloc(64)]);
});

test('native encryption and Lua decode match the multi-block RFC 8439 section 2.4.2 vector', () => {
    const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
    const nonce = Buffer.from('000000000000004a00000000', 'hex');
    const plain = Buffer.from("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
    const cipher = Buffer.from('6e2e359a2568f98041ba0728dd0d6981e97e7aec1d4360c20a27afccfd9fae0b' +
        'f91b65c5524733ab8f593dabcd62b3571639d624e65152ab8f530c359f0861d8' +
        '07ca0dbf500d6a6156a38e088a22b65e52bc514d16ccf806818ce91ab7793736' +
        '5af90bbf74a35be6b40b8eedf2785e42874d', 'hex');
    assert.deepEqual(cryptRuntimeString(plain, key, nonce), cipher);
    const source = buildRuntimeStringHelper('decode', [{ cipher }], { key, noncePrefix: nonce.subarray(0, 8) });
    assert.deepEqual(decodeWithLua(source + 'return decode(1)'), [plain]);
});

test('packed payloads preserve every byte at word and block boundaries with high-bit keys and multiple nonces', () => {
    const key = Buffer.alloc(32, 255), noncePrefix = Buffer.alloc(8, 255);
    const values = [0, 1, 2, 3, 4, 5, 63, 64, 65, 127, 128, 129, 513].map(length =>
        Buffer.from(Array.from({ length }, (_, index) => index % 256)));
    const records = values.map((value, index) => ({ cipher: cryptRuntimeString(value, key, runtimeStringNonce(noncePrefix, index + 1)) }));
    const source = buildRuntimeStringHelper('decode', records, { key, noncePrefix });
    const returns = values.map((_, index) => 'decode(' + (index + 1) + ')').join(',');
    assert.deepEqual(decodeWithLua(source + 'return ' + returns), values);
    // A repeated nonempty record must still work after its packed table is
    // discarded. Pointer-sized values never depend on native integer width.
    assert.deepEqual(decodeWithLua(source + 'local first=decode(13);return first,decode(13)'), [values[12], values[12]]);
});

test('map-specific key material is deterministic, separated by seed and content, and nonces cannot wrap', () => {
    const original = deriveRuntimeStringKey('release seed', 'return "message one"');
    assert.deepEqual(deriveRuntimeStringKey('release seed', 'return "message one"'), original);
    assert.notDeepEqual(deriveRuntimeStringKey('different seed', 'return "message one"'), original);
    assert.notDeepEqual(deriveRuntimeStringKey('release seed', 'return "message two"'), original);
    assert.notDeepEqual(deriveRuntimeStringKey('release seed ', 'return "message one"'), original);
    assert.throws(() => deriveRuntimeStringKey('', ''), /seed/);
    assert.throws(() => deriveRuntimeStringKey('\ud800', ''), /seed/);
    assert.notDeepEqual(runtimeStringNonce(original.noncePrefix, 1), runtimeStringNonce(original.noncePrefix, 2));
    assert.equal(runtimeStringNonce(original.noncePrefix, 0x7fffffff).readUInt32LE(8), 0x7ffffffe);
    for (const id of [0, -1, 0x80000000, 1.5, NaN]) assert.throws(() => runtimeStringNonce(original.noncePrefix, id), /nonce range/);
    assert.throws(() => cryptRuntimeString(Buffer.alloc(65), original.key, runtimeStringNonce(original.noncePrefix, 1), 0xffffffff), /counter/);
});

test('first use releases packed cipher data and later calls reuse exactly the decoded cached string', () => {
    const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;
    const state = lauxlib.luaL_newstate();
    try {
        lualib.luaL_openlibs(state);
        const material = deriveRuntimeStringKey('cache check', 'source');
        const value = Buffer.from('cached actual bytes 한글');
        const cipher = cryptRuntimeString(value, material.key, runtimeStringNonce(material.noncePrefix, 1));
        const source = buildRuntimeStringHelper('decode', [{ cipher }], material) +
            // Local names vary with the key, so find the payload and cache tables by shape.
            'local p,c;for j=1,10 do local name,value=debug.getupvalue(decode,j);if type(value)=="table" then ' +
            'if type(value[1])=="table" then p=value elseif next(value)==nil then c=value end end end;' +
            'assert(p[1]~=nil and c[1]==nil);local first=decode(1);assert(p[1]==nil and c[1]==first);p[1]={0};' +
            'local second=decode(1);assert(second==first and p[1]~=nil);return first,second';
        const status = lauxlib.luaL_dostring(state, to_luastring(source));
        assert.equal(status, lua.LUA_OK, status === lua.LUA_OK ? undefined : to_jsstring(lua.lua_tostring(state, -1)));
        assert.deepEqual(Buffer.from(lua.lua_tolstring(state, 1)), value);
        assert.deepEqual(Buffer.from(lua.lua_tolstring(state, 2)), value);
    } finally { lua.lua_close(state); }
});

test('helper shape varies with the key without changing decoded bytes', () => {
    const value = Buffer.from('shape independent text 한글');
    const helpers = ['seed one', 'seed two'].map(seed => {
        const material = deriveRuntimeStringKey(seed, 'source');
        const cipher = cryptRuntimeString(value, material.key, runtimeStringNonce(material.noncePrefix, 1));
        return buildRuntimeStringHelper('decode', [{ cipher }], material);
    });
    assert.notEqual(helpers[0].replace(/\{\{.*?\}\}/, ''), helpers[1].replace(/\{\{.*?\}\}/, ''));
    for (const helper of helpers) {
        assert(!/0x61707865|0x3320646e|0x79622d32|0x6b206574/.test(helper), 'ChaCha constants are not written literally');
        assert.deepEqual(decodeWithLua(helper + 'return decode(1)')[0], value);
    }
    const material = deriveRuntimeStringKey('seed one', 'source');
    const cipher = cryptRuntimeString(value, material.key, runtimeStringNonce(material.noncePrefix, 1));
    assert.equal(buildRuntimeStringHelper('decode', [{ cipher }], material), helpers[0], 'The shape is reproducible');
});
