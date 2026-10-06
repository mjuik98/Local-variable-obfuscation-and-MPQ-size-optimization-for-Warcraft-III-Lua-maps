import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, resolveConfig } from './config.mjs';

const presets = [
    {
        id: 'fast-check', label: '빠른 검사',
        description: 'Lua 원문과 파일을 보존하고 zlib 6 설정으로 전체 변환을 검사합니다. 결과 맵은 저장하지 않습니다.',
        checkOnly: true, requiresCleanupContract: false,
        settings: { lua: { minify: false, renameLocals: false }, strings: { enabled: false }, cleanup: { editor: false, development: false }, compression: { enabled: true, levels: [6] } },
    },
    {
        id: 'size', label: '용량 최적화',
        description: 'Lua 원문과 파일을 보존하고 zlib 6·9 및 비압축 후보 중 작은 결과를 선택합니다.',
        checkOnly: false, requiresCleanupContract: false,
        settings: { lua: { minify: false, renameLocals: false }, strings: { enabled: false }, cleanup: { editor: false, development: false }, compression: { enabled: true, levels: [6, 9] } },
    },
    {
        id: 'protect', label: '기본 보호',
        description: 'Lua 주석·공백 정리와 local 이름 변경을 적용합니다. 문자열 숨김과 파일 정리는 기본적으로 끕니다.',
        checkOnly: false, requiresCleanupContract: false,
        settings: { lua: { minify: true, renameLocals: true }, strings: { enabled: false }, cleanup: { editor: false, development: false }, compression: { enabled: true, levels: [6, 9] } },
    },
    {
        id: 'distribution', label: '배포 준비',
        description: 'Lua 기본 보호와 알려진 에디터·개발 파일 정리를 적용합니다. 파일 정리를 켜면 정확한 입력에 대한 검토 계약이 필요합니다.',
        checkOnly: false, requiresCleanupContract: true,
        settings: { lua: { minify: true, renameLocals: true }, strings: { enabled: false }, cleanup: { editor: true, development: true }, compression: { enabled: true, levels: [6, 9] } },
    },
    {
        id: 'hardened', label: '보호 강화',
        description: '시드 기반 local 이름과 런타임 문자열 복원을 적용합니다. VM 함수는 직접 지정하며 게임 검증이 필요한 실험 옵션입니다. 파일 정리는 기본적으로 끕니다.',
        checkOnly: false, requiresCleanupContract: false,
        settings: { lua: { minify: true, renameLocals: true, nameMode: 'seeded', vmFunctions: [] }, strings: { enabled: true, mode: 'runtime' }, cleanup: { editor: false, development: false }, compression: { enabled: true, levels: [6, 9] } },
    },
    {
        id: 'maximum', label: '최대 보호',
        description: '보호 강화에 더해 정적으로 확인된 전역·닫힌 테이블 필드 이름 변경과 엔진 함수 호출 숨김을 적용합니다. 모두 게임 검증이 필요한 실험 옵션입니다. 섹터 크기 변경과 파일 정리는 별도로 켭니다.',
        checkOnly: false, requiresCleanupContract: false,
        settings: { lua: { minify: true, renameLocals: true, nameMode: 'seeded', vmFunctions: [], renameGlobals: true, renameFields: true, hideNatives: true }, strings: { enabled: true, mode: 'runtime' }, cleanup: { editor: false, development: false }, compression: { enabled: true, levels: [6, 9] } },
    },
];
const appendKeys = { lua: ['keepLocals', 'vmFunctions', 'keepGlobals'], strings: ['keep'], cleanup: ['keepFiles'], compression: ['excludeFiles'] };

function metadata(preset) {
    const { id, label, description, checkOnly, requiresCleanupContract } = preset;
    return { id, label, description, checkOnly, requiresCleanupContract };
}

export function listPresets() {
    return presets.map(metadata);
}

export function resolveSettings({ preset = null, configuration = {}, overrides = {}, noVm = false } = {}) {
    // Validate each supplied layer before merging: a valid CLI override must
    // never hide a malformed JSON option or an unsupported section.
    resolveConfig(configuration);
    resolveConfig(overrides);
    assert(typeof noVm === 'boolean', 'noVm must be boolean');
    assert(preset === null || typeof preset === 'string', 'Preset must be a stable preset ID or null');
    const selected = preset === null ? null : presets.find(item => item.id === preset);
    assert(preset === null || selected, 'Unknown preset: ' + preset);
    const merged = {};
    for (const [section, defaults] of Object.entries(DEFAULT_CONFIG)) {
        const supplied = Object.hasOwn(configuration, section) ? configuration[section] : {};
        const explicit = Object.hasOwn(overrides, section) ? overrides[section] : {};
        merged[section] = { ...defaults, ...selected?.settings[section], ...supplied, ...explicit };
        for (const key of appendKeys[section]) {
            if (Object.hasOwn(explicit, key)) {
                const before = Object.hasOwn(supplied, key) ? supplied[key] : selected?.settings[section]?.[key] ?? defaults[key];
                merged[section][key] = [...before, ...explicit[key]];
            }
        }
    }
    if (noVm) merged.lua.vmFunctions = [];
    const config = resolveConfig(merged), info = selected ? metadata(selected) : null;
    if (info) info.requiresCleanupContract = selected.requiresCleanupContract && (config.cleanup.editor || config.cleanup.development);
    return { config, preset: info };
}
