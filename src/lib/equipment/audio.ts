// ── Equipment Audio Engine ───────────────────────────────────────────
// Web Audio synthesis driven by physics state. Produces:
//   • Diesel engine drone whose pitch tracks RPM and timbre roughens with
//     load (lugging), goes silent on stall.
//   • Hydraulic flow whine that rises with pump pressure × flow.
//   • Relief-valve squeal when the relief cracks.
//   • Track squeak/clank proportional to slip mobilization and travel.
//   • One-shot landing thump when a vehicle drops onto the soil.
//
// Single global engine; lazily initialized on first user interaction (browser
// audio context unlock requirement).

let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;

interface VehicleAudio {
  // Engine
  engineOsc: OscillatorNode;
  engineSubOsc: OscillatorNode;
  engineNoise: AudioBufferSourceNode;
  engineNoiseFilter: BiquadFilterNode;
  engineGain: GainNode;
  // Hydraulics
  hydOsc: OscillatorNode;
  hydGain: GainNode;
  reliefOsc: OscillatorNode;
  reliefGain: GainNode;
  // Tracks
  trackNoise: AudioBufferSourceNode;
  trackFilter: BiquadFilterNode;
  trackGain: GainNode;
}

const vehicles = new Map<string, VehicleAudio>();

function makeNoiseBuffer(audioCtx: AudioContext, duration = 2): AudioBuffer {
  const sr = audioCtx.sampleRate;
  const buf = audioCtx.createBuffer(1, sr * duration, sr);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

export function ensureAudioContext(): AudioContext | null {
  if (ctx) return ctx;
  try {
    ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    masterGain = ctx.createGain();
    masterGain.gain.value = 0.5;
    masterGain.connect(ctx.destination);
  } catch {
    ctx = null;
  }
  return ctx;
}

export function setMasterVolume(v: number) {
  if (masterGain) masterGain.gain.value = Math.max(0, Math.min(1, v));
}

function createVehicleAudio(audioCtx: AudioContext): VehicleAudio {
  // Engine: dual square+sine for diesel-like fundamental
  const engineOsc = audioCtx.createOscillator();
  engineOsc.type = 'sawtooth';
  engineOsc.frequency.value = 35;

  const engineSubOsc = audioCtx.createOscillator();
  engineSubOsc.type = 'square';
  engineSubOsc.frequency.value = 17;

  const engineGain = audioCtx.createGain();
  engineGain.gain.value = 0;

  // Roughness noise for combustion grit
  const engineNoise = audioCtx.createBufferSource();
  engineNoise.buffer = makeNoiseBuffer(audioCtx);
  engineNoise.loop = true;
  const engineNoiseFilter = audioCtx.createBiquadFilter();
  engineNoiseFilter.type = 'bandpass';
  engineNoiseFilter.frequency.value = 120;
  engineNoiseFilter.Q.value = 1.4;
  const engineNoiseGain = audioCtx.createGain();
  engineNoiseGain.gain.value = 0.18;

  engineOsc.connect(engineGain);
  engineSubOsc.connect(engineGain);
  engineNoise.connect(engineNoiseFilter).connect(engineNoiseGain).connect(engineGain);
  engineGain.connect(masterGain!);

  // Hydraulic whine
  const hydOsc = audioCtx.createOscillator();
  hydOsc.type = 'triangle';
  hydOsc.frequency.value = 220;
  const hydGain = audioCtx.createGain();
  hydGain.gain.value = 0;
  hydOsc.connect(hydGain).connect(masterGain!);

  // Relief valve squeal (high-Q narrow band, ~1.6kHz)
  const reliefOsc = audioCtx.createOscillator();
  reliefOsc.type = 'sine';
  reliefOsc.frequency.value = 1650;
  const reliefGain = audioCtx.createGain();
  reliefGain.gain.value = 0;
  reliefOsc.connect(reliefGain).connect(masterGain!);

  // Track squeak/clank (filtered noise, modulated by slip)
  const trackNoise = audioCtx.createBufferSource();
  trackNoise.buffer = makeNoiseBuffer(audioCtx);
  trackNoise.loop = true;
  const trackFilter = audioCtx.createBiquadFilter();
  trackFilter.type = 'bandpass';
  trackFilter.frequency.value = 480;
  trackFilter.Q.value = 4.5;
  const trackGain = audioCtx.createGain();
  trackGain.gain.value = 0;
  trackNoise.connect(trackFilter).connect(trackGain).connect(masterGain!);

  engineOsc.start();
  engineSubOsc.start();
  engineNoise.start();
  hydOsc.start();
  reliefOsc.start();
  trackNoise.start();

  return {
    engineOsc, engineSubOsc, engineNoise, engineNoiseFilter, engineGain,
    hydOsc, hydGain, reliefOsc, reliefGain,
    trackNoise, trackFilter, trackGain,
  };
}

export interface VehicleAudioParams {
  rpm: number;          // 0..maxRpm
  maxRpm: number;
  throttle: number;     // 0..1
  lugging: boolean;
  stalled: boolean;
  hydPressure: number;  // 0..1
  hydFlow: number;      // 0..1
  reliefOpen: boolean;
  trackSpeed: number;   // 0..1 absolute
  slip: number;         // 0..1
  active: boolean;      // is this the active equipment? quiet others
}

export function updateVehicleAudio(id: string, p: VehicleAudioParams) {
  const audioCtx = ctx;
  if (!audioCtx || !masterGain) return;

  let av = vehicles.get(id);
  if (!av) {
    av = createVehicleAudio(audioCtx);
    vehicles.set(id, av);
  }

  const t = audioCtx.currentTime;
  const ramp = 0.06;
  const focus = p.active ? 1 : 0.18; // background vehicles audible but quieter

  // Engine
  if (p.stalled || p.rpm < 1) {
    av.engineGain.gain.setTargetAtTime(0, t, ramp);
  } else {
    const rpmNorm = p.rpm / p.maxRpm;
    const baseHz = 22 + rpmNorm * 110; // diesel range ~22-130 Hz
    av.engineOsc.frequency.setTargetAtTime(baseHz, t, ramp);
    av.engineSubOsc.frequency.setTargetAtTime(baseHz * 0.5, t, ramp);
    av.engineNoiseFilter.frequency.setTargetAtTime(80 + rpmNorm * 220, t, ramp);
    const lugBoost = p.lugging ? 1.4 : 1.0;
    const vol = (0.04 + rpmNorm * 0.10 + p.throttle * 0.06) * lugBoost * focus;
    av.engineGain.gain.setTargetAtTime(vol, t, ramp);
  }

  // Hydraulics — whine pitch scales with flow, vol with pressure×flow
  const hydAmt = p.hydPressure * p.hydFlow;
  av.hydOsc.frequency.setTargetAtTime(180 + p.hydFlow * 380, t, ramp);
  av.hydGain.gain.setTargetAtTime(hydAmt * 0.05 * focus, t, ramp);

  // Relief squeal
  av.reliefGain.gain.setTargetAtTime(p.reliefOpen ? 0.06 * focus : 0, t, 0.03);

  // Track squeak: only when moving + slipping
  const trackAmt = Math.min(1, p.trackSpeed * 1.2) * Math.min(1, 0.3 + p.slip);
  av.trackFilter.frequency.setTargetAtTime(380 + p.slip * 600, t, ramp);
  av.trackGain.gain.setTargetAtTime(trackAmt * 0.04 * focus, t, ramp);
}

/** One-shot landing thump (low boom + click) */
export function playLandingThump(intensity: number) {
  const audioCtx = ensureAudioContext();
  if (!audioCtx || !masterGain) return;
  const t = audioCtx.currentTime;
  const amp = Math.min(0.6, 0.15 + intensity * 0.4);

  // Sub thump
  const osc = audioCtx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(80, t);
  osc.frequency.exponentialRampToValueAtTime(28, t + 0.35);
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(amp, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
  osc.connect(g).connect(masterGain);
  osc.start(t);
  osc.stop(t + 0.5);

  // Click (noise burst)
  const noise = audioCtx.createBufferSource();
  noise.buffer = makeNoiseBuffer(audioCtx, 0.2);
  const nf = audioCtx.createBiquadFilter();
  nf.type = 'bandpass';
  nf.frequency.value = 1800;
  nf.Q.value = 2;
  const ng = audioCtx.createGain();
  ng.gain.setValueAtTime(amp * 0.7, t);
  ng.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
  noise.connect(nf).connect(ng).connect(masterGain);
  noise.start(t);
  noise.stop(t + 0.2);
}

export function disposeAllAudio() {
  vehicles.forEach((av) => {
    av.engineOsc.stop();
    av.engineSubOsc.stop();
    av.engineNoise.stop();
    av.hydOsc.stop();
    av.reliefOsc.stop();
    av.trackNoise.stop();
  });
  vehicles.clear();
}
