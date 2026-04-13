/**
 * Slicer — Main Application Module
 *
 * Orchestrates file loading, audio decoding, transient detection,
 * waveform rendering, playback, and WAV export with cue markers.
 */

import { WaveformRenderer } from "./waveform-renderer.js";
import { detectTransients } from "./transient-detector.js";
import { exportWavWithCueMarkers } from "./wav-exporter.js";

// ── State ──────────────────────────────────────────────────────────
let audioContext = null;
let audioBuffer = null; // decoded AudioBuffer
let monoData = null; // Float32Array — mono mixdown for analysis/display
let markers = []; // Array<number> — detected transient sample indices
let isPlaying = false;
let sourceNode = null; // currently playing AudioBufferSourceNode
let playbackStartTime = 0; // audioContext.currentTime when playback began
let playbackOffset = 0; // offset into the buffer (seconds)
let animFrameId = null;
let renderer = null; // WaveformRenderer instance
let fileName = "";
let dragCounter = 0; // tracks nested dragenter/dragleave for child elements

// ── DOM references ─────────────────────────────────────────────────
const app = document.getElementById("app");
const btnLoad = document.getElementById("btn-load");
const btnExport = document.getElementById("btn-export");
const btnPlay = document.getElementById("btn-play");
const fileInput = document.getElementById("file-input");
const dropZone = document.getElementById("drop-zone");
const canvas = document.getElementById("waveform-canvas");
const thresholdInput = document.getElementById("threshold");
const sensitivityInput = document.getElementById("sensitivity");
const minDistInput = document.getElementById("min-distance");
const thresholdVal = document.getElementById("threshold-value");
const sensitivityVal = document.getElementById("sensitivity-value");
const minDistVal = document.getElementById("min-distance-value");
const fileInfo = document.getElementById("file-info");
const sliceCount = document.getElementById("slice-count");
const btnAbout = document.getElementById("btn-about");
const aboutOverlay = document.getElementById("about-overlay");
const btnAboutClose = document.getElementById("btn-about-close");
const btnAboutOk = document.getElementById("btn-about-ok");

// ── Initialize ─────────────────────────────────────────────────────
function ensureAudioContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioContext.state === "suspended") {
    audioContext.resume();
  }
}

function init() {
  renderer = new WaveformRenderer(canvas);
  renderer.render();

  // Create AudioContext on the first user gesture (click, key, pointer).
  // This ensures it's ready before a drag-and-drop, which some browsers
  // don't consider a valid user-activation gesture.
  const gestureEvents = ["click", "keydown", "pointerdown", "touchstart"];
  function onFirstGesture() {
    ensureAudioContext();
    gestureEvents.forEach((evt) =>
      document.removeEventListener(evt, onFirstGesture, true),
    );
  }
  gestureEvents.forEach((evt) =>
    document.addEventListener(evt, onFirstGesture, true),
  );

  bindEvents();
  handleResize();
}

// ── Event Binding ──────────────────────────────────────────────────
function bindEvents() {
  // About modal
  btnAbout.addEventListener("click", openAbout);
  btnAboutClose.addEventListener("click", closeAbout);
  btnAboutOk.addEventListener("click", closeAbout);
  aboutOverlay.addEventListener("click", (e) => {
    if (e.target === aboutOverlay) closeAbout();
  });

  // File loading
  btnLoad.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", handleFileSelect);

  // Click on drop zone also opens file picker
  dropZone.addEventListener("click", (e) => {
    // Prevent triggering if user clicked something else inside
    if (e.target === dropZone || dropZone.contains(e.target)) {
      fileInput.click();
    }
  });

  // Drag & drop — listen on the whole document so drops work everywhere,
  // using a counter to handle dragenter/dragleave on child elements.
  document.addEventListener("dragenter", handleDragEnter);
  document.addEventListener("dragover", handleDragOver);
  document.addEventListener("dragleave", handleDragLeave);
  document.addEventListener("drop", handleDrop);

  // Transport
  btnPlay.addEventListener("click", () => {
    // Resume AudioContext synchronously within the user gesture so Safari allows audio
    if (audioContext && audioContext.state === "suspended") {
      audioContext.resume();
    }
    togglePlayback();
  });

  // Sliders
  thresholdInput.addEventListener("input", onSliderChange);
  sensitivityInput.addEventListener("input", onSliderChange);
  minDistInput.addEventListener("input", onSliderChange);

  // Export
  btnExport.addEventListener("click", handleExport);

  // Resize
  window.addEventListener("resize", handleResize);

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if (e.code === "Space" && audioBuffer) {
      e.preventDefault();
      // Resume AudioContext synchronously within the user gesture so Safari allows audio
      if (audioContext && audioContext.state === "suspended") {
        audioContext.resume();
      }
      togglePlayback();
    }
    // Ctrl/Cmd+O to load file
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyO") {
      e.preventDefault();
      fileInput.click();
    }
    // Ctrl/Cmd+E to export
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyE" && audioBuffer) {
      e.preventDefault();
      handleExport();
    }
    if (e.code === "Escape") {
      closeAbout();
    }
  });
}

