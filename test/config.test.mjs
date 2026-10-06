import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, resolveConfig, canonicalPath } from '../src/config.mjs';

test('configuration defaults preserve files and are independent between runs', () => {
    const first = resolveConfig(), second = resolveConfig();
    assert.equal(first.cleanup.editor, false);
    assert.equal(first.cleanup.development, false);
    assert.equal(first.lua.renameLocals, true);
    first.lua.keepLocals.push('privateName');
    first.compression.levels.push(1);
    assert.deepEqual(second.lua.keepLocals, []);
    assert.deepEqual(DEFAULT_CONFIG.compression.levels, [6, 9]);
});

test('configuration normalizes compression and repeatable names deterministically', () => {
    const resolved = resolveConfig({ lua: { keepLocals: ['MyLocal', 'MyLocal'] }, compression: { levels: [9, 0, 6, 9], excludeFiles: ['Textures/test.blp'] } });
    assert.deepEqual(resolved.lua.keepLocals, ['MyLocal']);
    assert.deepEqual(resolved.compression.levels, [0, 6, 9]);
    assert.equal(canonicalPath(resolved.compression.excludeFiles[0]), 'TEXTURES\\TEST.BLP');
});

test('configuration accepts UTF-8 MPQ paths and folds only ASCII letters', () => {
    const resolved = resolveConfig({ compression: { excludeFiles: ['textures/한글.blp'] } });
    assert.deepEqual(resolved.compression.excludeFiles, ['textures/한글.blp']);
    assert.equal(canonicalPath('textures/한글.blp'), 'TEXTURES\\한글.BLP');
    // MPQ hashing leaves non-ASCII bytes unchanged, so these are different files.
    assert.notEqual(canonicalPath('é.blp'), canonicalPath('É.blp'));
});

test('invalid configuration fails explicitly instead of silently falling back', () => {
    for (const input of [null, [], { unexpected: {} }, { lua: null }, { lua: { rename: true } }, { lua: { minify: 1 } },
        { lua: { keepLocals: ['bad-name'] } }, { cleanup: { keepFiles: ['bad\nname'] } }, { compression: { levels: [] } },
        { compression: { levels: [10] } }, { compression: { levels: [1.5] } }, { compression: { excludeFiles: ['tab\tname.blp'] } }, { cleanup: { keepFiles: ['\ud800.blp'] } }]) {
        assert.throws(() => resolveConfig(input));
    }
});
