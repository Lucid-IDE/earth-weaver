// ── Vehicle Physics Engine ───────────────────────────────────────────
// Realistic drivetrain simulation: Engine → Torque Converter → Transmission → Final Drive → Tracks
// All values scaled to world units (1.0 ≈ 2m)
//
// Reference machines:
//   Excavator: CAT 320 class (20-ton, ~120kW diesel)
//   Bulldozer: CAT D6 class (20-ton, ~150kW diesel)

import { VehicleState } from './types';
import {
  computeTrackForces,
  getTerramechParams,
  type SoilTerramechParams,
} from './terramechanics';
import { createRigidBody, integrateRigidBody, RigidBodyState } from './rigidBody';

export const DEG = Math.PI / 180;

// ── Engine Model ────────────────────────────────────────────────────
export interface EngineState {
  rpm: number;           // current RPM
  targetThrottle: number; // 0-1 commanded
  throttle: number;      // 0-1 actual (lag)
  torque: number;        // current output torque (Nm, scaled)
  fuelConsumption: number;
  smoke: number;         // 0..1 black-smoke factor (lugging / overload)
  lugging: boolean;      // true when in low-rpm overload zone
  stalled: boolean;      // true when engine fully stalled
  stallTimer: number;    // sec since stall
  idleRpm: number;
  maxRpm: number;
  peakTorqueRpm: number;
  maxTorque: number;     // scaled Nm
  inertia: number;       // flywheel moment of inertia
  /** rpm below which torque collapses (real diesel: ~peakTorque×0.55) */
  stallRpm: number;
}

export function createEngine(maxTorqueScaled: number, maxRpm: number = 2200, idleRpm: number = 750): EngineState {
  return {
    rpm: idleRpm,
    targetThrottle: 0,
    throttle: 0,
    torque: 0,
    fuelConsumption: 0,
    smoke: 0,
    lugging: false,
    stalled: false,
    stallTimer: 0,
    idleRpm,
    maxRpm,
    peakTorqueRpm: maxRpm * 0.55,
    maxTorque: maxTorqueScaled,
    inertia: 0.08,
    stallRpm: idleRpm * 0.45,
  };
}

// Torque curve: bell shape peaking at peakTorqueRpm, dropping at high RPM
// Below stallRpm torque collapses to ~0 (engine bogs).
function engineTorqueCurve(engine: EngineState): number {
  if (engine.stalled) return 0;
  const normRpm = engine.rpm / engine.maxRpm;
  const peakNorm = engine.peakTorqueRpm / engine.maxRpm;
  const x = (normRpm - peakNorm) / 0.35;
  let envelope = Math.max(0, 1 - x * x);

  // Low-rpm collapse (lugging zone)
  if (engine.rpm < engine.peakTorqueRpm * 0.55) {
    const t = Math.max(0, (engine.rpm - engine.stallRpm)) /
              Math.max(1, engine.peakTorqueRpm * 0.55 - engine.stallRpm);
    envelope *= t * t; // quadratic falloff
  }

  return engine.maxTorque * envelope * engine.throttle;
}

export function updateEngine(engine: EngineState, loadTorque: number, dt: number) {
  // Throttle response lag (diesel governor ~200ms)
  const throttleLag = 5.0;
  engine.throttle += (engine.targetThrottle - engine.throttle) * Math.min(1, throttleLag * dt);

  // Try to restart from stall when throttle is released
  if (engine.stalled) {
    engine.stallTimer += dt;
    if (engine.targetThrottle < 0.05 && engine.stallTimer > 0.6) {
      engine.stalled = false;
      engine.rpm = engine.idleRpm;
      engine.stallTimer = 0;
    } else {
      engine.torque = 0;
      engine.smoke += (0 - engine.smoke) * Math.min(1, 4 * dt);
      return;
    }
  }

  // Torque from curve
  engine.torque = engineTorqueCurve(engine);

  // RPM dynamics: flywheel inertia + load
  const netTorque = engine.torque - loadTorque * 0.3;
  const rpmAccel = netTorque / engine.inertia;
  engine.rpm += rpmAccel * dt * 30;

  // Governor: idle control and rev limiter
  if (engine.throttle < 0.05) {
    engine.rpm += (engine.idleRpm - engine.rpm) * Math.min(1, 3 * dt);
  }

  // Detect lugging zone (load >> torque available, rpm dropping)
  const torqueDeficit = loadTorque * 0.3 - engine.torque;
  engine.lugging = engine.rpm < engine.peakTorqueRpm * 0.7
    && engine.throttle > 0.4
    && torqueDeficit > engine.maxTorque * 0.15;

  // Stall: rpm drops below stallRpm
  if (engine.rpm < engine.stallRpm && engine.throttle > 0.3) {
    engine.stalled = true;
    engine.rpm = 0;
    engine.stallTimer = 0;
  }

  engine.rpm = Math.max(0, Math.min(engine.maxRpm * 1.02, engine.rpm));

  // Smoke factor: lugging produces black smoke; high throttle some smoke
  const smokeTarget = engine.lugging ? 0.85 : engine.throttle * 0.25;
  engine.smoke += (smokeTarget - engine.smoke) * Math.min(1, 3.5 * dt);

  // Fuel consumption (proportional to torque * rpm)
  engine.fuelConsumption = engine.torque * engine.rpm * 0.0001;
}

