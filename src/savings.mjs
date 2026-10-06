import assert from 'node:assert/strict';
import { openMap } from './mpq.mjs';
import { canonicalPath } from './config.mjs';
import { CLEANUP_CANDIDATES } from './cleanup.mjs';

const KNOWN_NAMES = Object.freeze([
    'war3map.lua', 'war3map.w3i', 'war3map.w3e', 'war3map.imp',
    '(listfile)', '(attributes)', ...CLEANUP_CANDIDATES,
]);
const KIND_LABELS = Object.freeze({
    unchanged: '압축 블록 보존', rewrite: '내용 기록', recompress: '재압축',
    removed: '파일 정리', added: '파일 추가',
});

function snapshot(bytes, map) {
    // Only the listfile needs decoding to associate names with hash slots.
    // Opaque file payloads are never decoded or assigned guessed names/sizes.
    let metadata = map.inspect({ includeHashes: true, names: KNOWN_NAMES, includeListedNames: false });
    const listSlots = metadata.namedEntries.find(entry => canonicalPath(entry.name) === '(LISTFILE)')?.slots ?? [];
    if (listSlots.length === 1 && map.read('(listfile)', true) !== null) {
        metadata = map.inspect({ includeHashes: true, names: KNOWN_NAMES });
    }
    const names = new Map();
    for (const entry of metadata.namedEntries) {
        for (const slot of entry.slots) {
            const index = metadata.hashes[slot].blockIndex;
            if (!names.has(index)) names.set(index, new Map());
            names.get(index).set(canonicalPath(entry.name), entry.name);
        }
    }
    const blocks = new Map();
    let payloadBytes = 0;
    for (const block of metadata.blocks) {
        if (!block.live) continue;
        payloadBytes += block.packedSize;
        blocks.set(block.index, { ...block, names: [...(names.get(block.index)?.values() ?? [])] });
    }
    assert(Number.isSafeInteger(payloadBytes) && payloadBytes <= bytes.length, 'Invalid MPQ payload savings total');
    return { blocks, archiveOffset: metadata.archiveOffset, payloadBytes, otherBytes: bytes.length - payloadBytes };
}

function samePayload(beforeBytes, before, afterBytes, after, index) {
    const a = before.blocks.get(index), b = after.blocks.get(index);
    if (!a || !b) return a === b;
    if (a.packedSize !== b.packedSize || a.size !== b.size || a.flags !== b.flags) return false;
    const aStart = before.archiveOffset + a.offset, bStart = after.archiveOffset + b.offset;
    return beforeBytes.subarray(aStart, aStart + a.packedSize)
        .equals(afterBytes.subarray(bStart, bStart + b.packedSize));
}

function rowLabel(kind, before, after) {
    const block = after ?? before;
    let label = KIND_LABELS[kind];
    if (!block.names.length) label +=
        block.hashReferences ? ' · 미열거 활성 블록' : ' · 해시 참조 없는 활성 블록';
    // These formats are known to be opaque to the reader. Other unchanged
    // payloads still report preservation from packed bytes, without decoding.
    if (kind === 'unchanged' && ((block.flags & (0x100 | 0x1000000)) ||
        ((block.flags & 0x10000) && !(block.flags & 0x200)))) label = '읽기 미지원 블록 보존';
    if (before && after) {
        const names = new Set(after.names.map(canonicalPath));
        if (before.names.some(name => !names.has(canonicalPath(name)))) label += ' · 일부 이름 정리';
    }
    return label;
}

export function createSavingsTracker(input, original = openMap(input)) {
    assert(Buffer.isBuffer(input), 'Savings requires input map bytes');
    const initial = snapshot(input, original), stages = [], rewritten = new Set();
    let previousBytes = input, previous = initial;
    return {
        record(id, label, bytes, { map, rewrite = false } = {}) {
            assert(typeof id === 'string' && id.length > 0 && !stages.some(stage => stage.id === id), 'Invalid or duplicate savings stage');
            assert(typeof label === 'string' && label.length > 0, 'Savings stage requires a label');
            assert(Buffer.isBuffer(bytes) && typeof rewrite === 'boolean', 'Invalid savings stage bytes');
            const next = bytes === previousBytes ? previous : snapshot(bytes, map ?? openMap(bytes));
            if (rewrite) {
                for (const index of new Set([...previous.blocks.keys(), ...next.blocks.keys()])) {
                    if (!samePayload(previousBytes, previous, bytes, next, index)) rewritten.add(index);
                }
            }
            stages.push({ id, label, beforeBytes: previousBytes.length, afterBytes: bytes.length,
                savedBytes: previousBytes.length - bytes.length });
            // Retain only the immediately preceding archive for the next packed
            // comparison. The returned report contains sizes and names only.
            previousBytes = bytes; previous = next;
        },
        summary() {
            const savedBytes = input.length - previousBytes.length;
            const files = [...new Set([...initial.blocks.keys(), ...previous.blocks.keys()])].map(blockIndex => {
                const before = initial.blocks.get(blockIndex), after = previous.blocks.get(blockIndex);
                const beforeBytes = before?.packedSize ?? 0, afterBytes = after?.packedSize ?? 0;
                const kind = !before ? 'added' : !after ? 'removed' :
                    samePayload(input, initial, previousBytes, previous, blockIndex) ? 'unchanged' :
                    rewritten.has(blockIndex) ? 'rewrite' : 'recompress';
                const names = new Map([...(before?.names ?? []), ...(after?.names ?? [])]
                    .map(name => [canonicalPath(name), name]));
                return { blockIndex, names: [...names.values()], kind, label: rowLabel(kind, before, after),
                    beforeBytes, afterBytes, savedBytes: beforeBytes - afterBytes };
            }).sort((a, b) => b.savedBytes - a.savedBytes || a.blockIndex - b.blockIndex);
            const storage = { beforePayloadBytes: initial.payloadBytes, afterPayloadBytes: previous.payloadBytes,
                beforeOtherBytes: initial.otherBytes, afterOtherBytes: previous.otherBytes,
                savedOtherBytes: initial.otherBytes - previous.otherBytes };
            assert.equal(stages.reduce((total, stage) => total + stage.savedBytes, 0), savedBytes, 'MPQ stage savings do not reconcile');
            assert.equal(files.reduce((total, file) => total + file.savedBytes, 0),
                storage.beforePayloadBytes - storage.afterPayloadBytes, 'MPQ file savings do not reconcile');
            assert.equal(storage.beforePayloadBytes - storage.afterPayloadBytes + storage.savedOtherBytes,
                savedBytes, 'MPQ storage savings do not reconcile');
            return { savedBytes, savedPercent: input.length ? savedBytes * 100 / input.length : 0,
                stages: stages.map(stage => ({ ...stage })), files, storage };
        },
    };
}
