/**
 * WaveformRenderer — renders an audio waveform with slice markers, playhead,
 * and time axis onto an HTML Canvas element.
 *
 * Usage:
 *   const renderer = new WaveformRenderer(canvasElement);
 *   renderer.setAudioData(channelData, sampleRate);
 *   renderer.setMarkers([0, 44100, 88200]);
 *   renderer.render();
 *
 * ES module, vanilla JS, no dependencies.
 */

// ─── Color constants ────────────────────────────────────────────────────────

const COLOR_BG            = '#1a1a2e';
const COLOR_WAVE_TOP      = '#00d4ff';
const COLOR_WAVE_BOTTOM   = '#0099cc';
const COLOR_CENTER_LINE   = '#333333';
const COLOR_MARKER        = '#ff6b35';
const COLOR_PLAYHEAD      = '#ffffff';
const COLOR_TIME_TEXT      = '#888888';
const COLOR_TIME_TICK      = '#444444';

// Alternating slice region fills
const COLOR_SLICE_A = 'rgba(0, 212, 255, 0.04)';
const COLOR_SLICE_B = 'rgba(255, 107, 53, 0.04)';

// Waveform glow overlay
const COLOR_GLOW = 'rgba(0, 212, 255, 0.15)';

// Layout
const TIME_AXIS_HEIGHT = 24;          // pixels reserved for time labels at the bottom
const MARKER_TRIANGLE_SIZE = 8;       // height/width of the triangle hat on markers

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Format a time value in seconds into a human-readable string.
 * < 1 min  → "0.00 s" style
 * >= 1 min → "1:02.30" style
 */
function formatTime(seconds) {
  if (seconds < 0) seconds = 0;

  if (seconds < 60) {
    // Show two decimal places for short durations, fewer for longer
    if (seconds < 10) return seconds.toFixed(2) + ' s';
    return seconds.toFixed(1) + ' s';
  }

  const mins = Math.floor(seconds / 60);
  const secs = seconds - mins * 60;
  const secStr = secs < 10 ? '0' + secs.toFixed(1) : secs.toFixed(1);
  return `${mins}:${secStr}`;
}

/**
 * Pick a "nice" tick interval (in seconds) so that we get roughly
 * `targetCount` ticks across the visible duration.
 */
function niceTickInterval(durationSec, targetCount) {
  const rough = durationSec / targetCount;
  // Candidate steps — multiples friendly to humans
  const steps = [
    0.001, 0.002, 0.005,
    0.01, 0.02, 0.05,
    0.1, 0.2, 0.5,
    1, 2, 5,
    10, 15, 30,
    60, 120, 300, 600,
  ];
  for (const s of steps) {
    if (s >= rough) return s;
  }
  return steps[steps.length - 1];
}

// ─── WaveformRenderer ───────────────────────────────────────────────────────

