import test from 'node:test';
import assert from 'node:assert/strict';
import { stripMediaMetadata } from '../src/media.mjs';
import { protectMap } from '../src/protect.mjs';
import { openMap } from '../src/mpq.mjs';
import { createLuaMap } from './map-fixture.mjs';

function chunk(id, body) {
    const header = Buffer.alloc(8);
    header.write(id, 0, 'latin1');
    header.writeUInt32LE(body.length, 4);
    return Buffer.concat([header, body, body.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}
function wav(...chunks) {
    const body = Buffer.concat([Buffer.from('WAVE'), ...chunks]), header = Buffer.from('RIFF\0\0\0\0');
    header.writeUInt32LE(body.length, 4);
    return Buffer.concat([header, body]);
}
const format = chunk('fmt ', Buffer.from([1, 0, 1, 0, 0x44, 0xac, 0, 0, 0x88, 0x58, 1, 0, 2, 0, 16, 0]));
const samples = chunk('data', Buffer.from([1, 2, 3, 4, 5, 6, 7]));
const loops = chunk('smpl', Buffer.alloc(36, 9));
const info = chunk('LIST', Buffer.concat([Buffer.from('INFOINAM'), Buffer.from([5, 0, 0, 0]), Buffer.from('Title\0')]));
const labels = chunk('LIST', Buffer.from('adtllabl'));

// MPEG-1 Layer III, 128 kbit/s, 44.1 kHz frames of 417 bytes (418 with padding).
function frame(padding = false) {
    const bytes = Buffer.alloc(padding ? 418 : 417, 0x55);
    bytes.set([0xff, 0xfb, 0x90 | (padding ? 2 : 0), 0x64]);
    return bytes;
}
const audio = Buffer.concat([frame(), frame(true), frame()]);
function id3v2(body, footer = false) {
    const size = body.length, header = Buffer.from([0x49, 0x44, 0x33, 4, 0, footer ? 0x10 : 0, (size >> 21) & 127, (size >> 14) & 127, (size >> 7) & 127, size & 127]);
    return Buffer.concat([header, body, footer ? Buffer.from([0x33, 0x44, 0x49, 4, 0, 0x10, 0, 0, 0, size & 127]) : Buffer.alloc(0)]);
}
const id3v1 = Buffer.concat([Buffer.from('TAG'), Buffer.alloc(125, 0x20)]);

test('WAV metadata chunks are removed while format, samples, loops and labels stay', () => {
    const source = wav(format, info, chunk('JUNK', Buffer.alloc(13)), samples, loops, labels, chunk('bext', Buffer.alloc(20)));
    const stripped = stripMediaMetadata('Sound\\Effect.WAV', source);
    assert.deepEqual(stripped, wav(format, samples, loops, labels));
    assert.equal(stripped.readUInt32LE(4) + 8, stripped.length);
    assert.equal(stripMediaMetadata('effect.wav', stripped), null, 'Nothing more to remove');
    assert.equal(stripMediaMetadata('effect.wav', wav(format, samples)), null);
});

test('malformed or incomplete WAV files are left unchanged', () => {
    const truncated = wav(format, info, samples).subarray(0, -3);
    for (const bytes of [truncated, wav(info, samples), wav(format, info), Buffer.from('RIFX'), Buffer.concat([wav(format, info, samples), Buffer.alloc(2)])]) {
        assert.equal(stripMediaMetadata('effect.wav', bytes), null);
    }
});

test('MP3 ID3 tags are removed only when the rest is a complete chain of audio frames', () => {
    for (const source of [Buffer.concat([id3v2(Buffer.alloc(40, 1)), audio]), Buffer.concat([audio, id3v1]),
        Buffer.concat([id3v2(Buffer.alloc(9, 1), true), audio, id3v1])]) {
        assert.deepEqual(stripMediaMetadata('music\\theme.mp3', source), audio);
    }
    assert.equal(stripMediaMetadata('theme.mp3', audio), null, 'Untagged audio is unchanged');
    assert.equal(stripMediaMetadata('theme.mp3', Buffer.concat([id3v2(Buffer.alloc(4)), audio.subarray(0, -1)])), null, 'A partial last frame is unchanged');
    assert.equal(stripMediaMetadata('theme.mp3', Buffer.concat([id3v2(Buffer.alloc(4)), audio, Buffer.from('APETAGEX')])), null, 'Unknown trailing data is unchanged');
    const unsynchronised = id3v2(Buffer.alloc(4));
    unsynchronised[9] = 0x80;
    assert.equal(stripMediaMetadata('theme.mp3', Buffer.concat([unsynchronised, audio])), null);
    assert.equal(stripMediaMetadata('theme.ogg', Buffer.concat([id3v2(Buffer.alloc(4)), audio])), null, 'Other formats are not touched');
});

test('protection strips listed audio metadata only when selected and keeps other files', () => {
    const effect = wav(format, info, samples), music = Buffer.concat([id3v2(Buffer.alloc(300, 7)), audio, id3v1]);
    const source = createLuaMap({ extraEntries: [['Sound\\effect.wav', effect], ['Sound\\theme.mp3', music], ['Sound\\kept.wav', effect], ['war3mapImported\\model.mdx', Buffer.from('model')]], mpq: { attributes: true } });
    const original = openMap(source);
    assert.deepEqual(openMap(protectMap(source).bytes).read('Sound\\effect.wav'), effect, 'Off by default');
    const result = protectMap(source, { compression: { stripMediaMetadata: true, excludeFiles: ['Sound/kept.wav'] } }), output = openMap(result.bytes);
    assert.deepEqual(output.read('Sound\\effect.wav'), wav(format, samples));
    assert.deepEqual(output.read('Sound\\theme.mp3'), audio);
    assert.deepEqual(output.read('Sound\\kept.wav'), effect, 'Excluded files keep their bytes');
    for (const name of ['war3map.w3i', 'war3map.w3e', 'war3mapImported\\model.mdx']) assert.deepEqual(output.read(name), original.read(name));
    assert.deepEqual(result.summary.media.strippedFiles, ['Sound\\effect.wav', 'Sound\\theme.mp3']);
    assert.equal(result.summary.media.savedBytes, effect.length - wav(format, samples).length + music.length - audio.length);
    assert(result.summary.savings.stages.some(stage => stage.id === 'media'));
    const plain = protectMap(source, { compression: { enabled: false, stripMediaMetadata: true, excludeFiles: ['Sound/kept.wav'] } });
    assert(original.verifyPreserved(plain.bytes, { changedNames: ['war3map.lua', 'Sound\\effect.wav', 'Sound\\theme.mp3'] }));
});
