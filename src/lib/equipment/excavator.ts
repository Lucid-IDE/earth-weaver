// ── Excavator Model & Physics ────────────────────────────────────────
// Articulated hydraulic excavator with boom/stick/bucket + cab swing
// Forward kinematics computes bucket tip position for SDF interaction

import { ExcavatorState, DEG } from './types';

export function createExcavatorState(): ExcavatorState {
  return {
    vehicle: {
      posX: 0.3, posY: 0, posZ: 0.3,
      heading: -Math.PI / 4,
      pitch: 0,
      tracks: { leftSpeed: 0, rightSpeed: 0 },
      speed: 0,
      turnRate: 0,
    },
    swing: {
      angle: 0, minAngle: -180 * DEG, maxAngle: 180 * DEG,
      speed: 1.2, length: 0, label: 'Swing',
    },
    boom: {
      angle: -30 * DEG, minAngle: -60 * DEG, maxAngle: 70 * DEG,
      speed: 0.8, length: 0.25, label: 'Boom',
    },
    stick: {
      angle: -100 * DEG, minAngle: -160 * DEG, maxAngle: -30 * DEG,
      speed: 1.0, length: 0.18, label: 'Stick',
    },
    bucket: {
      angle: -20 * DEG, minAngle: -170 * DEG, maxAngle: 30 * DEG,
      speed: 1.5, length: 0.08, label: 'Bucket',
    },
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
    swingInput: number;     // -1 to 1
    boomInput: number;      // -1 to 1 
    stickInput: number;     // -1 to 1
    bucketInput: number;    // -1 to 1
    leftTrack: number;      // -1 to 1
    rightTrack: number;     // -1 to 1
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
  
  // Hydraulic pressure visual (based on arm activity)
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

// Forward kinematics: compute world positions of each joint and the bucket tip
export interface ExcavatorFK {
  cabBase: [number, number, number];
  boomPivot: [number, number, number];
  boomEnd: [number, number, number];
  stickEnd: [number, number, number];
  bucketTip: [number, number, number];
  bucketTeeth: [number, number, number][];  // 3-5 teeth positions for multi-point dig
}

export function computeExcavatorFK(state: ExcavatorState): ExcavatorFK {
  const v = state.vehicle;
  const ch = Math.cos(v.heading);
  const sh = Math.sin(v.heading);
  const cs = Math.cos(state.swing.angle);
  const ss = Math.sin(state.swing.angle);
  
  // Cab sits on vehicle at a height
  const cabHeight = 0.06;
  const cabBase: [number, number, number] = [v.posX, v.posY + cabHeight, v.posZ];
  
  // Boom pivot at front of cab
  const pivotOffset = 0.04;
  const boomPivot: [number, number, number] = [
    cabBase[0] + (sh * cs + ch * ss) * pivotOffset,
    cabBase[1] + 0.03,
    cabBase[2] + (ch * cs - sh * ss) * pivotOffset,
  ];
  
  // Combined heading + swing angle for arm direction
  const armHeading = v.heading + state.swing.angle;
  const cah = Math.cos(armHeading);
  const sah = Math.sin(armHeading);
  
  // Boom end (boom rotates in the vertical plane defined by armHeading)
  const boomAngle = state.boom.angle;
  const boomHoriz = Math.cos(boomAngle) * state.boom.length;
  const boomVert = Math.sin(boomAngle) * state.boom.length;
  const boomEnd: [number, number, number] = [
    boomPivot[0] + sah * boomHoriz,
    boomPivot[1] + boomVert,
    boomPivot[2] + cah * boomHoriz,
  ];
  
  // Stick end
  const stickAbsAngle = boomAngle + state.stick.angle;
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
  
  // Bucket teeth spread perpendicular to arm direction
  const perpX = cah;
  const perpZ = -sah;
  const teethSpread = 0.025;
  const bucketTeeth: [number, number, number][] = [
    [bucketTip[0] - perpX * teethSpread, bucketTip[1], bucketTip[2] - perpZ * teethSpread],
    [bucketTip[0], bucketTip[1], bucketTip[2]],
    [bucketTip[0] + perpX * teethSpread, bucketTip[1], bucketTip[2] + perpZ * teethSpread],
  ];
  
  return { cabBase, boomPivot, boomEnd, stickEnd, bucketTip, bucketTeeth };
}
