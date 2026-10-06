import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { executeJob, createJobSession } from '../src/jobs.mjs';
import { protectMap } from '../src/protect.mjs';
import { createLuaMap } from './map-fixture.mjs';
import { openMap } from '../src/mpq.mjs';

function fixture(t, options = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'w3lp-session-'));
    t.after(() => {
        const target = path.resolve(directory);
        assert(path.dirname(target) === path.resolve(os.tmpdir()) && path.basename(target).startsWith('w3lp-session-'));
        fs.rmSync(target, { recursive: true, force: true });
    });
    const input = path.join(directory, 'input.w3x'), bytes = createLuaMap({ script: 'function config() end\nfunction main() local message="Hello world!" return message end', ...options });
    fs.writeFileSync(input, bytes);
    return { directory, input, bytes, output: path.join(directory, 'never-written.w3x') };
}

function counted(limitBytes) {
    let calls = 0;
    const session = createJobSession({ ...(limitBytes === undefined ? {} : { limitBytes }), transform(...args) { calls++; return protectMap(...args); } });
    return { session, calls: () => calls };
}

test('settings preview resolves actual layers without map access or output and rejects malformed layers', t => {
    const map = fixture(t), configPath = path.join(map.directory, 'settings.json');
    fs.writeFileSync(configPath, JSON.stringify({ lua: { minify: true, keepLocals: ['original'] }, strings: { enabled: true }, compression: { levels: [9] } }));
    const result = executeJob({ action: 'settings', preset: 'size', configPath, hideStrings: false, overrides: { lua: { keepLocals: ['extra'] } } });
    assert(result.config.lua.minify && !result.config.lua.renameLocals);
    assert.deepEqual(result.config.lua.keepLocals, ['original', 'extra']);
    assert.deepEqual(result.config.compression.levels, [9]);
    assert(!result.config.strings.enabled);
    assert.throws(() => executeJob({ action: 'settings', input: map.input }), /cannot include/);
    assert.throws(() => executeJob({ action: 'settings', overrides: { compression: { strategies: ['unknown'] } } }));
    assert.deepEqual(fs.readFileSync(map.input), map.bytes);
});

test('check to save reuses one verified result while retaining the final source and settings guards', t => {
    const map = fixture(t), state = counted(), request = { action: 'check', input: map.input, preset: 'protect' };
    const checked = executeJob(request, state);
    assert(!checked.cache.reused && checked.cache.retained);
    checked.summary.outputBytes = 0;
    let published = false;
    const stages = [];
    const saved = executeJob({ ...request, action: 'protect', output: map.output }, { session: state.session, onProgress: stage => stages.push(stage), publish(destination, contents, { beforePublish }) {
        assert.equal(destination, map.output);
        assert(openMap(contents).read('war3map.lua').includes(Buffer.from('function main')));
        beforePublish(); published = true;
    } });
    assert(published && saved.cache.reused && saved.summary.outputBytes > 0);
    assert.equal(state.calls(), 1);
    assert.deepEqual(stages, ['reuse', 'write']);
    assert(!fs.existsSync(map.output));
    assert.deepEqual(fs.readdirSync(map.directory), ['input.w3x']);
});

test('input changes cause fresh verification while different settings replace the single entry', t => {
    const map = fixture(t), state = counted(), request = { action: 'check', input: map.input };
    executeJob(request, state);
    const changed = createLuaMap({ script: 'function config() end\nfunction main() return 99 end' });
    fs.writeFileSync(map.input, changed);
    assert(!executeJob(request, state).cache.reused);
    assert.equal(state.calls(), 2);
    assert(executeJob(request, state).cache.reused);
    assert(!executeJob({ ...request, preset: 'size' }, state).cache.reused);
    assert.equal(state.calls(), 3);
    assert(!executeJob(request, state).cache.reused);
    assert.equal(state.calls(), 4);
    fs.writeFileSync(map.input, Buffer.from('invalid map'));
    assert.throws(() => executeJob(request, state), /MPQ|map/);
    assert(!state.session.status().retained);
});

test('cache keys distinguish naming mode, exact seed, string mode and explicit VM selections', t => {
    const map = fixture(t, { script: 'local function Reviewed(x) return x + 1 end\nfunction config() end\nfunction main() return Reviewed(2) end' }), state = counted();
    const request = { action: 'check', input: map.input };
    assert(!executeJob(request, state).cache.reused);
    const variants = [
        { lua: { nameMode: 'seeded', seed: 'seed one' } },
        { lua: { nameMode: 'seeded', seed: 'seed two' } },
        { strings: { mode: 'runtime', enabled: false } },
        { lua: { vmFunctions: ['Reviewed'] } },
    ];
    for (const overrides of variants) { const selected = { ...request, overrides }; assert(!executeJob(selected, state).cache.reused); assert(executeJob(selected, state).cache.reused); }
    const disabled = { ...request, overrides: { lua: { vmFunctions: ['Reviewed'] } }, noVm: true };
    assert(!executeJob(disabled, state).cache.reused);
    assert(executeJob(disabled, state).cache.reused);
    assert.equal(state.calls(), 6);
    assert.deepEqual(fs.readdirSync(map.directory), ['input.w3x']);
    assert.deepEqual(fs.readFileSync(map.input), map.bytes);
});

