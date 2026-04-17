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
  idleRpm: number;
  maxRpm: number;
  peakTorqueRpm: number;
  maxTorque: number;     // scaled Nm
  inertia: number;       // flywheel moment of inertia
}

export function createEngine(maxTorqueScaled: number, maxRpm: number = 2200, idleRpm: number = 750): EngineState {
  return {
    rpm: idleRpm,
    targetThrottle: 0,
    throttle: 0,
    torque: 0,
    fuelConsumption: 0,
    idleRpm,
    maxRpm,
    peakTorqueRpm: maxRpm * 0.55,
    maxTorque: maxTorqueScaled,
    inertia: 0.08,
  };
}

// Torque curve: bell shape peaking at peakTorqueRpm, dropping at high RPM
function engineTorqueCurve(engine: EngineState): number {
  const normRpm = engine.rpm / engine.maxRpm;
  const peakNorm = engine.peakTorqueRpm / engine.maxRpm;
  // Parabolic envelope
  const x = (normRpm - peakNorm) / 0.35;
  const envelope = Math.max(0, 1 - x * x);
  return engine.maxTorque * envelope * engine.throttle;
}

export function updateEngine(engine: EngineState, loadTorque: number, dt: number) {
  // Throttle response lag (diesel governor ~200ms)
  const throttleLag = 5.0; // 1/tau
  engine.throttle += (engine.targetThrottle - engine.throttle) * Math.min(1, throttleLag * dt);
  
  // Torque from curve
  engine.torque = engineTorqueCurve(engine);
  
  // RPM dynamics: flywheel inertia
  const netTorque = engine.torque - loadTorque * 0.3; // load feedback
  const rpmAccel = netTorque / engine.inertia;
  engine.rpm += rpmAccel * dt * 30; // scale to RPM
  
  // Governor: idle control and rev limiter
  if (engine.throttle < 0.05) {
    // Return to idle
    engine.rpm += (engine.idleRpm - engine.rpm) * Math.min(1, 3 * dt);
  }
  engine.rpm = Math.max(engine.idleRpm * 0.8, Math.min(engine.maxRpm * 1.02, engine.rpm));
  
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
}

export function createHydraulicSystem(): HydraulicSystem {
  return {
    pressure: 0,
    flowRate: 0,
    maxFlowRate: 1.0,
    pumpLoad: 0,
    demand: 0,
  };
}

export function updateHydraulicSystem(hyd: HydraulicSystem, engine: EngineState, demand: number, dt: number) {
  hyd.demand = demand;
  
  // Flow rate depends on engine RPM (pump is mechanically driven)
  const rpmFactor = Math.max(0, (engine.rpm - engine.idleRpm * 0.9)) / (engine.maxRpm - engine.idleRpm * 0.9);
  hyd.flowRate = hyd.maxFlowRate * rpmFactor;
  
  // Pressure builds with demand, limited by relief valve
  const targetPressure = Math.min(1, demand * 1.2);
  hyd.pressure += (targetPressure - hyd.pressure) * Math.min(1, 8 * dt);
  
  // Pump load on engine (proportional to pressure * flow)
  hyd.pumpLoad = hyd.pressure * hyd.flowRate * 0.4;
}

// Hydraulic actuator speed: limited by flow rate and pressure
export function hydraulicActuatorSpeed(
  hyd: HydraulicSystem,
  baseSpeed: number,
  loadFactor: number = 1.0,
): number {
  // Speed = flow available / load
  const available = hyd.flowRate * hyd.pressure;
  const effectiveSpeed = baseSpeed * Math.min(1, available / Math.max(0.1, loadFactor));
  return effectiveSpeed;
}

// ── Drivetrain ──────────────────────────────────────────────────────
export interface DrivetrainState {
  // Torque converter
  converterSlip: number;    // 0-1, how much the converter is slipping
  converterOutputTorque: number;
  
  // Final drive output per track
  leftDriveTorque: number;
  rightDriveTorque: number;
  leftBrake: number;        // 0-1 brake force
  rightBrake: number;
  
  // Track speeds (actual, not commanded)
  leftTrackVelocity: number;  // world units/s
  rightTrackVelocity: number;
  
