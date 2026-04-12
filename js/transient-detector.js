/**
 * transient-detector.js
 *
 * ES module that detects transients/onsets in audio data using a robust
 * energy-based onset detection function (time-domain spectral-flux style).
 *
 * Exports a single function: detectTransients(channelData, sampleRate, options)
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default analysis frame size in samples (~23 ms at 44.1 kHz). */
const FRAME_SIZE = 1024;

/** Default hop size – 50 % overlap. */
const HOP_SIZE = 512;

/** Half-window (in frames) used for local-maximum peak-picking. */
const PEAK_PICK_WINDOW = 3;

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Compute the RMS energy of a single frame.
 *
 * @param {Float32Array} channelData  Full mono audio buffer.
 * @param {number}       start        First sample index of the frame.
 * @param {number}       length       Number of samples in the frame.
 * @returns {number} RMS energy of the frame.
 */
function computeFrameRMS(channelData, start, length) {
  let sum = 0;
  const end = Math.min(start + length, channelData.length);
  const count = end - start;

  for (let i = start; i < end; i++) {
    const s = channelData[i];
    sum += s * s;
  }

  return count > 0 ? Math.sqrt(sum / count) : 0;
}

/**
 * Compute the onset detection function (ODF) from an array of frame energies.
 *
 * The ODF is the positive half-wave rectified first-order difference of
 * consecutive RMS energies — conceptually similar to spectral flux but
 * operating in the time-domain energy envelope.
 *
 * @param {Float64Array} energies  Per-frame RMS energies.
 * @returns {Float64Array} Onset detection function (same length as energies).
 */
function computeODF(energies) {
  const len = energies.length;
  const odf = new Float64Array(len);

  // First frame has no predecessor – ODF is 0.
  odf[0] = 0;

  for (let i = 1; i < len; i++) {
    const diff = energies[i] - energies[i - 1];
    // Half-wave rectification: keep only positive increases (onsets).
    odf[i] = diff > 0 ? diff : 0;
  }

  return odf;
}

/**
 * Normalize an array of values into the 0–1 range (in-place).
 *
 * @param {Float64Array} arr  Array to normalize.
 */
function normalizeInPlace(arr) {
  let max = 0;

  for (let i = 0; i < arr.length; i++) {
    if (arr[i] > max) max = arr[i];
  }

  if (max > 0) {
    for (let i = 0; i < arr.length; i++) {
      arr[i] /= max;
    }
  }
}

/**
 * Return `true` when `odf[index]` is a local maximum inside
 * [index - window, index + window].
 *
 * @param {Float64Array} odf    Onset detection function.
 * @param {number}       index  Frame index to test.
 * @param {number}       window Half-window size (in frames).
 * @returns {boolean}
 */
function isLocalMax(odf, index, window) {
  const val = odf[index];
  const lo = Math.max(0, index - window);
  const hi = Math.min(odf.length - 1, index + window);

  for (let i = lo; i <= hi; i++) {
    if (i === index) continue;
    if (odf[i] > val) return false;
    // Tie-break: keep the earliest peak (lower index wins).
    if (odf[i] === val && i < index) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

/**
 * Detect transient / onset positions in a mono audio buffer.
 *
 * @param {Float32Array} channelData
 *   Mono audio samples in the range −1 … 1.
 * @param {number} sampleRate
 *   Sample rate of the audio (e.g. 44100).
 * @param {object} [options]
 * @param {number} [options.threshold=0.3]
 *   Detection sensitivity threshold (0–1).  Lower values detect more onsets.
 * @param {number} [options.sensitivity=0.5]
 *   How sensitive onset detection is (0–1).  Higher values detect more onsets.
 * @param {number} [options.minDistance=0.05]
 *   Minimum time in seconds between consecutive detected transients.
 *
 * @returns {number[]}
 *   Sorted array of sample indices (integers) where transients were detected.
 */
export function detectTransients(channelData, sampleRate, options = {}) {
  // ------------------------------------------------------------------
  // 1. Validate & unpack parameters
  // ------------------------------------------------------------------
  if (!(channelData instanceof Float32Array) || channelData.length === 0) {
    return [];
  }

  const threshold   = typeof options.threshold   === 'number' ? options.threshold   : 0.3;
  const sensitivity = typeof options.sensitivity === 'number' ? options.sensitivity : 0.5;
  const minDistance  = typeof options.minDistance  === 'number' ? options.minDistance  : 0.05;

  const frameSize = FRAME_SIZE;
  const hopSize   = HOP_SIZE;

  // Minimum distance between onsets expressed in frames.
  const minDistSamples = Math.round(minDistance * sampleRate);
  const minDistFrames  = Math.max(1, Math.round(minDistSamples / hopSize));

  // ------------------------------------------------------------------
  // 2. Compute per-frame RMS energies
  // ------------------------------------------------------------------
  const numFrames = Math.max(0, Math.floor((channelData.length - frameSize) / hopSize) + 1);

  if (numFrames < 2) {
    // Not enough data to compute any difference – nothing to detect.
    return [];
  }

  const energies = new Float64Array(numFrames);

  for (let f = 0; f < numFrames; f++) {
    const start = f * hopSize;
    energies[f] = computeFrameRMS(channelData, start, frameSize);
  }

  // ------------------------------------------------------------------
  // 3. Compute the onset detection function (positive HWR of energy diff)
  // ------------------------------------------------------------------
  const odf = computeODF(energies);

  // ------------------------------------------------------------------
  // 4. Normalize ODF to 0–1
  // ------------------------------------------------------------------
  normalizeInPlace(odf);

  // ------------------------------------------------------------------
  // 5. Compute the adaptive threshold
  //    effectiveThreshold = threshold * (1.1 - sensitivity)
  //    A higher sensitivity lowers the effective threshold → more onsets.
  // ------------------------------------------------------------------
  const effectiveThreshold = threshold * (1.1 - sensitivity);

  // ------------------------------------------------------------------
  // 6 & 7. Threshold + peak-pick: keep only local maxima that exceed
  //        the effective threshold.
  // ------------------------------------------------------------------
  const candidateFrames = [];

  for (let f = 1; f < numFrames; f++) {
    if (odf[f] < effectiveThreshold) continue;
    if (!isLocalMax(odf, f, PEAK_PICK_WINDOW)) continue;
    candidateFrames.push(f);
  }

  // ------------------------------------------------------------------
  // 8. Enforce minimum distance between consecutive onsets (in frames)
  // ------------------------------------------------------------------
  const filteredFrames = [];
  let lastAccepted = -Infinity;

  for (let i = 0; i < candidateFrames.length; i++) {
    const frame = candidateFrames[i];
    if (frame - lastAccepted >= minDistFrames) {
      filteredFrames.push(frame);
      lastAccepted = frame;
    }
  }

  // ------------------------------------------------------------------
  // 9. Convert frame indices → sample indices
  // ------------------------------------------------------------------
  const totalSamples = channelData.length;
  const sampleIndices = new Array(filteredFrames.length);

  for (let i = 0; i < filteredFrames.length; i++) {
    // The onset is at the start of the frame.
    const idx = filteredFrames[i] * hopSize;
    // Clamp to valid sample range.
    sampleIndices[i] = Math.min(idx, totalSamples - 1);
  }

  // ------------------------------------------------------------------
  // 10. Return sorted sample indices (already sorted by construction)
  // ------------------------------------------------------------------
  return sampleIndices;
}