// ── Hydraulic System ────────────────────────────────────────────────
export interface HydraulicSystem {
  pressure: number;       // 0-1 normalized (max ~350 bar real)
  flowRate: number;       // 0-1 normalized
  maxFlowRate: number;    // base max flow
  pumpLoad: number;       // torque load on engine from hydraulics
  demand: number;         // total hydraulic demand this frame
  reliefOpen: boolean;    // relief valve cracking → pressure squeal
}

export function createHydraulicSystem(): HydraulicSystem {
  return {
    pressure: 0,
    flowRate: 0,
    maxFlowRate: 1.0,
    pumpLoad: 0,
    demand: 0,
    reliefOpen: false,
  };
}

export function updateHydraulicSystem(hyd: HydraulicSystem, engine: EngineState, demand: number, dt: number) {
  hyd.demand = demand;

  // Flow rate depends on engine RPM (pump is mechanically driven). Stalled = 0.
  const rpmFactor = engine.stalled
    ? 0
    : Math.max(0, (engine.rpm - engine.idleRpm * 0.9)) / Math.max(1, engine.maxRpm - engine.idleRpm * 0.9);
  hyd.flowRate = hyd.maxFlowRate * rpmFactor;

  // Pressure builds with demand, limited by relief valve
  const targetPressure = Math.min(1, demand * 1.2);
  hyd.pressure += (targetPressure - hyd.pressure) * Math.min(1, 8 * dt);
  hyd.reliefOpen = demand > 0.92 && hyd.pressure > 0.9;

  // Pump load on engine
  hyd.pumpLoad = hyd.pressure * hyd.flowRate * 0.4;
}

// Hydraulic actuator speed: limited by flow rate and pressure
export function hydraulicActuatorSpeed(
  hyd: HydraulicSystem,
  baseSpeed: number,
  loadFactor: number = 1.0,
): number {
  const available = hyd.flowRate * hyd.pressure;
  const effectiveSpeed = baseSpeed * Math.min(1, available / Math.max(0.1, loadFactor));
  return effectiveSpeed;
}

// ── Drivetrain ──────────────────────────────────────────────────────
export interface DrivetrainState {
  converterSlip: number;
  converterOutputTorque: number;
  leftDriveTorque: number;
  rightDriveTorque: number;
  leftBrake: number;
  rightBrake: number;
  leftTrackVelocity: number;
  rightTrackVelocity: number;
  steerInput: number;
  throttleInput: number;
}

export function createDrivetrain(): DrivetrainState {
  return {
    converterSlip: 0,
    converterOutputTorque: 0,
    leftDriveTorque: 0,
    rightDriveTorque: 0,
    leftBrake: 0,
    rightBrake: 0,
    leftTrackVelocity: 0,
    rightTrackVelocity: 0,
    steerInput: 0,
    throttleInput: 0,
  };
}

// ── Vehicle Mass Properties ─────────────────────────────────────────
export interface MassProperties {
  mass: number;
  momentOfInertia: number;
  trackWidth: number;
  trackLength: number;
  groundPressure: number;
  cg: [number, number, number];
  rollingResistance: number;
}

export function createExcavatorMass(): MassProperties {
  return {
    mass: 20,
    momentOfInertia: 2.5,
    trackWidth: 0.10,
    trackLength: 0.16,
    groundPressure: 0.45,
    cg: [0, 0.03, 0],
    rollingResistance: 0.06,
  };
}

export function createBulldozerMass(): MassProperties {
  return {
    mass: 22,
    momentOfInertia: 3.2,
    trackWidth: 0.13,
    trackLength: 0.20,
    groundPressure: 0.38,
    cg: [0, 0.025, -0.01],
    rollingResistance: 0.07,
  };
}