  // Steering input (differential)
  steerInput: number;       // -1 to 1 (left to right)
  throttleInput: number;    // -1 to 1 (reverse to forward)
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
  mass: number;              // kg (scaled)
  momentOfInertia: number;   // yaw inertia
  trackWidth: number;        // center-to-center
  trackLength: number;       // contact patch length
  groundPressure: number;    // kPa equivalent (scaled)
  cg: [number, number, number]; // center of gravity offset
  rollingResistance: number; // coefficient
}

export function createExcavatorMass(): MassProperties {
  return {
    mass: 20,               // 20-ton class, scaled
    momentOfInertia: 2.5,
    trackWidth: 0.10,
    trackLength: 0.16,
    groundPressure: 0.45,   // ~45 kPa
    cg: [0, 0.03, 0],
    rollingResistance: 0.06,
  };
}

export function createBulldozerMass(): MassProperties {
  return {
    mass: 22,               // D6 class
    momentOfInertia: 3.2,
    trackWidth: 0.13,
    trackLength: 0.20,
    groundPressure: 0.38,   // wider tracks = lower pressure
    cg: [0, 0.025, -0.01],  // slightly rear-biased
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

  // Per-track shear-deformation memory (Janosi)
  leftShearJ: number;
  rightShearJ: number;
  // Latest per-track terramechanics readouts (for HUD / debug)
  leftSinkage: number;
  rightSinkage: number;
  shearMobilization: number;

  // Derived motion state
  forwardVelocity: number;   // world units/s
  angularVelocity: number;   // rad/s (yaw)

  // Ground interaction
  groundResistance: number;  // 0-1 current rolling resistance factor
  slopeResistance: number;   // additional from grade
  isSlipping: boolean;
  slipAmount: number;        // 0-1
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
  leftInput: number,  // -1 to 1
  rightInput: number, // -1 to 1
  hydraulicDemand: number, // 0-1
  terrainSoftness: number, // 0-1 from soil properties
  dt: number,
  terramech?: SoilTerramechParams,
) {
  const dt_clamped = Math.min(dt, 0.033);
  const drv = physics.drivetrain;
  const eng = physics.engine;
  const mass = physics.mass;

  // ── Interpret track inputs ──
  const avgInput = (leftInput + rightInput) * 0.5;
  const steerDiff = rightInput - leftInput;

  drv.throttleInput = avgInput;
  drv.steerInput = steerDiff;

  // Engine throttle from track demand
  const demandMagnitude = Math.max(Math.abs(leftInput), Math.abs(rightInput));
  eng.targetThrottle = Math.min(1, demandMagnitude + hydraulicDemand * 0.4);

  // ── Engine update ──
  const totalLoad = Math.abs(physics.forwardVelocity) * mass.mass * 10 + physics.hydraulics.pumpLoad;
  updateEngine(eng, totalLoad, dt_clamped);

  // ── Hydraulic system ──
  updateHydraulicSystem(physics.hydraulics, eng, hydraulicDemand, dt_clamped);

  // ── Torque converter ──
  const speedRatio = Math.min(1, Math.abs(physics.forwardVelocity) * 40);
  drv.converterSlip = Math.max(0.05, 1 - speedRatio * 0.85);
  const torqueMultiplier = 1 + (1 - speedRatio) * 1.5;
  drv.converterOutputTorque = eng.torque * torqueMultiplier * (1 - drv.converterSlip * 0.3);

  // ── Differential steering ──
  const baseTorque = drv.converterOutputTorque;
  const steerFactor = drv.steerInput * 0.5;
  drv.leftDriveTorque = baseTorque * (avgInput - steerFactor) * 0.5;
  drv.rightDriveTorque = baseTorque * (avgInput + steerFactor) * 0.5;

  // Braking
  drv.leftBrake = 0;
  drv.rightBrake = 0;
  if (leftInput * drv.leftTrackVelocity < -0.001) drv.leftBrake = 0.7;
  if (rightInput * drv.rightTrackVelocity < -0.001) drv.rightBrake = 0.7;
  if (Math.abs(leftInput) < 0.05) drv.leftBrake = 0.3;
  if (Math.abs(rightInput) < 0.05) drv.rightBrake = 0.3;

  // ── Commanded track velocities (drivetrain output, before ground) ──
  const maxTrackSpeed = 0.12;
  // Drive command in world u/s — simple gear ratio
  const driveGain = 0.0009;
  const cmdLeftV = drv.leftDriveTorque * driveGain - drv.leftBrake * Math.sign(drv.leftTrackVelocity) * 0.04;
  const cmdRightV = drv.rightDriveTorque * driveGain - drv.rightBrake * Math.sign(drv.rightTrackVelocity) * 0.04;

  // Ramp commanded velocities into "what the sprocket wants"
  drv.leftTrackVelocity += (cmdLeftV - drv.leftTrackVelocity) * Math.min(1, 6 * dt_clamped);
  drv.rightTrackVelocity += (cmdRightV - drv.rightTrackVelocity) * Math.min(1, 6 * dt_clamped);
  drv.leftTrackVelocity = Math.max(-maxTrackSpeed, Math.min(maxTrackSpeed, drv.leftTrackVelocity));
  drv.rightTrackVelocity = Math.max(-maxTrackSpeed, Math.min(maxTrackSpeed, drv.rightTrackVelocity));

  // ── Bekker-Wong terramechanics per track ──
  // Fall back to derived params if none supplied
  const params = terramech ?? getTerramechParams(30 * DEG, 0.3, terrainSoftness);

  // Per-track normal load = half vehicle weight (+ small weight transfer from pitch)
  const pitchTransfer = Math.sin(physics.rigidBody.pitchAccum) * mass.mass * 0.15;
  const halfWeight = mass.mass * 9.81 * 0.5; // gravity in scaled "kN"-ish
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

  // ── Chassis longitudinal dynamics ──
  // Net thrust from both tracks minus motion resistance and slope
  const totalThrust = leftRes.thrust + rightRes.thrust;
  const totalResistance = leftRes.resistance + rightRes.resistance;
  const slopeForce = -Math.sin(vehicle.pitch) * mass.mass * 9.81 * 0.6;
  const dragForce = -physics.forwardVelocity * mass.mass * 0.6; // viscous + air

  const netLongForce = totalThrust - Math.sign(physics.forwardVelocity) * totalResistance + slopeForce + dragForce;
  const accel = netLongForce / Math.max(1, mass.mass * 60);
  physics.forwardVelocity += accel * dt_clamped;

  // Hard speed cap
  const vMaxChassis = 0.10;
  physics.forwardVelocity = Math.max(-vMaxChassis, Math.min(vMaxChassis, physics.forwardVelocity));

  // ── Yaw from track differential ──
  const turnDiff = (drv.rightTrackVelocity - drv.leftTrackVelocity) / mass.trackWidth;
  const targetAngVel = turnDiff * 0.55;
  const angAccel = (targetAngVel - physics.angularVelocity) * 8;
  physics.angularVelocity += angAccel * dt_clamped;
  physics.angularVelocity *= (1 - 2.4 * dt_clamped);

  // ── Rigid body integration (pitch/roll/yaw kick) ──
  const yawKick = integrateRigidBody(physics.rigidBody, physics.forwardVelocity, dt_clamped);

  // ── Apply to vehicle state ──
  vehicle.heading += physics.angularVelocity * dt_clamped + yawKick;

  const ch = Math.cos(vehicle.heading);
  const sh = Math.sin(vehicle.heading);
  vehicle.posX += sh * physics.forwardVelocity * dt_clamped;
  vehicle.posZ += ch * physics.forwardVelocity * dt_clamped;

  // World bounds
  vehicle.posX = Math.max(-0.7, Math.min(0.7, vehicle.posX));
  vehicle.posZ = Math.max(-0.7, Math.min(0.7, vehicle.posZ));

  // Bookkeeping
  physics.groundResistance = totalResistance / Math.max(1, mass.mass);
  physics.slopeResistance = Math.abs(slopeForce);

  vehicle.tracks.leftSpeed = drv.leftTrackVelocity / maxTrackSpeed;
  vehicle.tracks.rightSpeed = drv.rightTrackVelocity / maxTrackSpeed;
  vehicle.speed = physics.forwardVelocity;
  vehicle.turnRate = physics.angularVelocity;
}
