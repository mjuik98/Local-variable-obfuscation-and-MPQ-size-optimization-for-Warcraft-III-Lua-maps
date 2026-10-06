import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export function validateSeed(seed, label = 'seed') {
    assert(typeof seed === 'string' && seed.length > 0 && seed.length <= 128 && seed.isWellFormed() &&
        !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(seed),
    label + ' must be a nonempty well-formed Unicode string of at most 128 characters without controls');
    return seed;
}

export function createSeededRandom(seed) {
    validateSeed(seed);
    const initial = createHash('sha256').update(seed, 'utf8').digest();
    let a = initial.readUInt32LE(0), b = initial.readUInt32LE(4),
        c = initial.readUInt32LE(8), d = initial.readUInt32LE(12);
    if ((a | b | c | d) === 0) a = 1;
    // xoshiro128** is a deterministic build-time generator, not a cryptographic
    // RNG. Its state never reaches Lua or consumes the game's random stream.
    return () => {
        const product = Math.imul(b, 5);
        const result = Math.imul((product << 7) | (product >>> 25), 9) >>> 0;
        const shifted = b << 9;
        c ^= a; d ^= b; b ^= c; a ^= d; c ^= shifted;
        d = (d << 11) | (d >>> 21);
        return result;
    };
}
