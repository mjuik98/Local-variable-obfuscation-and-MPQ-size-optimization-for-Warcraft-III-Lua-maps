import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { openMap } from './mpq.mjs';
import { parseLua } from './lua.mjs';
import { readScriptLanguage } from './map-info.mjs';
import { canonicalPath } from './config.mjs';
import { CLEANUP_CANDIDATES, planCleanup, validateCleanupContract } from './cleanup.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const SUPPORTED_FLAGS = new Set([0x80000000, 0x80000200]);

function snapshot(input, label) {
    assert(Buffer.isBuffer(input), label + ' map must be a Buffer');
    const signature = input.subarray(0, 4);
    assert(signature.equals(Buffer.from([77, 80, 81, 26])) || signature.equals(Buffer.from('HM3W')), label + ' must be a raw MPQ or HM3W-prefixed map');
    const map = openMap(input);
    map.validate();
    // Validate attributes and all existing MPQ preservation invariants without
    // generating or writing a different archive.
    map.verifyPreserved(input);
    assert(map.has('war3map.lua') && map.has('war3map.w3e'), label + ' must contain root Lua and terrain');
    assert(!map.has('war3map.j') && !map.has('Scripts\\war3map.j') && !map.has('Scripts\\war3map.lua'), label + ' has ambiguous map scripts');
    assert.equal(readScriptLanguage(map.read('war3map.w3i')).language, 1, label + ' does not select Lua');
    const scriptBytes = map.read('war3map.lua');
    const code = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(scriptBytes);
    assert(Buffer.from(code).equals(scriptBytes), label + ' Lua must contain canonical UTF-8 bytes');
    const ast = parseLua(code, label + ' war3map.lua');
    for (const name of ['main', 'config']) {
        assert.equal(ast.body.filter(node => node.type === 'FunctionDeclaration' && !node.isLocal &&
            node.identifier?.type === 'Identifier' && node.identifier.name === name).length, 1, label + ' must have one top-level ' + name);
    }
    const metadata = map.inspect({ includeHashes: true, names: [
        'war3map.lua', 'war3map.w3i', 'war3map.w3e', 'war3map.imp', '(attributes)', '(listfile)', ...CLEANUP_CANDIDATES,
    ] });
    const entries = new Map();
    for (const entry of metadata.namedEntries) for (const slot of entry.slots) {
        const index = metadata.hashes[slot].blockIndex;
        if (!entries.has(index)) entries.set(index, []);
        if (!entries.get(index).some(value => canonicalPath(value.name) === canonicalPath(entry.name))) entries.get(index).push(entry);
    }
    return { input, map, scriptBytes, ast, metadata, entries, prefix: input.subarray(0, metadata.archiveOffset) };
}

function reviewedOptions(contract) {
    const reviewed = new Set(contract.files.map(file => canonicalPath(file.path)));
    return { editor: true, development: true, editorData: true, keepFiles: CLEANUP_CANDIDATES.filter(name => !reviewed.has(canonicalPath(name))) };
}

function packed(value, block) {
    const start = value.metadata.archiveOffset + block.offset;
    return value.input.subarray(start, start + block.packedSize);
}

function decodableName(value, block) {
    if (!SUPPORTED_FLAGS.has(block.flags)) return null;
    // A known alias can decode a nonencrypted block regardless of its other
    // aliases. Multiple locales for the same name cannot be selected by read().
    return value.entries.get(block.index)?.find(entry => entry.slots.length === 1)?.name ?? null;
}

function labelFor(before, after, index) {
    const names = [...(before.entries.get(index) ?? []), ...(after.entries.get(index) ?? [])].map(entry => entry.name);
    return [...new Map(names.map(name => [canonicalPath(name), name])).values()].join(', ') || 'MPQ block #' + index;
}

