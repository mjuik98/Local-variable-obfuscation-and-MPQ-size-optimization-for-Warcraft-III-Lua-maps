import { parentPort } from 'node:worker_threads';
import { compressSector } from './compress.mjs';

// Each job shares the input bytes and an atomic work index with every worker.
// A worker posts each result before counting it, so the waiting caller can
// drain every counted result from the port.
let port = null;
parentPort.on('message', message => {
    if (message.port) { port = message.port; return; }
    const data = new Uint8Array(message.data), offsets = new Int32Array(message.offsets), control = new Int32Array(message.control);
    const count = offsets.length - 1;
    for (let index = Atomics.add(control, 0, 1); index < count && Atomics.load(control, 2) === 0; index = Atomics.add(control, 0, 1)) {
        try {
            const raw = Buffer.from(data.buffer, offsets[index], offsets[index + 1] - offsets[index]);
            // Copy out of shared memory so zlib reads a stable private buffer.
            const result = compressSector(Buffer.from(raw), message.options);
            // A small Buffer is a view into a shared 8 KB pool, and cloning a view
            // copies its whole backing store. Transfer an exact-size copy instead.
            const bytes = new Uint8Array(result.length);
            bytes.set(result);
            port.postMessage({ id: message.id, index, bytes }, [bytes.buffer]);
        } catch (error) {
            port.postMessage({ id: message.id, index, error: error?.message ?? String(error) });
            Atomics.store(control, 2, 1);
        }
        Atomics.add(control, 1, 1);
        Atomics.notify(control, 1);
    }
});
