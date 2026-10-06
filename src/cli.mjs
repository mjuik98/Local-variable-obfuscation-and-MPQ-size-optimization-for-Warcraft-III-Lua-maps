#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { executeJob } from './jobs.mjs';

const USAGE = `Usage: w3lua-protect <input.w3x|input.w3m> --output <new-map> [options]
       w3lua-protect <input.w3x|input.w3m> --check [options]
       w3lua-protect <input.w3x|input.w3m> --compare [options]
       w3lua-protect --show-settings [options]

--check                 Validate the full transformation in memory; write no files
--config <file.json>     Read strict JSON transformation settings
--preset <id>           fast-check, size, protect, distribution, hardened or maximum
--show-settings         Preview resolved settings without opening a map
--compare               Compare presets/string choices in memory; write no maps
--details               Show packed file savings after a check or save
--compression-strategy <id> default, filtered, huffman-only, rle or fixed (repeatable)
--no-minify             Preserve comments and whitespace
--no-rename             Preserve local names
--rename-globals        Rename script-defined globals with only static lookups (experimental)
--no-rename-globals     Preserve global names
--rename-fields         Rename fields of closed tables (experimental)
--no-rename-fields      Preserve table field names
--keep-global <name>    Preserve a global name (repeatable)
--hide-natives          Call engine functions through one local table (experimental)
--no-hide-natives       Call engine functions by their global names
--fold-fourcc           Replace FourCC calls on literal rawcodes with integers (experimental)
--no-fold-fourcc        Keep FourCC calls
--name-mode <id>        compact or seeded local names (default: compact)
--seed <value>          Reproducible seed for strengthened transforms
--string-mode <id>      escape or runtime; enable separately with --hide-strings
--no-runtime-strings    Use escape string mode
--vm-function <name>    Select a reviewed local computation function for experimental VM (repeatable)
--no-vm                Clear every selected VM function, including JSON selections
--hide-strings          Hide eligible literals using the selected string mode
--no-hide-strings       Disable string encoding set in configuration
--keep-string <value>   Preserve a decoded string value (repeatable)
--keep-string=<value>   Preserve any value, including empty or -- prefixed strings
--no-cleanup            Preserve editor and development files
--clean-editor          Remove the two known editor trigger files if references can be checked
--clean-development     Remove the two known LoTKT development metadata files
--clean-editor-data     Remove editor region, camera, sound data and the import manifest if references can be checked
--remove-listfile       Remove the MPQ (listfile) after every other stage (experimental)
--keep-listfile         Keep the MPQ (listfile)
--cleanup-contract <file.json> Use a reviewed cleanup contract tied to the exact input
--review-cleanup        Compare the previous reviewed map with this input; write no map
--previous-input <map>  Previous input matched by --cleanup-contract
--contract-output <new.json> Explicitly save a repack-only proposed contract
--no-compress           Skip compression optimization
--sector-size-shift <n> Rebuild the MPQ with 512*2^n byte sectors, n = 3..8 (experimental)
--keep-sector-size      Keep the input MPQ sector size
--keep-local <name>     Preserve a local name (repeatable)
--keep-file <path>      Preserve a cleanup candidate (repeatable)
--exclude-compress <path> Skip recompression of an entry (repeatable)
--help                  Show this usage
`;