// Return a proposal only when every active dependency has the same meaning.
// The proposal is deliberately not saved, approved, or applied by this API.
export function reviewCleanupContract(previousInput, newInput, contract) {
    const before = snapshot(previousInput, 'Previous');
    validateCleanupContract(before.map, contract, { inputBytes: previousInput, scriptBytes: before.scriptBytes });
    const options = reviewedOptions(contract);
    planCleanup(before.map, before.ast, options, { cleanupContract: contract, inputBytes: previousInput, scriptBytes: before.scriptBytes });
    // The original AST is no longer needed once its contract and references
    // have passed. Do not retain both large map ASTs during the comparison.
    before.ast = null;
    const after = snapshot(newInput, 'New');
    const changes = [], reReviewReasons = [];
    const change = (entry, kind, reason, requiresReview = true) => {
        changes.push({ entry, kind, reason, requiresReview });
        if (requiresReview) reReviewReasons.push(entry + ': ' + reason);
    };
    if (!before.prefix.equals(after.prefix)) change('Map prefix', 'metadata', 'Map prefix bytes changed; only archive packing changes can reuse the review.');
    for (const key of ['formatVersion', 'sectorSize', 'hashCount', 'blockCount']) {
        if (before.metadata[key] !== after.metadata[key]) change('MPQ ' + key, 'directory', key + ' changed; dependency identity cannot be assumed.');
    }
    const slotCount = Math.max(before.metadata.hashes.length, after.metadata.hashes.length);
    for (let slot = 0; slot < slotCount; slot++) {
        const oldSlot = before.metadata.hashes[slot], newSlot = after.metadata.hashes[slot];
        if (!oldSlot || !newSlot || ['hashA', 'hashB', 'localePlatform', 'blockIndex'].some(key => oldSlot[key] !== newSlot[key])) {
            change('MPQ hash slot #' + slot, 'directory', 'File identity, locale/platform, alias mapping or slot state changed.');
        }
    }
    const count = Math.max(before.metadata.blocks.length, after.metadata.blocks.length);
    for (let index = 0; index < count; index++) {
        const oldBlock = before.metadata.blocks[index], newBlock = after.metadata.blocks[index];
        const entry = labelFor(before, after, index);
        if (!oldBlock || !newBlock) { change(entry, oldBlock ? 'removed' : 'added', 'MPQ block inventory changed.'); continue; }
        if (oldBlock.live !== newBlock.live) { change(entry, newBlock.live ? 'added' : 'removed', 'MPQ live state changed.'); continue; }
        if (!oldBlock.live) {
            if (['flags', 'size', 'packedSize', 'hashReferences'].some(key => oldBlock[key] !== newBlock[key])) change(entry, 'metadata', 'Inactive block metadata changed.');
            continue;
        }
        if (oldBlock.hashReferences !== newBlock.hashReferences) change(entry, 'directory', 'Block alias/reference count changed.');
        const oldName = decodableName(before, oldBlock), newName = decodableName(after, newBlock);
        const oldDecoded = oldName === null ? null : before.map.read(oldName, true);
        const newDecoded = newName === null ? null : after.map.read(newName, true);
        if (oldDecoded !== null && newDecoded !== null) {
            if (!oldDecoded.equals(newDecoded)) change(entry, 'content', 'Decoded file bytes changed; Lua, objects, imports and assets require a new dependency review.');
            else if (oldBlock.flags !== newBlock.flags || oldBlock.offset !== newBlock.offset || !packed(before, oldBlock).equals(packed(after, newBlock))) {
                change(entry, 'packing', 'Decoded bytes are identical; only supported compression or payload placement changed.', false);
            }
            continue;
        }
        // Unnamed, localized, encrypted or unsupported payloads are never
        // inferred equivalent from a file size, a path, or another readable file.
        const sameMetadata = ['flags', 'size', 'packedSize', 'hashReferences'].every(key => oldBlock[key] === newBlock[key]);
        const samePacked = packed(before, oldBlock).equals(packed(after, newBlock));
        const fixed = (oldBlock.flags & 0x30000) === 0x30000 || (newBlock.flags & 0x30000) === 0x30000;
        if (!sameMetadata || !samePacked || (fixed && oldBlock.offset !== newBlock.offset)) {
            change(entry, 'unverified', 'Opaque or unresolved payload bytes, metadata or FIX_KEY placement changed; equivalence cannot be proved.');
        } else if (oldBlock.offset !== newBlock.offset) {
            change(entry, 'packing', 'Opaque bytes and semantic metadata are identical; only non-FIX_KEY placement changed.', false);
        }
    }
    let candidate = null;
    if (reReviewReasons.length === 0) {
        if (!previousInput.equals(newInput) && changes.length === 0) change('MPQ archive', 'packing', 'Only table placement, padding or unused archive bytes changed.', false);
        candidate = structuredClone(contract);
        candidate.inputMapSha256 = digest(newInput);
        candidate.scriptSha256 = digest(after.scriptBytes);
        // The updated full hashes must pass the same execution-time validation
        // and candidate reference checks as a manually supplied v1 contract.
        planCleanup(after.map, after.ast, options, { cleanupContract: candidate, inputBytes: newInput, scriptBytes: after.scriptBytes });
    }
    after.ast = null;
    return {
        repackOnly: reReviewReasons.length === 0, inputIdentical: previousInput.equals(newInput), changes, reReviewReasons, candidate,
        previousInputMapSha256: digest(previousInput), newInputMapSha256: digest(newInput),
        previousScriptSha256: digest(before.scriptBytes), newScriptSha256: digest(after.scriptBytes),
    };
}
