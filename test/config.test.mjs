import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, resolveConfig, canonicalPath } from '../src/config.mjs';

test('configuration defaults preserve files and are independent between runs', () => {
    const first = resolveConfig(), second = resolveConfig();
    assert.equal(first.cleanup.editor, false);
    assert.equal(first.cleanup.development, false);
    assert.equal(first.lua.renameLocals, true);
    assert.equal(first.strings.enabled, false);
    assert.equal(first.lua.nameMode, 'compact');
    assert.equal(first.lua.seed, 'warcraft-lua-protector');
    assert.equal(first.strings.mode, 'escape');
    first.lua.vmFunctions.push('Reviewed');
    assert.deepEqual(second.lua.vmFunctions, []);
    first.lua.keepLocals.push('privateName');
    first.compression.levels.push(1);
    first.compression.strategies.push('rle');
    assert.deepEqual(second.lua.keepLocals, []);
    assert.deepEqual(DEFAULT_CONFIG.compression.levels, [6, 9]);
    assert.deepEqual(second.compression.strategies, ['default']);
    assert.deepEqual(DEFAULT_CONFIG.compression.strategies, ['default']);
    first.strings.keep.push('keep message');
    assert.deepEqual(second.strings.keep, []);
});

test('strengthening modes and explicit VM names are strict and keep the supplied seed intact', () => {
    const seed = '  재현 seed 😀  ', vmFunctions = ['Reviewed', 'Second', 'Reviewed'];
    const config = resolveConfig({ lua: { nameMode: 'seeded', seed, vmFunctions }, strings: { mode: 'runtime' } });
    assert.equal(config.lua.nameMode, 'seeded');
    assert.equal(config.lua.seed, seed);
    assert.equal(config.strings.mode, 'runtime');
    assert.equal(config.strings.enabled, false, 'Choosing a mode alone must not enable string rewriting');
    assert.deepEqual(config.lua.vmFunctions, ['Reviewed', 'Second']);
    assert.deepEqual(vmFunctions, ['Reviewed', 'Second', 'Reviewed']);
    assert.equal(resolveConfig({ lua: { seed: 'x'.repeat(128) } }).lua.seed.length, 128);
    for (const lua of [{ nameMode: null }, { nameMode: 'random' }, { vmFunctions: null }, { vmFunctions: ['bad-name'] }, { vmFunctions: [''] }, { vmFunctions: new Array(1) }]) assert.throws(() => resolveConfig({ lua }));
    for (const seed of ['', null, 1, 'x'.repeat(129), '\ud800', '\udc00', 'a\0b', 'a\nb', 'a\u0085b', 'a\u2028b', 'a\u2029b']) assert.throws(() => resolveConfig({ lua: { seed } }), /lua\.seed/);
    for (const mode of [null, '', 'Runtime', true]) assert.throws(() => resolveConfig({ strings: { mode } }), /strings\.mode/);
});

test('configuration normalizes compression and repeatable names deterministically', () => {
    const strategies = ['fixed', 'rle', 'default', 'fixed', 'huffman-only', 'filtered'];
    const resolved = resolveConfig({ lua: { keepLocals: ['MyLocal', 'MyLocal'] }, compression: { levels: [9, 0, 6, 9], strategies, excludeFiles: ['Textures/test.blp'] } });
    assert.deepEqual(resolved.lua.keepLocals, ['MyLocal']);
    assert.deepEqual(resolved.compression.levels, [0, 6, 9]);
    assert.deepEqual(resolved.compression.strategies, ['default', 'filtered', 'huffman-only', 'rle', 'fixed']);
    assert.deepEqual(strategies, ['fixed', 'rle', 'default', 'fixed', 'huffman-only', 'filtered']);
    assert.equal(canonicalPath(resolved.compression.excludeFiles[0]), 'TEXTURES\\TEST.BLP');
});

test('invalid configuration fails explicitly instead of silently falling back', () => {
    for (const input of [null, [], { unexpected: {} }, { lua: null }, { lua: { rename: true } }, { lua: { minify: 1 } },
        { lua: { keepLocals: ['bad-name'] } }, { cleanup: { keepFiles: ['bad\nname'] } }, { compression: { levels: [] } },
        { compression: { levels: [10] } }, { compression: { levels: [1.5] } }, { compression: { excludeFiles: ['tab\tname.blp'] } }, { cleanup: { keepFiles: ['\ud800.blp'] } },
        { strings: { enabled: 1 } }, { strings: { keep: [null] } }, { strings: { keep: ['\ud800'] } }]) {
        assert.throws(() => resolveConfig(input));
    }
});

