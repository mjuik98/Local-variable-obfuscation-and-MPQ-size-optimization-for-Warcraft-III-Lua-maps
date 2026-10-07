import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArguments, run } from '../src/cli.mjs';
import { protectMap } from '../src/protect.mjs';
import { openMap } from '../src/mpq.mjs';
import { createLuaMap } from './map-fixture.mjs';

const cliPath = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

test('CLI previews resolved settings and accepts strict repeatable compression strategy choices', () => {
    const result = capture(['--show-settings', '--preset', 'size', '--compression-strategy', 'fixed', '--compression-strategy', 'default', '--compression-strategy', 'fixed']);
    assert.equal(result.status, 0, result.stderr);
    const settings = JSON.parse(result.stdout);
    assert(!settings.config.lua.renameLocals);
    assert.deepEqual(settings.config.compression.strategies, ['default', 'fixed']);
    assert.equal(capture(['--show-settings', '--compression-strategy', 'unknown']).status, 1);
    for (const args of [['input.w3x', '--show-settings'], ['--show-settings', '--check'], ['input.w3x', '--compare', '--check'], ['input.w3x', '--compare', '--output', 'out.w3x'], ['input.w3x', '--compare', '--details']]) assert.throws(() => parseArguments(args));
});

test('CLI exposes strengthening modes without enabling runtime strings or choosing VM functions implicitly', () => {
    const parsed = parseArguments(['--show-settings', '--name-mode', 'seeded', '--seed', ' seed 한글 ', '--string-mode', 'runtime', '--vm-function', 'First', '--vm-function', 'Second']);
    assert.equal(parsed.overrides.lua.seed, ' seed 한글 ');
    assert.deepEqual(parsed.overrides.lua.vmFunctions, ['First', 'Second']);
    const result = capture(['--show-settings', '--name-mode', 'seeded', '--seed=--reproducible', '--string-mode', 'runtime']);
    assert.equal(result.status, 0, result.stderr);
    const { config } = JSON.parse(result.stdout);
    assert.equal(config.lua.nameMode, 'seeded');
    assert.equal(config.lua.seed, '--reproducible');
    assert.deepEqual(config.lua.vmFunctions, []);
    assert.equal(config.strings.mode, 'runtime');
    assert.equal(config.strings.enabled, false);
    const hardened = capture(['--show-settings', '--preset', 'hardened', '--no-runtime-strings']);
    assert.equal(hardened.status, 0, hardened.stderr);
    assert.equal(JSON.parse(hardened.stdout).config.strings.mode, 'escape');
    assert.equal(JSON.parse(hardened.stdout).config.strings.enabled, true);
    for (const options of [['--name-mode'], ['--seed'], ['--string-mode'], ['--vm-function'], ['--name-mode', 'compact', '--name-mode', 'seeded'], ['--seed=x', '--seed', 'y'], ['--string-mode', 'runtime', '--no-runtime-strings'], ['--no-vm', '--no-vm']]) assert.throws(() => parseArguments(['--show-settings', ...options]));
    for (const options of [['--name-mode', 'unknown'], ['--seed='], ['--string-mode', 'unknown'], ['--vm-function', 'bad-name']]) assert.equal(capture(['--show-settings', ...options]).status, 1);
});

