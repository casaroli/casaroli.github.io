/**
 * wav-exporter.js
 *
 * ES module that exports a Web Audio API AudioBuffer as a WAV file
 * (32-bit IEEE float) with embedded cue markers and labels.
 *
 * WAV layout:
 *   RIFF [filesize-8] WAVE
 *     fmt  [18] ...          (WAVE_FORMAT_IEEE_FLOAT with cbSize=0)
 *     fact [4]  ...          (required for non-PCM formats)
 *     data [dataSize] ...
 *     cue  [cueChunkDataSize] ...
 *     LIST [listChunkDataSize] adtl
 *       labl [labelDataSize] ...
 *       labl [labelDataSize] ...
 */

/**
 * Convert an AudioBuffer to a 32-bit IEEE float WAV Blob with embedded cue markers.
 *
 * @param {AudioBuffer} audioBuffer  - Web Audio API AudioBuffer
 * @param {Array<{position: number}>} cuePoints - Array of cue markers with sample positions
 * @returns {Blob} WAV file as a Blob with type 'audio/wav'
 */
export function exportWavWithCueMarkers(audioBuffer, cuePoints) {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const numFrames = audioBuffer.length;
  const bitsPerSample = 32;
  const bytesPerSample = bitsPerSample / 8; // 4
  const blockAlign = numChannels * bytesPerSample;
  const audioFormat = 3; // WAVE_FORMAT_IEEE_FLOAT

  // ── Gather channel data ──────────────────────────────────────────────
  const channels = [];
  for (let ch = 0; ch < numChannels; ch++) {
    channels.push(audioBuffer.getChannelData(ch));
  }

  // ── Compute chunk sizes ──────────────────────────────────────────────

  // fmt chunk: 18 bytes of data for IEEE float (16 standard + 2 for cbSize)
  const fmtChunkDataSize = 18;
  // Pad fmt chunk to even boundary (18 is even, so no pad needed)
  const fmtPadByte = fmtChunkDataSize % 2;
  const fmtChunkSize = 8 + fmtChunkDataSize + fmtPadByte;

  // fact chunk: required for non-PCM formats, 4 bytes of data
  const factChunkDataSize = 4;
  const factChunkSize = 8 + factChunkDataSize;

  // data chunk
  const dataChunkDataSize = numFrames * numChannels * bytesPerSample;
  // Pad data chunk payload to even length if necessary
  const dataPadByte = dataChunkDataSize % 2;
  const dataChunkSize = 8 + dataChunkDataSize + dataPadByte;

  // cue chunk
  const numCuePoints = cuePoints.length;
  const cueChunkDataSize = 4 + numCuePoints * 24; // 4 bytes count + 24 bytes per point
  const cuePadByte = cueChunkDataSize % 2;
  const cueChunkSize = 8 + cueChunkDataSize + cuePadByte;

  // LIST / adtl chunk with labl sub-chunks
  const labels = [];
  let adtlPayloadSize = 4; // 'adtl' identifier (4 bytes)
  for (let i = 0; i < numCuePoints; i++) {
    const labelStr = "";
    // Label bytes: string + null terminator
    const labelBytes = labelStr.length + 1;
    // labl sub-chunk data size: 4 (cue point ID) + label bytes (with null)
    const lablDataSize = 4 + labelBytes;
    // Pad the sub-chunk to even total (data size may be odd → pad byte)
    const lablPadByte = lablDataSize % 2;
    const lablChunkTotalSize = 8 + lablDataSize + lablPadByte;

    labels.push({
      str: labelStr,
      lablDataSize,
      lablPadByte,
    });

    adtlPayloadSize += lablChunkTotalSize;
  }

  const listChunkDataSize = adtlPayloadSize; // includes 'adtl' + all labl sub-chunks
  const listPadByte = listChunkDataSize % 2;
  const listChunkSize = 8 + listChunkDataSize + listPadByte;

  // Total RIFF file size
  const riffPayloadSize =
    4 +
    fmtChunkSize +
    factChunkSize +
    dataChunkSize +
    cueChunkSize +
    listChunkSize;
  const totalFileSize = 8 + riffPayloadSize; // 'RIFF' + uint32 size + payload

  // ── Allocate buffer and create views ─────────────────────────────────
  const buffer = new ArrayBuffer(totalFileSize);
  const view = new DataView(buffer);
  let offset = 0;

  // ── Helper functions ─────────────────────────────────────────────────

  /** Write a 4-byte ASCII string at the current offset and advance. */
  function writeString(str) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset++, str.charCodeAt(i));
    }
  }

  /** Write a uint32 in little-endian at the current offset and advance. */
  function writeUint32(value) {
    view.setUint32(offset, value, true);
    offset += 4;
  }

  /** Write a uint16 in little-endian at the current offset and advance. */
  function writeUint16(value) {
    view.setUint16(offset, value, true);
    offset += 2;
  }

  /** Write a 32-bit IEEE float in little-endian at the current offset and advance. */
  function writeFloat32(value) {
    view.setFloat32(offset, value, true);
    offset += 4;
  }

  // ── RIFF header ──────────────────────────────────────────────────────
  writeString("RIFF");
  writeUint32(riffPayloadSize); // file size minus 8
  writeString("WAVE");

  // ── fmt  chunk ───────────────────────────────────────────────────────
  writeString("fmt ");
  writeUint32(fmtChunkDataSize); // chunk data size = 18
  writeUint16(audioFormat); // audio format: 3 = IEEE float
  writeUint16(numChannels); // number of channels
  writeUint32(sampleRate); // sample rate
  writeUint32(sampleRate * blockAlign); // byte rate
  writeUint16(blockAlign); // block align
  writeUint16(bitsPerSample); // bits per sample = 32
  writeUint16(0); // cbSize: size of extension (0 for basic IEEE float)

  // Pad fmt chunk to even byte boundary
  if (fmtPadByte) {
    view.setUint8(offset++, 0);
  }

  // ── fact chunk (required for non-PCM formats) ────────────────────────
  writeString("fact");
  writeUint32(factChunkDataSize); // chunk data size = 4
  writeUint32(numFrames); // dwSampleLength: total number of sample frames

  // ── data chunk ───────────────────────────────────────────────────────
  writeString("data");
  writeUint32(dataChunkDataSize);

  // Write interleaved 32-bit IEEE float samples
  for (let frame = 0; frame < numFrames; frame++) {
    for (let ch = 0; ch < numChannels; ch++) {
      writeFloat32(channels[ch][frame]);
    }
  }

  // Pad data chunk to even byte boundary
  if (dataPadByte) {
    view.setUint8(offset++, 0);
  }

  // ── cue  chunk ───────────────────────────────────────────────────────
  writeString("cue ");
  writeUint32(cueChunkDataSize);
  writeUint32(numCuePoints);

  for (let i = 0; i < numCuePoints; i++) {
    const samplePosition = cuePoints[i].position;
    writeUint32(i + 1); // dwName: unique ID starting from 1
    writeUint32(samplePosition); // dwPosition: play order position
    writeString("data"); // fccChunk: 'data'
    writeUint32(0); // dwChunkStart
    writeUint32(0); // dwBlockStart
    writeUint32(samplePosition); // dwSampleOffset
  }

  // Pad cue chunk to even byte boundary
  if (cuePadByte) {
    view.setUint8(offset++, 0);
  }

  // ── LIST chunk (adtl with labl sub-chunks) ───────────────────────────
  writeString("LIST");
  writeUint32(listChunkDataSize);
  writeString("adtl");

  for (let i = 0; i < numCuePoints; i++) {
    const label = labels[i];

    // labl sub-chunk header
    writeString("labl");
    writeUint32(label.lablDataSize);

    // Cue point ID (matches dwName in cue chunk)
    writeUint32(i + 1);

    // Null-terminated label string
    for (let c = 0; c < label.str.length; c++) {
      view.setUint8(offset++, label.str.charCodeAt(c));
    }
    view.setUint8(offset++, 0); // null terminator

    // Pad labl sub-chunk to even byte boundary
    if (label.lablPadByte) {
      view.setUint8(offset++, 0);
    }
  }

  // Pad LIST chunk to even byte boundary
  if (listPadByte) {
    view.setUint8(offset++, 0);
  }

  // ── Return the WAV as a Blob ─────────────────────────────────────────
  return new Blob([buffer], { type: "audio/wav" });
}
