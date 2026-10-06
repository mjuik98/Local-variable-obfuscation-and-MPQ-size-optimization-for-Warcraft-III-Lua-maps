import { writeNewOutput } from './output.mjs';

// Shared with the desktop parent: 0 computing, 1 cancelled, 2 writing,
// 3 publishing, 4 completed. Cancellation and publication use the same gate.
export function writeCancellableOutput(destination, contents, { state, beforePublish }) {
    if (Atomics.compareExchange(state, 0, 0, 2) !== 0) throw new Error('작업이 취소되었습니다.');
    writeNewOutput(destination, contents, { beforePublish() {
        beforePublish();
        if (Atomics.compareExchange(state, 0, 2, 3) !== 2) throw new Error('작업이 취소되었습니다.');
    } });
    Atomics.store(state, 0, 4);
}