export class WaveformRenderer {
  /**
   * @param {HTMLCanvasElement} canvas — the canvas element to draw onto.
   */
  constructor(canvas) {
    /** @type {HTMLCanvasElement} */
    this._canvas = canvas;
    /** @type {CanvasRenderingContext2D} */
    this._ctx = canvas.getContext('2d');

    // Audio data
    /** @type {Float32Array|null} */
    this._channelData = null;
    /** @type {number} */
    this._sampleRate = 44100;

    // Markers (sorted sample indices)
    /** @type {number[]} */
    this._markers = [];

    // Playhead position (-1 = hidden)
    /** @type {number} */
    this._playheadSample = -1;

    // Visible range (in samples). -1 means "show everything".
    /** @type {number} */
    this._viewStart = -1;
    /** @type {number} */
    this._viewEnd = -1;

    // Cached waveform summary for the last render configuration.
    // Invalidated when audio data, canvas size, or view range changes.
    /** @type {Float32Array|null} */
    this._cachedMin = null;
    /** @type {Float32Array|null} */
    this._cachedMax = null;
    /** @type {number} */
    this._cacheWidth = 0;
    /** @type {number} */
    this._cacheViewStart = -1;
    /** @type {number} */
    this._cacheViewEnd = -1;
    /** @type {Float32Array|null} */
    this._cacheChannelRef = null;

    // DPI-aware sizing — perform initial resize
    this.resize();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Provide new audio data.
   * @param {Float32Array} channelData — mono PCM samples in [-1, 1].
   * @param {number} sampleRate
   */
  setAudioData(channelData, sampleRate) {
    this._channelData = channelData;
    this._sampleRate = sampleRate;
    this._invalidateCache();

    // Reset view range to full when new data is loaded
    this._viewStart = -1;
    this._viewEnd = -1;
  }

  /**
   * Set slice marker positions (array of sample indices).
   * They will be sorted internally.
   * @param {number[]} markers
   */
  setMarkers(markers) {
    this._markers = [...markers].sort((a, b) => a - b);
  }

  /**
   * Set the playback head position. Pass -1 to hide.
   * @param {number} sampleIndex
   */
  setPlaybackPosition(sampleIndex) {
    this._playheadSample = sampleIndex;
  }

  /**
   * Set the visible sample range (for zooming / scrolling).
   * Pass no arguments (or -1, -1) to reset to full range.
   * @param {number} startSample
   * @param {number} endSample
   */
  setViewRange(startSample = -1, endSample = -1) {
    if (startSample < 0 || endSample < 0) {
      this._viewStart = -1;
      this._viewEnd = -1;
    } else {
      this._viewStart = Math.max(0, Math.floor(startSample));
      this._viewEnd = Math.min(
        this._channelData ? this._channelData.length : endSample,
        Math.ceil(endSample),
      );
    }
    this._invalidateCache();
  }

  /**
   * Handle high-DPI scaling and canvas resize.
   * Call this when the canvas's CSS size changes (e.g. window resize).
   */
  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this._canvas.getBoundingClientRect();

    // Only mutate the backing store when the size has actually changed
    const newW = Math.round(rect.width * dpr);
    const newH = Math.round(rect.height * dpr);

    if (this._canvas.width !== newW || this._canvas.height !== newH) {
      this._canvas.width = newW;
      this._canvas.height = newH;
      this._invalidateCache();
    }

    // Always keep the context transform in sync with DPR
    this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /**
   * Main draw call — renders background, waveform, markers, playhead, and
   * time axis onto the canvas. Designed to be called every animation frame.
   */
  render() {
    const ctx = this._ctx;
    const rect = this._canvas.getBoundingClientRect();
    const W = rect.width;
    const H = rect.height;

    if (W === 0 || H === 0) return;

    // ── 1. Background ───────────────────────────────────────────────────
    ctx.fillStyle = COLOR_BG;
    ctx.fillRect(0, 0, W, H);

    // If no audio data loaded, nothing more to draw
    if (!this._channelData || this._channelData.length === 0) return;

    const waveH = H - TIME_AXIS_HEIGHT;   // height for the waveform area
    const midY = waveH / 2;               // vertical center of waveform

    // Resolve visible sample range
    const viewStart = this._viewStart >= 0 ? this._viewStart : 0;
    const viewEnd = this._viewEnd > viewStart
      ? this._viewEnd
      : this._channelData.length;
    const viewLen = viewEnd - viewStart;

    // ── 2. Slice regions (alternating fills between markers) ────────────
    this._drawSliceRegions(ctx, W, waveH, viewStart, viewEnd);

    // ── 3. Center line ──────────────────────────────────────────────────
    ctx.strokeStyle = COLOR_CENTER_LINE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(W, midY);
    ctx.stroke();

    // ── 4. Waveform ─────────────────────────────────────────────────────
    this._drawWaveform(ctx, W, waveH, viewStart, viewEnd);

    // ── 5. Markers ──────────────────────────────────────────────────────
    this._drawMarkers(ctx, W, waveH, viewStart, viewEnd);

    // ── 6. Playhead ─────────────────────────────────────────────────────
    if (this._playheadSample >= 0) {
      const x = this._sampleToX(this._playheadSample, W, viewStart, viewEnd);
      if (x >= 0 && x <= W) {
        ctx.strokeStyle = COLOR_PLAYHEAD;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, waveH);
        ctx.stroke();
      }
    }

    // ── 7. Time axis ────────────────────────────────────────────────────
    this._drawTimeAxis(ctx, W, H, waveH, viewStart, viewEnd);
  }

