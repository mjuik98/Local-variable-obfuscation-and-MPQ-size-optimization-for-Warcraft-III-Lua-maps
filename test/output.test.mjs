import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertFileUnchanged, validateOutputPath, writeNewOutput } from '../src/output.mjs';

function directory(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w3lua-output-test-'));
    t.after(() => {
        // Verify the resolved owned target before recursive native cleanup.
        const resolved = path.resolve(root);
        assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
        assert(path.basename(resolved).startsWith('w3lua-output-test-'));
        fs.rmSync(resolved, { recursive: true, force: true });
    });
    return root;
}

test('output is published completely without changing the source', t => {
    const root = directory(t), source = path.join(root, 'source.bin'), target = path.join(root, 'target.bin');
    const input = Buffer.from('original bytes'), output = Buffer.from('complete output bytes');
    fs.writeFileSync(source, input);
    const paths = validateOutputPath(source, target);
    writeNewOutput(paths.output, output, { beforePublish: () => {
        assert(!fs.existsSync(target));
        assert(fs.readFileSync(source).equals(input));
    } });
    assert(fs.readFileSync(source).equals(input));
    assert(fs.readFileSync(target).equals(output));
    assert.deepEqual(fs.readdirSync(root).sort(), ['source.bin', 'target.bin']);
});

test('input paths, hardlink aliases and existing output files are refused', t => {
    const root = directory(t), source = path.join(root, 'source.bin'), alias = path.join(root, 'alias.bin');
    fs.writeFileSync(source, 'original');
    fs.linkSync(source, alias);
    assert.throws(() => validateOutputPath(source, source), /differ from input/);
    assert.throws(() => validateOutputPath(source, alias), /already exists/);
    assert.throws(() => validateOutputPath(source, path.join(root, 'missing', 'target.bin')), /ENOENT/);
    assert.throws(() => validateOutputPath(root, path.join(root, 'target.bin')), /Input must be a file/);
    if (process.platform === 'win32') assert.throws(() => validateOutputPath(source, source.toUpperCase()), /differ from input/);
});

test('an output created during processing wins and is never overwritten', t => {
    const root = directory(t), source = path.join(root, 'source.bin'), target = path.join(root, 'target.bin');
    fs.writeFileSync(source, 'original');
    const paths = validateOutputPath(source, target);
    assert.throws(() => writeNewOutput(paths.output, Buffer.from('replacement'), {
        beforePublish: () => fs.writeFileSync(target, 'existing file'),
    }), /EEXIST/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'existing file');
    assert.deepEqual(fs.readdirSync(root).sort(), ['source.bin', 'target.bin']);
});

test('failed publication guards remove temporary files and publish no output', t => {
    const root = directory(t), target = path.join(root, 'target.bin');
    assert.throws(() => writeNewOutput(target, Buffer.from('complete'), { beforePublish: () => { throw new Error('Input changed'); } }), /Input changed/);
    assert.deepEqual(fs.readdirSync(root), []);
});

test('bounded readback publishes every chunk including a partial tail and zero bytes', t => {
    const root = directory(t), large = path.join(root, 'large.bin'), empty = path.join(root, 'empty.bin');
    const contents = Buffer.alloc(2 * 64 * 1024 + 37);
    for (let index = 0; index < contents.length; index++) contents[index] = (index * 19 + 71) & 255;
    const snapshot = Buffer.from(contents);
    writeNewOutput(large, contents);
    writeNewOutput(empty, Buffer.alloc(0));
    assert.deepEqual(fs.readFileSync(large), contents);
    assert.deepEqual(contents, snapshot, 'The writer never mutates its supplied bytes');
    assert.equal(fs.statSync(empty).size, 0);
    assert.deepEqual(fs.readdirSync(root).sort(), ['empty.bin', 'large.bin']);
});

test('invalid contents and publication callbacks fail without temporary artifacts', t => {
    const root = directory(t), target = path.join(root, 'dummy.bin');
    assert.throws(() => writeNewOutput(target, 'not a Buffer'), /must be a Buffer/);
    assert.throws(() => writeNewOutput(target, Buffer.from('data'), { beforePublish: null }), /must be a function/);
    assert.deepEqual(fs.readdirSync(root), []);
});

test('an existing output file or directory is never replaced and temporary artifacts are cleaned', t => {
    const root = directory(t), target = path.join(root, 'dummy.bin'), occupiedDirectory = path.join(root, 'occupied.bin');
    fs.writeFileSync(target, 'original output'); fs.mkdirSync(occupiedDirectory);
    assert.throws(() => writeNewOutput(target, Buffer.from('replacement')), /EEXIST/);
    assert.throws(() => writeNewOutput(occupiedDirectory, Buffer.from('replacement')), /EEXIST/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'original output');
    assert(fs.statSync(occupiedDirectory).isDirectory());
    assert.deepEqual(fs.readdirSync(root).sort(), ['dummy.bin', 'occupied.bin']);
});

test('source change at publication time cancels the writer and leaves no target or temporary directory', t => {
    const root = directory(t), source = path.join(root, 'source.bin'), target = path.join(root, 'dummy.bin');
    const original = Buffer.from('initial source');
    fs.writeFileSync(source, original);
    const paths = validateOutputPath(source, target);
    assert.throws(() => writeNewOutput(paths.output, Buffer.from('result'), { beforePublish: () => {
        fs.writeFileSync(source, 'changed by another process');
        assert(fs.readFileSync(source).equals(original), 'Input changed while processing');
    } }), /Input changed/);
    assert.equal(fs.readFileSync(source, 'utf8'), 'changed by another process');
    assert.deepEqual(fs.readdirSync(root), ['source.bin']);
});

test('missing output parents fail without creating directories or touching the source', t => {
    const root = directory(t), source = path.join(root, 'source.bin'), missing = path.join(root, 'missing', 'dummy.bin');
    fs.writeFileSync(source, 'original');
    assert.throws(() => validateOutputPath(source, missing), /ENOENT/);
    assert.throws(() => writeNewOutput(missing, Buffer.from('data')), /ENOENT/);
    assert.equal(fs.readFileSync(source, 'utf8'), 'original');
    assert.deepEqual(fs.readdirSync(root), ['source.bin']);
});

test('bounded source checks detect changed tails, appended and truncated bytes', t => {
    const root = directory(t), input = path.join(root, 'source.bin'), original = Buffer.alloc(140000, 65);
    fs.writeFileSync(input, original);
    assertFileUnchanged(input, original);
    const changed = Buffer.from(original); changed[changed.length - 1] = 66;
    for (const contents of [changed, Buffer.concat([original, Buffer.from('x')]), original.subarray(0, original.length - 1)]) {
        fs.writeFileSync(input, contents);
        assert.throws(() => assertFileUnchanged(input, original), /Input changed/);
    }
});
