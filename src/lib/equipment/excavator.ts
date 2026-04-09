// ── Excavator Model & Physics ────────────────────────────────────────
// Articulated hydraulic excavator with boom/stick/bucket + cab swing
// Forward kinematics computes bucket tip position for SDF interaction
// Also provides local-space FK for renderer (avoids double-transform issues)
//
// Proportions reference: CAT 320 / Komatsu PC200 class (20-ton)
// Scaled to world units where 1.0 ≈ 2m

import { ExcavatorState, DEG } from './types';
import { hydraulicActuatorSpeed, HydraulicSystem } from './vehiclePhysics';

// ── Realistic joint limits (based on real excavator specs) ──────────
const BOOM_LENGTH = 0.22;   // ~4.4m real
const STICK_LENGTH = 0.16;  // ~3.2m real
const BUCKET_LENGTH = 0.07; // ~1.4m real (to teeth tip)
const CAB_HEIGHT = 0.06;    // ~1.2m cab pivot height above tracks
const PIVOT_OFFSET = 0.045; // boom pivot forward of cab center

export function createExcavatorState(): ExcavatorState {
  return {
    vehicle: {
      posX: 0.3, posY: 0, posZ: 0.3,
      heading: -Math.PI / 4,
      pitch: 0,
      contactSink: 0,
      groundClearance: 0,
      tracks: { leftSpeed: 0, rightSpeed: 0 },
      speed: 0,
      turnRate: 0,
    },
    swing: {
      angle: 0, minAngle: -180 * DEG, maxAngle: 180 * DEG,
      speed: 1.2, length: 0, label: 'Swing',
    },
    boom: {
      angle: -18 * DEG, minAngle: -65 * DEG, maxAngle: 72 * DEG,
      speed: 0.8, length: BOOM_LENGTH, label: 'Boom',
    },
    stick: {
      angle: -52 * DEG, minAngle: -135 * DEG, maxAngle: 35 * DEG,
      speed: 1.0, length: STICK_LENGTH, label: 'Stick',
    },
    bucket: {
      angle: -35 * DEG, minAngle: -145 * DEG, maxAngle: 55 * DEG,
      speed: 1.5, length: BUCKET_LENGTH, label: 'Bucket',
    },
    bucketFill: 0,
    hydraulicPressure: 0,
  };
}

function clampJoint(joint: { angle: number; minAngle: number; maxAngle: number }) {
  joint.angle = Math.max(joint.minAngle, Math.min(joint.maxAngle, joint.angle));
}

// Compute load factor for a joint based on arm geometry and bucket fill
function computeArmLoad(state: ExcavatorState, joint: string): number {
  const armWeight = 0.3; // base arm weight factor
  const bucketLoad = 0.2 + state.bucketFill * 0.8; // heavier when loaded
  
  switch (joint) {
    case 'boom':
      // Boom bears the weight of stick + bucket + load
      // Heavier when arm is extended horizontally
      return armWeight + bucketLoad + Math.abs(Math.cos(state.boom.angle)) * 0.3;
    case 'stick':
      return armWeight * 0.6 + bucketLoad;
    case 'bucket':
      return bucketLoad * 0.5;
    case 'swing':
      // Swing inertia increases with arm extension
      return 0.2 + Math.abs(Math.cos(state.boom.angle)) * 0.3;
    default:
      return 0.5;
  }
}

/**
 * Update excavator joints using hydraulic system for realistic speed limiting.
 * When hydraulics is null, falls back to base speed (for backward compat).
 */
