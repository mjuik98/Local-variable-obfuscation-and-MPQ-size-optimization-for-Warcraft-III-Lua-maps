import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateOutputPath, writeNewOutput } from '../src/output.mjs';

function directory(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w3lua-output-test-'));
    t.after(() => {
        // Remove only files created inside this exact, owned temporary directory.
        for (const item of fs.readdirSync(root)) fs.unlinkSync(path.join(root, item));
        fs.rmdirSync(root);
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