  /**
   * Convert a canvas-space X coordinate to the corresponding sample index,
   * useful for mouse/touch interaction.
   * @param {number} canvasX — X in CSS pixels relative to the canvas.
   * @returns {number} sample index (may be fractional; clamp as needed).
   */
  getClickedSample(canvasX) {
    const W = this._canvas.getBoundingClientRect().width;
    if (W === 0 || !this._channelData) return 0;

    const viewStart = this._viewStart >= 0 ? this._viewStart : 0;
    const viewEnd = this._viewEnd > viewStart
      ? this._viewEnd
      : this._channelData.length;

    const ratio = canvasX / W;
    return viewStart + ratio * (viewEnd - viewStart);
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  /** Invalidate the per-pixel min/max waveform cache. */
  _invalidateCache() {
    this._cachedMin = null;
    this._cachedMax = null;
  }

  /**
   * Build (or return cached) per-pixel-column min/max arrays for the
   * current view range and canvas width.
   */
  _getWaveformSummary(pixelWidth, viewStart, viewEnd) {
    // Check cache validity
    if (
      this._cachedMin &&
      this._cacheWidth === pixelWidth &&
      this._cacheViewStart === viewStart &&
      this._cacheViewEnd === viewEnd &&
      this._cacheChannelRef === this._channelData
    ) {
      return { min: this._cachedMin, max: this._cachedMax };
    }

    const data = this._channelData;
    const viewLen = viewEnd - viewStart;
    const cols = Math.ceil(pixelWidth);

    const minArr = new Float32Array(cols);
    const maxArr = new Float32Array(cols);

    for (let col = 0; col < cols; col++) {
      // Map this pixel column to a sample range
      const s0 = viewStart + (col / cols) * viewLen;
      const s1 = viewStart + ((col + 1) / cols) * viewLen;

      const iStart = Math.max(0, Math.floor(s0));
      const iEnd = Math.min(data.length, Math.ceil(s1));

      let lo = 0;
      let hi = 0;

      if (iEnd > iStart) {
        lo = data[iStart];
        hi = lo;
        for (let i = iStart + 1; i < iEnd; i++) {
          const v = data[i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }

      minArr[col] = lo;
      maxArr[col] = hi;
    }

    // Store in cache
    this._cachedMin = minArr;
    this._cachedMax = maxArr;
    this._cacheWidth = pixelWidth;
    this._cacheViewStart = viewStart;
    this._cacheViewEnd = viewEnd;
    this._cacheChannelRef = this._channelData;

    return { min: minArr, max: maxArr };
  }

  /**
   * Convert a sample index to an X position in CSS-pixel canvas space.
   */
  _sampleToX(sample, canvasWidth, viewStart, viewEnd) {
    const viewLen = viewEnd - viewStart;
    if (viewLen === 0) return 0;
    return ((sample - viewStart) / viewLen) * canvasWidth;
  }

  // ── Drawing sub-routines ────────────────────────────────────────────────

  /**
   * Draw the waveform as a mirrored amplitude display using per-pixel
   * min/max vertical lines with a gradient fill + subtle glow.
   */
  _drawWaveform(ctx, W, waveH, viewStart, viewEnd) {
    const midY = waveH / 2;
    const amp = midY * 0.9; // leave a small margin

    const { min, max } = this._getWaveformSummary(W, viewStart, viewEnd);
    const cols = min.length;

    // ── Gradient for the waveform lines ──
    const grad = ctx.createLinearGradient(0, midY - amp, 0, midY + amp);
    grad.addColorStop(0, COLOR_WAVE_TOP);
    grad.addColorStop(0.5, COLOR_WAVE_TOP);
    grad.addColorStop(1, COLOR_WAVE_BOTTOM);

    // Draw filled waveform shape for the glow background first
    ctx.beginPath();
    // Top edge (max values)
    for (let i = 0; i < cols; i++) {
      const y = midY - max[i] * amp;
      if (i === 0) ctx.moveTo(i, y);
      else ctx.lineTo(i, y);
    }
    // Bottom edge (min values), right to left
    for (let i = cols - 1; i >= 0; i--) {
      const y = midY - min[i] * amp;
      ctx.lineTo(i, y);
    }
    ctx.closePath();

    // Subtle glow fill
    ctx.fillStyle = COLOR_GLOW;
    ctx.fill();

    // ── Draw the per-pixel vertical lines on top ──
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < cols; i++) {
      const yMin = midY - max[i] * amp;   // max → higher on screen (lower Y)
      const yMax = midY - min[i] * amp;   // min → lower on screen (higher Y)
      ctx.moveTo(i + 0.5, yMin);
      ctx.lineTo(i + 0.5, yMax);
    }
    ctx.stroke();
  }

  /**
   * Draw semi-transparent alternating slice regions between markers.
   */
  _drawSliceRegions(ctx, W, waveH, viewStart, viewEnd) {
    // Build boundary list: [viewStart, ...markers in range..., viewEnd]
    const boundaries = [viewStart];
    for (const m of this._markers) {
      if (m > viewStart && m < viewEnd) {
        boundaries.push(m);
      }
    }
    boundaries.push(viewEnd);

    for (let i = 0; i < boundaries.length - 1; i++) {
      const x0 = this._sampleToX(boundaries[i], W, viewStart, viewEnd);
      const x1 = this._sampleToX(boundaries[i + 1], W, viewStart, viewEnd);
      ctx.fillStyle = i % 2 === 0 ? COLOR_SLICE_A : COLOR_SLICE_B;
      ctx.fillRect(x0, 0, x1 - x0, waveH);
    }
  }

  /**
   * Draw marker lines and triangle hats.
   */
  _drawMarkers(ctx, W, waveH, viewStart, viewEnd) {
    for (const m of this._markers) {
      const x = this._sampleToX(m, W, viewStart, viewEnd);

      // Skip markers outside the visible region (with some padding)
      if (x < -2 || x > W + 2) continue;

      // Vertical line
      ctx.strokeStyle = COLOR_MARKER;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, waveH);
      ctx.stroke();

      // Small triangle at the top
      const ts = MARKER_TRIANGLE_SIZE;
      ctx.fillStyle = COLOR_MARKER;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x - ts / 2, ts);
      ctx.lineTo(x + ts / 2, ts);
      ctx.closePath();
      ctx.fill();
    }
  }

