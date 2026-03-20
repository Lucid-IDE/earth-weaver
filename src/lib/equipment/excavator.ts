// ── Excavator Model & Physics ────────────────────────────────────────
// Articulated hydraulic excavator with boom/stick/bucket + cab swing
// Forward kinematics computes bucket tip position for SDF interaction
// Also provides local-space FK for renderer (avoids double-transform issues)

import { ExcavatorState, DEG } from './types';

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
      speed: 0.8, length: 0.22, label: 'Boom',
    },
    stick: {
      angle: -52 * DEG, minAngle: -135 * DEG, maxAngle: 35 * DEG,
      speed: 1.0, length: 0.16, label: 'Stick',
    },
    bucket: {
      angle: -35 * DEG, minAngle: -145 * DEG, maxAngle: 55 * DEG,
      speed: 1.5, length: 0.07, label: 'Bucket',
    },
    bucketFill: 0,
    hydraulicPressure: 0,
  };
}

// Clamp joint angle within limits
function clampJoint(joint: { angle: number; minAngle: number; maxAngle: number }) {
  joint.angle = Math.max(joint.minAngle, Math.min(joint.maxAngle, joint.angle));
}

// Update excavator state from control inputs
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
  }
) {
  // Update joints
  state.swing.angle += inputs.swingInput * state.swing.speed * dt;
  state.boom.angle += inputs.boomInput * state.boom.speed * dt;
  state.stick.angle += inputs.stickInput * state.stick.speed * dt;
  state.bucket.angle += inputs.bucketInput * state.bucket.speed * dt;
  
  clampJoint(state.swing);
  clampJoint(state.boom);
  clampJoint(state.stick);
  clampJoint(state.bucket);
  
  // Hydraulic pressure visual
  const armActivity = Math.abs(inputs.boomInput) + Math.abs(inputs.stickInput) + Math.abs(inputs.bucketInput);
  state.hydraulicPressure += (Math.min(1, armActivity) - state.hydraulicPressure) * 5 * dt;
  
  // Track drive
  state.vehicle.tracks.leftSpeed = inputs.leftTrack;
  state.vehicle.tracks.rightSpeed = inputs.rightTrack;
  
  const trackWidth = 0.12;
  const forward = (inputs.leftTrack + inputs.rightTrack) * 0.5;
  const turn = (inputs.rightTrack - inputs.leftTrack) / trackWidth;
  
  state.vehicle.speed = forward * 0.15 * dt;
  state.vehicle.turnRate = turn * 0.8 * dt;
  
  state.vehicle.heading += state.vehicle.turnRate;
  state.vehicle.posX += Math.sin(state.vehicle.heading) * state.vehicle.speed;
  state.vehicle.posZ += Math.cos(state.vehicle.heading) * state.vehicle.speed;
  
  // Clamp to world bounds
  state.vehicle.posX = Math.max(-0.7, Math.min(0.7, state.vehicle.posX));
  state.vehicle.posZ = Math.max(-0.7, Math.min(0.7, state.vehicle.posZ));
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
  
  const cabHeight = 0.06;
  const cabBase: [number, number, number] = [v.posX, v.posY + cabHeight, v.posZ];
  
  // Combined heading + swing for arm direction
  const armHeading = v.heading + state.swing.angle;
  const cah = Math.cos(armHeading);
  const sah = Math.sin(armHeading);
  
  // Boom pivot at front of cab
  const pivotOffset = 0.04;
  const boomPivot: [number, number, number] = [
    cabBase[0] + sah * pivotOffset,
    cabBase[1] + 0.03,
    cabBase[2] + cah * pivotOffset,
  ];
  
  // Boom end (rotates in vertical plane along armHeading)
  const boomHoriz = Math.cos(state.boom.angle) * state.boom.length;
  const boomVert = Math.sin(state.boom.angle) * state.boom.length;
  const boomEnd: [number, number, number] = [
    boomPivot[0] + sah * boomHoriz,
    boomPivot[1] + boomVert,
    boomPivot[2] + cah * boomHoriz,
  ];
  
  // Stick end
  const stickAbsAngle = state.boom.angle + state.stick.angle;
  const stickHoriz = Math.cos(stickAbsAngle) * state.stick.length;
  const stickVert = Math.sin(stickAbsAngle) * state.stick.length;
  const stickEnd: [number, number, number] = [
    boomEnd[0] + sah * stickHoriz,
    boomEnd[1] + stickVert,
    boomEnd[2] + cah * stickHoriz,
  ];
  
  // Bucket tip
  const bucketAbsAngle = stickAbsAngle + state.bucket.angle;
  const bucketHoriz = Math.cos(bucketAbsAngle) * state.bucket.length;
  const bucketVert = Math.sin(bucketAbsAngle) * state.bucket.length;
  const bucketTip: [number, number, number] = [
    stickEnd[0] + sah * bucketHoriz,
    stickEnd[1] + bucketVert,
    stickEnd[2] + cah * bucketHoriz,
  ];
  
  // Bucket teeth: forward from tip, spread laterally
  const bucketDirHoriz = Math.cos(bucketAbsAngle);
  const bucketDirX = sah * bucketDirHoriz;
  const bucketDirY = Math.sin(bucketAbsAngle);
  const bucketDirZ = cah * bucketDirHoriz;
  const dirLen = Math.sqrt(bucketDirX * bucketDirX + bucketDirY * bucketDirY + bucketDirZ * bucketDirZ) || 1;
  const ndx = bucketDirX / dirLen;
  const ndy = bucketDirY / dirLen;
  const ndz = bucketDirZ / dirLen;
  const sideX = cah;
  const sideZ = -sah;
  const teethSpread = 0.015;
  const teethForward = 0.012;
  const teethDrop = 0.004;
  const bucketTeeth: [number, number, number][] = [
    [
      bucketTip[0] + ndx * teethForward - sideX * teethSpread,
      bucketTip[1] + ndy * teethForward - teethDrop,
      bucketTip[2] + ndz * teethForward + sideZ * teethSpread,
    ],
    [
      bucketTip[0] + ndx * teethForward,
      bucketTip[1] + ndy * teethForward - teethDrop,
      bucketTip[2] + ndz * teethForward,
    ],
    [
      bucketTip[0] + ndx * teethForward + sideX * teethSpread,
      bucketTip[1] + ndy * teethForward - teethDrop,
      bucketTip[2] + ndz * teethForward - sideZ * teethSpread,
    ],
  ];
  
  return { cabBase, boomPivot, boomEnd, stickEnd, bucketTip, bucketTeeth };
}

