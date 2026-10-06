import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { compressSector, compressSectors, compressionThreads } from '../src/compress.mjs';

const text = index => Buffer.from(('local item' + index + ' = { name = "entry", value = ' + index + ' }\n').repeat(40 + index % 7));
const noise = index => Buffer.from(Array.from({ length: 900 + index }, (_, offset) => ((offset + index) * 2654435761 >>> 11) & 255));

test('threaded sector compression returns the same bytes as single-threaded compression', () => {
    const sectors = Array.from({ length: 60 }, (_, index) => index % 3 ? text(index) : noise(index));
    sectors.push(Buffer.alloc(0), Buffer.from('tiny'));
    for (const options of [{ levels: [6, 9], strategies: ['default'] }, { levels: [9], strategies: ['default', 'filtered', 'rle'] }, { levels: [9], strategies: ['default'], zopfli: true }]) {
        const single = sectors.map(sector => compressSector(sector, options));
        const threaded = compressSectors(sectors, options, { threads: Math.max(1, compressionThreads()) });
        assert.deepEqual(threaded, single, JSON.stringify(options));
        threaded.forEach((packed, index) => {
            const decoded = packed.length === sectors[index].length ? packed : zlib.inflateSync(packed.subarray(1));
            assert.deepEqual(decoded, sectors[index]);
        });
    }
    // Consecutive jobs reuse the same workers without mixing results.
    const again = compressSectors(sectors.slice(0, 10), { levels: [6], strategies: ['default'] }, { threads: Math.max(1, compressionThreads()) });
    assert.deepEqual(again, sectors.slice(0, 10).map(sector => compressSector(sector, { levels: [6], strategies: ['default'] })));
});

test('sector compression reports worker failures instead of returning partial data', () => {
    if (compressionThreads() < 1) return;
    const sectors = [text(1), text(2), text(3)];
    assert.throws(() => compressSectors(sectors, { levels: [42], strategies: ['default'] }, { threads: compressionThreads() }), /Sector compression failed/);
    assert.deepEqual(compressSectors(sectors, { levels: [9], strategies: ['default'] }, { threads: compressionThreads() }),
        sectors.map(sector => compressSector(sector, { levels: [9], strategies: ['default'] })), 'The pool keeps working after a failed job');
});

test('threaded results own exactly their bytes instead of a cloned buffer pool', () => {
    if (compressionThreads() < 1) return;
    // Small Buffers are views into an 8 KB pool; posting such a view copied the
    // whole pool per sector, so a 60 MB map held gigabytes of results.
    const sectors = Array.from({ length: 40 }, (_, index) => text(index));
    const threaded = compressSectors(sectors, { levels: [9], strategies: ['default'] }, { threads: compressionThreads() });
    for (const packed of threaded) assert.equal(packed.buffer.byteLength, packed.length);
});

test('compression workers start when the host process runs evaluated module code', () => {
    if (compressionThreads() < 1) return;
    // Workers inherited --input-type from such a host, failed to load, and the
    // synchronous caller waited for the ten-minute stall limit.
    const code = `import { compressSectors } from ${JSON.stringify(new URL('../src/compress.mjs', import.meta.url).href)};
        compressSectors([Buffer.alloc(4096, 1), Buffer.alloc(4096, 2)], { levels: [6], strategies: ['default'] }, { threads: 1 });`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.signal, null, 'Compression did not finish');
    assert.equal(result.status, 0, result.stderr);
});
