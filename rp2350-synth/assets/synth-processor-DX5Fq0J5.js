/*
 * Local browser port of the rp2350-synth DSP voice + FX chain (AudioWorklet).
 *
 * This is a faithful, plain-JS re-implementation of the Rust signal chain so the
 * web app can run the synth with no hardware. It is self-contained (no imports)
 * so it loads cleanly as an AudioWorklet module. It works purely in engineering
 * units (Hz, seconds, 0..1) — the main thread does all CC->value scaling and
 * posts plain values across the port (see ../audio/engine.ts).
 *
 * Ported from (rp2350-synth):
 *   vendor/infinitedsp-core/src/synthesis/oscillator.rs   (PolyBLEP osc, fast sine, LCG noise)
 *   vendor/infinitedsp-core/src/effects/filter/predictive_ladder.rs (4-pole ZDF ladder)
 *   vendor/infinitedsp-core/src/synthesis/envelope.rs     (ADSR)
 *   vendor/infinitedsp-core/src/synthesis/lfo.rs          (LFO)
 *   vendor/infinitedsp-core/src/effects/time/delay.rs     (ring-buffer delay)
 *   vendor/infinitedsp-core/src/effects/time/reverb.rs    (freeverb)
 *   src/dsp/moog.rs, src/tasks/core1.rs                   (voice wiring + stereo FX)
 *   src/control/midi.rs                                   (note->freq, portamento, bend)
 *
 * Mono voice (one note, last-note priority), matching the hardware.
 */

const PI = Math.PI;
const TWO_PI = PI * 2;
const HALF_PI = PI * 0.5;
const MAX_DELAY_SECONDS = 2.0; // rp2350-synth cc_map::MAX_DELAY_SECONDS

function midiToFreq(note) {
  return 440 * Math.pow(2, (note - 69) / 12);
}

// oscillator.rs: fast_sin_norm — phase in [0,1) -> sin(2*PI*phase)
function fastSin(phase) {
  let a = phase * TWO_PI;
  if (a >= PI) a -= TWO_PI;
  if (a > HALF_PI) a = PI - a;
  else if (a < -HALF_PI) a = -PI - a;
  const a2 = a * a;
  return a * (1.0 + a2 * (-1.0 / 6.0 + a2 * (1.0 / 120.0 + a2 * (-1.0 / 5040.0))));
}

// oscillator.rs: poly_blep
function polyBlep(t, dt) {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1.0;
  } else if (t > 1.0 - dt) {
    const x = (t - 1.0) / dt;
    return x * x + x + x + 1.0;
  }
  return 0.0;
}

// predictive_ladder.rs: fast_tan / fast_tanh
function fastTan(x) {
  return x * (1.0 + 0.333333 * x * x);
}
function fastTanh(x) {
  const xc = x < -3 ? -3 : x > 3 ? 3 : x;
  const x2 = xc * xc;
  return (xc * (27.0 + x2)) / (27.0 + 9.0 * x2);
}

// Band-limited oscillator (one shape). waveform: 0 Sine,1 Tri,2 Saw,3 Square,4 Noise
class Osc {
  constructor() {
    this.phase = 0;
    this.rng = 12345 >>> 0;
  }
  rand() {
    // LCG (Lehmer-like), matches oscillator.rs next_random
    this.rng = (Math.imul(this.rng, 1103515245) + 12345) >>> 0;
    const v = (this.rng >>> 16) & 0x7fff;
    return (v / 32768.0) * 2.0 - 1.0;
  }
  tick(freq, wave, sr) {
    if (wave === 4) return this.rand();
    const inc = freq / sr;
    let phase = this.phase + inc;
    if (phase >= 1.0) phase -= 1.0;
    else if (phase < 0.0) phase += 1.0;
    this.phase = phase;
    const dt = Math.abs(inc);
    switch (wave) {
      case 0:
        return fastSin(phase);
      case 1:
        return phase < 0.5 ? 4.0 * phase - 1.0 : 4.0 * (1.0 - phase) - 1.0;
      case 2:
        return 2.0 * phase - 1.0 - polyBlep(phase, dt);
      case 3: {
        const naive = phase < 0.5 ? 1.0 : -1.0;
        return naive + polyBlep(phase, dt) - polyBlep((phase + 0.5) % 1.0, dt);
      }
      default:
        return 0;
    }
  }
}