test('CLI VM disable clears JSON and repeated selections in either argument order while strict JSON is still validated', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'w3lua-settings-test-'));
    t.after(() => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert(path.basename(directory).startsWith('w3lua-settings-test-')); fs.rmSync(directory, { recursive: true, force: true }); });
    const configuration = configFile(directory, { lua: { vmFunctions: ['Configured', 'Same'], keepLocals: ['Kept'] } });
    const selected = capture(['--show-settings', '--config', configuration, '--vm-function', 'Cli', '--vm-function', 'Same']);
    assert.equal(selected.status, 0, selected.stderr);
    assert.deepEqual(JSON.parse(selected.stdout).config.lua.vmFunctions, ['Configured', 'Same', 'Cli']);
    for (const flags of [['--vm-function', 'Cli', '--no-vm'], ['--no-vm', '--vm-function', 'Cli']]) {
        const result = capture(['--show-settings', '--config', configuration, ...flags]);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout).config.lua.vmFunctions, []);
        assert.deepEqual(JSON.parse(result.stdout).config.lua.keepLocals, ['Kept']);
    }
    const invalid = configFile(directory, { lua: { vmFunctions: ['bad-name'] } }, 'invalid.json');
    assert.equal(capture(['--show-settings', '--config', invalid, '--no-vm']).status, 1);
    const invalidSeed = configFile(directory, { lua: { seed: '' } }, 'seed.json');
    assert.equal(capture(['--show-settings', '--config', invalidSeed, '--seed', 'valid']).status, 1);
    assert.deepEqual(fs.readdirSync(directory).sort(), ['config.json', 'invalid.json', 'seed.json']);
});

test('CLI validates explicitly selected VM functions and reports the applied count without producing a protected map', t => {
    const map = fixture(t, { script: 'local function Reviewed(x) local y = x + 1 return y end\nfunction config() end\nfunction main() return Reviewed(2) end' });
    const checked = capture([map.source, '--check', '--name-mode', 'seeded', '--seed', 'CLI reproducible', '--vm-function', 'Reviewed']);
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /VM functions: 1/);
    const unsupported = capture([map.source, '--check', '--vm-function', 'main']);
    assert.equal(unsupported.status, 1);
    assert.match(unsupported.stderr, /VM|vm|local function|selected|selection/);
    const disabled = capture([map.source, '--check', '--vm-function', 'main', '--no-vm']);
    assert.equal(disabled.status, 0, disabled.stderr);
    assert.match(disabled.stdout, /VM functions: 0/);
    assertUnchanged(map, ['input.w3x']);
});

test('CLI comparison writes only JSON to the supplied stream and detail mode reports real packed savings', t => {
    const map = fixture(t);
    const compare = capture([map.source, '--compare']);
    assert.equal(compare.status, 0, compare.stderr);
    assert(JSON.parse(compare.stdout).comparisons.some(row => row.ok));
    const details = capture([map.source, '--check', '--details', '--compression-strategy', 'default', '--compression-strategy', 'filtered']);
    assert.equal(details.status, 0, details.stderr);
    assert.match(details.stdout, /"savedBytes"/);
    assert.match(details.stdout, /"blockIndex"/);
    assert.deepEqual(fs.readdirSync(map.root), ['input.w3x']);
    assert.deepEqual(fs.readFileSync(map.source), map.bytes);
});
function fixture(t, options = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w3lua-cli-test-'));
    t.after(() => {
        const resolved = path.resolve(root);
        assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
        assert(path.basename(resolved).startsWith('w3lua-cli-test-'));
        fs.rmSync(resolved, { recursive: true, force: true });
    });
    const source = path.join(root, 'input.w3x'), bytes = createLuaMap(options);
    fs.writeFileSync(source, bytes);
    return { root, source, bytes, output: path.join(root, 'never-created.w3x') };
}
function capture(args) {
    let stdout = '', stderr = '';
    const status = run(args, { stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } } });
    return { status, stdout, stderr };
}
function configFile(root, configuration, name = 'config.json') {
    const file = path.join(root, name);
    fs.writeFileSync(file, JSON.stringify(configuration));
    return file;
}
function assertUnchanged(map, expectedFiles) {
    assert.deepEqual(fs.readFileSync(map.source), map.bytes);
    assert(!fs.existsSync(map.output));
    assert.deepEqual(fs.readdirSync(map.root).sort(), expectedFiles.sort());
}

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

test('run validates an on-disk synthetic input in check mode and creates no output or temporary artifacts', t => {
    const map = fixture(t, { mpq: { prefix: Buffer.alloc(0), attributes: true } });
    const result = capture([map.source, '--check', '--output', map.output]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Checked in memory/);
    assert.match(result.stdout, /local names changed: 1/);
    assert.equal(result.stderr, '');
    assertUnchanged(map, ['input.w3x']);
});