// ── Full Vehicle Physics Step ───────────────────────────────────────
export interface VehiclePhysicsState {
  engine: EngineState;
  hydraulics: HydraulicSystem;
  drivetrain: DrivetrainState;
  mass: MassProperties;
  rigidBody: RigidBodyState;

  leftShearJ: number;
  rightShearJ: number;
  leftSinkage: number;
  rightSinkage: number;
  shearMobilization: number;

  forwardVelocity: number;
  angularVelocity: number;

  groundResistance: number;
  slopeResistance: number;
  isSlipping: boolean;
  slipAmount: number;
}

export function createVehiclePhysics(
  mass: MassProperties,
  maxEngineTorque: number,
  maxRpm?: number,
): VehiclePhysicsState {
  return {
    engine: createEngine(maxEngineTorque, maxRpm),
    hydraulics: createHydraulicSystem(),
    drivetrain: createDrivetrain(),
    mass,
    rigidBody: createRigidBody(mass.mass),
    leftShearJ: 0,
    rightShearJ: 0,
    leftSinkage: 0,
    rightSinkage: 0,
    shearMobilization: 0,
    forwardVelocity: 0,
    angularVelocity: 0,
    groundResistance: 0,
    slopeResistance: 0,
    isSlipping: false,
    slipAmount: 0,
  };
}

