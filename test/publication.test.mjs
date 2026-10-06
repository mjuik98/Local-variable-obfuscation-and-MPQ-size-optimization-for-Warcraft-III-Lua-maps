import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeCancellableOutput } from '../src/publication.mjs';

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'w3lp-publication-'));
    t.after(() => {
        const resolved = path.resolve(directory);
        assert(path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('w3lp-publication-'));
        fs.rmSync(resolved, { recursive: true, force: true });
    });
    return { directory, output: path.join(directory, 'dummy.bin'), state: new Int32Array(new SharedArrayBuffer(4)) };
}

test('cancellation during the final source guard removes writer temporary data and prevents publication', t => {
    const value = fixture(t), contents = Buffer.alloc(200000, 65), original = Buffer.from(contents);
    assert.throws(() => writeCancellableOutput(value.output, contents, { state: value.state, beforePublish() {
        assert.equal(Atomics.load(value.state, 0), 2);
        assert.equal(Atomics.compareExchange(value.state, 0, 2, 1), 2);
    } }), /취소/);
    assert.deepEqual(fs.readdirSync(value.directory), []);
    assert.deepEqual(contents, original);
});

test('cancelled computation never starts a writer while successful publication completes atomically', t => {
    const value = fixture(t);
    Atomics.store(value.state, 0, 1);
    assert.throws(() => writeCancellableOutput(value.output, Buffer.from('data'), { state: value.state, beforePublish() { assert.fail(); } }), /취소/);
    assert.deepEqual(fs.readdirSync(value.directory), []);
    Atomics.store(value.state, 0, 0);
    writeCancellableOutput(value.output, Buffer.from('data'), { state: value.state, beforePublish() {} });
    assert.equal(Atomics.load(value.state, 0), 4);
    assert.equal(Atomics.compareExchange(value.state, 0, 2, 1), 4, 'Cancellation cannot win after publication');
    assert.equal(fs.readFileSync(value.output, 'utf8'), 'data');
});

test('failed source guards and existing targets cannot leave partial files or overwrite a winner', t => {
    const value = fixture(t);
    assert.throws(() => writeCancellableOutput(value.output, Buffer.from('result'), { state: value.state, beforePublish() { throw new Error('Input changed'); } }), /Input changed/);
    assert.deepEqual(fs.readdirSync(value.directory), []);
    fs.writeFileSync(value.output, 'winner');
    Atomics.store(value.state, 0, 0);
    assert.throws(() => writeCancellableOutput(value.output, Buffer.from('replacement'), { state: value.state, beforePublish() {} }), /EEXIST/);
    assert.deepEqual(fs.readdirSync(value.directory), ['dummy.bin']);
    assert.equal(fs.readFileSync(value.output, 'utf8'), 'winner');
});