  /**
   * Draw the time axis at the bottom of the canvas.
   */
  _drawTimeAxis(ctx, W, H, waveH, viewStart, viewEnd) {
    const durationSec = (viewEnd - viewStart) / this._sampleRate;
    const startSec = viewStart / this._sampleRate;

    // Dark strip behind the time labels
    ctx.fillStyle = '#111122';
    ctx.fillRect(0, waveH, W, TIME_AXIS_HEIGHT);

    // Separator line
    ctx.strokeStyle = COLOR_TIME_TICK;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, waveH);
    ctx.lineTo(W, waveH);
    ctx.stroke();

    // Determine a nice tick interval (target ~8–12 ticks)
    const targetTicks = Math.max(4, Math.min(14, Math.floor(W / 80)));
    const tickSec = niceTickInterval(durationSec, targetTicks);

    // First tick that falls on a multiple of tickSec at or after startSec
    const firstTick = Math.ceil(startSec / tickSec) * tickSec;

    ctx.fillStyle = COLOR_TIME_TEXT;
    ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    for (let t = firstTick; t <= startSec + durationSec; t += tickSec) {
      const sample = t * this._sampleRate;
      const x = this._sampleToX(sample, W, viewStart, viewEnd);

      // Tick mark
      ctx.strokeStyle = COLOR_TIME_TICK;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, waveH);
      ctx.lineTo(x, waveH + 5);
      ctx.stroke();

      // Label
      ctx.fillStyle = COLOR_TIME_TEXT;
      ctx.fillText(formatTime(t), x, waveH + 6);
    }
  }
}
