import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Synchronous work cannot be interrupted by a test timeout, so each workload
// runs in a child process that is killed at the limit. The limits are far above
// the linear-time cost and far below the former exponential/cubic cost.
const LIMIT_MS = 30000;
function runBounded(code) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: LIMIT_MS });
    assert.equal(result.signal, null, 'Workload exceeded ' + LIMIT_MS + ' ms');
    assert.equal(result.status, 0, result.stderr);
}
const moduleUrl = path => JSON.stringify(new URL(path, import.meta.url).href);

test('reflection analysis of deeply nested calls stays linear', () => {
    // Depth 10 previously took minutes because every argument was re-evaluated per check.
    runBounded(`
        import { transformLua } from ${moduleUrl('../src/lua.mjs')};
        let expression = 'value';
        for (let depth = 0; depth < 40; depth++) expression = 'f' + depth + '(' + expression + ', 1)';
        transformLua('local value = 1; return ' + expression);
        transformLua('local value = 1; return ' + expression, { minify: false });
    `);
});

test('archive updates with many entries avoid repeated hash-table scans', () => {
    // Replacement verification previously scanned the hash table per block and change.
    runBounded(`
        import { openMap } from ${moduleUrl('../src/mpq.mjs')};
        import { createTestMap } from ${moduleUrl('./mpq-fixture.mjs')};
        const entries = Array.from({ length: 3000 }, (_, index) => ['war3mapImported\\\\file' + index + '.bin', Buffer.alloc(600, index % 251)]);
        const map = openMap(createTestMap(entries, { attributes: true, hashCount: 8192 }));
        const optimized = map.optimize();
        openMap(optimized).remove(['war3mapImported\\\\file7.bin']);
    `);
});