export function updateExcavator(
  state: ExcavatorState,
  dt: number,
  inputs: {
    swingInput: number;
    boomInput: number;
    stickInput: number;
    bucketInput: number;
    leftTrack: number;
    rightTrack: number;
  },
  hydraulics?: HydraulicSystem | null,
) {
  // Update joints with hydraulic-limited speeds
  if (hydraulics) {
    const swingLoad = computeArmLoad(state, 'swing');
    const boomLoad = computeArmLoad(state, 'boom');
    const stickLoad = computeArmLoad(state, 'stick');
    const bucketLoad = computeArmLoad(state, 'bucket');
    
    // Boom down is gravity-assisted (faster), boom up fights gravity
    const boomGravityFactor = inputs.boomInput > 0 ? 1.0 : 1.4; // down is easier
    
    state.swing.angle += inputs.swingInput * hydraulicActuatorSpeed(hydraulics, state.swing.speed, swingLoad) * dt;
    state.boom.angle += inputs.boomInput * hydraulicActuatorSpeed(hydraulics, state.boom.speed, boomLoad) * boomGravityFactor * dt;
    state.stick.angle += inputs.stickInput * hydraulicActuatorSpeed(hydraulics, state.stick.speed, stickLoad) * dt;
    state.bucket.angle += inputs.bucketInput * hydraulicActuatorSpeed(hydraulics, state.bucket.speed, bucketLoad) * dt;
  } else {
    // Legacy direct mode
    state.swing.angle += inputs.swingInput * state.swing.speed * dt;
    state.boom.angle += inputs.boomInput * state.boom.speed * dt;
    state.stick.angle += inputs.stickInput * state.stick.speed * dt;
    state.bucket.angle += inputs.bucketInput * state.bucket.speed * dt;
  }

  clampJoint(state.swing);
  clampJoint(state.boom);
  clampJoint(state.stick);
  clampJoint(state.bucket);

  // Hydraulic pressure visual
  const armActivity = Math.abs(inputs.boomInput) + Math.abs(inputs.stickInput) + Math.abs(inputs.bucketInput);
  state.hydraulicPressure += (Math.min(1, armActivity) - state.hydraulicPressure) * 5 * dt;

  // NOTE: Track drive is now handled by vehiclePhysics.updateVehiclePhysics()
  // We still store track speeds for the renderer but don't compute position here
  state.vehicle.tracks.leftSpeed = inputs.leftTrack;
  state.vehicle.tracks.rightSpeed = inputs.rightTrack;
}

// ── World-space FK (for terrain interaction) ────────────────────────
export interface ExcavatorFK {
  cabBase: [number, number, number];
  boomPivot: [number, number, number];
  boomEnd: [number, number, number];
  stickEnd: [number, number, number];
  bucketTip: [number, number, number];
  bucketTeeth: [number, number, number][];
}

export function computeExcavatorFK(state: ExcavatorState): ExcavatorFK {
  const v = state.vehicle;

  const cabBase: [number, number, number] = [v.posX, v.posY + CAB_HEIGHT, v.posZ];

  const armHeading = v.heading + state.swing.angle;
  const cah = Math.cos(armHeading);
  const sah = Math.sin(armHeading);

  const boomPivot: [number, number, number] = [
    cabBase[0] + sah * PIVOT_OFFSET,
    cabBase[1] + 0.03,
    cabBase[2] + cah * PIVOT_OFFSET,
  ];

  const boomHoriz = Math.cos(state.boom.angle) * BOOM_LENGTH;
  const boomVert = Math.sin(state.boom.angle) * BOOM_LENGTH;
  const boomEnd: [number, number, number] = [
    boomPivot[0] + sah * boomHoriz,
    boomPivot[1] + boomVert,
    boomPivot[2] + cah * boomHoriz,
  ];

  const stickAbsAngle = state.boom.angle + state.stick.angle;
  const stickHoriz = Math.cos(stickAbsAngle) * STICK_LENGTH;
  const stickVert = Math.sin(stickAbsAngle) * STICK_LENGTH;
  const stickEnd: [number, number, number] = [
    boomEnd[0] + sah * stickHoriz,
    boomEnd[1] + stickVert,
    boomEnd[2] + cah * stickHoriz,
  ];

  const bucketAbsAngle = stickAbsAngle + state.bucket.angle;
  const bucketHoriz = Math.cos(bucketAbsAngle) * BUCKET_LENGTH;
  const bucketVert = Math.sin(bucketAbsAngle) * BUCKET_LENGTH;
  const bucketTip: [number, number, number] = [
    stickEnd[0] + sah * bucketHoriz,
    stickEnd[1] + bucketVert,
    stickEnd[2] + cah * bucketHoriz,
  ];

  // Bucket teeth
  const bucketDirHoriz = Math.cos(bucketAbsAngle);
  const ndx = sah * bucketDirHoriz;
  const ndy = Math.sin(bucketAbsAngle);
  const ndz = cah * bucketDirHoriz;
  const dirLen = Math.sqrt(ndx * ndx + ndy * ndy + ndz * ndz) || 1;
  const sideX = cah;
  const sideZ = -sah;
  const teethSpread = 0.015;
  const teethForward = 0.012;
  const teethDrop = 0.004;
  const bucketTeeth: [number, number, number][] = [
    [
      bucketTip[0] + (ndx / dirLen) * teethForward - sideX * teethSpread,
      bucketTip[1] + (ndy / dirLen) * teethForward - teethDrop,
      bucketTip[2] + (ndz / dirLen) * teethForward + sideZ * teethSpread,
    ],
    [
      bucketTip[0] + (ndx / dirLen) * teethForward,
      bucketTip[1] + (ndy / dirLen) * teethForward - teethDrop,
      bucketTip[2] + (ndz / dirLen) * teethForward,
    ],
    [
      bucketTip[0] + (ndx / dirLen) * teethForward + sideX * teethSpread,
      bucketTip[1] + (ndy / dirLen) * teethForward - teethDrop,
      bucketTip[2] + (ndz / dirLen) * teethForward - sideZ * teethSpread,
    ],
  ];

  return { cabBase, boomPivot, boomEnd, stickEnd, bucketTip, bucketTeeth };
}