test('changed config bytes invalidate cache even with equal effective settings and guards cover writes', t => {
    const map = fixture(t), state = counted(), configPath = path.join(map.directory, 'settings.json');
    fs.writeFileSync(configPath, '{}');
    const request = { action: 'check', input: map.input, configPath };
    executeJob(request, state);
    fs.writeFileSync(configPath, '{ }');
    assert(!executeJob(request, state).cache.reused);
    assert.equal(state.calls(), 2);
    assert.throws(() => executeJob({ ...request, action: 'protect', output: map.output }, { session: state.session, publish(destination, contents, { beforePublish }) {
        fs.writeFileSync(configPath, '{  }'); beforePublish();
    } }), /Input changed/);
    assert(!fs.existsSync(map.output));
    fs.writeFileSync(configPath, '{"lua":{"renameLocals":1}}');
    assert.throws(() => executeJob(request, state), /boolean/);
});

test('cleanup contract changes are revalidated and cached publication rechecks contract bytes', t => {
    const map = fixture(t, { extraEntries: [['war3map.wtg', Buffer.from('editor')]] }), state = counted(), hash = bytes => createHash('sha256').update(bytes).digest('hex');
    const contract = { version: 1, inputMapSha256: hash(map.bytes), scriptSha256: hash(openMap(map.bytes).read('war3map.lua')),
        review: { dynamicFileAccess: 'Synthetic fixture.', objectAndImportReferences: 'No objects.', limitations: 'Fixture only.' },
        files: [{ path: 'war3map.wtg', reason: 'No editor execution dependency.', evidence: ['Synthetic Lua has no file loading.'] }] };
    const cleanupContractPath = path.join(map.directory, 'contract.json');
    fs.writeFileSync(cleanupContractPath, JSON.stringify(contract));
    const request = { action: 'check', input: map.input, cleanupContractPath };
    executeJob(request, state);
    assert(executeJob(request, state).cache.reused);
    fs.writeFileSync(cleanupContractPath, JSON.stringify(contract, null, 2));
    assert(!executeJob(request, state).cache.reused);
    assert.equal(state.calls(), 2);
    assert.throws(() => executeJob({ ...request, action: 'protect', output: map.output }, { session: state.session, publish(destination, contents, { beforePublish }) {
        fs.appendFileSync(cleanupContractPath, ' '); beforePublish();
    } }), /Input changed/);
    fs.writeFileSync(cleanupContractPath, JSON.stringify({ ...contract, inputMapSha256: '0'.repeat(64) }));
    assert.throws(() => executeJob(request, state), /hash|match/i);
    assert(!fs.existsSync(map.output));
});

test('cache byte limit and explicit clear release entries without changing the check result', t => {
    const map = fixture(t), state = counted(1), request = { action: 'check', input: map.input };
    const first = executeJob(request, state), second = executeJob(request, state);
    assert(!first.cache.retained && !second.cache.reused && !second.cache.retained);
    assert.equal(state.calls(), 2);
    assert.equal(state.session.status().bytes, 0);
    const other = counted();
    executeJob(request, other);
    assert(other.session.status().bytes <= other.session.status().limitBytes);
    other.session.clear();
    assert(!other.session.status().retained);
    assert.throws(() => createJobSession({ limitBytes: -1 }));
});

test('comparison sequentially evaluates unique settings and reports refusals per row without output', t => {
    const map = fixture(t), state = counted(), stages = [];
    const result = executeJob({ action: 'compare', input: map.input, preset: 'protect' }, { session: state.session, onProgress: (stage, detail) => { if (stage === 'compare') stages.push(detail); } });
    assert(result.comparisons.length >= 6);
    assert.equal(result.comparisons.length, stages.length);
    assert(result.comparisons.some(value => value.ok && value.hideStrings && value.summary.strings.encodedLiterals === 1));
    assert(result.comparisons.some(value => value.ok && value.preset === 'size' && value.summary.lua.renamedLocals === 0));
    assert(result.comparisons.some(value => value.preset === 'hardened' && value.config.lua.nameMode === 'seeded' && value.config.strings.mode === 'runtime'));
    assert(result.comparisons.filter(value => value.preset === 'distribution').every(value => !value.ok && /cleanup-contract/.test(value.error)));
    const successes = result.comparisons.filter(value => value.ok);
    assert.equal(state.calls(), successes.length);
    for (const item of successes) assert.deepEqual(item.summary, protectMap(map.bytes, item.config).summary);
    assert(result.elapsedMs >= 0);
    assert.throws(() => executeJob({ action: 'compare', input: map.input, output: map.output }), /cannot include/);
    assert.deepEqual(fs.readdirSync(map.directory), ['input.w3x']);
});

test('comparison aborts if the original input changes between variants', t => {
    const map = fixture(t);
    assert.throws(() => executeJob({ action: 'compare', input: map.input }, { onProgress(stage) { if (stage === 'verify') fs.appendFileSync(map.input, 'changed'); } }), /Input changed/);
    assert(!fs.existsSync(map.output));
});