test('standalone check executes the full map pipeline with JSON and leaves only its input fixtures', t => {
    const map = fixture(t, { extraEntries: [['war3map.wtg', Buffer.from('editor')]], mpq: { attributes: true } });
    const settings = configFile(map.root, { lua: { minify: false, renameLocals: false }, compression: { enabled: false } });
    const result = spawnSync(process.execPath, [cliPath, map.source, '--config', settings, '--check'], { encoding: 'utf8', cwd: map.root });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Checked in memory/);
    assert.match(result.stdout, /local names changed: 0/);
    assert.match(result.stdout, /files removed: 0/);
    assertUnchanged(map, ['input.w3x', 'config.json']);
});

test('CLI flags override valid JSON booleans and append every exclusion array', t => {
    const script = 'function config() end\nfunction main() local Configured=1;local Cli=2;local Repeated=3;local Rename=4;return Configured+Cli+Repeated+Rename end';
    const map = fixture(t, { script, extraEntries: [
        ['war3map.wtg', Buffer.from('editor trigger')], ['war3map.wct', Buffer.from('editor script')],
        ['first.bin', Buffer.alloc(4096, 65)], ['second.bin', Buffer.alloc(4096, 66)],
    ] });
    const settings = configFile(map.root, { lua: { keepLocals: ['Configured'] }, cleanup: { editor: true, keepFiles: ['war3map.wtg'] }, compression: { excludeFiles: ['first.bin'] } });
    const result = capture([map.source, '--config', settings, '--check', '--keep-local', 'Cli', '--keep-local', 'Repeated', '--keep-file', 'war3map.wct', '--exclude-compress', 'second.bin']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /local names changed: 1/);
    assert.match(result.stdout, /files removed: 0/);
    const expected = protectMap(map.bytes, { lua: { keepLocals: ['Configured', 'Cli', 'Repeated'] }, cleanup: { editor: true, keepFiles: ['war3map.wtg', 'war3map.wct'] }, compression: { excludeFiles: ['first.bin', 'second.bin'] } });
    const printedSize = Number(result.stdout.match(/Map bytes: \d+ -> (\d+)/)[1]);
    assert.equal(printedSize, expected.bytes.length, 'Compression exclusions from JSON and flags are both effective');
    const override = capture([map.source, '--config', settings, '--check', '--no-minify', '--no-rename', '--no-cleanup', '--no-compress']);
    assert.equal(override.status, 0, override.stderr);
    assert.match(override.stdout, /local names changed: 0/);
    assert.match(override.stdout, /files removed: 0/);
    assertUnchanged(map, ['input.w3x', 'config.json']);
});

test('string flags override JSON enablement and append decoded keep values', t => {
    const script = 'function config() end\nfunction main() local first="Configured message";local second="CLI message";local third="Encoded message";return first,second,third end';
    const map = fixture(t, { script });
    const settings = configFile(map.root, { strings: { enabled: false, keep: ['Configured message'] } });
    const result = capture([map.source, '--config', settings, '--check', '--hide-strings', '--keep-string', 'CLI message']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /strings hidden: 1/);
    const enabled = configFile(map.root, { strings: { enabled: true } }, 'enabled.json');
    const disabled = capture([map.source, '--config', enabled, '--check', '--no-hide-strings']);
    assert.equal(disabled.status, 0, disabled.stderr);
    assert.match(disabled.stdout, /strings hidden: 0/);
    const parsed = parseArguments([map.source, '--check', '--hide-strings', '--keep-string', '첫 번째 값', '--keep-string', 'Second value', '--cleanup-contract', 'contract.json']);
    assert.equal(parsed.overrides.strings.enabled, true);
    assert.deepEqual(parsed.overrides.strings.keep, ['첫 번째 값', 'Second value']);
    assert.equal(parsed.cleanupContractPath, 'contract.json');
    assertUnchanged(map, ['input.w3x', 'config.json', 'enabled.json']);
});

