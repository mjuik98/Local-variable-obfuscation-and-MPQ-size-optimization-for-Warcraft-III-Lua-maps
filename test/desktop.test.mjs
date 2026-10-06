import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDesktopJob, createDesktopSession } from '../src/desktop.mjs';
import { createLuaMap } from './map-fixture.mjs';

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'w3lp-desktop-'));
    t.after(() => {
        const resolved = path.resolve(directory);
        assert(path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('w3lp-desktop-'));
        fs.rmSync(resolved, { recursive: true, force: true });
    });
    const input = path.join(directory, '한글 input.w3x'), bytes = createLuaMap();
    fs.writeFileSync(input, bytes);
    return { directory, input, bytes, output: path.join(directory, 'never-created.w3x') };
}

test('desktop worker runs the real check pipeline and emits stages without map output', async t => {
    const map = fixture(t), events = [];
    const result = await startDesktopJob({ action: 'check', input: map.input, preset: 'protect' }, { emit: value => events.push(value) }).completion;
    assert(result.ok, result.error);
    assert.equal(result.summary.lua.renamedLocals, 1);
    assert.deepEqual(events.filter(event => event.type === 'progress').map(event => event.stage), ['validate', 'lua', 'archive', 'verify']);
    assert.equal(events.filter(event => event.type === 'result').length, 1);
    assert.deepEqual(fs.readFileSync(map.input), map.bytes);
    assert.deepEqual(fs.readdirSync(map.directory), [path.basename(map.input)]);
});

test('immediate cancellation ends computation before publication and leaves no temporary artifacts', async t => {
    const map = fixture(t), job = startDesktopJob({ action: 'protect', input: map.input, output: map.output });
    assert.equal(job.cancel(), true);
    const result = await job.completion;
    assert.equal(result.ok, false);
    assert.equal(result.cancelled, true);
    assert.equal(job.cancel(), false);
    assert.deepEqual(fs.readdirSync(map.directory), [path.basename(map.input)]);
});

test('desktop worker forwards validation failures without publishing output', async t => {
    const map = fixture(t);
    const result = await startDesktopJob({ action: 'protect', input: map.input, output: map.output, preset: 'fast-check' }).completion;
    assert.equal(result.ok, false);
    assert.match(result.error, /only supports --check/);
    assert(!fs.existsSync(map.output));
});

test('desktop cleanup refusal shows Korean contract instructions and keeps the map untouched', async t => {
    const map = fixture(t);
    const bytes = createLuaMap({ script: 'function config() end\nfunction main() Preloader(savePath) end',
        extraEntries: [['war3map.wtg', Buffer.from('editor data')], ['lotkt-object-history.json', Buffer.from('{}')]] });
    fs.writeFileSync(map.input, bytes);
    const result = await startDesktopJob({ action: 'check', input: map.input, preset: 'protect',
        overrides: { cleanup: { editor: true, development: true } } }).completion;
    assert.equal(result.ok, false);
    assert.match(result.error, /Preloader/);
    assert.match(result.error, /검토 계약 → 찾아보기/);
    assert.match(result.error, /war3map\.wtg, lotkt-object-history\.json/);
    assert.deepEqual(fs.readFileSync(map.input), bytes);
    assert.deepEqual(fs.readdirSync(map.directory), [path.basename(map.input)]);
});

test('JSON line protocol carries Korean paths and exits after a result', { timeout: 15000 }, async t => {
    const map = fixture(t), script = fileURLToPath(new URL('../src/desktop.mjs', import.meta.url));
    const child = spawn(process.execPath, [script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
    child.stdin.write(JSON.stringify({ action: 'check', input: map.input }) + '\n');
    await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    assert.equal(stderr, '');
    const result = stdout.trim().split('\n').map(line => JSON.parse(line)).at(-1);
    assert(result.ok, result.error);
    assert.equal(result.path, map.input);
    assert.deepEqual(fs.readdirSync(map.directory), [path.basename(map.input)]);
});

test('preset bootstrap and malformed requests return one structured result', () => {
    const script = fileURLToPath(new URL('../src/desktop.mjs', import.meta.url));
    for (const input of [JSON.stringify({ action: 'presets' }) + '\n', '{broken\n']) {
        const result = spawnSync(process.execPath, [script], { input, encoding: 'utf8', windowsHide: true, timeout: 10000 });
        assert.equal(result.status, 0, result.stderr);
        const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
        assert.equal(events.length, 1);
        assert.equal(events[0].ok, input.startsWith('{"action"'));
    }
});

test('persistent desktop worker reuses checks, previews settings and recovers after cancellation', async t => {
    const map = fixture(t), session = createDesktopSession();
    t.after(() => session.close());
    const request = { action: 'check', input: map.input, preset: 'protect' };
    const first = await session.run(request).completion;
    assert(first.ok && !first.cache.reused && first.cache.retained, first.error);
    const preview = await session.run({ action: 'settings', preset: 'size' }).completion;
    assert(preview.ok && !preview.config.lua.renameLocals);
    const second = await session.run(request).completion;
    assert(second.ok && second.cache.reused, second.error);
    const cancelled = session.run(request);
    assert(cancelled.cancel());
    assert((await cancelled.completion).cancelled);
    const fresh = await session.run(request).completion;
    assert(fresh.ok && !fresh.cache.reused, fresh.error);
    assert.deepEqual(fs.readdirSync(map.directory), [path.basename(map.input)]);
});

test('desktop comparison carries row errors without creating outputs and honors cache memory limits', async t => {
    const map = fixture(t), session = createDesktopSession({ limitBytes: 0 });
    t.after(() => session.close());
    const compare = await session.run({ action: 'compare', input: map.input }).completion;
    assert(compare.ok && compare.comparisons.some(item => item.ok) && compare.comparisons.some(item => !item.ok), compare.error);
    const first = await session.run({ action: 'check', input: map.input }).completion;
    const second = await session.run({ action: 'check', input: map.input }).completion;
    assert(first.ok && second.ok && !first.cache.retained && !second.cache.reused);
    assert.deepEqual(fs.readdirSync(map.directory), [path.basename(map.input)]);
});

test('persistent JSON protocol accepts sequential requests and releases its cached worker on EOF', { timeout: 15000 }, async t => {
    const map = fixture(t), script = fileURLToPath(new URL('../src/desktop.mjs', import.meta.url));
    const child = spawn(process.execPath, [script, '--session'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    child.stdout.setEncoding('utf8');
    let pending = '', stderr = '';
    const results = [];
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
    child.stdout.on('data', value => {
        pending += value;
        let index;
        while ((index = pending.indexOf('\n')) >= 0) {
            const event = JSON.parse(pending.slice(0, index)); pending = pending.slice(index + 1);
            if (event.type !== 'result') continue;
            results.push(event);
            if (results.length === 1) child.stdin.write(JSON.stringify({ action: 'check', input: map.input }) + '\n');
            else if (results.length === 2) child.stdin.end();
        }
    });
    child.stdin.write(JSON.stringify({ action: 'check', input: map.input }) + '\n');
    await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    assert.equal(stderr, '');
    assert.equal(results.length, 2);
    assert(results[0].ok && !results[0].cache.reused && results[1].ok && results[1].cache.reused);
    assert.deepEqual(fs.readdirSync(map.directory), [path.basename(map.input)]);
});
