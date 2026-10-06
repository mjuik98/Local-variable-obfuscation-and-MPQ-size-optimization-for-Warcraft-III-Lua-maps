import test from 'node:test';
import assert from 'node:assert/strict';
import { createSavingsTracker } from '../src/savings.mjs';
import { openMap } from '../src/mpq.mjs';
import { createTestMap } from './mpq-fixture.mjs';

function reconcile(savings, input, output) {
    assert.equal(savings.savedBytes, input.length - output.length);
    assert.equal(savings.savedPercent, savings.savedBytes * 100 / input.length);
    let previous = input.length;
    for (const stage of savings.stages) {
        assert.equal(stage.beforeBytes, previous);
        assert.equal(stage.savedBytes, stage.beforeBytes - stage.afterBytes);
        previous = stage.afterBytes;
    }
    assert.equal(previous, output.length);
    assert.equal(savings.stages.reduce((sum, stage) => sum + stage.savedBytes, 0), savings.savedBytes);
    const storage = savings.storage;
    assert.equal(storage.beforePayloadBytes + storage.beforeOtherBytes, input.length);
    assert.equal(storage.afterPayloadBytes + storage.afterOtherBytes, output.length);
    assert.equal(savings.files.reduce((sum, file) => sum + file.savedBytes, 0) + storage.savedOtherBytes, savings.savedBytes);
    assert.equal(new Set(savings.files.map(file => file.blockIndex)).size, savings.files.length);
}

test('packed file changes and archive space reconcile across rewrite, cleanup and recompression', () => {
    const input = createTestMap([
        ['script.lua', Buffer.from('return ' + '1 + '.repeat(80) + '2')],
        ['editor.bin', Buffer.from('editor data to remove')],
        ['resource.bin', Buffer.alloc(12000, 65)],
    ], { gap: 32, attributes: true });
    const original = openMap(input), tracker = createSavingsTracker(input, original);
    const rewritten = original.replace([['script.lua', Buffer.from('return 82')]], { levels: [0] });
    tracker.record('lua', '기록 및 공간 회수', rewritten, { rewrite: true });
    const cleaned = openMap(rewritten).remove(['editor.bin']);
    tracker.record('cleanup', '정리', cleaned, { rewrite: true });
    const output = openMap(cleaned).optimize();
    tracker.record('recompression', '재압축', output);
    const savings = tracker.summary();
    reconcile(savings, input, output);
    assert.equal(savings.files.find(file => file.names.includes('script.lua')).kind, 'rewrite');
    assert.equal(savings.files.find(file => file.names.includes('editor.bin')).kind, 'removed');
    const resource = savings.files.find(file => file.names.includes('resource.bin'));
    assert.equal(resource.kind, 'recompress');
    assert.equal(resource.beforeBytes, 12000);
    assert(resource.afterBytes < resource.beforeBytes);
    assert.equal(savings.files.find(file => file.names.includes('(listfile)')).kind, 'rewrite');
    assert.equal(savings.files.find(file => file.names.includes('(attributes)')).kind, 'rewrite');
    assert(savings.storage.savedOtherBytes > 0);
    assert.deepEqual(tracker.summary(), savings);
});

test('aliases, locales, unlisted live files, orphans and opaque blocks each count once', () => {
    const list = '(listfile)\r\naliased.bin\r\nalias.bin\r\nALIASED.BIN\r\nlocalized.bin\r\nopaque.bin\r\n';
    const input = createTestMap([
        ['aliased.bin', Buffer.from('one payload for two names')],
        ['localized.bin', Buffer.from('neutral locale')],
        ['opaque.bin', { data: Buffer.from('unsupported PKWARE payload'), flags: 0x80000100 }],
        ['(listfile)', Buffer.from(list)],
    ], { gap: 13, aliases: [{ name: 'alias.bin', target: 'aliased.bin' }], records: [
        { name: 'localized.bin', locale: 0x412, data: Buffer.from('other locale') },
        { name: 'not-listed.bin', data: Buffer.from('live hash without known name') },
        { data: Buffer.from('live block without hash') },
        { data: Buffer.from('inactive space'), flags: 0 },
    ] });
    const tracker = createSavingsTracker(input), output = openMap(input).compact();
    tracker.record('recompression', '공간 회수', output);
    const savings = tracker.summary();
    reconcile(savings, input, output);
    assert.equal(savings.files.length, openMap(input).inspect().blocks.filter(block => block.live).length);
    assert.equal(savings.files.filter(file => file.names.includes('aliased.bin')).length, 1);
    assert.deepEqual(savings.files.find(file => file.blockIndex === 0).names, ['aliased.bin', 'alias.bin']);
    assert.equal(savings.files.filter(file => file.names.includes('localized.bin')).length, 2);
    assert(savings.files.every(file => file.kind === 'unchanged' && file.savedBytes === 0));
    assert.match(savings.files.find(file => file.blockIndex === 5).label, /미열거/);
    assert.match(savings.files.find(file => file.blockIndex === 6).label, /해시 참조 없는/);
    assert.match(savings.files.find(file => file.names.includes('opaque.bin')).label, /읽기 미지원.*보존/);
    assert(savings.storage.savedOtherBytes > 0);
    assert(!savings.files.some(file => file.blockIndex === 7));
});

