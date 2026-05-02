// ── Diagnostic Telemetry Bus ────────────────────────────────────────
// Central pub/sub for all live simulation signals. Cheap: ring buffer +
// shallow snapshot, no React rerenders unless subscribers ask.

export interface InputSnapshot {
  // Raw key state (true = down)
  keys: Record<string, boolean>;
  // Combined per-equipment inputs (-1..1)
  exc: { leftTrack: number; rightTrack: number; swing: number; boom: number; stick: number; bucket: number };
  doz: { leftTrack: number; rightTrack: number; bladeUp: number; bladeTilt: number; bladeAngle: number };
  truck?: { throttle: number; steer: number; dumpBed: number; bedLoad: number; tirePressurePsi: number };
  events: { switchExc: boolean; switchDoz: boolean; switchTruck?: boolean; switchFree: boolean; impact: boolean; explosion: boolean };
}

export interface PhysicsSnapshot {
  rpm: number;
  throttle: number;
  engineTorque: number;
  engineStalled: boolean;
  engineLugging: boolean;
  hydPressure: number;
  hydFlow: number;
  reliefOpen: boolean;
  leftDriveTorque: number;
  rightDriveTorque: number;
  leftTrackVel: number;
  rightTrackVel: number;
  forwardVel: number;
  angularVel: number;
  slip: number;
  isSlipping: boolean;
  leftSinkage: number;
  rightSinkage: number;
  groundResistance: number;
  posX: number;
  posZ: number;
  heading: number;
  pitch: number;
}

export interface DumpTruckSnapshot {
  rpm: number;
  throttle: number;
  forwardVel: number;
  steeringAngle: number;
  wheelRotation: number;
  bedAngle: number;
  bedLoad: number;
  tirePressurePsi: number;
  avgTireDeflection: number;
  maxTireDeflection: number;
  posX: number;
  posZ: number;
  heading: number;
  pitch: number;
}

export interface JointSnapshot {
  swing: number; boom: number; stick: number; bucket: number; bucketFill: number;
  bladeHeight: number; bladeTilt: number; bladeAngle: number;
}

export interface RenderSnapshot {
  fps: number;
  frameMs: number;
  vertices: number;
  triangles: number;
  activeParticles: number;
  totalParticles: number;
  simActive: boolean;
}

export interface TelemetryFrame {
  t: number;
  active: 'excavator' | 'bulldozer' | 'dumpTruck' | 'none';
  input: InputSnapshot;
  exc: PhysicsSnapshot;
  doz: PhysicsSnapshot;
  truck?: DumpTruckSnapshot;
  joints: JointSnapshot;
  render: RenderSnapshot;
}

type Listener = (f: TelemetryFrame) => void;

class TelemetryBus {
  private latest: TelemetryFrame | null = null;
  private history: TelemetryFrame[] = [];
  private listeners = new Set<Listener>();
  private maxHistory = 600; // ~30s at 20Hz publish
  private lastPub = 0;
  private pubInterval = 0.05; // 20 Hz to subscribers

  publish(frame: TelemetryFrame) {
    this.latest = frame;
    this.history.push(frame);
    if (this.history.length > this.maxHistory) this.history.shift();

    if (frame.t - this.lastPub >= this.pubInterval) {
      this.lastPub = frame.t;
      this.listeners.forEach((l) => l(frame));
    }
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }

  getLatest(): TelemetryFrame | null { return this.latest; }
  getHistory(): TelemetryFrame[] { return this.history.slice(); }
  clearHistory() { this.history = []; }
}

export const telemetryBus = new TelemetryBus();
