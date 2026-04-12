/**
 * wav-exporter.js
 *
 * ES module that exports a Web Audio API AudioBuffer as a WAV file (PCM 16-bit)
 * with embedded cue markers and labels.
 *
 * WAV layout:
 *   RIFF [filesize-8] WAVE
 *     fmt  [16] ...
 *     data [dataSize] ...
 *     cue  [cueChunkDataSize] ...
 *     LIST [listChunkDataSize] adtl
 *       labl [labelDataSize] ...
 *       labl [labelDataSize] ...
 */

/**
 * Convert an AudioBuffer to a WAV Blob with embedded cue markers.
 *
 * @param {AudioBuffer} audioBuffer  - Web Audio API AudioBuffer
 * @param {Array<{position: number}>} cuePoints - Array of cue markers with sample positions
 * @returns {Blob} WAV file as a Blob with type 'audio/wav'
 */
export function exportWavWithCueMarkers(audioBuffer, cuePoints) {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const numFrames = audioBuffer.length;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;

  // ── Gather channel data ──────────────────────────────────────────────
  const channels = [];
  for (let ch = 0; ch < numChannels; ch++) {
    channels.push(audioBuffer.getChannelData(ch));
  }

  // ── Compute chunk sizes ──────────────────────────────────────────────

  // fmt chunk: always 16 bytes of data for PCM
  const fmtChunkDataSize = 16;
  const fmtChunkSize = 8 + fmtChunkDataSize; // chunk header (id + size) + data

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
  // Each label: "Slice N\0", padded to even length
  const labels = [];
  let adtlPayloadSize = 4; // 'adtl' identifier (4 bytes)
  for (let i = 0; i < numCuePoints; i++) {
    const labelStr = "";
    // Label bytes: string + null terminator
    const labelBytes = labelStr.length + 1;
    // Pad label bytes to even length
    const paddedLabelBytes = labelBytes + (labelBytes % 2);
    // labl sub-chunk data size: 4 (cue point ID) + label bytes (with null)
    const lablDataSize = 4 + labelBytes;
    // Pad the sub-chunk to even total (data size may be odd → pad byte)
    const lablPadByte = lablDataSize % 2;
    const lablChunkTotalSize = 8 + lablDataSize + lablPadByte;

    labels.push({
      str: labelStr,
      lablDataSize,
      lablPadByte,
      paddedLabelBytes,
    });

    adtlPayloadSize += lablChunkTotalSize;
  }

  const listChunkDataSize = adtlPayloadSize; // includes 'adtl' + all labl sub-chunks
  const listPadByte = listChunkDataSize % 2;
  const listChunkSize = 8 + listChunkDataSize + listPadByte;

  // Total RIFF file size
  // RIFF header: 'RIFF' (4) + fileSize (4) + 'WAVE' (4) = 12 bytes
  // Then all chunks follow
  const riffPayloadSize =
    4 + fmtChunkSize + dataChunkSize + cueChunkSize + listChunkSize;
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

  /** Write a signed int16 in little-endian at the current offset and advance. */
  function writeInt16(value) {
    view.setInt16(offset, value, true);
    offset += 2;
  }

  // ── RIFF header ──────────────────────────────────────────────────────
  writeString("RIFF");
  writeUint32(riffPayloadSize); // file size minus 8
  writeString("WAVE");

  // ── fmt  chunk ───────────────────────────────────────────────────────
  writeString("fmt ");
  writeUint32(fmtChunkDataSize); // chunk data size = 16
  writeUint16(1); // audio format: 1 = PCM
  writeUint16(numChannels); // number of channels
  writeUint32(sampleRate); // sample rate
  writeUint32(sampleRate * blockAlign); // byte rate
  writeUint16(blockAlign); // block align
  writeUint16(bitsPerSample); // bits per sample

  // ── data chunk ───────────────────────────────────────────────────────
  writeString("data");
  writeUint32(dataChunkDataSize);

  // Write interleaved 16-bit PCM samples
  for (let frame = 0; frame < numFrames; frame++) {
    for (let ch = 0; ch < numChannels; ch++) {
      // Clamp the float sample to [-1, 1] then scale to 16-bit range
      let sample = channels[ch][frame];
      if (sample > 1.0) sample = 1.0;
      else if (sample < -1.0) sample = -1.0;
      writeInt16(Math.round(sample * 32767));
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
