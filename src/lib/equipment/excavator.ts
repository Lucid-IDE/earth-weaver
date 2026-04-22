// ── Excavator Model & Physics ────────────────────────────────────────
// Articulated hydraulic excavator with boom/stick/bucket + cab swing.
// Joints are now driven by individual hydraulic cylinders modeled as
// force-producing elements (CylinderState). Each tick, the cylinder is
// stepped given current pump pressure/flow and the load it sees from
// gravity + arm geometry + bucket contents; the resulting cylinder
// velocity converts to angular joint velocity via a per-joint moment
// arm. This gives realistic lag, pressure-dependent speed, and saturated
// motion when the engine is lugging or the relief valve cracks.

import { ExcavatorState, ExcavatorCylinders, DEG } from './types';
import { HydraulicSystem } from './vehiclePhysics';
import { createCylinder, stepCylinder } from './hydraulicCylinder';

// ── Realistic joint limits (based on real excavator specs) ──────────
const BOOM_LENGTH = 0.22;
const STICK_LENGTH = 0.16;
const BUCKET_LENGTH = 0.07;
const CAB_HEIGHT = 0.06;
const PIVOT_OFFSET = 0.045;

// Effective moment arms (cylinder linear → joint angular)
const BOOM_MOMENT = 0.06;
const STICK_MOMENT = 0.05;
const BUCKET_MOMENT = 0.035;
const SWING_MOMENT = 0.10;

function makeCylinders(): ExcavatorCylinders {
  return {
    boom: createCylinder({ boreArea: 0.014, rodArea: 0.0035, maxStroke: 1.5, reliefPressure: 350 }),
    stick: createCylinder({ boreArea: 0.011, rodArea: 0.003, maxStroke: 1.4, reliefPressure: 350 }),
    bucket: createCylinder({ boreArea: 0.009, rodArea: 0.0024, maxStroke: 1.2, reliefPressure: 350 }),
    swing: createCylinder({ boreArea: 0.008, rodArea: 0.002, maxStroke: 2.0, reliefPressure: 280 }),
  };
}

export function createExcavatorState(): ExcavatorState {
  return {
    vehicle: {
      posX: 0.3, posY: 0, posZ: 0.3,
      heading: -Math.PI / 4,
      pitch: 0,
      contactSink: 0,
      groundClearance: 0,
      tracks: { leftSpeed: 0, rightSpeed: 0, leftTravel: 0, rightTravel: 0, slack: 0 },
      speed: 0,
      turnRate: 0,
    },
    swing: {
      angle: 0, minAngle: -180 * DEG, maxAngle: 180 * DEG,
      speed: 1.2, length: 0, label: 'Swing',
    },
    // Spawn pose: boom raised, stick tucked, bucket curled — entire arm above
    // track height so the machine drops cleanly without clipping the ground.
    boom: {
      angle: 32 * DEG, minAngle: -65 * DEG, maxAngle: 72 * DEG,
      speed: 0.8, length: BOOM_LENGTH, label: 'Boom',
    },
    stick: {
      angle: -95 * DEG, minAngle: -135 * DEG, maxAngle: 35 * DEG,
      speed: 1.0, length: STICK_LENGTH, label: 'Stick',
    },
    bucket: {
      angle: 30 * DEG, minAngle: -145 * DEG, maxAngle: 55 * DEG,
      speed: 1.5, length: BUCKET_LENGTH, label: 'Bucket',
    },
    bucketFill: 0,
    hydraulicPressure: 0,
    cylinders: makeCylinders(),
  };
}

function clampJoint(joint: { angle: number; minAngle: number; maxAngle: number }) {
  joint.angle = Math.max(joint.minAngle, Math.min(joint.maxAngle, joint.angle));
}

/**
 * Per-joint load model.
 * Returns the external load (N, scaled) opposing cylinder extension
 * for a given joint, in the same scaled units as cylinder force.
 *
 * Includes:
 *  - Gravitational moment of arm + bucket
 *  - Bucket contents (heavier when filled)
 *  - Geometry (worse leverage when arm extended horizontally)
 */
