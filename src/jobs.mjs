import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { protectMap } from './protect.mjs';
import { listPresets, resolveSettings } from './presets.mjs';
import { resolveConfig } from './config.mjs';
import { reviewCleanupContract } from './cleanup-review.mjs';
import { assertFileUnchanged, validateOutputPath, writeNewOutput } from './output.mjs';

const sessions = new WeakMap();
const CACHE_LIMIT = 192 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// One validated map only, held in memory. No cache files or Lua ASTs are kept.
export function createJobSession({ limitBytes = CACHE_LIMIT, transform = protectMap } = {}) {
    assert(Number.isSafeInteger(limitBytes) && limitBytes >= 0 && typeof transform === 'function', 'Invalid session options');
    const state = { limitBytes, transform, entry: null };
    const session = Object.freeze({ clear() { state.entry = null; }, status() {
        return { retained: Boolean(state.entry), bytes: state.entry?.size ?? 0, limitBytes };
    } });
    sessions.set(session, state);
    return session;
}

function readJSON(file, label) {
    if (!file) return { path: null, bytes: null, value: undefined };
    try {
        const resolved = fs.realpathSync(file), bytes = fs.readFileSync(resolved);
        return { path: resolved, bytes, value: JSON.parse(bytes.toString('utf8')) };
    } catch (cause) { throw new Error(label + ' ' + file + ': ' + cause.message, { cause }); }
}

function settingsFor(request, configuration) {
    if (Object.hasOwn(request, 'hideStrings')) assert(typeof request.hideStrings === 'boolean', 'hideStrings must be boolean');
    const overrides = Object.hasOwn(request, 'overrides') ? request.overrides : {};
    resolveConfig(overrides);
    const explicit = Object.hasOwn(request, 'hideStrings') ? { ...overrides, strings: { ...overrides.strings, enabled: request.hideStrings } } : overrides;
    return resolveSettings({ preset: request.preset ?? null, configuration: configuration ?? {}, overrides: explicit, noVm: request.noVm ?? false });
}

function requireContract(settings, request) {
    assert(!settings.preset?.requiresCleanupContract || request.cleanupContractPath,
        '배포 준비의 파일 정리에는 현재 입력 맵에 맞는 검토 계약이 필요합니다. 메인 작업 화면의 검토 계약 → 찾아보기에서 선택하거나, 고급 설정의 에디터 파일 정리·개발 파일 정리를 해제하세요.\n' +
        'The distribution preset requires --cleanup-contract for file cleanup; use --no-cleanup to preserve files');
}

function cacheKey(source, settings, configuration, contract) {
    return JSON.stringify({ source, config: settings.config,
        configuration: [configuration.path, configuration.bytes ? digest(configuration.bytes) : null],
        contract: [contract.path, contract.bytes ? digest(contract.bytes) : null] });
}

function retain(state, key, original, result) {
    if (!state) return;
    const size = original.length + result.bytes.length;
    state.entry = size <= state.limitBytes ? { key, original, bytes: result.bytes, summary: structuredClone(result.summary), size } : null;
}

function comparisonCandidates(request, configuration) {
    const candidates = [];
    for (const hideStrings of [false, true]) candidates.push({ id: 'current-' + Number(hideStrings), label: '현재 설정 · 문자열 숨김 ' + (hideStrings ? '켬' : '끔'), request: { ...request, hideStrings } });
    for (const preset of ['size', 'protect', 'distribution', 'hardened']) for (const hideStrings of [false, true]) candidates.push({
        id: preset + '-' + Number(hideStrings), label: listPresets().find(value => value.id === preset).label + ' · 문자열 숨김 ' + (hideStrings ? '켬' : '끔'),
        request: { ...request, preset, configPath: null, hideStrings, overrides: {}, noVm: false }, configuration: {},
    });
    const seen = new Set();
    return candidates.filter(candidate => {
        candidate.settings = settingsFor(candidate.request, candidate.configuration ?? configuration);
        const key = JSON.stringify([candidate.settings.config, candidate.settings.preset?.checkOnly ?? false, candidate.settings.preset?.requiresCleanupContract ?? false]);
        if (seen.has(key)) return false;
        seen.add(key); return true;
    });
}

