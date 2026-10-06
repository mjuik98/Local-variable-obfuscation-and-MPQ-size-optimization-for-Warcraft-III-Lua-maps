import assert from 'node:assert/strict';
import zopfli from '@gfx/zopfli';

// Zopfli writes standard zlib streams that inflate like any other zlib data;
// it searches longer for smaller encodings. The WebAssembly runtime starts
// asynchronously once, after which each compression completes synchronously.
await zopfli.zlibAsync(Buffer.alloc(1), { numiterations: 1 });

export function zopfliZlib(bytes, iterations = 15) {
    assert(Buffer.isBuffer(bytes), 'Zopfli input must be a Buffer');
    let output = null;
    zopfli.zlib(bytes, { numiterations: iterations }, (error, result) => {
        if (error) throw error;
        output = result;
    });
    assert(output, 'Zopfli did not complete synchronously');
    return Buffer.from(output.buffer, output.byteOffset, output.length);
}
