import { DumpTruckState } from './types';

const DEG = Math.PI / 180;

export function createDumpTruckState(): DumpTruckState {
  return {
    vehicle: {
      posX: 0, posY: 0, posZ: -0.35,
      heading: 0,
      pitch: 0,
      contactSink: 0,
      groundClearance: 0,
      tracks: { leftSpeed: 0, rightSpeed: 0, leftTravel: 0, rightTravel: 0, slack: 0 },
      speed: 0,
      turnRate: 0,
    },
    steeringAngle: 0,
    wheelRotation: 0,
    bedAngle: 0,
    bedLoad: 0.65,
    tirePressurePsi: 72,
    tailgateOpen: false,
    suspensionCompression: [0, 0, 0, 0],
    tireDeflection: [0, 0, 0, 0],
    engineRpm: 750,
    throttle: 0,
  };
}

export function updateDumpTruck(
  state: DumpTruckState,
  dt: number,
  inputs: {
    throttle: number;
    steer: number;
    dumpBed: number;
    toggleTailgate: boolean;
    pressureDown: boolean;
    pressureUp: boolean;
    loadAdd: boolean;
    loadDump: boolean;
  },
) {
  const cdt = Math.min(dt, 0.033);
  const v = state.vehicle;

  if (inputs.toggleTailgate) state.tailgateOpen = !state.tailgateOpen;
  if (inputs.pressureDown) state.tirePressurePsi = Math.max(28, state.tirePressurePsi - 18 * cdt);
  if (inputs.pressureUp) state.tirePressurePsi = Math.min(105, state.tirePressurePsi + 24 * cdt);
  if (inputs.loadAdd) state.bedLoad = Math.min(1, state.bedLoad + 0.28 * cdt);
  if (inputs.loadDump) state.bedLoad = Math.max(0, state.bedLoad - 0.42 * cdt);

  const bedRate = inputs.dumpBed > 0 ? 32 * DEG : 24 * DEG;
  state.bedAngle += inputs.dumpBed * bedRate * cdt;
  state.bedAngle = Math.max(0, Math.min(54 * DEG, state.bedAngle));
  if (state.bedAngle > 32 * DEG && state.tailgateOpen) {
    state.bedLoad = Math.max(0, state.bedLoad - (0.22 + state.bedAngle) * cdt);
  }

  state.throttle += (inputs.throttle - state.throttle) * Math.min(1, 5 * cdt);
  const targetRpm = 750 + Math.abs(state.throttle) * 1450 + state.bedLoad * 120;
  state.engineRpm += (targetRpm - state.engineRpm) * Math.min(1, 4 * cdt);

  const targetSteer = inputs.steer * 28 * DEG;
  state.steeringAngle += (targetSteer - state.steeringAngle) * Math.min(1, 7 * cdt);

  const massFactor = 1 + state.bedLoad * 1.65;
  const pressureFactor = Math.max(0.62, Math.min(1.35, state.tirePressurePsi / 72));
  const tractionLimit = 0.82 + pressureFactor * 0.12;
  const rollingResistance = (0.08 + (1 / pressureFactor) * 0.05 + state.bedLoad * 0.07) * Math.sign(v.speed || state.throttle || 1);
  const engineForce = state.throttle * 0.58 * tractionLimit;
  const brakeDrag = Math.abs(state.throttle) < 0.04 ? v.speed * 1.8 : rollingResistance * 0.35;
  const accel = (engineForce - brakeDrag) / massFactor;
  v.speed += accel * cdt;
  v.speed *= 1 - Math.min(0.08, (0.018 + state.bedLoad * 0.012) * cdt);
  v.speed = Math.max(-0.32, Math.min(0.38, v.speed));

  const wheelbase = 0.26;
  const turnRate = Math.abs(state.steeringAngle) > 0.001
    ? Math.tan(state.steeringAngle) * v.speed / wheelbase
    : 0;
  v.turnRate = turnRate;
  v.heading += turnRate * cdt;
  v.posX += Math.sin(v.heading) * v.speed * cdt;
  v.posZ += Math.cos(v.heading) * v.speed * cdt;
  v.posX = Math.max(-0.75, Math.min(0.75, v.posX));
  v.posZ = Math.max(-0.75, Math.min(0.75, v.posZ));

  const tireRadius = 0.032;
  state.wheelRotation += (v.speed / tireRadius) * cdt;
  const baseDeflection = Math.max(0, (72 / state.tirePressurePsi - 0.55)) * 0.006;
  const payloadDeflection = state.bedLoad * 0.010;
  const rearBias = 1 + state.bedLoad * 0.9 + Math.sin(state.bedAngle) * state.bedLoad * 0.35;
  const frontBias = 0.75 + (1 - state.bedLoad) * 0.2;
  const targets: [number, number, number, number] = [
    (baseDeflection + payloadDeflection * 0.35) * frontBias,
    (baseDeflection + payloadDeflection * 0.35) * frontBias,
    (baseDeflection + payloadDeflection) * rearBias,
    (baseDeflection + payloadDeflection) * rearBias,
  ];
  for (let i = 0; i < 4; i++) {
    state.tireDeflection[i] += (targets[i] - state.tireDeflection[i]) * Math.min(1, 8 * cdt);
    state.suspensionCompression[i] += (state.tireDeflection[i] * 1.7 - state.suspensionCompression[i]) * Math.min(1, 6 * cdt);
  }

  v.tracks.leftSpeed = v.speed / 0.38;
  v.tracks.rightSpeed = v.tracks.leftSpeed;
  v.tracks.leftTravel = state.wheelRotation;
  v.tracks.rightTravel = state.wheelRotation;
}