// ── Local-space FK (for renderer) ───────────────────────────────────
// Returns positions in the coordinate system of the swing group
// (i.e., already inside <group pos={vehicle} rot={heading}> <group rot={swing}>)
// In this space: +Z = forward (arm direction), +Y = up, origin = vehicle base
export interface ExcavatorLocalFK {
  boomPivot: [number, number, number];
  boomEnd: [number, number, number];
  stickEnd: [number, number, number];
  bucketTip: [number, number, number];
  // Hydraulic attachment points
  boomCylBase: [number, number, number];
  boomCylEnd: [number, number, number];
  stickCylBase: [number, number, number];
  stickCylEnd: [number, number, number];
  bucketLinkBase: [number, number, number];
  bucketLinkEnd: [number, number, number];
}

export function computeExcavatorLocalFK(state: ExcavatorState): ExcavatorLocalFK {
  // In swing-local space, the arm extends along +Z (forward from cab)
  const cabHeight = 0.06;
  const pivotOffset = 0.045;
  
  // Boom pivot: front of cab, raised
  const boomPivot: [number, number, number] = [0, cabHeight + 0.028, pivotOffset];
  
  // Boom extends in the YZ plane (Z = forward, Y = up) at boom.angle
  // boom.angle: 0 = horizontal forward, positive = up, negative = down
  const boomHoriz = Math.cos(state.boom.angle) * state.boom.length;
  const boomVert = Math.sin(state.boom.angle) * state.boom.length;
  const boomEnd: [number, number, number] = [
    boomPivot[0],
    boomPivot[1] + boomVert,
    boomPivot[2] + boomHoriz,
  ];
  
  // Stick
  const stickAbsAngle = state.boom.angle + state.stick.angle;
  const stickHoriz = Math.cos(stickAbsAngle) * state.stick.length;
  const stickVert = Math.sin(stickAbsAngle) * state.stick.length;
  const stickEnd: [number, number, number] = [
    boomEnd[0],
    boomEnd[1] + stickVert,
    boomEnd[2] + stickHoriz,
  ];
  
  // Bucket tip
  const bucketAbsAngle = stickAbsAngle + state.bucket.angle;
  const bucketHoriz = Math.cos(bucketAbsAngle) * state.bucket.length;
  const bucketVert = Math.sin(bucketAbsAngle) * state.bucket.length;
  const bucketTip: [number, number, number] = [
    stickEnd[0],
    stickEnd[1] + bucketVert,
    stickEnd[2] + bucketHoriz,
  ];
  
  // Hydraulic cylinder attachment points (realistic locations):
  
  // Boom cylinder: base at cab body, end partway up boom
  const boomCylBase: [number, number, number] = [0.018, cabHeight + 0.012, 0.018];
  const boomMidFrac = 0.32;
  const boomCylEnd: [number, number, number] = [
    0.015,
    boomPivot[1] + boomVert * boomMidFrac,
    boomPivot[2] + boomHoriz * boomMidFrac,
  ];
  
  // Stick cylinder: base at mid-boom, end at stick pivot area
  const stickCylBase: [number, number, number] = [
    -0.014,
    boomPivot[1] + boomVert * 0.7,
    boomPivot[2] + boomHoriz * 0.7,
  ];
  const stickCylEnd: [number, number, number] = [
    -0.014,
    boomEnd[1] + stickVert * 0.22,
    boomEnd[2] + stickHoriz * 0.22,
  ];
  
  // Bucket linkage: runs from mid-stick to bucket pivot
  const bucketLinkBase: [number, number, number] = [
    0.011,
    boomEnd[1] + stickVert * 0.75,
    boomEnd[2] + stickHoriz * 0.75,
  ];
  const bucketLinkEnd: [number, number, number] = [
    0.011,
    stickEnd[1] + bucketVert * 0.46,
    stickEnd[2] + bucketHoriz * 0.46,
  ];
  
  return {
    boomPivot, boomEnd, stickEnd, bucketTip,
    boomCylBase, boomCylEnd,
    stickCylBase, stickCylEnd,
    bucketLinkBase, bucketLinkEnd,
  };
}
