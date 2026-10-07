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

test('parsing scripts with many distinct globals stays linear', () => {
    // The parser's own scope tracking scanned every known global per reference
    // (about 25 s for 40,000 globals, quadratic beyond); this takes about 1 s.
    runBounded(`
        import { transformLua } from ${moduleUrl('../src/lua.mjs')};
        const parts = ['function config() end', 'function main() end'];
        for (let index = 0; index < 60000; index++) parts.push('function G' + index + '() return G' + Math.floor(index / 2) + ' end');
        transformLua(parts.join('\\n'));
    `);
});

test('closed-table method analysis avoids rescanning every field per method', () => {
    runBounded(`
        import assert from 'node:assert/strict';
        import { transformLua } from ${moduleUrl('../src/lua.mjs')};
        const count = 40000, parts = ['local Methods = {value = 7}'];
        for (let index = 0; index < count; index++) parts.push('function Methods:method' + index + '() return self.value end');
        parts.push('return Methods:method0()');
        const result = transformLua(parts.join('\\n'), { renameFields: true });
        assert.equal(result.stats.closedTables, 1);
        assert.equal(result.stats.renamedFields, count + 1);
    `);
});

test('archive updates with many entries avoid repeated hash-table scans', () => {
    // Replacement verification previously compared every block with every change
    // (about 70 s for this archive); it is now linear (about 2 s).
    runBounded(`
        import { openMap } from ${moduleUrl('../src/mpq.mjs')};
        import { createTestMap } from ${moduleUrl('./mpq-fixture.mjs')};
        const entries = Array.from({ length: 10000 }, (_, index) => ['war3mapImported\\\\file' + index + '.bin', Buffer.alloc(600, index % 251)]);
        const map = openMap(createTestMap(entries, { attributes: true, hashCount: 32768 }));
        const optimized = map.optimize();
        openMap(optimized).remove(['war3mapImported\\\\file7.bin']);
    `);
});