// ── File Handling ──────────────────────────────────────────────────
function handleFileSelect(e) {
  const file = e.target.files[0];
  if (file) loadFile(file);
}

function handleDragEnter(e) {
  e.preventDefault();
  dragCounter++;
  // Show the drop zone on first enter
  if (dragCounter === 1) {
    dropZone.classList.remove("hidden");
    dropZone.classList.add("drag-over");
  }
}

function handleDragOver(e) {
  e.preventDefault();
  // dataTransfer.dropEffect tells the browser to show a copy cursor
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = "copy";
  }
}

function handleDragLeave(e) {
  e.preventDefault();
  dragCounter--;
  // Only hide when we've left all nested elements (counter back to 0)
  if (dragCounter <= 0) {
    dragCounter = 0;
    dropZone.classList.remove("drag-over");
    if (audioBuffer) dropZone.classList.add("hidden");
  }
}

function handleDrop(e) {
  e.preventDefault();
  dragCounter = 0;
  dropZone.classList.remove("drag-over");

  const files = e.dataTransfer.files;
  if (files.length > 0) {
    const file = files[0];
    if (
      file.type === "audio/wav" ||
      file.type === "audio/x-wav" ||
      file.type === "" ||
      file.name.toLowerCase().endsWith(".wav")
    ) {
      loadFile(file);
    } else {
      showFileInfo("⚠️ Please drop a WAV file", true);
      if (audioBuffer) dropZone.classList.add("hidden");
    }
  } else {
    if (audioBuffer) dropZone.classList.add("hidden");
  }
}

async function loadFile(file) {
  // Stop any current playback
  stopPlayback();

  fileName = file.name;
  showFileInfo("Loading…");

  try {
    // Ensure AudioContext exists (fallback if no prior gesture created it)
    ensureAudioContext();

    const arrayBuffer = await file.arrayBuffer();
    audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    // Reject files that aren't 48000 Hz
    if (audioBuffer.sampleRate !== 48000) {
      const badRate = audioBuffer.sampleRate;
      audioBuffer = null;
      monoData = null;
      showFileInfo(
        `⚠️ Unsupported sample rate: ${badRate} Hz — Set your system to 48000 Hz sample rate and try again`,
        true,
      );
      return;
    }

    // Create mono mixdown for analysis and display
    monoData = mixToMono(audioBuffer);

    // Update UI
    const duration = audioBuffer.duration;
    const mins = Math.floor(duration / 60);
    const secs = (duration % 60).toFixed(2);
    const durationStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    showFileInfo(
      `${fileName} — ${audioBuffer.numberOfChannels}ch, ${audioBuffer.sampleRate}Hz, ${durationStr}`,
    );

    // Hide drop zone, enable controls
    dropZone.classList.add("hidden");
    btnPlay.disabled = false;
    btnExport.disabled = false;

    // Set audio data on renderer
    renderer.setAudioData(monoData, audioBuffer.sampleRate);

    // Run initial detection
    runDetection();
  } catch (err) {
    console.error("Error loading file:", err);
    showFileInfo(`⚠️ Error: ${err.message}`, true);
  }
}

// ── Mono Mixdown ───────────────────────────────────────────────────
function mixToMono(buffer) {
  const length = buffer.length;
  const channels = buffer.numberOfChannels;

  if (channels === 1) {
    return new Float32Array(buffer.getChannelData(0));
  }

  const mono = new Float32Array(length);
  for (let ch = 0; ch < channels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      mono[i] += data[i];
    }
  }

  const scale = 1 / channels;
  for (let i = 0; i < length; i++) {
    mono[i] *= scale;
  }

  return mono;
}

// ── Transient Detection ────────────────────────────────────────────
function runDetection() {
  if (!monoData) return;

  const threshold = parseInt(thresholdInput.value) / 100;
  const sensitivity = parseInt(sensitivityInput.value) / 100;
  const minDistMs = parseInt(minDistInput.value);
  const minDistance = minDistMs / 1000; // convert to seconds

  markers = detectTransients(monoData, audioBuffer.sampleRate, {
    threshold,
    sensitivity,
    minDistance,
  });

  // Update renderer and UI
  renderer.setMarkers(markers);
  renderer.render();

  sliceCount.textContent = `${markers.length} slice${markers.length !== 1 ? "s" : ""} detected`;
  sliceCount.innerHTML = `<span class="highlight">${markers.length}</span> slice${markers.length !== 1 ? "s" : ""} detected`;
}

