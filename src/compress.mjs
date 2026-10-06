import assert from 'node:assert/strict';
import os from 'node:os';
import zlib from 'node:zlib';
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';
import { zopfliZlib } from './zopfli.mjs';

const zlibStrategies = Object.freeze({ default: zlib.constants.Z_DEFAULT_STRATEGY,
    filtered: zlib.constants.Z_FILTERED, 'huffman-only': zlib.constants.Z_HUFFMAN_ONLY,
    rle: zlib.constants.Z_RLE, fixed: zlib.constants.Z_FIXED });
// Below this much input, starting work on other threads costs more than it saves.
const POOL_THRESHOLD = 512 * 1024;
const STALL_LIMIT_MS = 10 * 60 * 1000;
let pool = null, jobs = 0;

// The smallest MPQ sector encoding: raw bytes or a zlib stream behind the
// 0x02 compression mask. Zopfli runs only where zlib already saves at least
// 10%; nearly incompressible sectors (textures, audio) cannot repay its cost.
export function compressSector(raw, { levels, strategies, zopfli = false }) {
    let best = raw;
    for (const level of levels) for (const strategy of strategies) {
        // Level zero adds a zlib wrapper and stored-block framing, so it can
        // never beat the already available raw sector.
        if (level === 0) continue;
        const candidate = Buffer.concat([Buffer.from([2]), zlib.deflateSync(raw, { level, strategy: zlibStrategies[strategy] })]);
        if (candidate.length < best.length) best = candidate;
    }
    if (zopfli && best.length < raw.length * 0.9) {
        const candidate = Buffer.concat([Buffer.from([2]), zopfliZlib(raw)]);
        if (candidate.length < best.length) best = candidate;
    }
    return best;
}

export function compressionThreads() {
    return Math.max(0, Math.min(12, os.availableParallelism() - 1));
}

function workers() {
    if (pool) return pool;
    pool = Array.from({ length: compressionThreads() }, () => {
        const worker = new Worker(new URL('./compress-worker.mjs', import.meta.url));
        const { port1, port2 } = new MessageChannel();
        worker.postMessage({ port: port2 }, [port2]);
        // Idle workers must not keep the process alive.
        worker.unref();
        return { worker, port: port1 };
    });
    return pool;
}

// Compress independent sectors. Each result depends only on its own sector,
// so the bytes are identical whether threads are used or not. The caller is
// synchronous: it waits on a shared counter and drains result ports directly.
export function compressSectors(sectors, options, { threads } = {}) {
    assert(Array.isArray(sectors) && sectors.every(Buffer.isBuffer), 'Sectors must be Buffers');
    const total = sectors.reduce((sum, sector) => sum + sector.length, 0);
    const wanted = threads ?? (options.zopfli || total >= POOL_THRESHOLD ? compressionThreads() : 0);
    if (wanted < 1 || sectors.length < 2 || compressionThreads() < 1) return sectors.map(raw => compressSector(raw, options));
    const active = workers().slice(0, wanted);
    const data = new Uint8Array(new SharedArrayBuffer(Math.max(1, total)));
    const offsets = new Int32Array(new SharedArrayBuffer((sectors.length + 1) * 4));
    let cursor = 0;
    sectors.forEach((sector, index) => { offsets[index] = cursor; data.set(sector, cursor); cursor += sector.length; });
    offsets[sectors.length] = cursor;
    // control: next sector index, completed count, failure flag.
    const control = new Int32Array(new SharedArrayBuffer(12));
    // Results of an earlier failed job may still arrive; the id filters them.
    const job = { id: ++jobs, data: data.buffer, offsets: offsets.buffer, control: control.buffer,
        options: { levels: options.levels, strategies: options.strategies, zopfli: Boolean(options.zopfli) } };
    for (const { worker } of active) worker.postMessage(job);
    let seen = 0, lastProgress = Date.now();
    while (Atomics.load(control, 2) === 0) {
        const done = Atomics.load(control, 1);
        if (done >= sectors.length) break;
        if (done !== seen) { seen = done; lastProgress = Date.now(); }
        assert(Date.now() - lastProgress < STALL_LIMIT_MS, 'Sector compression made no progress');
        Atomics.wait(control, 1, done, 1000);
    }
    const results = new Array(sectors.length);
    let failure = null;
    for (const { port } of active) {
        for (let message = receiveMessageOnPort(port); message; message = receiveMessageOnPort(port)) {
            const { id, index, bytes, error } = message.message;
            if (id !== job.id) continue;
            if (error) failure ??= error;
            else results[index] = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
        }
    }
    if (failure) throw new Error('Sector compression failed: ' + failure);
    for (let index = 0; index < results.length; index++) assert(results[index], 'Missing compressed sector ' + index);
    return results;
}
