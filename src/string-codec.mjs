import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import { validateSeed } from './seed.mjs';

// RFC 8439 ChaCha20. Key material is present in the map: this codec hides
// literals from static inspection, rather than storing a client-side secret.
export function deriveRuntimeStringKey(seed, code) {
    validateSeed(seed);
    const material = createHash('sha512').update('WarcraftLuaProtector/runtime-strings/v2\0')
        .update(seed, 'utf8').update('\0').update(code, 'utf8').digest();
    return { key: material.subarray(0, 32), noncePrefix: material.subarray(32, 40) };
}

export function runtimeStringNonce(noncePrefix, id) {
    assert(Buffer.isBuffer(noncePrefix) && noncePrefix.length === 8, 'Runtime string nonce prefix must contain 8 bytes');
    assert(Number.isInteger(id) && id >= 1 && id <= 0x7fffffff, 'Runtime string literal ID exceeds the portable nonce range');
    const nonce = Buffer.alloc(12);
    noncePrefix.copy(nonce);
    nonce.writeUInt32LE(id - 1, 8);
    return nonce;
}

export function cryptRuntimeString(bytes, key, nonce, counter = 1) {
    assert(Buffer.isBuffer(bytes) && Buffer.isBuffer(key) && key.length === 32 && Buffer.isBuffer(nonce) && nonce.length === 12,
        'Runtime string cipher requires byte buffers, a 256-bit key and a 96-bit nonce');
    assert(Number.isInteger(counter) && counter >= 0 && counter <= 0xffffffff &&
        Math.ceil(bytes.length / 64) <= 0x100000000 - counter, 'Runtime string block counter would wrap');
    // OpenSSL's 16-byte IV contains a 64-bit counter and a 64-bit nonce. With
    // the low counter word followed by the RFC's full nonce, its state equals
    // the IETF construction until the checked 32-bit counter boundary.
    const iv = Buffer.alloc(16);
    iv.writeUInt32LE(counter);
    nonce.copy(iv, 4);
    const cipher = createCipheriv('chacha20', key, iv);
    return Buffer.concat([cipher.update(bytes), cipher.final()]);
}

function hexWord(value) { return '0x' + value.toString(16).padStart(8, '0'); }

function packedWords(bytes) {
    const words = [];
    for (let offset = 0; offset < bytes.length; offset += 4) {
        let word = 0;
        for (let index = 0; index < 4 && offset + index < bytes.length; index++) word |= bytes[offset + index] << (index * 8);
        words.push(hexWord(word >>> 0));
    }
    return words;
}

export function buildRuntimeStringHelper(helper, records, { key, noncePrefix }) {
    assert(/^[A-Za-z_][A-Za-z0-9_]*$/.test(helper), 'Invalid runtime string helper identifier');
    assert(Buffer.isBuffer(key) && key.length === 32 && Buffer.isBuffer(noncePrefix) && noncePrefix.length === 8,
        'Invalid runtime string key material');
    const bytes = Array.from({ length: 256 }, (_, value) => '"\\' + String(value).padStart(3, '0') + '"').join(',');
    const payloads = records.map(record => '{' + [record.cipher.length, ...packedWords(record.cipher)].join(',') + '}').join(',');
    const initial = ['0x61707865', '0x3320646e', '0x79622d32', '0x6b206574', ...packedWords(key), '1', ...packedWords(noncePrefix), 'i-1'].join(',');
    // Mask every addition and rotation to the same 32-bit word in Lua's
    // normal 64-bit integers and Fengari's signed 32-bit integers. Hex
    // literals remain integers in both implementations, including high bits.
    const quarter = 'local function q(x,a,b,c,d)local e,f,g,h=x[a],x[b],x[c],x[d];' +
        'e=(e+f)&0xffffffff;h=h~e;h=((h<<16)|(h>>16))&0xffffffff;' +
        'g=(g+h)&0xffffffff;f=f~g;f=((f<<12)|(f>>20))&0xffffffff;' +
        'e=(e+f)&0xffffffff;h=h~e;h=((h<<8)|(h>>24))&0xffffffff;' +
        'g=(g+h)&0xffffffff;f=f~g;f=((f<<7)|(f>>25))&0xffffffff;x[a],x[b],x[c],x[d]=e,f,g,h end;';
    // Four cipher bytes occupy one number slot. Decode only on first use,
    // combine four-byte pieces through a balanced tree, then release the
    // ciphertext table. There are no global/library/native/RNG dependencies.
    return 'local ' + helper + '=(function()local b={' + bytes + '};local p={' + payloads + '};local c={};' + quarter +
        'return function(i)local v=c[i];if v~=nil then return v end;local d=p[i];local n=d[1];local z={' + initial + '};local x={};local o={};local h=0;local a=0;' +
        'while a<n do for j=1,16 do x[j]=z[j] end;for j=1,10 do ' +
        'q(x,1,5,9,13);q(x,2,6,10,14);q(x,3,7,11,15);q(x,4,8,12,16);' +
        'q(x,1,6,11,16);q(x,2,7,12,13);q(x,3,8,9,14);q(x,4,5,10,15) end;' +
        'for j=1,16 do if a<n then local w=d[a//4+2]~((x[j]+z[j])&0xffffffff);local t=b[(w&255)+1];' +
        'if a+1<n then t=t..b[((w>>8)&255)+1] end;if a+2<n then t=t..b[((w>>16)&255)+1] end;' +
        'if a+3<n then t=t..b[((w>>24)&255)+1] end;local u=1;while o[u]~=nil do t=o[u]..t;o[u]=nil;u=u+1 end;' +
        'o[u]=t;if u>h then h=u end;a=a+4 end end;z[13]=(z[13]+1)&0xffffffff end;' +
        'local r="";for j=h,1,-1 do if o[j]~=nil then r=r..o[j] end end;c[i]=r;p[i]=nil;return r end end)();\n';
}