let _detectTimeout = null;

function onSliderChange() {
  // Update value displays
  thresholdVal.textContent = (parseInt(thresholdInput.value) / 100).toFixed(2);
  sensitivityVal.textContent = (parseInt(sensitivityInput.value) / 100).toFixed(
    2,
  );
  minDistVal.textContent = `${minDistInput.value} ms`;

  // Re-run detection (debounced)
  if (_detectTimeout) clearTimeout(_detectTimeout);
  _detectTimeout = setTimeout(() => {
    runDetection();
  }, 50);
}

// ── Playback ───────────────────────────────────────────────────────
function togglePlayback() {
  if (isPlaying) {
    stopPlayback();
  } else {
    startPlayback();
  }
}

async function startPlayback() {
  if (!audioBuffer || !audioContext) return;

  // Wait for context to be fully running (resume was already kicked off
  // synchronously by the caller inside the user-gesture callback).
  if (audioContext.state !== "running") {
    try {
      await audioContext.resume();
    } catch (_) {
      /* ignore */
    }
  }

  sourceNode = audioContext.createBufferSource();
  sourceNode.buffer = audioBuffer;
  sourceNode.connect(audioContext.destination);

  sourceNode.onended = () => {
    if (isPlaying) {
      stopPlayback();
    }
  };

  playbackStartTime = audioContext.currentTime;
  sourceNode.start(0, playbackOffset);
  isPlaying = true;

  btnPlay.textContent = "⏹️";
  btnPlay.classList.add("active");

  // Start animation loop for playhead
  startPlayheadAnimation();
}

function stopPlayback() {
  if (sourceNode) {
    try {
      sourceNode.stop();
    } catch (_) {
      /* ignore */
    }
    sourceNode.disconnect();
    sourceNode = null;
  }

  isPlaying = false;
  playbackOffset = 0;

  btnPlay.textContent = "▶️";
  btnPlay.classList.remove("active");

  // Stop animation and hide playhead
  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }

  if (renderer) {
    renderer.setPlaybackPosition(-1);
    renderer.render();
  }
}

function startPlayheadAnimation() {
  function tick() {
    if (!isPlaying) return;

    const elapsed =
      audioContext.currentTime - playbackStartTime + playbackOffset;
    const samplePos = Math.floor(elapsed * audioBuffer.sampleRate);

    if (samplePos >= audioBuffer.length) {
      stopPlayback();
      return;
    }

    renderer.setPlaybackPosition(samplePos);
    renderer.render();

    animFrameId = requestAnimationFrame(tick);
  }

  animFrameId = requestAnimationFrame(tick);
}

// ── Export ──────────────────────────────────────────────────────────
function handleExport() {
  if (!audioBuffer) return;

  if (markers.length === 0) {
    showFileInfo("⚠️ No slices detected — try lowering the threshold", true);
    return;
  }

  // Build cue points from markers
  const cuePoints = markers.map((pos) => ({ position: pos }));

  // Generate WAV blob with cue markers
  const blob = exportWavWithCueMarkers(audioBuffer, cuePoints);

  // Create download link
  const baseName = fileName.replace(/\.wav$/i, "");
  const exportName = `${baseName}_sliced.wav`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = exportName;
  document.body.appendChild(a);
  a.click();

  // Cleanup
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);

  // Restore file info after brief delay
  const duration = audioBuffer.duration;
  const mins = Math.floor(duration / 60);
  const secs = (duration % 60).toFixed(2);
  const durationStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  setTimeout(() => {
    showFileInfo(
      `${fileName} — ${audioBuffer.numberOfChannels}ch, ${audioBuffer.sampleRate}Hz, ${durationStr}`,
    );
  }, 2000);
  showFileInfo(`✅ Exported ${exportName} with ${markers.length} cue markers`);
}

// ── UI Helpers ─────────────────────────────────────────────────────
function showFileInfo(text, isError = false) {
  fileInfo.textContent = text;
  fileInfo.style.color = isError ? "#ff4444" : "";
}

function handleResize() {
  if (renderer) {
    renderer.resize();
    renderer.render();
  }
}

// ── About Modal ────────────────────────────────────────────────
function openAbout() {
  aboutOverlay.classList.add("open");
}

function closeAbout() {
  aboutOverlay.classList.remove("open");
}

// ── Boot ───────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", init);
