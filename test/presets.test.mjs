import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../src/config.mjs';
import { listPresets, resolveSettings } from '../src/presets.mjs';

test('preset IDs and Korean descriptions remain stable and metadata is separate from configuration', () => {
    const available = listPresets();
    assert.deepEqual(available.map(preset => preset.id), ['fast-check', 'size', 'protect', 'distribution', 'hardened', 'maximum']);
    for (const preset of available) {
        assert.match(preset.label, /[가-힣]/);
        assert.match(preset.description, /[가-힣]/);
        assert.equal(typeof preset.checkOnly, 'boolean');
        assert.equal(typeof preset.requiresCleanupContract, 'boolean');
        assert(!Object.hasOwn(preset, 'settings'));
    }
    assert.equal(available[0].checkOnly, true);
    assert.equal(available[3].requiresCleanupContract, true);
});

test('hardened selects seeded names and enabled runtime strings without selecting VM functions or cleanup', () => {
    const { config, preset } = resolveSettings({ preset: 'hardened' });
    assert.equal(preset.label, '보호 강화');
    assert.equal(preset.requiresCleanupContract, false);
    assert.equal(config.lua.nameMode, 'seeded');
    assert.deepEqual(config.lua.vmFunctions, []);
    assert.equal(config.strings.enabled, true);
    assert.equal(config.strings.mode, 'runtime');
    assert.equal(config.cleanup.editor, false);
    assert.equal(config.cleanup.development, false);
    const customized = resolveSettings({ preset: 'hardened', configuration: { lua: { nameMode: 'compact', seed: 'my seed' }, strings: { enabled: false, mode: 'escape' }, cleanup: { editor: true } } }).config;
    assert.equal(customized.lua.nameMode, 'compact');
    assert.equal(customized.lua.seed, 'my seed');
    assert.equal(customized.strings.enabled, false);
    assert.equal(customized.strings.mode, 'escape');
    assert.equal(customized.cleanup.editor, true);
});

test('no preset retains the existing default behavior', () => {
    assert.deepEqual(resolveSettings(), { config: resolveConfig(), preset: null });
    const configuration = { strings: { enabled: true }, compression: { levels: [9] } };
    assert.deepEqual(resolveSettings({ configuration }).config, resolveConfig(configuration));
});

test('each preset applies its intended source preservation, compression and cleanup defaults', () => {
    const fast = resolveSettings({ preset: 'fast-check' }), size = resolveSettings({ preset: 'size' });
    for (const { config } of [fast, size]) {
        assert.equal(config.lua.minify, false);
        assert.equal(config.lua.renameLocals, false);
        assert.equal(config.strings.enabled, false);
        assert.deepEqual(config.cleanup, { editor: false, development: false, editorData: false, listfile: false, editorBlock: false, editorBlockFormat: 'empty', editorBlockFiles: 'both', editorBlockAcceptDynamic: false, keepFiles: [] });
        assert.equal(config.compression.enabled, true);
    }
    assert.deepEqual(fast.config.compression.levels, [6]);
    assert.deepEqual(size.config.compression.levels, [6, 9]);
    assert.deepEqual(resolveSettings({ preset: 'protect' }).config, resolveConfig());
    const distribution = resolveSettings({ preset: 'distribution' });
    assert.equal(distribution.config.lua.minify, true);
    assert.equal(distribution.config.lua.renameLocals, true);
    assert.equal(distribution.config.strings.enabled, false);
    assert.equal(distribution.config.cleanup.editor, true);
    assert.equal(distribution.config.cleanup.development, true);
    assert.deepEqual(distribution.config.compression.levels, [6, 9]);
    assert.equal(distribution.preset.requiresCleanupContract, true);
});

test('partial JSON overrides the preset and explicit booleans override JSON without restoring absent defaults', () => {
    const result = resolveSettings({ preset: 'fast-check',
        configuration: { lua: { minify: true }, cleanup: { editor: true }, compression: { enabled: false, levels: [9] } },
        overrides: { lua: { minify: false }, strings: { enabled: true }, cleanup: { editor: false } },
    });
    assert.equal(result.config.lua.minify, false);
    assert.equal(result.config.lua.renameLocals, false, 'Absent JSON keys retain their preset values');
    assert.equal(result.config.strings.enabled, true);
    assert.equal(result.config.cleanup.editor, false);
    assert.equal(result.config.compression.enabled, false);
    assert.deepEqual(result.config.compression.levels, [9]);
    assert.equal(result.preset.checkOnly, true, 'Check-only behavior is metadata, outside transformation JSON');
    assert(!Object.hasOwn(result.config, 'checkOnly'));
    assert.deepEqual(resolveSettings({ preset: 'fast-check', configuration: {} }).config.compression.levels, [6]);
});

