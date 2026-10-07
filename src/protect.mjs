import assert from 'node:assert/strict';
import { TextDecoder } from 'node:util';
import fengari from 'fengari';
import { openMap } from './mpq.mjs';
import { prepareLua } from './lua.mjs';
import { transformStrings } from './strings.mjs';
import { transformVm } from './vm.mjs';
import { transformNatives } from './natives.mjs';
import { resolveConfig, canonicalPath } from './config.mjs';
import { readScriptLanguage } from './map-info.mjs';
import { planCleanup } from './cleanup.mjs';
import { createSavingsTracker } from './savings.mjs';
import { stripMediaMetadata } from './media.mjs';

function assertCompilableLua(bytes) {
    const { lua, lauxlib, to_luastring, to_jsstring } = fengari, state = lauxlib.luaL_newstate();
    try {
        // Compile text only, with no libraries opened and no chunk execution.
        // This also catches temporary-register limits missed by AST parsing.
        const status = lauxlib.luaL_loadbufferx(state, bytes, bytes.length, to_luastring('@war3map.lua'), to_luastring('t'));
        assert.equal(status, lua.LUA_OK, status === lua.LUA_OK ? undefined :
            'Strengthened Lua compilation failed: ' + to_jsstring(lua.lua_tostring(state, -1)) +
            '. Recommended options: --no-runtime-strings --no-vm.');
    } finally { lua.lua_close(state); }
}

