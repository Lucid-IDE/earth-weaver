// ── Bulldozer Model & Physics ────────────────────────────────────────
// Tracked vehicle with adjustable blade height/tilt/angle + rear rippers.
// Blade actuators are modeled as discrete hydraulic cylinders.

import { BulldozerState, BulldozerCylinders, DEG } from './types';
import { HydraulicSystem } from './vehiclePhysics';
import { createCylinder, stepCylinder } from './hydraulicCylinder';

const BLADE_LIFT_MOMENT = 0.05;   // m of cylinder travel per m of blade rise
const BLADE_TILT_MOMENT = 0.04;
const BLADE_ANGLE_MOMENT = 0.08;
const RIPPER_MOMENT = 0.05;

function makeCylinders(): BulldozerCylinders {
  return {
    bladeLift: createCylinder({ boreArea: 0.016, rodArea: 0.004, maxStroke: 0.6, reliefPressure: 320 }),
    bladeTilt: createCylinder({ boreArea: 0.008, rodArea: 0.0022, maxStroke: 0.3, reliefPressure: 320 }),
    bladeAngle: createCylinder({ boreArea: 0.009, rodArea: 0.0025, maxStroke: 0.35, reliefPressure: 320 }),
    ripper: createCylinder({ boreArea: 0.012, rodArea: 0.003, maxStroke: 0.4, reliefPressure: 320 }),
  };
}

export function createBulldozerState(): BulldozerState {
  return {
    vehicle: {
      posX: -0.3, posY: 0, posZ: 0.3,
      heading: Math.PI / 4,
      pitch: 0,
      contactSink: 0,
      groundClearance: 0,
      tracks: { leftSpeed: 0, rightSpeed: 0, leftTravel: 0, rightTravel: 0, slack: 0 },
      speed: 0,
      turnRate: 0,
    },
    bladeHeight: 0.0,
    bladeTilt: 0,
    bladeAngle: 0,
    bladeWidth: 0.16,
    bladeMinHeight: -0.12,
    bladeMaxHeight: 0.06,
    rippersDown: false,
    hydraulicPressure: 0,
    cylinders: makeCylinders(),
  };
}

/**
 * Compute load opposing each blade actuator.
 *  bladeLift load grows when blade is below ground (digging soil).
 */
function bladeLiftLoad(state: BulldozerState, cmd: number): number {
  const buried = Math.max(0, -state.bladeHeight) * 4; // 0..0.4ish
  const base = 12 + buried * 90;
  // Lifting up (cmd > 0) fights gravity + lifts soil; lowering is mostly gravity
  return cmd > 0 ? base : base * 0.4;
}

/**
 * Update bulldozer blade/ripper using hydraulic cylinders.
 */
export function updateBulldozer(
  state: BulldozerState,
  dt: number,
  inputs: {
    leftTrack: number;
    rightTrack: number;
    bladeUp: number;
    bladeTiltInput: number;
    bladeAngleInput: number;
    toggleRippers: boolean;
  },
  hydraulics?: HydraulicSystem | null,
) {
  state.vehicle.tracks.leftSpeed = inputs.leftTrack;
  state.vehicle.tracks.rightSpeed = inputs.rightTrack;

  if (hydraulics) {
    // Blade lift: cylinder velocity directly drives blade height (1:1 scale)
    stepCylinder(
      state.cylinders.bladeLift,
      inputs.bladeUp,
      bladeLiftLoad(state, inputs.bladeUp),
      hydraulics.pressure, hydraulics.flowRate, dt,
    );
    state.bladeHeight += state.cylinders.bladeLift.velocity * dt * 0.15;

    // Tilt
    stepCylinder(
      state.cylinders.bladeTilt, inputs.bladeTiltInput, 6,
      hydraulics.pressure, hydraulics.flowRate, dt,
    );
    state.bladeTilt += (state.cylinders.bladeTilt.velocity / BLADE_TILT_MOMENT) * dt * (20 * DEG / 0.3);

    // Angle
    stepCylinder(
      state.cylinders.bladeAngle, inputs.bladeAngleInput, 5,
      hydraulics.pressure, hydraulics.flowRate, dt,
    );
    state.bladeAngle += (state.cylinders.bladeAngle.velocity / BLADE_ANGLE_MOMENT) * dt * (25 * DEG / 0.35);
  } else {
    state.bladeHeight += inputs.bladeUp * 0.15 * dt;
    state.bladeTilt += inputs.bladeTiltInput * 20 * DEG * dt;
    state.bladeAngle += inputs.bladeAngleInput * 25 * DEG * dt;
  }

  state.bladeHeight = Math.max(state.bladeMinHeight, Math.min(state.bladeMaxHeight, state.bladeHeight));
  state.bladeTilt = Math.max(-15 * DEG, Math.min(15 * DEG, state.bladeTilt));
  state.bladeAngle = Math.max(-20 * DEG, Math.min(20 * DEG, state.bladeAngle));

  if (inputs.toggleRippers) {
    state.rippersDown = !state.rippersDown;
  }

  // Aggregate hydraulic pressure visual
  const cyls = state.cylinders;
  const peak = Math.max(
    cyls.bladeLift.pressure / cyls.bladeLift.spec.reliefPressure,
    cyls.bladeTilt.pressure / cyls.bladeTilt.spec.reliefPressure,
    cyls.bladeAngle.pressure / cyls.bladeAngle.spec.reliefPressure,
  );
  state.hydraulicPressure += (peak - state.hydraulicPressure) * Math.min(1, 8 * dt);
}

// Compute blade edge points in world space for SDF interaction
export interface BladeGeometry {
  center: [number, number, number];
  left: [number, number, number];
  right: [number, number, number];
  bladeNormal: [number, number, number];
  samplePoints: [number, number, number][];
}

export function computeBladeGeometry(state: BulldozerState): BladeGeometry {
  const v = state.vehicle;
  const ch = Math.cos(v.heading);
  const sh = Math.sin(v.heading);

  const bladeOffset = 0.09;
  const bladeY = v.posY + state.bladeHeight;

  const center: [number, number, number] = [
    v.posX + sh * bladeOffset,
    bladeY,
    v.posZ + ch * bladeOffset,
  ];

  const bladeHeading = v.heading + state.bladeAngle;
  const cbh = Math.cos(bladeHeading);
  const sbh = Math.sin(bladeHeading);
  const halfWidth = state.bladeWidth / 2;

  const tiltDelta = Math.sin(state.bladeTilt) * halfWidth;

  const left: [number, number, number] = [
    center[0] + cbh * halfWidth,
    center[1] - tiltDelta,
    center[2] - sbh * halfWidth,
  ];

  const right: [number, number, number] = [
    center[0] - cbh * halfWidth,
    center[1] + tiltDelta,
    center[2] + sbh * halfWidth,
  ];

  const bladeNormal: [number, number, number] = [sh, 0, ch];

  const numSamples = 7;
  const samplePoints: [number, number, number][] = [];
  for (let i = 0; i < numSamples; i++) {
    const t = i / (numSamples - 1);
    samplePoints.push([
      left[0] + (right[0] - left[0]) * t,
      left[1] + (right[1] - left[1]) * t,
      left[2] + (right[2] - left[2]) * t,
    ]);
  }

  return { center, left, right, bladeNormal, samplePoints };
}
