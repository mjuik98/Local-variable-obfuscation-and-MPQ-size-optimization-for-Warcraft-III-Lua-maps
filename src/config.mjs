import assert from 'node:assert/strict';

export { canonicalPath } from './mpq.mjs';

export const DEFAULT_CONFIG = Object.freeze({
    lua: Object.freeze({ minify: true, renameLocals: true, keepLocals: Object.freeze([]) }),
    cleanup: Object.freeze({ editor: false, development: false, keepFiles: Object.freeze([]) }),
    compression: Object.freeze({ enabled: true, levels: Object.freeze([6, 9]), excludeFiles: Object.freeze([]) }),
});

function record(value, label) {
    assert(value !== null && typeof value === 'object' && !Array.isArray(value), label + ' must be an object');
    assert(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, label + ' must be a plain object');
}

function names(values, label, identifier = false) {
    assert(Array.isArray(values), label + ' must be an array');
    assert(values.every(name => typeof name === 'string' && name.length > 0 && !/[\0\r\n]/.test(name)), label + ' contains an invalid name');
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
    for (const [section, values] of Object.entries(result)) {
        for (const [key, value] of Object.entries(DEFAULT_CONFIG[section])) {
            if (typeof value === 'boolean') assert(typeof values[key] === 'boolean', section + '.' + key + ' must be boolean');
        }
    }
    result.lua.keepLocals = names(result.lua.keepLocals, 'lua.keepLocals', true);
    result.cleanup.keepFiles = names(result.cleanup.keepFiles, 'cleanup.keepFiles');
    result.compression.excludeFiles = names(result.compression.excludeFiles, 'compression.excludeFiles');
    const levels = result.compression.levels;
    assert(Array.isArray(levels) && levels.length > 0 && levels.length <= 10 && levels.every(level => Number.isInteger(level) && level >= 0 && level <= 9), 'compression.levels must contain zlib levels 0..9');
    result.compression.levels = [...new Set(levels)].sort((a, b) => a - b);
    return result;
}
