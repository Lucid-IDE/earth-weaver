// ── Hydraulic Cylinder Force Model ───────────────────────────────────
// Models a cylinder as a force-producing element with bore-side / rod-side
// asymmetry, flow-limited extension, and a relief valve. Force feedback
// from cylinder load is reported back so the chassis (rigid body) can
// react: digging hard tips the machine forward, lifting heavy loads
// pushes the cab back, etc.

export interface CylinderSpec {
  boreArea: number;     // m² (bore side, full piston)
  rodArea: number;      // m² (rod side reduces effective area)
  maxStroke: number;    // m
  reliefPressure: number; // bar (max pressure before relief cracks)
}

export interface CylinderState {
  spec: CylinderSpec;
  extension: number;    // 0..maxStroke
  velocity: number;     // m/s of rod
  pressure: number;     // bar (0..reliefPressure)
  force: number;        // last commanded force (N, signed: + extends)
  loadForce: number;    // external resistance
}

export function createCylinder(spec: Partial<CylinderSpec> = {}): CylinderState {
  return {
    spec: {
      boreArea: spec.boreArea ?? 0.012,        // ~125mm bore
      rodArea: spec.rodArea ?? 0.003,
      maxStroke: spec.maxStroke ?? 1.4,
      reliefPressure: spec.reliefPressure ?? 350,
    },
    extension: 0,
    velocity: 0,
    pressure: 0,
    force: 0,
    loadForce: 0,
  };
}

/**
 * Step a cylinder one tick.
 *  command: -1..1 (negative=retract, positive=extend)
 *  loadForce: external opposing force (N, scaled). Positive = resists extension.
 *  systemPressure: 0..1 normalized hydraulic pressure available
 *  systemFlow: 0..1 normalized flow available
 *
 * Returns the *reaction force* applied back into the linkage / chassis.
 * Sign convention: positive when cylinder is pushing (extending under load).
 */
export function stepCylinder(
  cyl: CylinderState,
  command: number,
  loadForce: number,
  systemPressure: number,
  systemFlow: number,
  dt: number,
): number {
  const dir = Math.sign(command);
  const cmdMag = Math.abs(command);

  // Effective piston area depends on direction of motion
  const area = dir >= 0 ? cyl.spec.boreArea : cyl.spec.rodArea;

  // Available force from hydraulics (pressure × area), capped by relief
  const maxPressure = cyl.spec.reliefPressure * 1e5; // bar → Pa
  const availablePressure = systemPressure * maxPressure;
  const maxForce = availablePressure * area;

  // Required force = load + small overhead
  const requiredForce = Math.max(0, loadForce);

  // If load exceeds what hydraulics can supply, relief valve cracks
  const reliefOpen = requiredForce > maxForce * 0.97;

  // Commanded force (driver intent × available)
  const commandedForce = cmdMag * maxForce;

  // Net force after overcoming load
  const netForce = commandedForce - requiredForce;

  // Velocity is flow-limited
  // Flow Q = A × v  →  v_max = Q_avail / A
  // Use systemFlow×maxFlowRef as proxy for Q
  const maxFlowRef = 0.0008; // m³/s scaled
  const vMax = (systemFlow * maxFlowRef) / Math.max(1e-5, area);
  const targetVel = dir * Math.min(vMax, Math.abs(netForce) * 0.0002 + cmdMag * vMax);

  // Velocity ramp (mass + fluid inertia)
  const accel = (targetVel - cyl.velocity) * 18;
  cyl.velocity += accel * dt;

  // Position integration with stroke limits
  cyl.extension += cyl.velocity * dt;
  if (cyl.extension < 0) { cyl.extension = 0; cyl.velocity = Math.max(0, cyl.velocity); }
  if (cyl.extension > cyl.spec.maxStroke) {
    cyl.extension = cyl.spec.maxStroke;
    cyl.velocity = Math.min(0, cyl.velocity);
  }

  // Pressure builds with load
  const targetPressure = reliefOpen
    ? cyl.spec.reliefPressure
    : Math.min(cyl.spec.reliefPressure, (requiredForce / Math.max(1e-5, area)) / 1e5);
  cyl.pressure += (targetPressure - cyl.pressure) * Math.min(1, 12 * dt);

  cyl.force = commandedForce * dir;
  cyl.loadForce = loadForce;

  // Reaction force on chassis: equal and opposite to net force the cylinder applies.
  // When digging into resistance, this pushes back on the cab.
  return -dir * Math.min(commandedForce, requiredForce + 1e-6);
}
