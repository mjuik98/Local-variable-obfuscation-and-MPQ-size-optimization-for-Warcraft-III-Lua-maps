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
    assert(!fs.existsSync(destination), 'Output already exists; refusing to overwrite');
    try { fs.lstatSync(destination); assert.fail('Output already exists; refusing to overwrite'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { input: source, output: destination };
}

export function writeNewOutput(destination, contents, { beforePublish = () => {} } = {}) {
    assert(Buffer.isBuffer(contents), 'Output contents must be a Buffer');
    // A hard link publishes the fully written file atomically and fails if the
    // destination already exists. No rename-overwrite fallback is permitted.
    const directory = fs.mkdtempSync(path.join(path.dirname(destination), '.w3lua-'));
    const temporary = path.join(directory, 'result');
    try {
        const descriptor = fs.openSync(temporary, 'wx', 0o600);
        try { fs.writeFileSync(descriptor, contents); fs.fsyncSync(descriptor); }
        finally { fs.closeSync(descriptor); }
        assert(fs.readFileSync(temporary).equals(contents), 'Output readback mismatch');
        beforePublish();
        fs.linkSync(temporary, destination);
    } finally {
        fs.rmSync(temporary, { force: true });
        fs.rmdirSync(directory);
    }
}