test('new string and contract options reject missing values, repetition and conflicting enablement', () => {
    for (const options of [
        ['--keep-string'], ['--cleanup-contract'], ['--cleanup-contract', 'a.json', '--cleanup-contract', 'b.json'],
        ['--hide-strings', '--hide-strings'], ['--hide-strings', '--no-hide-strings'], ['--no-hide-strings', '--hide-strings'],
    ]) assert.throws(() => parseArguments(['input.w3x', '--check', ...options]));
});

test('inline keep-string values preserve empty and option-prefixed string values in the full pipeline', t => {
    const map = fixture(t, { script: 'function config() end\nfunction main() return "", "-- status message --", "other message" end' });
    const settings = configFile(map.root, { strings: { keep: ['other message'] } });
    const args = [map.source, '--check', '--config', settings, '--hide-strings', '--keep-string=', '--keep-string=-- status message --'];
    assert.deepEqual(parseArguments(args).overrides.strings.keep, ['', '-- status message --']);
    const result = capture(args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /strings hidden: 0/);
    assertUnchanged(map, ['input.w3x', 'config.json']);
});

test('malformed or invalid JSON settings fail before output publication even when CLI flags would override them', t => {
    const map = fixture(t);
    const file = path.join(map.root, 'config.json');
    for (const text of ['{', '[]', '{"unknown":true}', '{"lua":{"minify":"true"}}', '{"compression":{"levels":[10]}}', '{"strings":{"enabled":1}}']) {
        fs.writeFileSync(file, text);
        const result = capture([map.source, '--config', file, '--output', map.output, '--no-minify']);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /Protection failed/);
        assert.equal(result.stdout, '');
        assertUnchanged(map, ['input.w3x', 'config.json']);
    }
});

test('transformation failures do not publish a map and keep the synthetic source unchanged', t => {
    const map = fixture(t, { script: 'function config() end\nfunction main(' });
    const result = capture([map.source, '--output', map.output]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Protection failed:.*expected/);
    assertUnchanged(map, ['input.w3x']);
    const processResult = spawnSync(process.execPath, [cliPath, map.source, '--output', map.output], { encoding: 'utf8' });
    assert.equal(processResult.status, 1);
    assert.match(processResult.stderr, /Protection failed/);
    assertUnchanged(map, ['input.w3x']);
});

test('opaque loader refusal in the full CLI pipeline publishes no output', t => {
    const map = fixture(t, { script: 'function config() end\nfunction main() local loaded=loadfile("external.lua");return loaded end' });
    const failed = capture([map.source, '--output', map.output]);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /Protection failed/);
    assertUnchanged(map, ['input.w3x']);
    const preserved = capture([map.source, '--check', '--no-rename', '--no-minify']);
    assert.equal(preserved.status, 0, preserved.stderr);
    assertUnchanged(map, ['input.w3x']);
});

test('missing input and directory input failures create no target or processing artifacts', t => {
    const map = fixture(t), absent = path.join(map.root, 'absent.w3x'), folder = path.join(map.root, 'folder.w3x');
    fs.mkdirSync(folder);
    for (const input of [absent, folder]) {
        const failed = capture([input, '--output', map.output]);
        assert.equal(failed.status, 1);
        assert.match(failed.stderr, /Protection failed/);
    }
    assertUnchanged(map, ['input.w3x', 'folder.w3x']);
});

test('existing output fixtures and input aliases are refused before any transform or publication', t => {
    const map = fixture(t);
    const existing = path.join(map.root, 'existing.w3x');
    fs.writeFileSync(existing, 'existing placeholder, not a protected map');
    const result = capture([map.source, '--output', existing]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /already exists/);
    assert.equal(fs.readFileSync(existing, 'utf8'), 'existing placeholder, not a protected map');
    const same = capture([map.source, '--output', map.source]);
    assert.equal(same.status, 1);
    assert.match(same.stderr, /differ from input/);
    assertUnchanged(map, ['input.w3x', 'existing.w3x']);
});