test('larger rewritten payloads report negative savings without hiding growth', () => {
    const input = createTestMap([['message.bin', Buffer.from('x')]]);
    const tracker = createSavingsTracker(input);
    const output = openMap(input).replace([['message.bin', Buffer.alloc(2000, 65)]], { levels: [0] });
    tracker.record('lua', '기록', output, { rewrite: true });
    const savings = tracker.summary();
    reconcile(savings, input, output);
    assert.equal(savings.savedBytes, -1999);
    assert(savings.savedPercent < 0);
    assert.equal(savings.files.find(file => file.names.includes('message.bin')).savedBytes, -1999);
    assert.equal(savings.storage.savedOtherBytes, 0);
});

test('opaque or multi-locale listfiles do not force decoding just to collect savings', () => {
    for (const extra of [
        { data: Buffer.from('opaque list bytes'), flags: 0x80000100 },
        Buffer.from('unknown.bin\r\n'),
    ]) {
        const localized = Buffer.isBuffer(extra);
        const input = createTestMap([
            ['unknown.bin', Buffer.from('packed data')], ['(listfile)', extra],
        ], { gap: 8, records: localized ? [{ name: '(listfile)', locale: 0x412, data: Buffer.from('other listing') }] : [] });
        const tracker = createSavingsTracker(input), output = openMap(input).compact();
        tracker.record('recompression', '공간 회수', output);
        const savings = tracker.summary();
        reconcile(savings, input, output);
        assert.deepEqual(savings.files.find(file => file.blockIndex === 0).names, []);
        assert(savings.files.every(file => file.kind === 'unchanged'));
    }
});

test('fixed required paths remain identifiable without any listfile', () => {
    const input = createTestMap([['war3map.lua', Buffer.from('source')], ['unknown.bin', Buffer.from('unknown')]], { listfile: false });
    const tracker = createSavingsTracker(input), output = openMap(input).compact();
    tracker.record('recompression', '공간 회수', output);
    const savings = tracker.summary();
    reconcile(savings, input, output);
    assert.deepEqual(savings.files.find(file => file.blockIndex === 0).names, ['war3map.lua']);
    assert.deepEqual(savings.files.find(file => file.blockIndex === 1).names, []);
});

test('removing one alias preserves the shared payload instead of claiming file-byte savings', () => {
    const input = createTestMap([['war3map.wtg', Buffer.from('shared editor payload')]],
        { aliases: [{ name: 'remaining.bin', target: 'war3map.wtg' }] });
    const tracker = createSavingsTracker(input), output = openMap(input).remove(['war3map.wtg']);
    tracker.record('cleanup', '이름 정리', output, { rewrite: true });
    const savings = tracker.summary();
    reconcile(savings, input, output);
    const shared = savings.files.find(file => file.blockIndex === 0);
    assert.equal(shared.kind, 'unchanged');
    assert.equal(shared.savedBytes, 0);
    assert.match(shared.label, /일부 이름 정리/);
    assert.deepEqual(shared.names, ['war3map.wtg', 'remaining.bin']);
    assert(openMap(output).has('remaining.bin') && !openMap(output).has('war3map.wtg'));
});

test('unknown compression masks stay opaque and never contribute decoded-size estimates', () => {
    const packed = Buffer.from([8, 0, 0, 0, 11, 0, 0, 0, 0x10, 1, 2]);
    const input = createTestMap([['opaque.bin', { data: packed, decoded: Buffer.alloc(100, 65), flags: 0x80000200 }]]);
    assert.equal(openMap(input).read('opaque.bin', true), null);
    const tracker = createSavingsTracker(input), output = openMap(input).compact();
    tracker.record('recompression', '공간 회수', output);
    const savings = tracker.summary();
    reconcile(savings, input, output);
    const row = savings.files.find(file => file.names.includes('opaque.bin'));
    assert.equal(row.kind, 'unchanged');
    assert.equal(row.beforeBytes, packed.length);
    assert.equal(row.afterBytes, packed.length);
    assert.match(row.label, /보존/);
});
