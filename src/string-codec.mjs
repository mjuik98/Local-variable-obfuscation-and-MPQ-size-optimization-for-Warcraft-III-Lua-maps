import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import { createSeededRandom, validateSeed } from './seed.mjs';

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

const helperRoles = ['bytes', 'payloads', 'cache', 'quarter', 'qx', 'qa', 'qb', 'qc', 'qd', 'qe', 'qf', 'qg', 'qh',
    'id', 'value', 'data', 'length', 'state', 'work', 'pieces', 'height', 'offset', 'index', 'word', 'text', 'level', 'result'];
const helperNames = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

function shuffle(values, random) {
    const result = [...values];
    for (let index = result.length - 1; index > 0; index--) {
        const other = random() % (index + 1);
        [result[index], result[other]] = [result[other], result[index]];
    }
    return result;
}

// The helper's local names, independent statement order, quarter-round call
// order within each round and constant words (written as XOR pairs) vary with
// the key material, so the generated code has no fixed textual signature.
// The decoded bytes do not depend on these choices.
export function buildRuntimeStringHelper(helper, records, { key, noncePrefix }) {
    assert(/^[A-Za-z_][A-Za-z0-9_]*$/.test(helper), 'Invalid runtime string helper identifier');
    assert(Buffer.isBuffer(key) && key.length === 32 && Buffer.isBuffer(noncePrefix) && noncePrefix.length === 8,
        'Invalid runtime string key material');
    const random = createSeededRandom(createHash('sha256').update('WarcraftLuaProtector/runtime-helper-shape\0').update(key).update(noncePrefix).digest('hex'));
    const names = Object.fromEntries(shuffle(helperNames, random).slice(0, helperRoles.length).map((name, index) => [helperRoles[index], name]));
    const { bytes: B, payloads: P, cache: C, quarter: Q, qx, qa, qb, qc, qd, qe, qf, qg, qh,
        id: I, value: V, data: D, length: N, state: Z, work: X, pieces: O, height: H, offset: A, index: J, word: W, text: T, level: U, result: R } = names;
    const masked = word => {
        const mask = random() >>> 0;
        return '(' + hexWord((word ^ mask) >>> 0) + '~' + hexWord(mask) + ')';
    };
    const words = buffer => Array.from({ length: buffer.length / 4 }, (_, index) => buffer.readUInt32LE(index * 4));
    const bytes = Array.from({ length: 256 }, (_, value) => '"\\' + String(value).padStart(3, '0') + '"').join(',');
    const payloads = records.map(record => '{' + [record.cipher.length, ...packedWords(record.cipher)].join(',') + '}').join(',');
    const initial = [...[0x61707865, 0x3320646e, 0x79622d32, 0x6b206574, ...words(key)].map(masked), '1',
        ...words(noncePrefix).map(masked), I + '-1'].join(',');
    // Mask every addition, XOR and rotation to the same 32-bit word in Lua's
    // normal 64-bit integers and Fengari's signed 32-bit integers. Hex
    // literals remain integers in both implementations, including high bits.
    const quarter = 'local function ' + Q + '(' + [qx, qa, qb, qc, qd].join(',') + ')local ' + [qe, qf, qg, qh].join(',') + '=' +
        [qa, qb, qc, qd].map(name => qx + '[' + name + ']').join(',') + ';' +
        `${qe}=(${qe}+${qf})&0xffffffff;${qh}=${qh}~${qe};${qh}=((${qh}<<16)|(${qh}>>16))&0xffffffff;` +
        `${qg}=(${qg}+${qh})&0xffffffff;${qf}=${qf}~${qg};${qf}=((${qf}<<12)|(${qf}>>20))&0xffffffff;` +
        `${qe}=(${qe}+${qf})&0xffffffff;${qh}=${qh}~${qe};${qh}=((${qh}<<8)|(${qh}>>24))&0xffffffff;` +
        `${qg}=(${qg}+${qh})&0xffffffff;${qf}=${qf}~${qg};${qf}=((${qf}<<7)|(${qf}>>25))&0xffffffff;` +
        [qa, qb, qc, qd].map(name => qx + '[' + name + ']').join(',') + '=' + [qe, qf, qg, qh].join(',') + ' end;';
    // Quarter rounds within one column or diagonal round touch disjoint words.
    const round = groups => shuffle(groups, random).map(group => Q + '(' + X + ',' + group.join(',') + ');').join('');
    const columns = round([[1, 5, 9, 13], [2, 6, 10, 14], [3, 7, 11, 15], [4, 8, 12, 16]]);
    const diagonals = round([[1, 6, 11, 16], [2, 7, 12, 13], [3, 8, 9, 14], [4, 5, 10, 15]]);
    const declarations = shuffle(['local ' + B + '={' + bytes + '};', 'local ' + P + '={' + payloads + '};', 'local ' + C + '={};', quarter], random).join('');
    // Four cipher bytes occupy one number slot. Decode only on first use,
    // combine four-byte pieces through a balanced tree, then release the
    // ciphertext table. There are no global/library/native/RNG dependencies.
    return 'local ' + helper + '=(function()' + declarations +
        `return function(${I})local ${V}=${C}[${I}];if ${V}~=nil then return ${V} end;local ${D}=${P}[${I}];local ${N}=${D}[1];` +
        `local ${Z}={${initial}};for ${J}=1,16 do ${Z}[${J}]=${Z}[${J}]&0xffffffff end;local ${X}={};local ${O}={};local ${H}=0;local ${A}=0;` +
        `while ${A}<${N} do for ${J}=1,16 do ${X}[${J}]=${Z}[${J}] end;for ${J}=1,10 do ${columns}${diagonals} end;` +
        `for ${J}=1,16 do if ${A}<${N} then local ${W}=${D}[${A}//4+2]~((${X}[${J}]+${Z}[${J}])&0xffffffff);local ${T}=${B}[(${W}&255)+1];` +
        `if ${A}+1<${N} then ${T}=${T}..${B}[((${W}>>8)&255)+1] end;if ${A}+2<${N} then ${T}=${T}..${B}[((${W}>>16)&255)+1] end;` +
        `if ${A}+3<${N} then ${T}=${T}..${B}[((${W}>>24)&255)+1] end;local ${U}=1;while ${O}[${U}]~=nil do ${T}=${O}[${U}]..${T};${O}[${U}]=nil;${U}=${U}+1 end;` +
        `${O}[${U}]=${T};if ${U}>${H} then ${H}=${U} end;${A}=${A}+4 end end;${Z}[13]=(${Z}[13]+1)&0xffffffff end;` +
        `local ${R}="";for ${J}=${H},1,-1 do if ${O}[${J}]~=nil then ${R}=${R}..${O}[${J}] end end;${C}[${I}]=${R};${P}[${I}]=nil;return ${R} end end)();\n`;
}