test('reviewed cleanup contracts load separately from config and are bound to the exact synthetic input', t => {
    const map = fixture(t, { script: 'function config() end\nfunction main() local environment=_G;return environment end', extraEntries: [['war3map.wtg', Buffer.from('editor')]] });
    const options = ['--check', '--clean-editor', '--no-minify', '--no-rename'];
    assert.equal(capture([map.source, ...options]).status, 1, 'Unreviewed unresolved environment access remains refused');
    const digest = bytes => createHash('sha256').update(bytes).digest('hex');
    const reviewed = { version: 1, inputMapSha256: digest(map.bytes), scriptSha256: digest(openMap(map.bytes).read('war3map.lua')),
        review: { dynamicFileAccess: 'This synthetic script returns its environment but never invokes file APIs.', objectAndImportReferences: 'The synthetic input has no objects or import manifest.', limitations: 'This contract applies only to the deliberately minimal test fixture.' },
        files: [{ path: 'war3map.wtg', reason: 'Test-only editor data is unused by the fixture script.', evidence: ['The complete fixture has only config and main, neither reads editor data.'] }],
    };
    const contract = configFile(map.root, reviewed, 'contract.json');
    const result = capture([map.source, ...options, '--cleanup-contract', contract]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /files removed: 1/);
    const stale = configFile(map.root, { ...reviewed, inputMapSha256: '0'.repeat(64) }, 'stale.json');
    const failed = capture([map.source, '--output', map.output, '--clean-editor', '--no-minify', '--no-rename', '--cleanup-contract', stale]);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /SHA-256 mismatch/);
    assertUnchanged(map, ['input.w3x', 'contract.json', 'stale.json']);
});

test('bad cleanup contract JSON and schema publish no output', t => {
    const map = fixture(t, { extraEntries: [['war3map.wtg', Buffer.from('editor')]] });
    const contract = path.join(map.root, 'contract.json');
    for (const text of ['{', '[]', '{}', '{"version":99}']) {
        fs.writeFileSync(contract, text);
        const result = capture([map.source, '--output', map.output, '--clean-editor', '--cleanup-contract', contract]);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /Protection failed/);
        assertUnchanged(map, ['input.w3x', 'contract.json']);
    }
});

test('CLI presets enforce check-only and reviewed cleanup while JSON overrides preset settings', t => {
    const map = fixture(t);
    const settings = configFile(map.root, { lua: { renameLocals: true } });
    const checked = capture([map.source, '--check', '--preset', 'size', '--config', settings]);
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /local names changed: 1/);
    const prohibited = capture([map.source, '--output', map.output, '--preset', 'fast-check']);
    assert.equal(prohibited.status, 1);
    assert.match(prohibited.stderr, /only supports --check/);
    assert.equal(capture([map.source, '--check', '--preset', 'distribution']).status, 1);
    assert.equal(capture([map.source, '--check', '--preset', 'distribution', '--no-cleanup']).status, 0);
    assertUnchanged(map, ['input.w3x', 'config.json']);
});

test('CLI review prints a proposal and saves a new contract only with an explicit JSON target', t => {
    const map = fixture(t, { extraEntries: [['war3map.wtg', Buffer.from('editor')]] });
    const digest = bytes => createHash('sha256').update(bytes).digest('hex');
    const reviewed = { version: 1, inputMapSha256: digest(map.bytes), scriptSha256: digest(openMap(map.bytes).read('war3map.lua')),
        review: { dynamicFileAccess: 'No loader in synthetic fixture.', objectAndImportReferences: 'No imported assets.', limitations: 'Synthetic fixture only.' },
        files: [{ path: 'war3map.wtg', reason: 'Unused editor data.', evidence: ['Complete root Lua is independent of editor data.'] }] };
    const contract = configFile(map.root, reviewed, 'previous.json');
    const args = [map.source, '--review-cleanup', '--previous-input', map.source, '--cleanup-contract', contract];
    const comparison = capture(args);
    assert.equal(comparison.status, 0, comparison.stderr);
    assert(JSON.parse(comparison.stdout).review.candidate);
    assertUnchanged(map, ['input.w3x', 'previous.json']);
    const next = path.join(map.root, 'new.json');
    assert.equal(capture([...args, '--contract-output', next]).status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(contract)), reviewed);
    assert.equal(capture([...args, '--contract-output', next]).status, 1);
    assertUnchanged(map, ['input.w3x', 'previous.json', 'new.json']);
});