export function updateVehiclePhysics(
  physics: VehiclePhysicsState,
  vehicle: VehicleState,
  leftInput: number,
  rightInput: number,
  hydraulicDemand: number,
  terrainSoftness: number,
  dt: number,
  terramech?: SoilTerramechParams,
) {
  const dt_clamped = Math.min(dt, 0.033);
  const drv = physics.drivetrain;
  const eng = physics.engine;
  const mass = physics.mass;

  const avgInput = (leftInput + rightInput) * 0.5;
  const steerDiff = rightInput - leftInput;

  drv.throttleInput = avgInput;
  drv.steerInput = steerDiff;

  const demandMagnitude = Math.max(Math.abs(leftInput), Math.abs(rightInput));
  eng.targetThrottle = Math.min(1, demandMagnitude + hydraulicDemand * 0.4);

  const totalLoad = Math.abs(physics.forwardVelocity) * mass.mass * 10 + physics.hydraulics.pumpLoad;
  updateEngine(eng, totalLoad, dt_clamped);

  updateHydraulicSystem(physics.hydraulics, eng, hydraulicDemand, dt_clamped);

  const speedRatio = Math.min(1, Math.abs(physics.forwardVelocity) * 40);
  drv.converterSlip = Math.max(0.05, 1 - speedRatio * 0.85);
  const torqueMultiplier = 1 + (1 - speedRatio) * 1.5;
  drv.converterOutputTorque = eng.torque * torqueMultiplier * (1 - drv.converterSlip * 0.3);

  const baseTorque = drv.converterOutputTorque;
  const steerFactor = drv.steerInput * 0.5;
  drv.leftDriveTorque = baseTorque * (avgInput - steerFactor) * 0.5;
  drv.rightDriveTorque = baseTorque * (avgInput + steerFactor) * 0.5;

  drv.leftBrake = 0;
  drv.rightBrake = 0;
  if (leftInput * drv.leftTrackVelocity < -0.001) drv.leftBrake = 0.7;
  if (rightInput * drv.rightTrackVelocity < -0.001) drv.rightBrake = 0.7;
  if (Math.abs(leftInput) < 0.05) drv.leftBrake = 0.3;
  if (Math.abs(rightInput) < 0.05) drv.rightBrake = 0.3;

  const maxTrackSpeed = 0.12;
  const driveGain = 0.0009;
  const cmdLeftV = drv.leftDriveTorque * driveGain - drv.leftBrake * Math.sign(drv.leftTrackVelocity) * 0.04;
  const cmdRightV = drv.rightDriveTorque * driveGain - drv.rightBrake * Math.sign(drv.rightTrackVelocity) * 0.04;

  drv.leftTrackVelocity += (cmdLeftV - drv.leftTrackVelocity) * Math.min(1, 6 * dt_clamped);
  drv.rightTrackVelocity += (cmdRightV - drv.rightTrackVelocity) * Math.min(1, 6 * dt_clamped);
  drv.leftTrackVelocity = Math.max(-maxTrackSpeed, Math.min(maxTrackSpeed, drv.leftTrackVelocity));
  drv.rightTrackVelocity = Math.max(-maxTrackSpeed, Math.min(maxTrackSpeed, drv.rightTrackVelocity));

  const params = terramech ?? getTerramechParams(30 * DEG, 0.3, terrainSoftness);

  const pitchTransfer = Math.sin(physics.rigidBody.pitchAccum) * mass.mass * 0.15;
  const halfWeight = mass.mass * 9.81 * 0.5;
  const leftLoad = halfWeight - pitchTransfer * 0.5;
  const rightLoad = halfWeight - pitchTransfer * 0.5;
  const shoeArea = mass.trackWidth * mass.trackLength;

  const leftRes = computeTrackForces(
    leftLoad, shoeArea, mass.trackWidth, mass.trackLength,
    drv.leftTrackVelocity, physics.forwardVelocity,
    dt_clamped, params, physics.leftShearJ,
  );
  const rightRes = computeTrackForces(
    rightLoad, shoeArea, mass.trackWidth, mass.trackLength,
    drv.rightTrackVelocity, physics.forwardVelocity,
    dt_clamped, params, physics.rightShearJ,
  );

  physics.leftShearJ = leftRes.newShearJ;
  physics.rightShearJ = rightRes.newShearJ;
  physics.leftSinkage = leftRes.avgSinkage;
  physics.rightSinkage = rightRes.avgSinkage;
  physics.shearMobilization = (leftRes.shearMobilization + rightRes.shearMobilization) * 0.5;
  physics.isSlipping = leftRes.saturated || rightRes.saturated;
  physics.slipAmount = physics.isSlipping ? Math.min(1, physics.shearMobilization) : physics.slipAmount * (1 - 4 * dt_clamped);

  const totalThrust = leftRes.thrust + rightRes.thrust;
  const totalResistance = leftRes.resistance + rightRes.resistance;
  const slopeForce = -Math.sin(vehicle.pitch) * mass.mass * 9.81 * 0.6;
  const dragForce = -physics.forwardVelocity * mass.mass * 0.6;

  const netLongForce = totalThrust - Math.sign(physics.forwardVelocity) * totalResistance + slopeForce + dragForce;
  const accel = netLongForce / Math.max(1, mass.mass * 60);
  physics.forwardVelocity += accel * dt_clamped;

  const vMaxChassis = 0.10;
  physics.forwardVelocity = Math.max(-vMaxChassis, Math.min(vMaxChassis, physics.forwardVelocity));

  const turnDiff = (drv.rightTrackVelocity - drv.leftTrackVelocity) / mass.trackWidth;
  const targetAngVel = turnDiff * 0.55;
  const angAccel = (targetAngVel - physics.angularVelocity) * 8;
  physics.angularVelocity += angAccel * dt_clamped;
  physics.angularVelocity *= (1 - 2.4 * dt_clamped);

  const yawKick = integrateRigidBody(physics.rigidBody, physics.forwardVelocity, dt_clamped);

  vehicle.heading += physics.angularVelocity * dt_clamped + yawKick;

  const ch = Math.cos(vehicle.heading);
  const sh = Math.sin(vehicle.heading);
  vehicle.posX += sh * physics.forwardVelocity * dt_clamped;
  vehicle.posZ += ch * physics.forwardVelocity * dt_clamped;

  vehicle.posX = Math.max(-0.7, Math.min(0.7, vehicle.posX));
  vehicle.posZ = Math.max(-0.7, Math.min(0.7, vehicle.posZ));

  physics.groundResistance = totalResistance / Math.max(1, mass.mass);
  physics.slopeResistance = Math.abs(slopeForce);

  // ── Track shoe travel + slack (for renderer) ──
  vehicle.tracks.leftSpeed = drv.leftTrackVelocity / maxTrackSpeed;
  vehicle.tracks.rightSpeed = drv.rightTrackVelocity / maxTrackSpeed;
  vehicle.tracks.leftTravel += drv.leftTrackVelocity * dt_clamped;
  vehicle.tracks.rightTravel += drv.rightTrackVelocity * dt_clamped;
  // Slack visualization: rises with slip mobilization
  const slackTarget = physics.isSlipping ? Math.min(1, physics.shearMobilization * 1.2) : 0;
  vehicle.tracks.slack += (slackTarget - vehicle.tracks.slack) * Math.min(1, 5 * dt_clamped);

  vehicle.speed = physics.forwardVelocity;
  vehicle.turnRate = physics.angularVelocity;
}
