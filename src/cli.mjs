#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { protectMap } from './protect.mjs';
import { resolveConfig } from './config.mjs';
import { validateOutputPath, writeNewOutput } from './output.mjs';

const USAGE = `Usage: w3lua-protect <input.w3x|input.w3m> --output <new-map> [options]
       w3lua-protect <input.w3x|input.w3m> --check [options]

--check                 Validate the full transformation in memory; write no files
--config <file.json>     Read strict JSON transformation settings
--no-minify             Preserve comments and whitespace
--no-rename             Preserve local names
--no-cleanup            Preserve editor and development files
--clean-editor          Remove the two known editor trigger files if references can be checked
--clean-development     Remove the two known LoTKT development metadata files
--no-compress           Skip compression optimization
--keep-local <name>     Preserve a local name (repeatable)
--keep-file <path>      Preserve a cleanup candidate (repeatable)
--exclude-compress <path> Skip recompression of an entry (repeatable)
--help                  Show this usage
`;

export function parseArguments(args) {
    const parsed = { input: null, output: null, configPath: null, check: false, help: false, overrides: { lua: {}, cleanup: {}, compression: {} } };
    const seen = new Set();
    const unique = flag => { assert(!seen.has(flag), 'Repeated option: ' + flag); seen.add(flag); };
    for (let index = 0; index < args.length; index++) {
        const argument = args[index];
        const value = () => { const next = args[++index]; assert(next && !next.startsWith('--'), 'Missing value for ' + argument); return next; };
        if (['--output', '--config'].includes(argument)) {
            unique(argument);
            parsed[argument === '--output' ? 'output' : 'configPath'] = value();
        } else if (argument === '--check' || argument === '--help') {
            unique(argument); parsed[argument.slice(2)] = true;
        } else if (argument === '--no-minify' || argument === '--no-rename') {
            unique(argument); parsed.overrides.lua[argument === '--no-minify' ? 'minify' : 'renameLocals'] = false;
        } else if (argument === '--no-cleanup') {
            unique(argument); Object.assign(parsed.overrides.cleanup, { editor: false, development: false });
        } else if (argument === '--clean-development' || argument === '--clean-editor') {
            unique(argument); parsed.overrides.cleanup[argument === '--clean-editor' ? 'editor' : 'development'] = true;
        } else if (argument === '--no-compress') {
            unique(argument); parsed.overrides.compression.enabled = false;
        } else if (['--keep-local', '--keep-file', '--exclude-compress'].includes(argument)) {
            const [section, key] = argument === '--keep-local' ? ['lua', 'keepLocals'] : argument === '--keep-file' ? ['cleanup', 'keepFiles'] : ['compression', 'excludeFiles'];
            (parsed.overrides[section][key] ??= []).push(value());
        } else {
            assert(!argument.startsWith('-'), 'Unknown option: ' + argument);
            assert(parsed.input === null, 'Only one input map is supported');
            parsed.input = argument;
        }
    }
    assert(!(seen.has('--no-cleanup') && (seen.has('--clean-development') || seen.has('--clean-editor'))), '--no-cleanup conflicts with cleanup options');
    if (!parsed.help) {
        assert(parsed.input, 'An input map is required');
        assert(parsed.check || parsed.output, 'Specify --output or --check');
        assert(/\.w3[xm]$/i.test(parsed.input), 'Input must be a .w3x or .w3m file');
        if (parsed.output) assert(path.extname(parsed.output).toLowerCase() === path.extname(parsed.input).toLowerCase(), 'Output must use the same map extension');
    }
    return parsed;
}

export function run(args, { stdout = process.stdout, stderr = process.stderr } = {}) {
    try {
        const options = parseArguments(args);
        if (options.help) { stdout.write(USAGE); return 0; }
        const configuration = options.configPath ? JSON.parse(fs.readFileSync(options.configPath, 'utf8')) : {};
        const defaults = resolveConfig(configuration);
        const merged = Object.fromEntries(Object.keys(defaults).map(section => [section, { ...defaults[section], ...options.overrides[section],
            ...(options.overrides[section].keepLocals ? { keepLocals: [...defaults[section].keepLocals, ...options.overrides[section].keepLocals] } : {}),
            ...(options.overrides[section].keepFiles ? { keepFiles: [...defaults[section].keepFiles, ...options.overrides[section].keepFiles] } : {}),
            ...(options.overrides[section].excludeFiles ? { excludeFiles: [...defaults[section].excludeFiles, ...options.overrides[section].excludeFiles] } : {}),
        }]));
        const sourcePath = fs.realpathSync(options.input);
        assert(fs.statSync(sourcePath).isFile(), 'Input must be a file');
        const paths = options.output ? validateOutputPath(sourcePath, options.output) : { input: sourcePath, output: null };
        const original = fs.readFileSync(paths.input);
        const result = protectMap(original, merged);
        const unchanged = () => assert(fs.readFileSync(paths.input).equals(original), 'Input changed while processing; output cancelled');
        unchanged();
        if (!options.check) writeNewOutput(paths.output, result.bytes, { beforePublish: unchanged });
        stdout.write((options.check ? 'Checked in memory' : 'Protected map saved') + ': ' + (options.check ? paths.input : paths.output) + '\n');
        stdout.write('Map bytes: ' + result.summary.inputBytes + ' -> ' + result.summary.outputBytes + '; local names changed: ' + result.summary.lua.renamedLocals + '; files removed: ' + result.summary.removedFiles.length + '\n');
        stdout.write('Warcraft III gameplay, multiplayer synchronization and performance require separate game testing.\n');
        return 0;
    } catch (error) {
        stderr.write('Protection failed: ' + error.message + '\n');
        return 1;
    }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = run(process.argv.slice(2));
