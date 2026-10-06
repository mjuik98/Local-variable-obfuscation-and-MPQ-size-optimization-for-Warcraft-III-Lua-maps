import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { executeJob } from '../src/jobs.mjs';
import { openMap } from '../src/mpq.mjs';
import { createLuaMap } from './map-fixture.mjs';

function fixture(t, options = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'w3lp-job-'));
    t.after(() => {
        const resolved = path.resolve(directory);
        assert(path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('w3lp-job-'));
        fs.rmSync(resolved, { recursive: true, force: true });
    });
    const input = path.join(directory, 'input.w3x'), bytes = createLuaMap(options);
    fs.writeFileSync(input, bytes);
    return { directory, input, bytes, output: path.join(directory, 'not-written.w3x') };
}

test('shared jobs resolve presets, report actual stages and keep check mode read-only', t => {
    const map = fixture(t), stages = [];
    const result = executeJob({ action: 'check', input: map.input, preset: 'size' }, { onProgress: value => stages.push(value) });
    assert.deepEqual(stages, ['validate', 'lua', 'archive', 'verify']);
    assert.equal(result.summary.lua.renamedLocals, 0);
    assert.equal(result.preset.id, 'size');
    assert.deepEqual(fs.readFileSync(map.input), map.bytes);
    assert.deepEqual(fs.readdirSync(map.directory), ['input.w3x']);
});

test('fast check and reviewed distribution enforce their output and contract requirements', t => {
    const map = fixture(t);
    assert.throws(() => executeJob({ action: 'protect', input: map.input, output: map.output, preset: 'fast-check' }), /only supports --check/);
    assert.throws(() => executeJob({ action: 'check', input: map.input, preset: 'distribution' }), /requires --cleanup-contract/);
    assert.equal(executeJob({ action: 'check', input: map.input, preset: 'distribution', overrides: { cleanup: { editor: false, development: false } } }).summary.removedFiles.length, 0);
    assert(!fs.existsSync(map.output));
});

test('desktop string selection overrides valid JSON but cannot hide malformed settings', t => {
    const map = fixture(t, { script: 'function config() end\nfunction main() return "hidden text" end' });
    const configPath = path.join(map.directory, 'settings.json');
    fs.writeFileSync(configPath, JSON.stringify({ strings: { enabled: true } }));
    assert.equal(executeJob({ action: 'check', input: map.input, configPath, hideStrings: false }).summary.strings.encodedLiterals, 0);
    assert.equal(executeJob({ action: 'check', input: map.input, configPath, hideStrings: true }).summary.strings.encodedLiterals, 1);
    fs.writeFileSync(configPath, JSON.stringify({ strings: { enabled: 1 } }));
    assert.throws(() => executeJob({ action: 'check', input: map.input, configPath, hideStrings: false }), /boolean/);
    assert.throws(() => executeJob({ action: 'check', input: map.input, hideStrings: true, overrides: { strings: { enabled: 1 } } }), /boolean/);
});

test('publication uses the same validated bytes and source guard without generating a map fixture', t => {
    const map = fixture(t);
    let called = false;
    const result = executeJob({ action: 'protect', input: map.input, output: map.output }, { publish(destination, contents, { beforePublish }) {
        called = true;
        assert.equal(destination, map.output);
        assert(openMap(contents).has('war3map.lua'));
        fs.appendFileSync(map.input, Buffer.from('external change'));
        assert.throws(beforePublish, /Input changed/);
    } });
    assert(called && result.summary.outputBytes > 0);
    assert(!fs.existsSync(map.output));
});

test('contract proposals are read-only and only explicit new JSON publication is allowed', t => {
    const map = fixture(t, { extraEntries: [['war3map.wtg', Buffer.from('editor')]] });
    const digest = bytes => createHash('sha256').update(bytes).digest('hex');
    const contract = { version: 1, inputMapSha256: digest(map.bytes), scriptSha256: digest(openMap(map.bytes).read('war3map.lua')),
        review: { dynamicFileAccess: 'Synthetic fixture has no file loader.', objectAndImportReferences: 'No imported objects.', limitations: 'Synthetic test only.' },
        files: [{ path: 'war3map.wtg', reason: 'Unused editor data in fixture.', evidence: ['Root Lua has no file access.'] }] };
    const cleanupContractPath = path.join(map.directory, 'previous.json');
    fs.writeFileSync(cleanupContractPath, JSON.stringify(contract));
    const request = { action: 'review', input: map.input, previousInput: map.input, cleanupContractPath };
    const review = executeJob(request).review;
    assert(review.repackOnly && review.candidate);
    assert.deepEqual(fs.readdirSync(map.directory).sort(), ['input.w3x', 'previous.json']);
    const contractOutput = path.join(map.directory, 'new.json');
    executeJob({ ...request, action: 'save-contract', contractOutput });
    assert.deepEqual(JSON.parse(fs.readFileSync(contractOutput)), review.candidate);
    assert.deepEqual(JSON.parse(fs.readFileSync(cleanupContractPath)), contract);
    assert.throws(() => executeJob({ ...request, action: 'save-contract', contractOutput }), /already exists/);
    assert.throws(() => executeJob({ ...request, action: 'save-contract', contractOutput: map.output }), /\.json/);
    assert(!fs.existsSync(map.output));
});

test('unknown fields and mixed contract/transformation actions are refused', () => {
    for (const request of [null, { action: 'unknown' }, { action: 'check', typo: true }, { action: 'review', output: 'map.w3x' },
        { action: 'check', configPath: 0 }, { action: 'check', overrides: null }, { action: 'settings', noVm: null }, { action: 'review', noVm: false }, { action: 'presets', input: 'ignored.w3x' }]) assert.throws(() => executeJob(request));
    assert.equal(executeJob({ action: 'presets' }).presets.length, 6);
});

test('desktop settings carry strengthening overrides and clear VM selections separately from transformation JSON', () => {
    const settings = executeJob({ action: 'settings', preset: 'hardened', hideStrings: false, overrides: { lua: { seed: 'desktop seed', vmFunctions: ['Reviewed'] }, strings: { mode: 'escape' } } });
    assert.equal(settings.config.lua.nameMode, 'seeded');
    assert.equal(settings.config.lua.seed, 'desktop seed');
    assert.deepEqual(settings.config.lua.vmFunctions, ['Reviewed']);
    assert.equal(settings.config.strings.enabled, false);
    assert.equal(settings.config.strings.mode, 'escape');
    assert.deepEqual(executeJob({ action: 'settings', overrides: { lua: { vmFunctions: ['Reviewed'] } }, noVm: true }).config.lua.vmFunctions, []);
    assert(!Object.hasOwn(settings.config, 'noVm'));
});
