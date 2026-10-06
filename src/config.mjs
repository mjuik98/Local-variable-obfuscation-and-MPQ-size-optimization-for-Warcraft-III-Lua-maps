import assert from 'node:assert/strict';
import { validateSeed } from './seed.mjs';

// Non-default sizes are experimental; Warcraft III support needs an in-game check.
export const SUPPORTED_OUTPUT_SECTOR_SHIFTS = Object.freeze([3, 4, 5, 6, 7, 8]);

export const COMPRESSION_STRATEGIES = Object.freeze(['default', 'filtered', 'huffman-only', 'rle', 'fixed']);

export function normalizeCompressionStrategies(strategies) {
    assert(Array.isArray(strategies) && strategies.length > 0 &&
        Array.from(strategies).every(strategy => COMPRESSION_STRATEGIES.includes(strategy)),
    'compression.strategies must contain default, filtered, huffman-only, rle or fixed');
    return COMPRESSION_STRATEGIES.filter(strategy => strategies.includes(strategy));
}

export const DEFAULT_CONFIG = Object.freeze({
    lua: Object.freeze({ minify: true, renameLocals: true, keepLocals: Object.freeze([]), nameMode: 'compact', seed: 'warcraft-lua-protector', vmFunctions: Object.freeze([]),
        renameGlobals: false, renameFields: false, keepGlobals: Object.freeze([]), hideNatives: false, foldFourCC: false }),
    strings: Object.freeze({ enabled: false, keep: Object.freeze([]), mode: 'escape' }),
    cleanup: Object.freeze({ editor: false, development: false, editorData: false, listfile: false, keepFiles: Object.freeze([]) }),
    compression: Object.freeze({ enabled: true, levels: Object.freeze([6, 9]), strategies: Object.freeze(['default']), excludeFiles: Object.freeze([]), sectorSizeShift: null }),
});

function record(value, label) {
    assert(value !== null && typeof value === 'object' && !Array.isArray(value), label + ' must be an object');
    assert(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, label + ' must be a plain object');
}

function names(values, label, identifier = false) {
    assert(Array.isArray(values), label + ' must be an array');
    assert(Array.from(values).every(name => typeof name === 'string' && name.length > 0 && !/[\0\r\n]/.test(name)), label + ' contains an invalid name');
    if (identifier) assert(values.every(name => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)), label + ' must contain Lua identifiers');
    else assert(values.every(name => /^[\x20-\x7e]+$/.test(name)), label + ' supports ASCII MPQ paths only');
    return [...new Set(values)];
}

export function resolveConfig(input = {}) {
    record(input, 'Configuration');
    assert(Object.keys(input).every(key => Object.hasOwn(DEFAULT_CONFIG, key)), 'Unknown configuration section');
    const result = {};
    for (const [section, defaults] of Object.entries(DEFAULT_CONFIG)) {
        const supplied = Object.hasOwn(input, section) ? input[section] : {};
        record(supplied, section);
        assert(Object.keys(supplied).every(key => Object.hasOwn(defaults, key)), 'Unknown ' + section + ' option');
        result[section] = { ...defaults, ...supplied };
    }
    for (const [section, keys] of [['lua', ['minify', 'renameLocals', 'renameGlobals', 'renameFields', 'hideNatives', 'foldFourCC']], ['strings', ['enabled']], ['cleanup', ['editor', 'development', 'editorData', 'listfile']], ['compression', ['enabled']]]) {
        for (const key of keys) assert(typeof result[section][key] === 'boolean', section + '.' + key + ' must be boolean');
    }
    result.lua.keepLocals = names(result.lua.keepLocals, 'lua.keepLocals', true);
    result.lua.vmFunctions = names(result.lua.vmFunctions, 'lua.vmFunctions', true);
    result.lua.keepGlobals = names(result.lua.keepGlobals, 'lua.keepGlobals', true);
    assert(['compact', 'seeded'].includes(result.lua.nameMode), 'lua.nameMode must be compact or seeded');
    validateSeed(result.lua.seed, 'lua.seed');
    assert(['escape', 'runtime'].includes(result.strings.mode), 'strings.mode must be escape or runtime');
    assert(Array.isArray(result.strings.keep) && Array.from(result.strings.keep).every(value => typeof value === 'string' && value.isWellFormed()), 'strings.keep must contain well-formed Unicode strings');
    result.strings.keep = [...new Set(result.strings.keep)];
    result.cleanup.keepFiles = names(result.cleanup.keepFiles, 'cleanup.keepFiles');
    result.compression.excludeFiles = names(result.compression.excludeFiles, 'compression.excludeFiles');
    const levels = result.compression.levels;
    assert(Array.isArray(levels) && levels.length > 0 && levels.length <= 10 && levels.every(level => Number.isInteger(level) && level >= 0 && level <= 9), 'compression.levels must contain zlib levels 0..9');
    result.compression.levels = [...new Set(levels)].sort((a, b) => a - b);
    result.compression.strategies = normalizeCompressionStrategies(result.compression.strategies);
    const shift = result.compression.sectorSizeShift;
    assert(shift === null || SUPPORTED_OUTPUT_SECTOR_SHIFTS.includes(shift), 'compression.sectorSizeShift must be null or one of ' + SUPPORTED_OUTPUT_SECTOR_SHIFTS.join(', '));
    // A new sector size re-encodes every block, so it cannot keep exclusions.
    if (shift !== null) assert(result.compression.enabled && !result.compression.excludeFiles.length, 'compression.sectorSizeShift requires compression without excluded files');
    return result;
}

export const canonicalPath = name => name.replaceAll('/', '\\').toUpperCase();