export function parseArguments(args) {
    const parsed = { input: null, output: null, configPath: null, cleanupContractPath: null, preset: null, previousInput: null, contractOutput: null, reviewCleanup: false, check: false, compare: false, showSettings: false, details: false, help: false, noVm: false, overrides: { lua: {}, strings: {}, cleanup: {}, compression: {} } };
    const seen = new Set();
    const unique = flag => { assert(!seen.has(flag), 'Repeated option: ' + flag); seen.add(flag); };
    for (let index = 0; index < args.length; index++) {
        const argument = args[index];
        const value = () => { const next = args[++index]; assert(next && !next.startsWith('--'), 'Missing value for ' + argument); return next; };
        if (['--output', '--config', '--cleanup-contract', '--preset', '--previous-input', '--contract-output'].includes(argument)) {
            unique(argument);
            const keys = { '--output': 'output', '--config': 'configPath', '--cleanup-contract': 'cleanupContractPath', '--preset': 'preset', '--previous-input': 'previousInput', '--contract-output': 'contractOutput' };
            parsed[keys[argument]] = value();
        } else if (argument === '--check' || argument === '--help') {
            unique(argument); parsed[argument.slice(2)] = true;
        } else if (argument === '--review-cleanup') {
            unique(argument); parsed.reviewCleanup = true;
        } else if (argument === '--compare' || argument === '--details' || argument === '--show-settings') {
            unique(argument); parsed[argument === '--show-settings' ? 'showSettings' : argument.slice(2)] = true;
        } else if (argument === '--compression-strategy') {
            (parsed.overrides.compression.strategies ??= []).push(value());
        } else if (['--name-mode', '--seed', '--string-mode'].includes(argument)) {
            unique(argument); const [section, key] = argument === '--name-mode' ? ['lua', 'nameMode'] : argument === '--seed' ? ['lua', 'seed'] : ['strings', 'mode']; parsed.overrides[section][key] = value();
        } else if (argument.startsWith('--seed=')) {
            unique('--seed'); parsed.overrides.lua.seed = argument.slice('--seed='.length);
        } else if (argument === '--no-vm') {
            unique(argument); parsed.noVm = true;
        } else if (argument === '--no-runtime-strings') {
            unique(argument); parsed.overrides.strings.mode = 'escape';
        } else if (['--rename-globals', '--no-rename-globals', '--rename-fields', '--no-rename-fields', '--hide-natives', '--no-hide-natives', '--fold-fourcc', '--no-fold-fourcc'].includes(argument)) {
            const key = argument.endsWith('globals') ? 'renameGlobals' : argument.endsWith('fields') ? 'renameFields' : argument.endsWith('fourcc') ? 'foldFourCC' : 'hideNatives';
            const opposite = argument.startsWith('--no-') ? '--' + argument.slice(5) : '--no-' + argument.slice(2);
            assert(!seen.has(opposite), argument + ' conflicts with ' + opposite);
            unique(argument); parsed.overrides.lua[key] = !argument.startsWith('--no-');
        } else if (argument === '--sector-size-shift' || argument === '--keep-sector-size') {
            assert(!seen.has('--sector-size-shift') && !seen.has('--keep-sector-size'), '--sector-size-shift conflicts with --keep-sector-size');
            unique(argument);
            if (argument === '--keep-sector-size') parsed.overrides.compression.sectorSizeShift = null;
            else {
                const text = value();
                assert(/^[0-9]+$/.test(text), '--sector-size-shift requires an integer');
                parsed.overrides.compression.sectorSizeShift = Number(text);
            }
        } else if (argument === '--no-minify' || argument === '--no-rename') {
            unique(argument); parsed.overrides.lua[argument === '--no-minify' ? 'minify' : 'renameLocals'] = false;
        } else if (argument === '--no-cleanup') {
            unique(argument); Object.assign(parsed.overrides.cleanup, { editor: false, development: false, editorData: false });
        } else if (argument === '--clean-development' || argument === '--clean-editor' || argument === '--clean-editor-data') {
            unique(argument); parsed.overrides.cleanup[argument === '--clean-editor' ? 'editor' : argument === '--clean-editor-data' ? 'editorData' : 'development'] = true;
        } else if (argument === '--remove-listfile' || argument === '--keep-listfile') {
            assert(!seen.has('--remove-listfile') && !seen.has('--keep-listfile'), '--remove-listfile conflicts with --keep-listfile');
            unique(argument); parsed.overrides.cleanup.listfile = argument === '--remove-listfile';
        } else if (argument === '--no-compress') {
            unique(argument); parsed.overrides.compression.enabled = false;
        } else if (argument === '--hide-strings' || argument === '--no-hide-strings') {
            unique(argument); parsed.overrides.strings.enabled = argument === '--hide-strings';
        } else if (argument.startsWith('--keep-string=')) {
            (parsed.overrides.strings.keep ??= []).push(argument.slice('--keep-string='.length));
        } else if (['--keep-local', '--keep-global', '--keep-file', '--exclude-compress', '--keep-string', '--vm-function'].includes(argument)) {
            const [section, key] = argument === '--vm-function' ? ['lua', 'vmFunctions'] : argument === '--keep-local' ? ['lua', 'keepLocals'] : argument === '--keep-global' ? ['lua', 'keepGlobals'] : argument === '--keep-file' ? ['cleanup', 'keepFiles'] : argument === '--keep-string' ? ['strings', 'keep'] : ['compression', 'excludeFiles'];
            (parsed.overrides[section][key] ??= []).push(value());
        } else {
            assert(!argument.startsWith('-'), 'Unknown option: ' + argument);
            assert(parsed.input === null, 'Only one input map is supported');
            parsed.input = argument;
        }
    }
    assert(!(seen.has('--no-cleanup') && (seen.has('--clean-development') || seen.has('--clean-editor') || seen.has('--clean-editor-data'))), '--no-cleanup conflicts with cleanup options');
    assert(!(seen.has('--hide-strings') && seen.has('--no-hide-strings')), '--hide-strings conflicts with --no-hide-strings');
    assert(!(seen.has('--string-mode') && seen.has('--no-runtime-strings')), '--string-mode conflicts with --no-runtime-strings');
    if (!parsed.help) {
        if (parsed.showSettings) {
            assert(!parsed.input && !parsed.output && !parsed.check && !parsed.compare && !parsed.details && !parsed.reviewCleanup && !parsed.previousInput && !parsed.contractOutput && !parsed.cleanupContractPath, '--show-settings accepts only preset and transformation settings');
            return parsed;
        }
        assert(parsed.input, 'An input map is required');
        assert(/\.w3[xm]$/i.test(parsed.input), 'Input must be a .w3x or .w3m file');
        if (parsed.reviewCleanup) {
            assert(parsed.previousInput && parsed.cleanupContractPath, 'Contract review requires --previous-input and --cleanup-contract');
            assert(!parsed.check && !parsed.compare && !parsed.details && !parsed.output && !parsed.configPath && !parsed.preset && !parsed.noVm && Object.values(parsed.overrides).every(section => !Object.keys(section).length), 'Contract review conflicts with transformation options');
        } else {
            assert(!parsed.compare || (!parsed.output && !parsed.check && !parsed.details), '--compare conflicts with output, check and details options');
            assert(parsed.check || parsed.compare || parsed.output, 'Specify --output, --check or --compare');
            assert(!parsed.previousInput && !parsed.contractOutput, 'Use --review-cleanup for contract review options');
        }
        if (parsed.output) assert(path.extname(parsed.output).toLowerCase() === path.extname(parsed.input).toLowerCase(), 'Output must use the same map extension');
    }
    return parsed;
}