// envelope.rs: ADSR (linear attack, exponential decay/release).
class Adsr {
  constructor() {
    this.state = 0; // 0 idle,1 attack,2 decay,3 sustain,4 release
    this.level = 0;
    this.lastGate = 0;
    this.attackStep = 1;
    this.decayCoeff = 0;
    this.releaseCoeff = 0;
    this.lastA = -1;
    this.lastD = -1;
    this.lastR = -1;
  }
  recalc(a, d, r, sr) {
    if (Math.abs(a - this.lastA) > 0.0001) {
      const n = a * sr;
      this.attackStep = n > 0 ? 1.0 / n : 1.0;
      this.lastA = a;
    }
    if (Math.abs(d - this.lastD) > 0.0001) {
      const n = d * sr;
      this.decayCoeff = n > 0 ? Math.exp(-1.0 / (n / 3.0)) : 0.0;
      this.lastD = d;
    }
    if (Math.abs(r - this.lastR) > 0.0001) {
      const n = r * sr;
      this.releaseCoeff = n > 0 ? Math.exp(-1.0 / (n / 3.0)) : 0.0;
      this.lastR = r;
    }
  }
  tick(gate, sustain) {
    const g = gate ? 1 : 0;
    if (g >= 0.5 && this.lastGate < 0.5) this.state = 1;
    else if (g < 0.5 && this.lastGate >= 0.5) this.state = 4;
    this.lastGate = g;

    switch (this.state) {
      case 0:
        this.level = 0;
        break;
      case 1:
        this.level += this.attackStep;
        if (this.level >= 1.0) {
          this.level = 1.0;
          this.state = 2;
        }
        break;
      case 2:
        this.level = sustain + (this.level - sustain) * this.decayCoeff;
        if (Math.abs(this.level - sustain) < 0.001) {
          this.level = sustain;
          this.state = 3;
        }
        break;
      case 3:
        this.level = sustain;
        break;
      case 4:
        this.level *= this.releaseCoeff;
        if (this.level < 0.0001) {
          this.level = 0;
          this.state = 0;
        }
        break;
    }
    return this.level;
  }
}

// lfo.rs: bipolar LFO in [-1,1]. waveform: 0 Sine,1 Tri,2 Saw,3 Square
class Lfo {
  constructor() {
    this.phase = 0;
  }
  tick(freq, wave, sr) {
    const cur = this.phase;
    this.phase += freq / sr;
    if (this.phase >= 1.0) this.phase -= 1.0;
    else if (this.phase < 0.0) this.phase += 1.0;
    let raw;
    switch (wave) {
      case 0: {
        let t = cur * 2.0 - 1.0;
        t = 2.0 * Math.abs(t) - 1.0;
        raw = t * (1.5 - 0.5 * t * t);
        break;
      }
      case 1: {
        const t = cur * 2.0 - 1.0;
        raw = 2.0 * Math.abs(t) - 1.0;
        break;
      }
      case 2:
        raw = 2.0 * cur - 1.0;
        break;
      case 3:
        raw = cur < 0.5 ? 1.0 : -1.0;
        break;
      default:
        raw = 0;
    }
    // set_range(-1,1) => output == raw
    return raw;
  }
}