test('compression strategies reject malformed and unsupported values even when compression is disabled', () => {
    for (const strategies of [undefined, null, [], 'default', [0], ['DEFAULT'], ['unknown'], ['default', null], new Array(1)]) {
        assert.throws(() => resolveConfig({ compression: { enabled: false, strategies } }), /compression\.strategies/);
    }
});

test('sparse compression levels are refused before normalization even when compression is disabled', () => {
    for (const levels of [new Array(1), Object.assign(new Array(3), { 0: 6, 2: 9 }), [undefined], [NaN], [Infinity]]) {
        for (const enabled of [true, false]) {
            assert.throws(() => resolveConfig({ compression: { enabled, levels } }), /compression\.levels/);
        }
    }
});

test('experimental global, field, native and sector options are strict and default off', () => {
    const defaults = resolveConfig();
    assert.equal(defaults.lua.renameGlobals, false);
    assert.equal(defaults.lua.renameFields, false);
    assert.equal(defaults.lua.hideNatives, false);
    assert.deepEqual(defaults.lua.keepGlobals, []);
    assert.equal(defaults.compression.sectorSizeShift, null);
    const custom = resolveConfig({ lua: { renameGlobals: true, renameFields: true, hideNatives: true, keepGlobals: ['Kept', 'Kept'] }, compression: { sectorSizeShift: 7 } });
    assert.deepEqual(custom.lua.keepGlobals, ['Kept']);
    assert.equal(custom.compression.sectorSizeShift, 7);
    for (const invalid of [{ lua: { renameGlobals: 1 } }, { lua: { hideNatives: 'yes' } }, { lua: { keepGlobals: ['not a name'] } },
        { compression: { sectorSizeShift: 2 } }, { compression: { sectorSizeShift: 9 } }, { compression: { sectorSizeShift: '7' } },
        { compression: { sectorSizeShift: 7, enabled: false } }, { compression: { sectorSizeShift: 7, excludeFiles: ['war3map.lua'] } }]) {
        assert.throws(() => resolveConfig(invalid), JSON.stringify(invalid));
    }
});

test('FourCC folding, editor data cleanup and listfile removal are strict booleans that default off', () => {
    const defaults = resolveConfig();
    assert.equal(defaults.lua.foldFourCC, false);
    assert.equal(defaults.cleanup.editorData, false);
    assert.equal(defaults.cleanup.listfile, false);
    for (const invalid of [{ lua: { foldFourCC: 'yes' } }, { cleanup: { editorData: 1 } }, { cleanup: { listfile: null } }]) assert.throws(() => resolveConfig(invalid));
});

test('Zopfli compression is a strict boolean that defaults off', () => {
    assert.equal(resolveConfig().compression.zopfli, false);
    assert.equal(resolveConfig({ compression: { zopfli: true } }).compression.zopfli, true);
    assert.throws(() => resolveConfig({ compression: { zopfli: 1 } }));
});

test('configuration accepts UTF-8 MPQ paths and folds only ASCII letters', () => {
    const resolved = resolveConfig({ compression: { excludeFiles: ['textures/한글.blp'] } });
    assert.deepEqual(resolved.compression.excludeFiles, ['textures/한글.blp']);
    assert.equal(canonicalPath('textures/한글.blp'), 'TEXTURES\\한글.BLP');
    // MPQ hashing leaves non-ASCII bytes unchanged, so these are different files.
    assert.notEqual(canonicalPath('é.blp'), canonicalPath('É.blp'));
});

test('all-literal string hiding is a strict boolean that defaults off and requires runtime mode', () => {
    assert.equal(resolveConfig().strings.allLiterals, false);
    assert.equal(resolveConfig({ strings: { mode: 'runtime', allLiterals: true } }).strings.allLiterals, true);
    assert.equal(resolveConfig({ strings: { allLiterals: true } }).strings.allLiterals, true, 'An inactive scope can be layered before the mode');
    assert.throws(() => resolveConfig({ strings: { enabled: true, allLiterals: true } }), /requires strings\.mode runtime/);
    assert.throws(() => resolveConfig({ strings: { mode: 'runtime', allLiterals: 1 } }), /allLiterals must be boolean/);
});
