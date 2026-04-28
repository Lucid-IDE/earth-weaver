// ── MPM Health Monitor + NaN Failsafe + Replay Recorder ─────────────
// Centralizes:
//   • Per-frame health metrics (gridMass min/max, velocity bounds, NaN counts, sigma ranges)
//   • Auto-trip failsafe: when any NaN/Inf is detected, snapshots state and disables MPM
//   • First-failure heatmap: records the (i,j,k) of the first non-finite grid node and
//     the indices of non-finite particles each frame so an overlay can render them
//   • Deterministic dig replay: records last dig inputs + RNG seed for reliable repro

export interface DigEvent {
  t: number;
  worldX: number; worldY: number; worldZ: number;
  radius: number;
  kernelStrength: number;
  kernelRadius: number;
  rngSeed: number;
  source: 'click' | 'bucket' | 'blade' | 'impact' | 'replay';
}

export interface HealthMetrics {
  // Grid
  gridMassMin: number;
  gridMassMax: number;
  gridMassActive: number;     // count of cells with mass > clampThreshold
  gridVelMin: number;
  gridVelMax: number;
  gridNaNCount: number;
  // Particles
  partVelMin: number;
  partVelMax: number;
  partNaNCount: number;
  // SVD sigma ranges (across particles this frame)
  sigmaMin: number;
  sigmaMax: number;
  // Failsafe
  tripped: boolean;
  tripReason: string;
  tripFrame: number;
  // Replay
  lastDig: DigEvent | null;
}

export interface NaNHotspot {
  // Grid cells that became non-finite this frame (indices into the (GS)^3 grid)
  gridIdxs: number[];
  // Particle indices that became non-finite this frame
  particleIdxs: number[];
  // First failure point (world-ish): for camera focus
  firstGridIdx: number;
  firstParticleIdx: number;
}

const EMPTY_METRICS: HealthMetrics = {
  gridMassMin: 0, gridMassMax: 0, gridMassActive: 0,
  gridVelMin: 0, gridVelMax: 0, gridNaNCount: 0,
  partVelMin: 0, partVelMax: 0, partNaNCount: 0,
  sigmaMin: 1, sigmaMax: 1,
  tripped: false, tripReason: '', tripFrame: -1,
  lastDig: null,
};

class HealthMonitorImpl {
  metrics: HealthMetrics = { ...EMPTY_METRICS };
  hotspot: NaNHotspot = { gridIdxs: [], particleIdxs: [], firstGridIdx: -1, firstParticleIdx: -1 };
  // Snapshot of the very first frame an explosion happened (for forensic inspection)
  postMortem: {
    metrics: HealthMetrics;
    hotspot: NaNHotspot;
    digEvent: DigEvent | null;
  } | null = null;

  // Tunable disturbance kernel — exposed to UI
  kernel = {
    radius: 1.0,    // multiplier on dig radius for ejection falloff
    strength: 0.30, // ejection speed (was hard-coded 0.3 in bridge.ts)
    enabled: true,  // false = legacy hard impulse
  };

  // NaN/Inf heatmap overlay toggle
  heatmapEnabled = false;

  // Replay recorder
  digHistory: DigEvent[] = [];
  private maxDigHistory = 32;

  // Listeners
  private listeners = new Set<() => void>();
  // Failsafe callback — soilSim wires this to flip MPM_RUNTIME.enabled = false
  private onTrip: (() => void) | null = null;

  reset() {
    this.metrics = { ...EMPTY_METRICS };
    this.hotspot = { gridIdxs: [], particleIdxs: [], firstGridIdx: -1, firstParticleIdx: -1 };
    this.postMortem = null;
    this.notify();
  }

  setOnTrip(cb: () => void) { this.onTrip = cb; }

  recordDig(ev: DigEvent) {
    this.digHistory.push(ev);
    if (this.digHistory.length > this.maxDigHistory) this.digHistory.shift();
    this.metrics.lastDig = ev;
    this.notify();
  }

  getLastDig(): DigEvent | null {
    return this.digHistory[this.digHistory.length - 1] ?? null;
  }

  // Called by mpmSolver after each step
  publish(m: Partial<HealthMetrics>, hot: NaNHotspot) {
    Object.assign(this.metrics, m);
    this.hotspot = hot;

    if ((m.gridNaNCount ?? 0) > 0 || (m.partNaNCount ?? 0) > 0) {
      if (!this.metrics.tripped) {
        this.metrics.tripped = true;
        this.metrics.tripReason = `NaN/Inf: grid=${m.gridNaNCount ?? 0} part=${m.partNaNCount ?? 0}`;
        this.metrics.tripFrame = (this.metrics.tripFrame === -1 ? 0 : this.metrics.tripFrame);
        // Capture forensic snapshot ONCE
        this.postMortem = {
          metrics: { ...this.metrics },
          hotspot: { ...hot, gridIdxs: hot.gridIdxs.slice(), particleIdxs: hot.particleIdxs.slice() },
          digEvent: this.getLastDig(),
        };
        // Trip failsafe — soilSim flips MPM off, telemetry preserved
        this.onTrip?.();
      }
    }
    this.notify();
  }

  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }
  private notify() { this.listeners.forEach((l) => l()); }

  // For deterministic replay
  rngSeedForNextDig: number | null = null;
}

export const mpmHealth = new HealthMonitorImpl();

// Expose for console debugging
if (typeof window !== 'undefined') {
  // @ts-ignore
  window.__MPM_HEALTH = mpmHealth;
}

// ── Wendland C2 quintic falloff ──────────────────────────────────────
// Smooth, compact-support kernel (zero outside r=1, derivatives smooth)
// W(q) = (1-q)^4 (4q+1) for q in [0,1], else 0
export function wendland(q: number): number {
  if (q >= 1) return 0;
  if (q <= 0) return 1;
  const t = 1 - q;
  return t * t * t * t * (4 * q + 1);
}
