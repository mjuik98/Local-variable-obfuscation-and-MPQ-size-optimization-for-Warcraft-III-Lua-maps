import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArguments, run } from '../src/cli.mjs';

test('CLI accepts check mode and preserves repeated exclusion arguments', () => {
    const result = parseArguments(['input.w3x', '--check', '--clean-editor', '--keep-local', 'Private', '--keep-local', 'Second', '--keep-file', 'war3map.wct', '--exclude-compress', 'Textures/a.blp']);
    assert.equal(result.check, true);
    assert.equal(result.output, null);
    assert.equal(result.overrides.cleanup.editor, true);
    assert.deepEqual(result.overrides.lua.keepLocals, ['Private', 'Second']);
    assert.deepEqual(result.overrides.cleanup.keepFiles, ['war3map.wct']);
    assert.deepEqual(result.overrides.compression.excludeFiles, ['Textures/a.blp']);
});

test('CLI rejects ambiguous or incomplete output and option requests', () => {
    for (const args of [[], ['input.w3x'], ['input.w3n', '--check'], ['input.w3x', '--output', 'output.w3m'],
        ['input.w3x', '--check', '--check'], ['input.w3x', '--check', '--unknown'], ['input.w3x', '--keep-file'],
        ['input.w3x', '--check', 'second.w3x'], ['input.w3x', '--check', '--no-cleanup', '--clean-editor'],
        ['input.w3x', '--check', '--clean-development', '--no-cleanup']]) assert.throws(() => parseArguments(args));
});

test('CLI help and failure return correct status through supplied streams', () => {
    let out = '', err = '';
    const streams = { stdout: { write: value => { out += value; } }, stderr: { write: value => { err += value; } } };
    assert.equal(run(['--help'], streams), 0);
    assert.match(out, /--check/);
    assert.equal(err, '');
    assert.equal(run([], streams), 1);
    assert.match(err, /input map is required/);
});

test('standalone CLI entry point displays help without creating a map', () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), '--help'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: w3lua-protect/);
});

test('configuration file errors name the file without reading the input map', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w3lua-cli-test-'));
    t.after(() => fs.rmSync(root, { recursive: true }));
    const invalidJson = path.join(root, 'broken.json'), invalidValue = path.join(root, 'invalid.json');
    fs.writeFileSync(invalidJson, '{bad');
    fs.writeFileSync(invalidValue, JSON.stringify({ lua: { minify: 'yes' } }));
    for (const [file, detail] of [[invalidJson, /JSON/], [invalidValue, /lua\.minify must be boolean/], [path.join(root, 'missing.json'), /ENOENT/]]) {
        let err = '';
        const status = run(['missing-map.w3x', '--check', '--config', file], { stdout: { write() {} }, stderr: { write: value => { err += value; } } });
        assert.equal(status, 1);
        assert(err.includes('Configuration file ' + file + ': '), err);
        assert.match(err, detail);
    }
});