test('repeatable exclusion arrays append JSON values before CLI values and normalize duplicates', () => {
    const result = resolveSettings({ preset: 'protect', configuration: {
        lua: { keepLocals: ['Configured', 'Same'], vmFunctions: ['ConfiguredFunction', 'SameFunction'] }, strings: { keep: ['설정 문자열', 'same message'] },
        cleanup: { keepFiles: ['war3map.wtg', 'same.bin'] }, compression: { excludeFiles: ['first.bin', 'same.bin'] },
    }, overrides: {
        lua: { keepLocals: ['Cli', 'Same'], vmFunctions: ['CliFunction', 'SameFunction'] }, strings: { keep: ['추가 문자열', 'same message'] },
        cleanup: { keepFiles: ['war3map.wct', 'same.bin'] }, compression: { excludeFiles: ['second.bin', 'same.bin'] },
    } });
    assert.deepEqual(result.config.lua.keepLocals, ['Configured', 'Same', 'Cli']);
    assert.deepEqual(result.config.lua.vmFunctions, ['ConfiguredFunction', 'SameFunction', 'CliFunction']);
    assert.deepEqual(result.config.strings.keep, ['설정 문자열', 'same message', '추가 문자열']);
    assert.deepEqual(result.config.cleanup.keepFiles, ['war3map.wtg', 'same.bin', 'war3map.wct']);
    assert.deepEqual(result.config.compression.excludeFiles, ['first.bin', 'same.bin', 'second.bin']);
});

test('explicit VM disable clears the merged JSON and override selections without masking invalid input', () => {
    const options = { configuration: { lua: { vmFunctions: ['Configured'] } }, overrides: { lua: { vmFunctions: ['Cli'], keepLocals: ['Keep'] } }, noVm: true };
    const config = resolveSettings(options).config;
    assert.deepEqual(config.lua.vmFunctions, []);
    assert.deepEqual(config.lua.keepLocals, ['Keep']);
    assert.deepEqual(options.configuration.lua.vmFunctions, ['Configured']);
    assert.deepEqual(options.overrides.lua.vmFunctions, ['Cli']);
    assert.throws(() => resolveSettings({ ...options, configuration: { lua: { vmFunctions: ['bad-name'] } } }), /vmFunctions/);
    assert.throws(() => resolveSettings({ ...options, configuration: { lua: { seed: '' } }, overrides: { lua: { seed: 'valid' } } }), /lua\.seed/);
    for (const noVm of [null, 0, 'true']) assert.throws(() => resolveSettings({ noVm }), /noVm/);
});

test('distribution contract requirement follows the resolved cleanup booleans', () => {
    const off = resolveSettings({ preset: 'distribution', overrides: { cleanup: { editor: false, development: false } } });
    assert.equal(off.preset.requiresCleanupContract, false);
    const configuredOff = resolveSettings({ preset: 'distribution', configuration: { cleanup: { editor: false, development: false } } });
    assert.equal(configuredOff.preset.requiresCleanupContract, false);
    const partial = resolveSettings({ preset: 'distribution', overrides: { cleanup: { editor: false } } });
    assert.equal(partial.config.cleanup.development, true);
    assert.equal(partial.preset.requiresCleanupContract, true);
});

test('invalid JSON, overrides and preset IDs fail even when later layers could mask them', () => {
    const invalid = [null, [], { unknown: {} }, { lua: { minify: 1 } }, { lua: { keepLocals: ['bad-name'] } }, { strings: { keep: ['\ud800'] } }, { cleanup: { editor: 'true' } }, { compression: { levels: [] } }];
    const validOverrides = { lua: { minify: false, keepLocals: ['Valid'] }, strings: { keep: [] }, cleanup: { editor: false }, compression: { levels: [6] } };
    for (const configuration of invalid) assert.throws(() => resolveSettings({ preset: 'protect', configuration, overrides: validOverrides }));
    for (const overrides of invalid) assert.throws(() => resolveSettings({ preset: 'protect', overrides }));
    for (const preset of ['', 'unknown', 'Protect', 1, [], {}]) assert.throws(() => resolveSettings({ preset }));
    assert.throws(() => resolveSettings({ configuration: { checkOnly: true } }));
    assert.throws(() => resolveSettings({ configuration: { requiresCleanupContract: false } }));
});

test('caller settings, returned arrays and public metadata cannot alter future preset resolution', () => {
    const configuration = { lua: { keepLocals: ['Configured'] }, compression: { levels: [9, 6, 9] } }, overrides = { lua: { keepLocals: ['Cli'] } };
    const before = structuredClone({ configuration, overrides });
    const first = resolveSettings({ preset: 'size', configuration, overrides });
    assert.deepEqual({ configuration, overrides }, before);
    assert.deepEqual(first.config.compression.levels, [6, 9]);
    first.config.lua.keepLocals.push('Mutated');
    first.config.compression.levels.push(0);
    first.preset.label = 'changed';
    const listed = listPresets(); listed[0].id = 'changed';
    const next = resolveSettings({ preset: 'size', configuration, overrides });
    assert.deepEqual(next.config.lua.keepLocals, ['Configured', 'Cli']);
    assert.deepEqual(next.config.compression.levels, [6, 9]);
    assert.equal(next.preset.label, '용량 최적화');
    assert.equal(listPresets()[0].id, 'fast-check');
});

test('a distribution preset needs no contract for editor blocking with accepted dynamic access only', () => {
    const settings = resolveSettings({ preset: 'distribution', overrides: { cleanup: { editor: false, development: false, editorBlock: true, editorBlockAcceptDynamic: true } } });
    assert.equal(settings.preset.requiresCleanupContract, false);
    const reviewed = resolveSettings({ preset: 'distribution', overrides: { cleanup: { editor: false, development: false, editorBlock: true } } });
    assert.equal(reviewed.preset.requiresCleanupContract, true);
});