// delay.rs: mono ring-buffer delay with linear interpolation + feedback + mix.
class Delay {
  constructor(sr) {
    this.size = Math.max(1, Math.floor(MAX_DELAY_SECONDS * sr) + 1);
    this.buf = new Float32Array(this.size);
    this.w = 0;
    this.sr = sr;
  }
  process(input, timeSec, fb, mix) {
    const len = this.size;
    const delaySamples = timeSec * this.sr;
    let rp = this.w - delaySamples;
    while (rp < 0) rp += len;
    while (rp >= len) rp -= len;
    const a = rp | 0;
    const b = (a + 1) % len;
    const frac = rp - a;
    const delayed = this.buf[a] * (1.0 - frac) + this.buf[b] * frac;
    this.buf[this.w] = input + delayed * fb;
    this.w = (this.w + 1) % len;
    return input * (1.0 - mix) + delayed * mix;
  }
}

// reverb.rs: lowpass-feedback comb (one line of a Comb4 group).
class Comb {
  constructor(size) {
    this.buf = new Float32Array(size);
    this.pos = 0;
    this.filterState = 0;
  }
  process(input, feedback, damp, dampInv) {
    const delayed = this.buf[this.pos];
    this.buf[this.pos] = input + this.filterState * feedback;
    this.filterState = delayed * dampInv + this.filterState * damp;
    this.pos++;
    if (this.pos >= this.buf.length) this.pos = 0;
    return delayed;
  }
}

class Allpass {
  constructor(size) {
    this.buf = new Float32Array(size);
    this.pos = 0;
    this.feedback = 0.5;
  }
  process(input) {
    const delayed = this.buf[this.pos];
    const output = -input + delayed;
    this.buf[this.pos] = input + output * this.feedback;
    this.pos++;
    if (this.pos >= this.buf.length) this.pos = 0;
    return output;
  }
}

// reverb.rs: freeverb (8 combs + 4 allpass per channel, stereo spread).
class Reverb {
  constructor(sr) {
    const scale = sr / 44100.0;
    const sc = (n) => Math.max(1, Math.round(n * scale));
    const combTuning = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
    const allpassTuning = [556, 441, 341, 225];
    const spread = Math.round(23 * scale);
    this.combsL = combTuning.map((t) => new Comb(sc(t)));
    this.combsR = combTuning.map((t) => new Comb(sc(t) + spread));
    this.apL = allpassTuning.map((t) => new Allpass(sc(t)));
    this.apR = allpassTuning.map((t) => new Allpass(sc(t) + spread));
  }
  // returns [outL, outR] (wet only); dry/wet mix applied by caller
  process(l, r, size, damping) {
    const rs = size * 0.28 + 0.7;
    const dp = damping * 0.4;
    const dpInv = 1.0 - dp;
    const input = (l + r) * 0.5 * 0.015;
    let outL = 0;
    let outR = 0;
    for (let i = 0; i < 8; i++) outL += this.combsL[i].process(input, rs, dp, dpInv);
    for (let i = 0; i < 8; i++) outR += this.combsR[i].process(input, rs, dp, dpInv);
    for (let i = 0; i < 4; i++) outL = this.apL[i].process(outL);
    for (let i = 0; i < 4; i++) outR = this.apR[i].process(outR);
    return [outL, outR];
  }
}

// Default param image (overwritten by the first applyPreset).
function defaultParams() {
  return {
    osc1Level: 1, osc1Octave: 0, osc1Detune: 0, osc1Wave: 2, osc1Vib: 0,
    osc2Level: 0, osc2Octave: 0, osc2Detune: 0, osc2Wave: 2, osc2Vib: 0,
    osc3Level: 0, osc3Octave: 0, osc3Detune: 0, osc3Wave: 2, osc3Vib: 0,
    noise: 0, portamento: 0,
    filtCutoff: 20000, filtReso: 0, filtEnvAmt: 0,
    filtAttack: 0, filtDecay: 0, filtSustain: 1, filtRelease: 0,
    ampAttack: 0.01, ampDecay: 0.1, ampSustain: 1, ampRelease: 0.1,
    lfoEnabled: 0, lfoFreq: 1, lfoWave: 0, lfoVibAmt: 0, lfoFiltAmt: 0,
    delayEnabled: 0, delayTime: 0.25, delayFeedback: 0.3, delayMix: 0.3,
    reverbEnabled: 0, reverbSize: 0.5, reverbDamping: 0.5, reverbMix: 0.1,
  };
}

class SynthProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const sr = sampleRate;
    this.p = defaultParams();

    this.osc1 = new Osc();
    this.osc2 = new Osc();
    this.osc3 = new Osc();
    this.noiseOsc = new Osc();
    this.ampEnv = new Adsr();
    this.filtEnv = new Adsr();
    this.lfo = new Lfo();
    this.ladder = [0, 0, 0, 0];
    this.delayL = new Delay(sr);
    this.delayR = new Delay(sr);
    this.reverb = new Reverb(sr);

    // note / pitch state
    this.notes = []; // held notes, last = active
    this.gate = false;
    this.velocity = 0;
    this.target = 440;
    this.curFreq = 440;
    this.bend = 1.0;
    this.chunkFreq = 440; // portamento-stepped base freq * bend, held per 32-sample chunk
    this.glideClock = 0;

    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    switch (m.type) {
      case 'preset':
        Object.assign(this.p, m.params);
        break;
      case 'param':
        this.p[m.key] = m.value;
        break;
      case 'noteOn':
        this.noteOn(m.note, m.velocity);
        break;
      case 'noteOff':
        this.noteOff(m.note);
        break;
      case 'pitchBend':
        this.bend = m.factor;
        break;
      case 'panic':
        this.notes.length = 0;
        this.gate = false;
        break;
    }
  }

  noteOn(note, velocity) {
    const wasEmpty = this.notes.length === 0;
    const idx = this.notes.indexOf(note);
    if (idx >= 0) this.notes.splice(idx, 1);
    this.notes.push(note);
    this.velocity = velocity;
    this.target = midiToFreq(note);
    if (wasEmpty) {
      // First note after silence: snap (no glide up from the previous pitch).
      this.curFreq = this.target;
      this.chunkFreq = this.target * this.bend;
    }
    this.gate = true;
  }

  noteOff(note) {
    const idx = this.notes.indexOf(note);
    if (idx >= 0) this.notes.splice(idx, 1);
    if (this.notes.length === 0) {
      this.gate = false;
    } else {
      this.target = midiToFreq(this.notes[this.notes.length - 1]);
    }
  }

  stepGlide() {
    const diff = this.target - this.curFreq;
    if (Math.abs(diff) < 0.1) {
      this.curFreq = this.target;
    } else {
      const amt = this.p.portamento;
      const factor = 1.0 - Math.min(Math.max(amt, 0), 0.999);
      this.curFreq += diff * factor;
    }
    this.chunkFreq = this.curFreq * this.bend;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const outL = out[0];
    const outR = out[1] || out[0];
    const n = outL.length;
    const sr = sampleRate;
    const p = this.p;

    const oct1 = Math.pow(2, p.osc1Octave);
    const oct2 = Math.pow(2, p.osc2Octave);
    const oct3 = Math.pow(2, p.osc3Octave);
    const w1 = Math.round(p.osc1Wave), w2 = Math.round(p.osc2Wave), w3 = Math.round(p.osc3Wave);
    const lvl1 = p.osc1Level, lvl2 = p.osc2Level, lvl3 = p.osc3Level, lvlN = p.noise;
    const vib1 = p.osc1Vib >= 0.5, vib2 = p.osc2Vib >= 0.5, vib3 = p.osc3Vib >= 0.5;
    const lfoOn = p.lfoEnabled >= 0.5;
    const lfoWave = Math.round(p.lfoWave);
    const vibAmt = p.lfoVibAmt, filtAmt = p.lfoFiltAmt;
    const baseCut = p.filtCutoff, reso = p.filtReso, envAmt = p.filtEnvAmt;
    const delayOn = p.delayEnabled >= 0.5;
    const reverbOn = p.reverbEnabled >= 0.5;

    const s = this.ladder;
    const maxF = sr * 0.49;

    for (let i = 0; i < n; i++) {
      if (this.glideClock <= 0) {
        this.stepGlide();
        this.glideClock = 32;
      }
      this.glideClock--;

      const base = this.chunkFreq;
      const lfoVal = lfoOn ? this.lfo.tick(p.lfoFreq, lfoWave, sr) : 0;

      // envelopes
      this.ampEnv.recalc(p.ampAttack, p.ampDecay, p.ampRelease, sr);
      this.filtEnv.recalc(p.filtAttack, p.filtDecay, p.filtRelease, sr);
      const ampE = this.ampEnv.tick(this.gate, p.ampSustain);
      const filtE = this.filtEnv.tick(this.gate, p.filtSustain);

      // oscillators + noise (detune is a literal Hz offset, per moog.rs pitch chain)
      let mono = 0;
      const vib = lfoOn ? lfoVal * vibAmt : 0;
      if (lvl1 > 0.0001) mono += this.osc1.tick(base * oct1 + p.osc1Detune + (vib1 ? vib : 0), w1, sr) * lvl1;
      if (lvl2 > 0.0001) mono += this.osc2.tick(base * oct2 + p.osc2Detune + (vib2 ? vib : 0), w2, sr) * lvl2;
      if (lvl3 > 0.0001) mono += this.osc3.tick(base * oct3 + p.osc3Detune + (vib3 ? vib : 0), w3, sr) * lvl3;
      if (lvlN > 0.0001) mono += this.noiseOsc.rand() * lvlN;

      // filter: cutoff = base + filterEnv*envAmt + lfo*filterAmt
      let cut = baseCut + filtE * envAmt + (lfoOn ? lfoVal * filtAmt : 0);
      if (cut < 10) cut = 10;
      else if (cut > maxF) cut = maxF;
      const g = fastTan((PI * cut) / sr);
      const k = reso * 4.0;
      const beta = 1.0 / (1.0 + g);
      const gVal = g * beta;
      const s0 = s[0] * beta, s1 = s[1] * beta, s2 = s[2] * beta, s3 = s[3] * beta;
      const g2 = gVal * gVal;
      const gamma = g2 * g2;
      const sigma = s3 + gVal * (s2 + gVal * (s1 + gVal * s0));
      const yEst = (gamma * mono + sigma) / (1.0 + k * gamma);
      const u = mono - k * fastTanh(yEst);
      const v1 = gVal * u + s0;
      const v2 = gVal * v1 + s1;
      const v3 = gVal * v2 + s2;
      const v4 = gVal * v3 + s3;
      s[0] = 2.0 * v1 - s[0];
      s[1] = 2.0 * v2 - s[1];
      s[2] = 2.0 * v3 - s[2];
      s[3] = 2.0 * v4 - s[3];

      // VCA: filtered * ampEnv * velocity
      let l = v4 * ampE * this.velocity;
      let r = l;

      // stereo FX chain
      if (delayOn) {
        l = this.delayL.process(l, p.delayTime, p.delayFeedback, p.delayMix);
        r = this.delayR.process(r, p.delayTime * 1.15, p.delayFeedback, p.delayMix);
      }
      if (reverbOn) {
        const wet = this.reverb.process(l, r, p.reverbSize, p.reverbDamping);
        const mix = p.reverbMix;
        const dry = 1.0 - mix;
        l = l * dry + wet[0] * mix;
        r = r * dry + wet[1] * mix;
      }
      // stereo widener (width 1.5)
      const mid = (l + r) * 0.5;
      const side = (l - r) * 0.5 * 1.5;
      l = mid + side;
      r = mid - side;

      // output gain 0.5
      outL[i] = l * 0.5;
      if (out[1]) outR[i] = r * 0.5;
    }

    return true;
  }
}

registerProcessor('synth-processor', SynthProcessor);
