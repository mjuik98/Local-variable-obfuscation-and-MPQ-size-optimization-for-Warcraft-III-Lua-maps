import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { createInterface } from 'node:readline';
import { listPresets } from './presets.mjs';

// A worker and its single memory cache belong to one open desktop session.
// Cancelling computation discards that worker; the next request starts fresh.
export function createDesktopSession({ emit = () => {}, limitBytes } = {}) {
    assert(typeof emit === 'function', 'emit must be a function');
    let worker = null, active = null, closed = false;
    const finish = (job, result) => {
        if (active !== job) return;
        active = null;
        emit(result); job.resolve(result);
    };
    function ensureWorker() {
        if (worker) return worker;
        const current = new Worker(new URL('./desktop-worker.mjs', import.meta.url), { workerData: { persistent: true, ...(limitBytes === undefined ? {} : { limitBytes }) }, execArgv: [] });
        worker = current;
        current.on('message', value => {
            if (worker !== current || !active) return;
            if (value.type === 'result') finish(active, value);
            else emit(value);
        });
        current.on('error', error => {
            if (worker !== current) return;
            worker = null;
            if (active) finish(active, { type: 'result', ok: false, error: error.message });
        });
        current.on('exit', code => {
            if (worker !== current) return;
            worker = null;
            if (active) finish(active, { type: 'result', ok: false, cancelled: Atomics.load(active.state, 0) === 1, error: '처리 프로세스가 결과 없이 종료되었습니다 (' + code + ').' });
        });
        return current;
    }
    return {
        run(request) {
            assert(!closed && !active, 'Desktop session is closed or busy');
            const current = ensureWorker(), state = new Int32Array(new SharedArrayBuffer(4));
            let resolve;
            const completion = new Promise(done => { resolve = done; });
            const job = { state, resolve };
            active = job;
            current.postMessage({ request, state: state.buffer });
            return { completion, cancel() {
                if (active !== job) return false;
                for (const phase of [0, 2]) {
                    if (Atomics.compareExchange(state, 0, phase, 1) !== phase) continue;
                    if (phase === 0) {
                        worker = null;
                        current.terminate().then(() => finish(job, { type: 'result', ok: false, cancelled: true, error: '작업이 취소되었습니다. 출력 파일을 만들지 않았습니다.' }));
                    } else emit({ type: 'progress', stage: 'cancelling' });
                    return true;
                }
                emit({ type: 'progress', stage: 'publishing' });
                return false;
            } };
        },
        async close() {
            assert(!active, 'Finish or cancel the active job before closing its session');
            closed = true;
            const current = worker; worker = null;
            if (current) await current.terminate();
        },
    };
}

export function startDesktopJob(request, options = {}) {
    const session = createDesktopSession(options), job = session.run(request);
    return { cancel: job.cancel, completion: job.completion.finally(() => session.close()) };
}

export function runDesktopProtocol({ input = process.stdin, output = process.stdout, persistent = false } = {}) {
    const lines = createInterface({ input, crlfDelay: Infinity });
    let job = null, closing = false;
    const emit = event => output.write(JSON.stringify(event) + '\n');
    const session = createDesktopSession({ emit });
    const close = () => {
        closing = true; lines.close();
        if (typeof input.destroy === 'function') input.destroy();
        return session.close();
    };
    lines.on('line', line => {
        try {
            assert(line.length <= 65536, 'Desktop request exceeds the size limit');
            const request = JSON.parse(line);
            if (request?.action === 'cancel') {
                assert(Object.keys(request).length === 1, 'Unknown cancellation field');
                job?.cancel(); return;
            }
            assert(!job, 'Only one desktop job can run at a time');
            if (request?.action === 'presets') {
                assert(Object.keys(request).length === 1, 'Unknown preset request field');
                emit({ type: 'result', ok: true, presets: listPresets() });
                if (!persistent) void close();
                return;
            }
            job = session.run(request);
            job.completion.then(() => {
                job = null;
                if (!persistent || closing) void close();
            });
        } catch (error) {
            if (job) { job.cancel(); return; }
            emit({ type: 'result', ok: false, error: error.message });
            if (!persistent) void close();
        }
    });
    lines.on('close', () => {
        if (closing) return;
        closing = true;
        if (job) job.cancel();
        else void session.close();
    });
    return lines;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    assert(process.argv.slice(2).every((value, index) => index === 0 && value === '--session'), 'Unknown desktop protocol option');
    runDesktopProtocol({ persistent: process.argv[2] === '--session' });
}
