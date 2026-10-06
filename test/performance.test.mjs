import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Synchronous work cannot be interrupted by a test timeout, so each workload
// runs in a child process that is killed at the limit. The limits are far above
// the linear-time cost and far below the former exponential/cubic cost. The
// workload is a module file, not --eval: compression workers inherit the
// parent's execArgv and cannot load modules under --input-type.
const LIMIT_MS = 30000;
function runBounded(t, code) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'w3lua-performance-'));
    t.after(() => fs.rmSync(directory, { recursive: true }));
    const script = path.join(directory, 'workload.mjs');
    fs.writeFileSync(script, code);
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: LIMIT_MS });
    assert.equal(result.signal, null, 'Workload exceeded ' + LIMIT_MS + ' ms');
    assert.equal(result.status, 0, result.stderr);
}
const moduleUrl = path => JSON.stringify(new URL(path, import.meta.url).href);

test('reflection analysis of deeply nested calls stays linear', t => {
    // Depth 10 previously took minutes because every argument was re-evaluated per check.
    runBounded(t, `
        import { transformLua } from ${moduleUrl('../src/lua.mjs')};
        let expression = 'value';
        for (let depth = 0; depth < 40; depth++) expression = 'f' + depth + '(' + expression + ', 1)';
        transformLua('local value = 1; return ' + expression);
        transformLua('local value = 1; return ' + expression, { minify: false });
    `);
});

test('archive updates with many entries avoid repeated hash-table scans', t => {
    // Replacement verification previously compared every block with every change
    // (about 70 s for this archive); it is now linear (about 2 s).
    runBounded(t, `
        import { openMap } from ${moduleUrl('../src/mpq.mjs')};
        import { createTestMap } from ${moduleUrl('./mpq-fixture.mjs')};
        const entries = Array.from({ length: 10000 }, (_, index) => ['war3mapImported\\\\file' + index + '.bin', Buffer.alloc(600, index % 251)]);
        const map = openMap(createTestMap(entries, { attributes: true, hashCount: 32768 }));
        const optimized = map.optimize();
        openMap(optimized).remove(['war3mapImported\\\\file7.bin']);
    `);
});
