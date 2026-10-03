import assert from 'node:assert/strict';
import { TextDecoder } from 'node:util';
import { openMap } from './mpq.mjs';
import { parseLua, transformLua } from './lua.mjs';
import { resolveConfig, canonicalPath } from './config.mjs';
import { readScriptLanguage } from './map-info.mjs';
import { planCleanup } from './cleanup.mjs';

export function protectMap(input, configuration = {}) {
    assert(Buffer.isBuffer(input), 'protectMap requires map bytes');
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
    const ast = parseLua(code, 'war3map.lua');
    for (const name of ['main', 'config']) {
        const declarations = ast.body.filter(node => node.type === 'FunctionDeclaration' && !node.isLocal && node.identifier?.type === 'Identifier' && node.identifier.name === name);
        assert(declarations.length === 1, 'Expected one top-level ' + name + ' function');
    }
    const cleanup = planCleanup(original, ast, config.cleanup);
    const transformed = transformLua(code, config.lua);
    const replacements = [['war3map.lua', Buffer.from(transformed.code)]];
    if (cleanup.imports) replacements.push(['war3map.imp', cleanup.imports]);
    const rewriteOptions = { levels: config.compression.enabled ? config.compression.levels : [0] };
    let result = original.replace(replacements, rewriteOptions);
    if (cleanup.names.length) result = openMap(result).remove(cleanup.names);
    if (config.compression.enabled) {
        const current = openMap(result), excluded = new Set(config.compression.excludeFiles.map(canonicalPath));
        result = current.optimize({ names: current.listNames().filter(name => !excluded.has(canonicalPath(name))), levels: config.compression.levels });
    }
    const verified = openMap(result);
    assert(verified.read('war3map.lua').equals(Buffer.from(transformed.code)), 'Final script readback mismatch');
    parseLua(transformed.code, 'Protected war3map.lua');
    for (const name of ['war3map.w3i', 'war3map.w3e']) assert(verified.read(name).equals(original.read(name)), 'Required map entry changed: ' + name);
    for (const name of cleanup.names) assert(!verified.has(name), 'Cleanup candidate is still present: ' + name);
    return {
        bytes: result,
        summary: { inputBytes: input.length, outputBytes: result.length, removedFiles: cleanup.names, mapInfoVersion: info.version, lua: transformed.stats },
    };
}
