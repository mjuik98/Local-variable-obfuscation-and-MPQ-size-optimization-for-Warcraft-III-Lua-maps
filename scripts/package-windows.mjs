import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
assert(process.platform === 'win32' && process.arch === 'x64', 'Build this Windows x64 package on Windows x64');
const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const parent = path.join(root, 'dist');
fs.mkdirSync(parent, { recursive: true });
const args = process.argv.slice(2);
assert(args.length === 0 || (args.length === 2 && args[0] === '--output'), 'Usage: npm run package:windows -- [--output dist/NewFolder]');
const destination = args.length ? path.resolve(root, args[1]) : path.join(parent, 'WarcraftLuaProtector-' + packageInfo.version + '-win-x64');
assert(path.dirname(destination).toLowerCase() === parent.toLowerCase(), 'Package output must be a new directory directly inside dist');
assert(!fs.existsSync(destination), 'Package already exists; refusing to overwrite: ' + destination);
const stage = fs.mkdtempSync(path.join(parent, '.w3lp-package-'));
try {
    fs.mkdirSync(path.join(stage, 'runtime'));
    fs.copyFileSync(process.execPath, path.join(stage, 'runtime', 'node.exe'));
    fs.cpSync(path.join(root, 'src'), path.join(stage, 'src'), { recursive: true });
    fs.mkdirSync(path.join(stage, 'node_modules'));
    for (const name of ['luaparse', 'fengari', 'readline-sync', 'sprintf-js', 'tmp', '@gfx/zopfli', 'base64-js']) {
        fs.mkdirSync(path.dirname(path.join(stage, 'node_modules', name)), { recursive: true });
        fs.cpSync(path.join(root, 'node_modules', name), path.join(stage, 'node_modules', name), { recursive: true });
    }
    fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: packageInfo.name, version: packageInfo.version, private: true, type: 'module' }, null, 2) + '\n');
    fs.copyFileSync(path.join(root, 'README.md'), path.join(stage, 'README.md'));
    fs.cpSync(path.join(root, 'cleanup'), path.join(stage, 'cleanup'), { recursive: true });
    // Carry the exact runtime's third-party notices. A failed license download
    // aborts packaging; no silently incomplete distribution is published.
    const licenseURL = 'https://raw.githubusercontent.com/nodejs/node/' + process.version + '/LICENSE';
    const response = await fetch(licenseURL, { signal: AbortSignal.timeout(30000) });
    assert(response.ok, 'Could not read the bundled Node.js license: ' + response.status);
    const license = await response.text();
    assert(license.includes('Node.js') && license.includes('Permission'), 'Unexpected Node.js license contents');
    fs.writeFileSync(path.join(stage, 'runtime', 'LICENSE.txt'), license);
    const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'desktop', 'build.ps1'), '-SourcePath', path.join(root, 'desktop', 'WarcraftLuaProtector.cs'), '-OutputPath', path.join(stage, 'WarcraftLuaProtector.exe')], { windowsHide: true, stdio: 'pipe' });
    execFileSync(path.join(stage, 'WarcraftLuaProtector.exe'), ['--smoke-test'], { windowsHide: true, stdio: 'pipe' });
    const presets = execFileSync(path.join(stage, 'runtime', 'node.exe'), [path.join(stage, 'src', 'desktop.mjs')], { input: JSON.stringify({ action: 'presets' }) + '\n', encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const event = JSON.parse(presets.trim().split('\n').at(-1));
    assert(event.ok && event.presets?.length === 6 && event.presets.some(preset => preset.id === 'maximum'), 'Packaged desktop backend did not return the six presets');
    fs.renameSync(stage, destination);
    process.stdout.write('Windows package ready: ' + destination + '\n');
} finally {
    if (fs.existsSync(stage)) {
        const resolved = path.resolve(stage);
        assert(path.dirname(resolved) === path.resolve(parent) && path.basename(resolved).startsWith('.w3lp-package-'), 'Unsafe package cleanup target');
        fs.rmSync(resolved, { recursive: true, force: true });
    }
}
