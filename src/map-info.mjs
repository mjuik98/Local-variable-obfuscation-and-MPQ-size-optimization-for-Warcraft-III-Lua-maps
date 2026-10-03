import assert from 'node:assert/strict';

// Read the language field only; this tool never rewrites map information.
// Layout: WC3MapSpecification/Info/0-33.md and wc3libs W3I.read_0x27.
export function readScriptLanguage(bytes) {
    assert(Buffer.isBuffer(bytes), 'Missing war3map.w3i');
    let cursor = 0;
    const skip = size => {
        assert(cursor + size <= bytes.length, 'Truncated war3map.w3i');
        cursor += size;
    };
    const integer = () => { skip(4); return bytes.readUInt32LE(cursor - 4); };
    const string = () => {
        const end = bytes.indexOf(0, cursor);
        assert(end >= cursor, 'Unterminated war3map.w3i string');
        cursor = end + 1;
    };
    const strings = count => { for (let i = 0; i < count; i++) string(); };
    const version = integer();
    assert((version >= 28 && version <= 33) || version === 39, 'Unsupported war3map.w3i format: ' + version + ' (supported: 28..33, 39)');
    skip(8 + 16); // Saves, editor version, game version.
    strings(4);
    skip(32 + 16 + 12 + 1 + 4); // Camera, complements, dimensions/flags, tileset, loading background.
    if (version === 39) skip(4); // Loading screen crest race.
    strings(4);
    skip(4); // Game data set.
    strings(4);
    skip(4 + 12 + 4); // Fog type/ranges/color.
    if (version === 39) skip(24); // Terrain fog style, sky flag and four floats.
    skip(4); // Weather.
    string();
    skip(1 + 4); // Light environment, water tint.
    const language = integer();
    assert(language === 0 || language === 1, 'Invalid map scripting language: ' + language);
    return { version, language };
}