export function run(args, { stdout = process.stdout, stderr = process.stderr } = {}) {
    try {
        const options = parseArguments(args);
        if (options.help) { stdout.write(USAGE); return 0; }
        if (options.showSettings) {
            stdout.write(JSON.stringify(executeJob({ action: 'settings', preset: options.preset, configPath: options.configPath, overrides: options.overrides, noVm: options.noVm }), null, 2) + '\n');
            return 0;
        }
        const request = options.reviewCleanup ? { action: options.contractOutput ? 'save-contract' : 'review', input: options.input, previousInput: options.previousInput, cleanupContractPath: options.cleanupContractPath, ...(options.contractOutput ? { contractOutput: options.contractOutput } : {}) }
            : { action: options.compare ? 'compare' : options.check ? 'check' : 'protect', input: options.input, output: options.output, preset: options.preset, configPath: options.configPath, cleanupContractPath: options.cleanupContractPath, overrides: options.overrides, noVm: options.noVm };
        const result = executeJob(request);
        if (options.reviewCleanup || options.compare) {
            stdout.write(JSON.stringify(result, null, 2) + '\n');
            return 0;
        }
        stdout.write((options.check ? 'Checked in memory' : 'Protected map saved') + ': ' + result.path + '\n');
        stdout.write('Map bytes: ' + result.summary.inputBytes + ' -> ' + result.summary.outputBytes + '; local names changed: ' + result.summary.lua.renamedLocals + '; strings hidden: ' + result.summary.strings.encodedLiterals + '; string mode: ' + (result.summary.strings.mode ?? result.config.strings.mode) + '; VM functions: ' + (result.summary.vm?.virtualizedFunctions ?? 0) + '; files removed: ' + result.summary.removedFiles.length + '\n');
        const lua = result.summary.lua;
        stdout.write('Global names changed: ' + (lua.renamedGlobals ?? 0) + '; fields changed: ' + (lua.renamedFields ?? 0) + ' in ' + (lua.closedTables ?? 0) +
            ' closed tables; engine functions hidden: ' + (result.summary.natives?.hiddenNatives ?? 0) + '; Lua library functions hidden: ' + (result.summary.natives?.hiddenLibraryFunctions ?? 0) + '; FourCC folded: ' + (result.summary.natives?.foldedFourCC ?? 0) + '; MPQ sector size: ' + result.summary.sectorSize + '\n');
        if (options.details) stdout.write(JSON.stringify(result.summary.savings, null, 2) + '\n');
        stdout.write('Warcraft III gameplay, multiplayer synchronization and performance require separate game testing.\n');
        return 0;
    } catch (error) {
        stderr.write('Protection failed: ' + error.message + '\n');
        return 1;
    }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = run(process.argv.slice(2));
