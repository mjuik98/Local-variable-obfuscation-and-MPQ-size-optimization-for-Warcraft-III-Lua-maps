import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

export function validateOutputPath(input, output) {
    const source = fs.realpathSync(input);
    assert(fs.statSync(source).isFile(), 'Input must be a file');
    assert(typeof output === 'string' && output.length > 0, 'An explicit --output path is required');
    const candidate = path.resolve(output);
    const parent = fs.realpathSync(path.dirname(candidate));
    assert(fs.statSync(parent).isDirectory(), 'Output directory must exist');
    const destination = path.join(parent, path.basename(candidate));
    const comparison = value => process.platform === 'win32' ? value.toLowerCase() : value;
    assert(comparison(source) !== comparison(destination), 'Output must differ from input');
    // lstat also detects dangling symbolic links at the destination.
    assert(!fs.lstatSync(destination, { throwIfNoEntry: false }), 'Output already exists; refusing to overwrite');
    return { input: source, output: destination };
}

export function assertFileUnchanged(file, contents) {
    assert(Buffer.isBuffer(contents), 'Original contents must be a Buffer');
    const descriptor = fs.openSync(file, 'r');
    const message = 'Input changed while processing; output cancelled';
    try {
        assert.equal(fs.fstatSync(descriptor).size, contents.length, message);
        const chunk = Buffer.alloc(Math.min(64 * 1024, Math.max(1, contents.length)));
        let position = 0;
        while (position < contents.length) {
            const count = fs.readSync(descriptor, chunk, 0, Math.min(chunk.length, contents.length - position), position);
            assert(count > 0 && chunk.subarray(0, count).equals(contents.subarray(position, position + count)), message);
            position += count;
        }
        assert.equal(fs.fstatSync(descriptor).size, contents.length, message);
    } finally { fs.closeSync(descriptor); }
}

export function writeNewOutput(destination, contents, { beforePublish = () => {} } = {}) {
    assert(Buffer.isBuffer(contents), 'Output contents must be a Buffer');
    assert(typeof beforePublish === 'function', 'beforePublish must be a function');
    // A hard link publishes the fully written file atomically and fails if the
    // destination already exists. No rename-overwrite fallback is permitted.
    const directory = fs.mkdtempSync(path.join(path.dirname(destination), '.w3lua-'));
    const temporary = path.join(directory, 'result');
    try {
        const descriptor = fs.openSync(temporary, 'wx', 0o600);
        try { fs.writeFileSync(descriptor, contents); fs.fsyncSync(descriptor); }
        finally { fs.closeSync(descriptor); }
        const reader = fs.openSync(temporary, 'r');
        try {
            assert.equal(fs.fstatSync(reader).size, contents.length, 'Output readback length mismatch');
            const chunk = Buffer.alloc(Math.min(64 * 1024, Math.max(1, contents.length)));
            let position = 0;
            while (position < contents.length) {
                const count = fs.readSync(reader, chunk, 0, Math.min(chunk.length, contents.length - position), position);
                assert(count > 0 && chunk.subarray(0, count).equals(contents.subarray(position, position + count)), 'Output readback mismatch');
                position += count;
            }
            assert.equal(fs.fstatSync(reader).size, contents.length, 'Output readback length mismatch');
        } finally { fs.closeSync(reader); }
        beforePublish();
        fs.linkSync(temporary, destination);
    } finally {
        fs.rmSync(temporary, { force: true });
        fs.rmdirSync(directory);
    }
}