export function protectMap(input, configuration = {}, { cleanupContract, onProgress = () => {} } = {}) {
    assert(Buffer.isBuffer(input), 'protectMap requires map bytes');
    assert(typeof onProgress === 'function', 'onProgress must be a function');
    onProgress('validate');
    const config = resolveConfig(configuration);
    const signature = input.subarray(0, 4);
    assert(signature.equals(Buffer.from([77, 80, 81, 26])) || signature.toString('ascii') === 'HM3W', 'Expected a raw MPQ or HM3W-prefixed Warcraft III map');
    const original = openMap(input);
    assert(original.has('war3map.lua'), 'Missing root war3map.lua');
    assert(!original.has('war3map.j') && !original.has('Scripts\\war3map.j') && !original.has('Scripts\\war3map.lua'), 'Ambiguous or mixed map scripts are unsupported');
    assert(original.has('war3map.w3e'), 'Missing war3map.w3e terrain');
    const info = readScriptLanguage(original.read('war3map.w3i'));
    assert(info.language === 1, 'Map information selects JASS, not Lua');
    const scriptBytes = original.read('war3map.lua');
    const code = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(scriptBytes);
    assert(Buffer.from(code).equals(scriptBytes), 'Script must contain canonical UTF-8 bytes');
    const prepared = prepareLua(code, 'war3map.lua'), ast = prepared.ast;
    for (const name of ['main', 'config']) {
        const declarations = ast.body.filter(node => node.type === 'FunctionDeclaration' && !node.isLocal && node.identifier?.type === 'Identifier' && node.identifier.name === name);
        assert(declarations.length === 1, 'Expected one top-level ' + name + ' function');
    }
    const cleanup = planCleanup(original, ast, config.cleanup, { cleanupContract, scriptBytes, inputBytes: input });
    const savings = createSavingsTracker(input, original);
    onProgress('lua');
    const vm = transformVm(code, { functions: config.lua.vmFunctions, seed: config.lua.seed }, { prepared, prepareOutput: true });
    const luaInput = vm.prepared ?? prepared;
    const transformed = luaInput.transform(config.lua, { prepareOutput: config.strings.enabled || config.lua.hideNatives || config.lua.foldFourCC });
    const runtimeStrings = config.strings.enabled && config.strings.mode === 'runtime';
    const natives = transformNatives(transformed.code, { enabled: config.lua.hideNatives, encryptNames: runtimeStrings, foldFourCC: config.lua.foldFourCC, seed: config.lua.seed },
        { prepared: transformed.prepared, prepareOutput: config.strings.enabled });
    const strings = transformStrings(natives.code, config.strings, { prepared: natives.prepared, seed: config.lua.seed, forced: natives.forcedLiterals });
    const finalScript = Buffer.from(strings.code);
    if (vm.stats.virtualizedFunctions || natives.code !== transformed.code || strings.stats.mode === 'runtime') assertCompilableLua(finalScript);
    onProgress('archive');
    const replacements = [['war3map.lua', finalScript]];
    if (cleanup.imports) replacements.push(['war3map.imp', cleanup.imports]);
    replacements.push(...cleanup.blocked);
    const rewriteOptions = { levels: config.compression.enabled ? config.compression.levels : [0], strategies: config.compression.strategies,
        zopfli: config.compression.enabled && config.compression.zopfli };
    // Each stage reopens its result once; the reader is reused by the savings
    // snapshot and the next stage.
    let result = original.replace(replacements, rewriteOptions), archive = openMap(result);
    const stage = (id, label, bytes, options = {}) => {
        if (bytes !== result) { result = bytes; archive = openMap(result); }
        savings.record(id, label, result, { ...options, map: archive });
    };
    stage('lua', cleanup.blocked.length ? 'Lua·import·에디터 차단 기록 및 MPQ 공간 회수' : 'Lua·import 기록 및 MPQ 공간 회수', result, { rewrite: true });
    stage('cleanup', '파일 정리·목록 갱신 및 공간 회수', cleanup.names.length ? archive.remove(cleanup.names) : result, { rewrite: true });
    // Experimental: listed WAV/MP3 files lose metadata that carries no audio.
    // Aliased, localized, encrypted or excluded files keep their bytes.
    const media = [];
    if (config.compression.stripMediaMetadata) {
        const kept = new Set(config.compression.excludeFiles.map(canonicalPath)), metadata = archive.inspect({ includeHashes: true });
        for (const { name, slots } of metadata.namedEntries) {
            if (!/\.(wav|mp3)$/i.test(name) || slots.length !== 1 || kept.has(canonicalPath(name))) continue;
            const block = metadata.blocks[metadata.hashes[slots[0]].blockIndex];
            if (block.hashReferences !== 1 || (block.flags !== 0x80000000 && block.flags !== 0x80000200)) continue;
            const contents = archive.read(name, true), stripped = contents && stripMediaMetadata(name, contents);
            if (stripped) media.push({ name, stripped, savedBytes: contents.length - stripped.length });
        }
        stage('media', '오디오 메타데이터 제거', media.length ? archive.replace(media.map(({ name, stripped }) => [name, stripped]), rewriteOptions) : result, { rewrite: true });
    }
    if (config.compression.enabled) {
        const excluded = new Set(config.compression.excludeFiles.map(canonicalPath));
        for (const { name } of media) excluded.add(canonicalPath(name));
        // Changed payloads were just encoded with these exact candidates.
        // Identical replacements may have retained the original stream, so
        // they must still take part in the optional optimization below.
        for (const [name, contents] of replacements) {
            const previous = name === 'war3map.lua' ? scriptBytes : original.read(name);
            if (!previous?.equals(contents)) excluded.add(canonicalPath(name));
        }
        result = archive.optimize({ names: archive.listNames().filter(name => !excluded.has(canonicalPath(name))),
            levels: config.compression.levels, strategies: config.compression.strategies, zopfli: config.compression.zopfli });
        archive = openMap(result);
    }
    stage('recompression', '재압축·MPQ 공간 회수', result);
    const sectorSizeShift = config.compression.sectorSizeShift;
    if (sectorSizeShift !== null && archive.inspect().sectorSize !== 512 * 2 ** sectorSizeShift) {
        onProgress('sectors');
        stage('sectors', '섹터 크기 변경·전체 재압축', archive.resector({ shift: sectorSizeShift, levels: config.compression.levels,
            strategies: config.compression.strategies, zopfli: config.compression.zopfli }));
    }
    // The listfile names entries for every earlier stage, so it goes last.
    if (config.cleanup.listfile && archive.has('(listfile)')) {
        stage('listfile', '(listfile) 삭제', archive.remove(['(listfile)']), { rewrite: true });
    }
    onProgress('verify');
    const verified = archive;
    // Each transform reparses and verifies its emitted code. The final readback
    // is byte-identical to that verified script, so no additional parse is needed.
    assert(verified.read('war3map.lua').equals(finalScript), 'Final script readback mismatch');
    for (const name of ['war3map.w3i', 'war3map.w3e']) assert(verified.read(name).equals(original.read(name)), 'Required map entry changed: ' + name);
    for (const name of cleanup.names) assert(!verified.has(name), 'Cleanup candidate is still present: ' + name);
    if (config.cleanup.listfile) assert(!verified.has('(listfile)'), 'The MPQ listfile is still present');
    for (const [name, contents] of cleanup.blocked) assert(verified.read(name).equals(contents), 'Editor block readback mismatch: ' + name);
    for (const { name, stripped } of media) assert(verified.read(name).equals(stripped), 'Media readback mismatch: ' + name);
    return {
        bytes: result,
        summary: { inputBytes: input.length, outputBytes: result.length, removedFiles: [...cleanup.names, ...(config.cleanup.listfile && original.has('(listfile)') ? ['(listfile)'] : [])], editorBlockedFiles: cleanup.blocked.map(([name]) => name),
            ...(cleanup.blocked.length ? { editorBlockFormat: config.cleanup.editorBlockFormat } : {}), mapInfoVersion: info.version,
            lua: { ...transformed.stats, inputBytes: scriptBytes.length, outputBytes: finalScript.length }, natives: natives.stats, strings: strings.stats, vm: vm.stats,
            ...(config.compression.stripMediaMetadata ? { media: { strippedFiles: media.map(({ name }) => name), savedBytes: media.reduce((total, item) => total + item.savedBytes, 0) } } : {}),
            sectorSize: verified.inspect().sectorSize, savings: savings.summary(),
            // Compressed bytes depend on the zlib build; record it with the result.
            environment: { node: process.version, zlib: process.versions.zlib } },
    };
}
