import { workerData, parentPort } from 'node:worker_threads';
import { executeJob, createJobSession } from './jobs.mjs';
import { writeCancellableOutput } from './publication.mjs';

// 0 computing, 1 cancelled, 2 writing, 3 publishing, 4 completed.
// The parent can interrupt computation, but a writer always cleans its owned
// temporary file. Publication wins only after an atomic final cancellation gate.
const session = createJobSession({ ...(workerData.limitBytes === undefined ? {} : { limitBytes: workerData.limitBytes }) });
function run({ request, state: buffer }) {
    const state = new Int32Array(buffer);
    try {
        const result = executeJob(request, {
            session,
            onProgress(stage, detail) {
                if (Atomics.load(state, 0) === 1) throw new Error('작업이 취소되었습니다.');
                parentPort.postMessage({ type: 'progress', stage, ...(detail ? { message: detail.label + ' (' + detail.index + '/' + detail.total + ')' } : {}) });
            },
            publish(destination, contents, { beforePublish }) {
                writeCancellableOutput(destination, contents, { state, beforePublish });
            },
        });
        if (Atomics.load(state, 0) === 1) throw new Error('작업이 취소되었습니다.');
        Atomics.store(state, 0, 4);
        parentPort.postMessage({ type: 'result', ok: true, ...result });
    } catch (error) {
        session.clear();
        parentPort.postMessage({ type: 'result', ok: false, cancelled: Atomics.load(state, 0) === 1, error: error.message });
    }
}
if (workerData.persistent) parentPort.on('message', run);
else run(workerData);
