import assert from 'node:assert/strict';
import { createTestMap } from './mpq-fixture.mjs';

export const DEFAULT_LUA = '-- fixture comment\nfunction config() end\nfunction main() local counter = 7; return counter end\n';

// Build the W3I fields independently, using distinct values for fields adjacent
// to the language discriminator. The fixture does not use the reader's offsets.
export function createMapInfo({ version = 31, language = 1 } = {}) {
    const chunks = [];
    const integer = value => { const bytes = Buffer.alloc(4); bytes.writeInt32LE(value); chunks.push(bytes); };
    const real = value => { const bytes = Buffer.alloc(4); bytes.writeFloatLE(value); chunks.push(bytes); };
    const text = value => chunks.push(Buffer.from(value + '\0'));
    const byte = value => chunks.push(Buffer.from([value]));
    const color = (r, g, b, a) => chunks.push(Buffer.from([r, g, b, a]));
    integer(version);
    integer(2); // Save count.
    integer(6061); // Editor version.
    for (const component of [1, 36, 2, 21179]) integer(component); // Game version.
    for (const value of ['Lua map fixture', 'Test author', '한글 설명', '1-4']) text(value);
    for (const value of [-1024, -1024, 1024, -1024, 1024, 1024, -1024, 1024]) real(value); // Camera bounds.
    for (const value of [2, 3, 4, 5]) integer(value); // Camera complements.
    integer(64); integer(64); // Playable dimensions.
    integer(0x20); // Map flags.
    byte('L'.charCodeAt(0)); // Lordaeron tileset.
    integer(-1); // Custom loading screen.
    if (version === 39) integer(3); // Loading screen crest race.
    for (const value of ['', 'Loading description', 'Loading title', 'Loading subtitle']) text(value);
    integer(0); // Game data set.
    for (const value of ['', 'Prologue description', 'Prologue title', 'Prologue subtitle']) text(value);
    integer(0); real(100); real(4000); real(0.5); color(80, 90, 100, 255); // Terrain fog.
    if (version === 39) {
        integer(2); integer(1); // Terrain fog style and sky visibility.
        for (const value of [0.25, 0.5, 0.75, 1]) real(value);
    }
    integer(0); // Global weather rawcode.
    text('Default'); // Custom sound environment.
    byte('L'.charCodeAt(0)); // Lighting tileset.
    color(255, 254, 253, 252); // Water tint.
    integer(language);
    // Remaining sections have no players, forces, upgrades or custom tables.
    // Newer versions include graphics/game data fields before those sections.
    if (version >= 31) { integer(0); integer(0); }
    for (let section = 0; section < 6; section++) integer(0);
    return Buffer.concat(chunks);
}

export function createImports(entries) {
    const header = Buffer.alloc(8);
    header.writeUInt32LE(1, 0); header.writeUInt32LE(entries.length, 4);
    return Buffer.concat([header, ...entries.map(({ flag = 13, path }) => {
        assert(Number.isInteger(flag) && flag >= 0 && flag <= 255);
        const bytes = Buffer.isBuffer(path) ? path : Buffer.from(path);
        assert(!bytes.includes(0));
        return Buffer.concat([Buffer.from([flag]), bytes, Buffer.from([0])]);
    })]);
}

export function createLuaMap({ script = DEFAULT_LUA, version = 31, language = 1, extraEntries = [], mpq = {} } = {}) {
    const terrain = Buffer.from('W3E!synthetic terrain preservation fixture');
    return createTestMap([
        ['war3map.lua', Buffer.isBuffer(script) ? script : Buffer.from(script)],
        ['war3map.w3i', createMapInfo({ version, language })],
        ['war3map.w3e', terrain],
        ...extraEntries,
    ], mpq);
}