test('CLI rejects mixed review settings, missing comparison inputs and ambiguous preset flags', () => {
    for (const options of [
        ['--preset'], ['--preset', 'size', '--preset', 'protect'], ['--previous-input', 'old.w3x'], ['--contract-output', 'next.json'],
        ['--review-cleanup'], ['--review-cleanup', '--previous-input', 'old.w3x', '--cleanup-contract', 'old.json', '--check'],
        ['--review-cleanup', '--previous-input', 'old.w3x', '--cleanup-contract', 'old.json', '--hide-strings'],
    ]) assert.throws(() => parseArguments(['input.w3x', '--check', ...options]));
    assert.equal(capture(['input.w3x', '--check', '--preset', 'unknown']).status, 1);
});

test('CLI enables or disables global, field and native options and selects a sector size explicitly', () => {
    const parsed = parseArguments(['--show-settings', '--rename-globals', '--rename-fields', '--hide-natives', '--keep-global', 'First', '--keep-global', 'Second', '--sector-size-shift', '7']);
    assert.deepEqual(parsed.overrides.lua, { renameGlobals: true, renameFields: true, hideNatives: true, keepGlobals: ['First', 'Second'] });
    assert.equal(parsed.overrides.compression.sectorSizeShift, 7);
    const disabled = parseArguments(['--show-settings', '--preset', 'maximum', '--no-rename-globals', '--no-rename-fields', '--no-hide-natives', '--keep-sector-size']);
    assert.deepEqual(disabled.overrides.lua, { renameGlobals: false, renameFields: false, hideNatives: false });
    assert.equal(disabled.overrides.compression.sectorSizeShift, null);
    for (const options of [['--rename-globals', '--no-rename-globals'], ['--no-hide-natives', '--hide-natives'], ['--rename-fields', '--rename-fields'],
        ['--sector-size-shift'], ['--sector-size-shift', 'big'], ['--sector-size-shift', '7', '--keep-sector-size'], ['--keep-global']]) {
        assert.throws(() => parseArguments(['--show-settings', ...options]), options.join(' '));
    }
});

test('CLI toggles FourCC folding, editor data cleanup and listfile removal', () => {
    const parsed = parseArguments(['--show-settings', '--fold-fourcc', '--clean-editor-data', '--remove-listfile']);
    assert.equal(parsed.overrides.lua.foldFourCC, true);
    assert.deepEqual(parsed.overrides.cleanup, { editorData: true, listfile: true });
    const kept = parseArguments(['--show-settings', '--preset', 'maximum', '--no-fold-fourcc', '--keep-listfile', '--no-cleanup']);
    assert.equal(kept.overrides.lua.foldFourCC, false);
    assert.deepEqual(kept.overrides.cleanup, { listfile: false, editor: false, development: false, editorData: false, editorBlock: false });
    for (const options of [['--fold-fourcc', '--no-fold-fourcc'], ['--remove-listfile', '--keep-listfile'], ['--clean-editor-data', '--no-cleanup'], ['--clean-editor-data', '--clean-editor-data']]) {
        assert.throws(() => parseArguments(['--show-settings', ...options]), options.join(' '));
    }
});

test('CLI selects Zopfli compression candidates explicitly', () => {
    assert.equal(parseArguments(['--show-settings', '--zopfli']).overrides.compression.zopfli, true);
    assert.equal(parseArguments(['--show-settings', '--no-zopfli']).overrides.compression.zopfli, false);
    assert.throws(() => parseArguments(['--show-settings', '--zopfli', '--no-zopfli']));
    assert.throws(() => parseArguments(['--show-settings', '--zopfli', '--zopfli']));
});