function computeJointLoad(state: ExcavatorState, joint: keyof ExcavatorCylinders): number {
  const armWeight = 8;     // scaled N for empty arm segment
  const bucketEmpty = 5;
  const bucketLoad = bucketEmpty + state.bucketFill * 28;

  switch (joint) {
    case 'boom': {
      // Boom holds stick + bucket + load. Worst at horizontal.
      const horiz = Math.abs(Math.cos(state.boom.angle));
      return (armWeight * 1.5 + bucketLoad) * (0.6 + horiz * 1.0);
    }
    case 'stick': {
      const stickAbs = state.boom.angle + state.stick.angle;
      const horiz = Math.abs(Math.cos(stickAbs));
      return (armWeight + bucketLoad) * (0.5 + horiz * 0.8);
    }
    case 'bucket': {
      // Curl moment ∝ load × length to bucket CG
      return (bucketLoad) * 0.55;
    }
    case 'swing': {
      // Swing moment of inertia ∝ extended arm
      const extension = Math.abs(Math.cos(state.boom.angle)) * BOOM_LENGTH +
                        Math.abs(Math.cos(state.boom.angle + state.stick.angle)) * STICK_LENGTH;
      return (5 + bucketLoad * 0.3) * (1 + extension * 6);
    }
    default:
      return 5;
  }
}

/**
 * Drive a joint using the hydraulic cylinder. Returns realized angular
 * velocity (rad/s).
 *
 * cmd: -1..1 (mapped to cylinder retract/extend)
 * gravityAssist: when commanding the gravity-favoured direction the
 *   load helps rather than opposes (e.g. boom down).
 */
function driveJoint(
  state: ExcavatorState,
  jointKey: keyof ExcavatorCylinders,
  cmd: number,
  hyd: HydraulicSystem,
  dt: number,
  jointSign: number = 1, // some cylinders extend = positive joint angle change
): number {
  const cyl = state.cylinders[jointKey];
  const baseLoad = computeJointLoad(state, jointKey);
  // Gravity-assisted direction (e.g. boom going down, bucket dumping):
  // command sign opposite to load → load is helpful, halve effective load
  const effectiveLoad = (cmd * jointSign < 0) ? baseLoad * 0.4 : baseLoad;

  stepCylinder(cyl, cmd, effectiveLoad, hyd.pressure, hyd.flowRate, dt);

  // Convert linear cyl velocity → angular joint rate via moment arm
  const moment =
    jointKey === 'boom' ? BOOM_MOMENT :
    jointKey === 'stick' ? STICK_MOMENT :
    jointKey === 'bucket' ? BUCKET_MOMENT : SWING_MOMENT;
  return (cyl.velocity / moment) * jointSign;
}

/**
 * Update excavator joints using per-cylinder force/flow dynamics.
 * Falls back to simple kinematic mode when hydraulics is null.
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
  if (hydraulics) {
    const swingRate = driveJoint(state, 'swing', inputs.swingInput, hydraulics, dt, 1);
    const boomRate = driveJoint(state, 'boom', inputs.boomInput, hydraulics, dt, 1);
    const stickRate = driveJoint(state, 'stick', inputs.stickInput, hydraulics, dt, 1);
    const bucketRate = driveJoint(state, 'bucket', inputs.bucketInput, hydraulics, dt, 1);

    state.swing.angle += swingRate * dt;
    state.boom.angle += boomRate * dt;
    state.stick.angle += stickRate * dt;
    state.bucket.angle += bucketRate * dt;
  } else {
    state.swing.angle += inputs.swingInput * state.swing.speed * dt;
    state.boom.angle += inputs.boomInput * state.boom.speed * dt;
    state.stick.angle += inputs.stickInput * state.stick.speed * dt;
    state.bucket.angle += inputs.bucketInput * state.bucket.speed * dt;
  }

  clampJoint(state.swing);
  clampJoint(state.boom);
  clampJoint(state.stick);
  clampJoint(state.bucket);

  // System pressure visual = max of any cylinder's pressure / max relief
  const cyls = state.cylinders;
  const peakP = Math.max(
    cyls.boom.pressure / cyls.boom.spec.reliefPressure,
    cyls.stick.pressure / cyls.stick.spec.reliefPressure,
    cyls.bucket.pressure / cyls.bucket.spec.reliefPressure,
    cyls.swing.pressure / cyls.swing.spec.reliefPressure,
  );
  state.hydraulicPressure += (peakP - state.hydraulicPressure) * Math.min(1, 8 * dt);

  // NOTE: Track drive visuals are authored by vehiclePhysics.updateVehiclePhysics().
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
