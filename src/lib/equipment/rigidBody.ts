// ── Lightweight Rigid-Body Chassis ───────────────────────────────────
// Adds pitch/roll/yaw inertial response on top of kinematic position.
// Not a full 6-DOF integrator (we keep XZ kinematic for stability + control
// feel), but treats angular state as proper inertial degrees of freedom and
// applies weight-transfer torques from accel/braking and external dig reactions.

export interface RigidBodyState {
  // Angular state (pitch=around X / nose, roll=around Z / right)
  pitchVel: number;        // rad/s
  rollVel: number;         // rad/s
  pitchAccum: number;      // dynamic pitch offset added to terrain pitch
  rollAccum: number;       // dynamic roll offset

  // External torques accumulated this frame (world or body? body)
  pendingPitchTorque: number;
  pendingRollTorque: number;
  pendingYawTorque: number;

  // Inertia (scaled)
  Ixx: number;             // pitch inertia
  Izz: number;             // roll inertia
  Iyy: number;             // yaw inertia

  // Spring-damper that pulls dynamic offsets back toward terrain pose
  pitchStiffness: number;
  pitchDamping: number;
  rollStiffness: number;
  rollDamping: number;

  // Track of last linear velocity for accel-based weight transfer
  lastForwardVel: number;
}

export function createRigidBody(mass: number): RigidBodyState {
  return {
    pitchVel: 0, rollVel: 0,
    pitchAccum: 0, rollAccum: 0,
    pendingPitchTorque: 0, pendingRollTorque: 0, pendingYawTorque: 0,
    Ixx: mass * 0.18,
    Izz: mass * 0.14,
    Iyy: mass * 0.22,
    pitchStiffness: 28,
    pitchDamping: 7.5,
    rollStiffness: 36,
    rollDamping: 8.5,
    lastForwardVel: 0,
  };
}

export function applyChassisTorque(
  rb: RigidBodyState,
  pitch: number,
  roll: number = 0,
  yaw: number = 0,
) {
  rb.pendingPitchTorque += pitch;
  rb.pendingRollTorque += roll;
  rb.pendingYawTorque += yaw;
}

/**
 * Apply a force at an offset from the CG (in body coords).
 * Generates pitch/roll torques.
 *
 *   offset = [forward, up, right] from CG in world units
 *   force  = [forward, up, right] in scaled N
 */
export function applyForceAtPoint(
  rb: RigidBodyState,
  offset: [number, number, number],
  force: [number, number, number],
) {
  // Pitch torque: vertical force at forward offset, OR forward force at vertical offset
  const pitchT = offset[0] * force[1] - offset[1] * force[0];
  // Roll torque: vertical force at right offset, OR right force at vertical offset
  const rollT = offset[2] * force[1] - offset[1] * force[2];
  // Yaw torque from forward/right force at right/forward lever
  const yawT = offset[0] * force[2] - offset[2] * force[0];
  rb.pendingPitchTorque += pitchT;
  rb.pendingRollTorque += rollT;
  rb.pendingYawTorque += yawT;
}

/**
 * Integrate angular state. Spring-damps dynamic offsets back to zero so the
 * chassis returns to following terrain when external forces stop.
 *
 * Returns angular yaw delta (rad) to add to vehicle.heading.
 */
export function integrateRigidBody(
  rb: RigidBodyState,
  forwardVel: number,
  dt: number,
): number {
  // Weight transfer from longitudinal acceleration
  const accel = (forwardVel - rb.lastForwardVel) / Math.max(1e-4, dt);
  rb.lastForwardVel = forwardVel;
  // Acceleration creates rear-down (nose-up) pitch torque; deceleration nose-down
  rb.pendingPitchTorque += -accel * 0.6;

  // Pitch update
  const pitchSpring = -rb.pitchStiffness * rb.pitchAccum;
  const pitchDamp = -rb.pitchDamping * rb.pitchVel;
  const pitchAccel = (rb.pendingPitchTorque + pitchSpring + pitchDamp) / rb.Ixx;
  rb.pitchVel += pitchAccel * dt;
  rb.pitchAccum += rb.pitchVel * dt;

  // Roll update
  const rollSpring = -rb.rollStiffness * rb.rollAccum;
  const rollDamp = -rb.rollDamping * rb.rollVel;
  const rollAccel = (rb.pendingRollTorque + rollSpring + rollDamp) / rb.Izz;
  rb.rollVel += rollAccel * dt;
  rb.rollAccum += rb.rollVel * dt;

  // Yaw kick (returned to caller, applied to heading)
  const yawDelta = (rb.pendingYawTorque / rb.Iyy) * dt * dt * 0.5;

  // Clamp to reasonable range
  rb.pitchAccum = Math.max(-0.18, Math.min(0.18, rb.pitchAccum));
  rb.rollAccum = Math.max(-0.18, Math.min(0.18, rb.rollAccum));

  // Reset accumulators
  rb.pendingPitchTorque = 0;
  rb.pendingRollTorque = 0;
  rb.pendingYawTorque = 0;

  return yawDelta;
}