function inputPath(file) {
    assert(typeof file === 'string' && /\.w3[xm]$/i.test(file), 'Input must be a .w3x or .w3m file');
    const resolved = fs.realpathSync(file);
    assert(fs.statSync(resolved).isFile(), 'Input must be a file');
    return resolved;
}

export function executeJob(request, { onProgress = () => {}, publish = writeNewOutput, session } = {}) {
    const started = performance.now();
    const state = session === undefined ? null : sessions.get(session);
    assert(session === undefined || state, 'Expected a job session');
    assert(request && typeof request === 'object' && !Array.isArray(request), 'Job request must be an object');
    assert((Object.getPrototypeOf(request) === Object.prototype || Object.getPrototypeOf(request) === null) && Object.hasOwn(request, 'action'), 'Job request must be a plain object with its own action');
    const allowed = ['action', 'input', 'output', 'preset', 'configPath', 'cleanupContractPath', 'previousInput', 'contractOutput', 'hideStrings', 'overrides', 'noVm'];
    assert(Object.keys(request).every(key => allowed.includes(key)), 'Unknown job field');
    if (Object.hasOwn(request, 'noVm')) assert(typeof request.noVm === 'boolean', 'noVm must be boolean');
    assert(['presets', 'settings', 'compare', 'check', 'protect', 'review', 'save-contract'].includes(request.action), 'Unknown job action');
    for (const key of ['input', 'output', 'configPath', 'cleanupContractPath', 'previousInput', 'contractOutput']) {
        if (Object.hasOwn(request, key)) assert(request[key] === null || (typeof request[key] === 'string' && request[key].length > 0 && !request[key].includes('\0')), 'Invalid job path: ' + key);
    }
    assert(typeof onProgress === 'function' && typeof publish === 'function', 'Job callbacks must be functions');
    if (request.action === 'presets') {
        assert(Object.keys(request).length === 1, 'Preset listing cannot include job fields');
        return { presets: listPresets() };
    }
    if (request.action === 'review' || request.action === 'save-contract') {
        session?.clear();
        assert(!request.output && !request.configPath && !request.preset && request.hideStrings === undefined && !request.overrides && request.noVm === undefined, 'Contract review cannot include transformation settings or map output');
        assert(request.cleanupContractPath, 'Contract review requires the previous cleanup contract');
        const previousPath = inputPath(request.previousInput), currentPath = inputPath(request.input);
        const previous = fs.readFileSync(previousPath), current = fs.readFileSync(currentPath);
        const contract = readJSON(request.cleanupContractPath, 'Cleanup contract');
        onProgress('review');
        const review = reviewCleanupContract(previous, current, contract.value);
        const unchanged = () => { assertFileUnchanged(previousPath, previous); assertFileUnchanged(currentPath, current); assertFileUnchanged(contract.path, contract.bytes); };
        unchanged();
        if (request.action === 'review') {
            assert(!request.contractOutput, 'Use save-contract to explicitly save a proposed contract');
            return { review, path: currentPath };
        }
        assert(review.candidate, 'Dependency content changed or cannot be verified; review it again before creating a cleanup contract');
        assert(typeof request.contractOutput === 'string' && path.extname(request.contractOutput).toLowerCase() === '.json', 'An explicit new .json contract output is required');
        const paths = validateOutputPath(contract.path, request.contractOutput);
        onProgress('write');
        publish(paths.output, Buffer.from(JSON.stringify(review.candidate, null, 2) + '\n'), { beforePublish: unchanged });
        return { review, path: paths.output };
    }
    assert(!request.previousInput && !request.contractOutput, 'Contract review fields require a review action');
    const configuration = readJSON(request.configPath, 'Configuration file');
    const settings = settingsFor(request, configuration.value);
    if (request.action === 'settings') {
        assert(!request.input && !request.output && !request.cleanupContractPath, 'Settings preview cannot include map or contract paths');
        if (configuration.bytes) assertFileUnchanged(configuration.path, configuration.bytes);
        return { config: settings.config, preset: settings.preset };
    }
    if (request.action === 'compare') {
        assert(!request.output, 'Comparison cannot include a map output path');
        session?.clear();
        const source = inputPath(request.input), original = fs.readFileSync(source), contract = readJSON(request.cleanupContractPath, 'Cleanup contract');
        const unchanged = () => { assertFileUnchanged(source, original); if (configuration.bytes) assertFileUnchanged(configuration.path, configuration.bytes); if (contract.bytes) assertFileUnchanged(contract.path, contract.bytes); };
        const candidates = comparisonCandidates(request, configuration.value ?? {}), comparisons = [];
        for (let index = 0; index < candidates.length; index++) {
            const candidate = candidates[index], began = performance.now();
            onProgress('compare', { id: candidate.id, label: candidate.label, index: index + 1, total: candidates.length });
            // Release the last candidate before computing another full map.
            session?.clear();
            const item = { id: candidate.id, label: candidate.label, preset: candidate.request.preset ?? null, hideStrings: candidate.request.hideStrings, config: candidate.settings.config };
            try {
                requireContract(candidate.settings, candidate.request);
                const result = (state?.transform ?? protectMap)(original, candidate.settings.config, { cleanupContract: contract.value, onProgress });
                unchanged();
                retain(state, cacheKey(source, candidate.settings, candidate.id.startsWith('current-') ? configuration : { path: null, bytes: null }, contract), original, result);
                comparisons.push({ ...item, ok: true, summary: result.summary, elapsedMs: performance.now() - began });
            } catch (error) {
                session?.clear();
                // Source/settings changes are fatal to the whole comparison.
                unchanged();
                comparisons.push({ ...item, ok: false, error: error.message, elapsedMs: performance.now() - began });
            }
        }
        unchanged();
        return { path: source, comparisons, elapsedMs: performance.now() - started, cache: { reused: false, ...(session?.status() ?? { retained: false, bytes: 0, limitBytes: CACHE_LIMIT }) } };
    }
    assert(!(settings.preset?.checkOnly && request.action !== 'check'), 'The fast-check preset only supports --check; choose another preset to save a map');
    requireContract(settings, request);
    const sourcePath = inputPath(request.input);
    if (request.output) assert(path.extname(request.output).toLowerCase() === path.extname(sourcePath).toLowerCase(), 'Output must use the same map extension');
    const paths = request.output ? validateOutputPath(sourcePath, request.output) : { input: sourcePath, output: null };
    assert(request.action === 'check' || paths.output, 'An explicit new output map path is required');
    const contract = readJSON(request.cleanupContractPath, 'Cleanup contract'), key = cacheKey(paths.input, settings, configuration, contract);
    let original, result, reused = false;
    if (state?.entry?.key === key) {
        try {
            assertFileUnchanged(paths.input, state.entry.original);
            original = state.entry.original;
            result = { bytes: state.entry.bytes, summary: state.entry.summary };
            reused = true;
        } catch (error) {
            session.clear();
        }
    }
    if (reused) onProgress('reuse');
    if (!reused) {
        session?.clear();
        original = fs.readFileSync(paths.input);
        result = (state?.transform ?? protectMap)(original, settings.config, { cleanupContract: contract.value, onProgress });
    }
    const unchanged = () => { assertFileUnchanged(paths.input, original); if (configuration.bytes) assertFileUnchanged(configuration.path, configuration.bytes); if (contract.bytes) assertFileUnchanged(contract.path, contract.bytes); };
    unchanged();
    if (request.action === 'protect') {
        onProgress('write');
        publish(paths.output, result.bytes, { beforePublish: unchanged });
    }
    if (!reused) retain(state, key, original, result);
    return { path: request.action === 'check' ? paths.input : paths.output, summary: structuredClone(result.summary), preset: settings.preset, config: settings.config,
        elapsedMs: performance.now() - started, cache: { reused, ...(session?.status() ?? { retained: false, bytes: 0, limitBytes: CACHE_LIMIT }) } };
}