// ── Local-space FK (for renderer) ───────────────────────────────────
export interface ExcavatorLocalFK {
  boomPivot: [number, number, number];
  boomEnd: [number, number, number];
  stickEnd: [number, number, number];
  bucketTip: [number, number, number];
  boomCylBase: [number, number, number];
  boomCylEnd: [number, number, number];
  stickCylBase: [number, number, number];
  stickCylEnd: [number, number, number];
  bucketLinkBase: [number, number, number];
  bucketLinkEnd: [number, number, number];
}

export function computeExcavatorLocalFK(state: ExcavatorState): ExcavatorLocalFK {
  const boomPivot: [number, number, number] = [0, CAB_HEIGHT + 0.028, PIVOT_OFFSET];

  const boomHoriz = Math.cos(state.boom.angle) * BOOM_LENGTH;
  const boomVert = Math.sin(state.boom.angle) * BOOM_LENGTH;
  const boomEnd: [number, number, number] = [0, boomPivot[1] + boomVert, boomPivot[2] + boomHoriz];

  const stickAbs = state.boom.angle + state.stick.angle;
  const stickHoriz = Math.cos(stickAbs) * STICK_LENGTH;
  const stickVert = Math.sin(stickAbs) * STICK_LENGTH;
  const stickEnd: [number, number, number] = [0, boomEnd[1] + stickVert, boomEnd[2] + stickHoriz];

  const bucketAbs = stickAbs + state.bucket.angle;
  const bucketHoriz = Math.cos(bucketAbs) * BUCKET_LENGTH;
  const bucketVert = Math.sin(bucketAbs) * BUCKET_LENGTH;
  const bucketTip: [number, number, number] = [0, stickEnd[1] + bucketVert, stickEnd[2] + bucketHoriz];

  // Hydraulic attachment points
  const boomCylBase: [number, number, number] = [0, CAB_HEIGHT + 0.01, PIVOT_OFFSET - 0.01];
  const boomFrac = 0.30;
  const boomCylEnd: [number, number, number] = [
    0, boomPivot[1] + boomVert * boomFrac - 0.008, boomPivot[2] + boomHoriz * boomFrac,
  ];

  const stickCylBase: [number, number, number] = [
    0, boomPivot[1] + boomVert * 0.6 + 0.01, boomPivot[2] + boomHoriz * 0.6,
  ];
  const stickCylEnd: [number, number, number] = [
    0, boomEnd[1] + stickVert * 0.15, boomEnd[2] + stickHoriz * 0.15,
  ];

  const bucketLinkBase: [number, number, number] = [
    0, boomEnd[1] + stickVert * 0.7 + 0.008, boomEnd[2] + stickHoriz * 0.7,
  ];
  const bucketLinkEnd: [number, number, number] = [
    0, stickEnd[1] + bucketVert * 0.4, stickEnd[2] + bucketHoriz * 0.4,
  ];

  return {
    boomPivot, boomEnd, stickEnd, bucketTip,
    boomCylBase, boomCylEnd,
    stickCylBase, stickCylEnd,
    bucketLinkBase, bucketLinkEnd,
  };
}
