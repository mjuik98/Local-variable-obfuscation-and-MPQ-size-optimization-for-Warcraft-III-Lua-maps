import assert from 'node:assert/strict';

// Experimental lossless removal of audio metadata. Only chunks and tags that
// carry no playback data are removed, and the remaining file must parse as a
// complete WAV or MPEG audio stream; anything else is left byte for byte.

// RIFF chunks without sample data, loop points, cue points or format fields.
// LIST is removed only for its INFO (text tag) form.
const WAV_METADATA = new Set(['JUNK', 'junk', 'PAD ', 'pad ', 'bext', 'iXML', '_PMX', 'id3 ', 'ID3 ']);

function stripWav(bytes) {
    if (bytes.length < 12 || bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WAVE') return null;
    if (bytes.readUInt32LE(4) + 8 !== bytes.length) return null;
    const kept = [];
    let cursor = 12, removed = false, format = false, data = false;
    while (cursor < bytes.length) {
        if (cursor + 8 > bytes.length) return null;
        const id = bytes.toString('latin1', cursor, cursor + 4), size = bytes.readUInt32LE(cursor + 4);
        const end = cursor + 8 + size + (size & 1);
        if (end > bytes.length) return null;
        if (id === 'fmt ') {
            if (format || data || size < 16) return null;
            // The base format is 16 bytes; an extended format adds cbSize and
            // the indicated bytes. Do not strip a truncated format description.
            if (size !== 16 && (size < 18 || 18 + bytes.readUInt16LE(cursor + 24) > size)) return null;
        }
        if (id === 'data' && !format) return null;
        const metadata = WAV_METADATA.has(id) || (id === 'LIST' && size >= 4 && bytes.toString('latin1', cursor + 8, cursor + 12) === 'INFO');
        if (metadata) removed = true;
        else {
            kept.push(bytes.subarray(cursor, end));
            format ||= id === 'fmt ';
            data ||= id === 'data';
        }
        cursor = end;
    }
    if (!removed || !format || !data) return null;
    const header = Buffer.from(bytes.subarray(0, 12));
    const body = Buffer.concat(kept);
    header.writeUInt32LE(body.length + 4, 4);
    return Buffer.concat([header, body]);
}

const MPEG_BITRATES = {
    // [version 1 | 2 and 2.5][layer 1, 2, 3], kbit/s by bitrate index 1..14.
    1: [[32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
        [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
        [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]],
    2: [[32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
        [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
        [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]],
};
const MPEG_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

// Length of the MPEG audio frame at offset, or 0 for anything else. Free
// bitrate frames have no computable length and are not accepted.
function mpegFrameLength(bytes, offset) {
    if (offset + 4 > bytes.length || bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) return 0;
    const version = (bytes[offset + 1] >> 3) & 3, layer = (bytes[offset + 1] >> 1) & 3;
    const bitrateIndex = bytes[offset + 2] >> 4, rateIndex = (bytes[offset + 2] >> 2) & 3, padding = (bytes[offset + 2] >> 1) & 1;
    if (version === 1 || layer === 0 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return 0;
    const layerNumber = 4 - layer, bitrate = MPEG_BITRATES[version === 3 ? 1 : 2][layerNumber - 1][bitrateIndex - 1] * 1000;
    const rate = MPEG_RATES[version][rateIndex];
    if (layerNumber === 1) return (Math.floor(12 * bitrate / rate) + padding) * 4;
    const samples = layerNumber === 3 && version !== 3 ? 72 : 144;
    return Math.floor(samples * bitrate / rate) + padding;
}

function stripMp3(bytes) {
    let start = 0, end = bytes.length;
    if (bytes.length >= 10 && bytes.toString('latin1', 0, 3) === 'ID3') {
        const version = bytes[3], flags = bytes[5];
        // Only known ID3v2 layouts define these lengths and flag meanings.
        const allowed = version === 2 ? 0xc0 : version === 3 ? 0xe0 : version === 4 ? 0xf0 : 0;
        if (!allowed || bytes[4] === 0xff || (flags & ~allowed)) return null;
        const size = bytes.subarray(6, 10);
        if (size.some(byte => byte & 0x80)) return null;
        const tagEnd = 10 + ((size[0] << 21) | (size[1] << 14) | (size[2] << 7) | size[3]);
        const footer = version === 4 && (flags & 0x10);
        start = tagEnd + (footer ? 10 : 0);
        if (start > end) return null;
        // A footer repeats the header after its reversed identifier. Guessing
        // its size could otherwise delete ten bytes of sound data.
        if (footer && (bytes.toString('latin1', tagEnd, tagEnd + 3) !== '3DI' ||
            !bytes.subarray(tagEnd + 3, start).equals(bytes.subarray(3, 10)))) return null;
    }
    if (end - start >= 128 && bytes.toString('latin1', end - 128, end - 125) === 'TAG') end -= 128;
    if (start === 0 && end === bytes.length) return null;
    // Every remaining byte must belong to a chain of complete audio frames.
    let cursor = start, frames = 0;
    while (cursor < end) {
        const length = mpegFrameLength(bytes, cursor);
        if (!length || cursor + length > end) return null;
        cursor += length; frames++;
    }
    return frames ? Buffer.from(bytes.subarray(start, end)) : null;
}

// The stripped contents of an MPQ file selected by its extension, or null
// when nothing can be removed losslessly.
export function stripMediaMetadata(name, bytes) {
    assert(typeof name === 'string' && Buffer.isBuffer(bytes), 'Media stripping requires a name and bytes');
    const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
    const result = extension === 'wav' ? stripWav(bytes) : extension === 'mp3' ? stripMp3(bytes) : null;
    return result && result.length < bytes.length ? result : null;
}