test('unreadable configuration and contract files are named in the error', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w3lua-cli-config-'));
    t.after(() => fs.rmSync(root, { recursive: true }));
    const broken = path.join(root, 'broken.json'), missing = path.join(root, 'missing.json'), map = path.join(root, 'input.w3x');
    fs.writeFileSync(broken, '{bad');
    fs.writeFileSync(map, 'not read before the JSON files fail');
    for (const [args, prefix, detail] of [
        [['--config', broken], 'Configuration file ' + broken + ': ', /JSON/],
        [['--config', missing], 'Configuration file ' + missing + ': ', /ENOENT/],
        [['--cleanup-contract', broken], 'Cleanup contract ' + broken + ': ', /JSON/],
    ]) {
        let err = '';
        const status = run([map, '--check', ...args], { stdout: { write() {} }, stderr: { write: value => { err += value; } } });
        assert.equal(status, 1);
        assert(err.includes(prefix), err);
        assert.match(err, detail);
    }
});

test('CLI toggles experimental editor blocking and clears it with --no-cleanup', () => {
    assert.equal(parseArguments(['--show-settings', '--block-editor']).overrides.cleanup.editorBlock, true);
    assert.equal(parseArguments(['--show-settings', '--no-block-editor']).overrides.cleanup.editorBlock, false);
    assert.equal(parseArguments(['--show-settings', '--no-cleanup']).overrides.cleanup.editorBlock, false);
    for (const options of [['--block-editor', '--no-block-editor'], ['--block-editor', '--no-cleanup'], ['--block-editor', '--block-editor']]) {
        assert.throws(() => parseArguments(['--show-settings', ...options]));
    }
});

test('CLI toggles the experimental all-literal string scope', () => {
    assert.equal(parseArguments(['--show-settings', '--hide-all-strings']).overrides.strings.allLiterals, true);
    assert.equal(parseArguments(['--show-settings', '--no-hide-all-strings']).overrides.strings.allLiterals, false);
    for (const options of [['--hide-all-strings', '--no-hide-all-strings'], ['--hide-all-strings', '--hide-all-strings']]) assert.throws(() => parseArguments(['--show-settings', ...options]));
    const result = run(['--show-settings', '--preset', 'hardened', '--hide-all-strings'], { stdout: { write() {} }, stderr: { write(text) { throw new Error(text); } } });
    assert.equal(result, 0);
});

test('CLI selects the editor block format and target files', () => {
    const parsed = parseArguments(['--show-settings', '--block-editor', '--editor-block-format', 'truncated', '--editor-block-files', 'wct']);
    assert.deepEqual(parsed.overrides.cleanup, { editorBlock: true, editorBlockFormat: 'truncated', editorBlockFiles: 'wct' });
    assert.throws(() => parseArguments(['--show-settings', '--editor-block-format', 'empty', '--editor-block-format', 'version']), /Repeated option/);
    assert.throws(() => parseArguments(['--show-settings', '--editor-block-files']), /Missing value/);
});

test('CLI accepts dynamic access for editor blocking only when stated explicitly', () => {
    assert.equal(parseArguments(['--show-settings', '--block-editor', '--block-editor-accept-dynamic']).overrides.cleanup.editorBlockAcceptDynamic, true);
    assert.throws(() => parseArguments(['--show-settings', '--block-editor-accept-dynamic', '--no-cleanup']), /conflicts/);
});

test('CLI toggles experimental audio metadata stripping', () => {
    assert.equal(parseArguments(['--show-settings', '--strip-media-metadata']).overrides.compression.stripMediaMetadata, true);
    assert.equal(parseArguments(['--show-settings', '--no-strip-media-metadata']).overrides.compression.stripMediaMetadata, false);
    assert.throws(() => parseArguments(['--show-settings', '--strip-media-metadata', '--no-strip-media-metadata']), /conflicts/);
});

test('CLI toggles experimental runtime string preloading and escape mode clears it', () => {
    assert.equal(parseArguments(['--show-settings', '--preload-strings']).overrides.strings.preload, true);
    assert.equal(parseArguments(['--show-settings', '--no-runtime-strings']).overrides.strings.preload, false);
    assert.throws(() => parseArguments(['--show-settings', '--preload-strings', '--no-preload-strings']), /conflicts/);
});
