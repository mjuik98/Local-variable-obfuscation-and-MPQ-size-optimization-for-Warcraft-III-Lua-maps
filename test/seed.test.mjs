import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeededRandom, validateSeed } from '../src/seed.mjs';

test('seed generator has stable uint32 compatibility vectors and independent state', () => {
    const random = createSeededRandom('warcraft-lua-protector');
    const expected = [1962800213, 563309258, 3406570769, 3529020902, 1006895354, 3166084533, 2946009772, 3410803763];
    assert.deepEqual(Array.from({ length: expected.length }, () => random()), expected);
    const fresh = createSeededRandom('warcraft-lua-protector');
    assert.deepEqual(Array.from({ length: expected.length }, () => fresh()), expected);
    assert.notDeepEqual(Array.from({ length: expected.length }, createSeededRandom('other seed')), expected);
    assert.notEqual(random(), expected[0], 'Previously consumed state must not reset a generator');
});

test('Unicode seeds reproduce sequences and generation does not consult Math.random', () => {
    const before = Math.random;
    Math.random = () => { throw new Error('Build-time generator must not use ambient randomness'); };
    try {
        const a = createSeededRandom('배포 seed 🔒'), b = createSeededRandom('배포 seed 🔒');
        for (let index = 0; index < 4096; index++) {
            const value = a();
            assert(Number.isInteger(value) && value >= 0 && value <= 0xffffffff);
            assert.equal(value, b());
        }
    } finally { Math.random = before; }
});

test('invalid seed inputs are rejected without trimming or Unicode normalization', () => {
    for (const seed of [undefined, null, 1, [], '', 'a'.repeat(129), '\ud800', '\udc00', 'x\0y', 'x\ny', 'x\ty', '\u0085', '\u2028', '\u2029']) {
        assert.throws(() => createSeededRandom(seed), /well-formed Unicode/);
    }
    assert.equal(validateSeed('a'.repeat(128), 'lua.seed').length, 128);
    assert.equal(validateSeed('🔒'.repeat(64)).length, 128);
    assert.equal(validateSeed(' '), ' ');
    const composed = createSeededRandom('\u00e9'), decomposed = createSeededRandom('e\u0301');
    assert.notEqual(composed(), decomposed());
});
