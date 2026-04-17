// ── Bekker-Wong Terramechanics ───────────────────────────────────────
// Industry-standard pressure-sinkage + Janosi-Hanamoto slip-shear model
// Used in real off-road vehicle engineering (Wong, "Theory of Ground Vehicles")
//
// Pressure-sinkage:    p(z) = (kc/b + kphi) * z^n
// Shear (Janosi):      tau(j) = (c + p*tan(phi)) * (1 - exp(-j/K))
//
// Per-track-shoe contact patches give independent normal + shear,
// producing real motion resistance, slip-sinkage, drawbar pull curves.

export interface SoilTerramechParams {
  kc: number;        // cohesive modulus of sinkage [kPa·m^(1-n)]
  kphi: number;      // frictional modulus of sinkage [kPa·m^-n]
  n: number;         // sinkage exponent (0.5–1.2)
  c: number;         // cohesion [kPa]
  phi: number;       // internal friction angle [rad]
  K: number;         // shear deformation modulus [m] (~0.01–0.04)
  rho: number;       // bulk density [scaled]
}

// Library of soils tuned to scaled units used in this sim
// (real Bekker constants are in kPa; we use a scaling factor so
//  output sinkage lands in the 0–8 mm range that looks right at our
//  world scale where 1.0 ≈ 2 m).
const SCALE = 1 / 6500; // empirical pressure→sink gain for this sim

export function getTerramechParams(
  frictionAngle: number,
  cohesion: number,
  moisture: number,
): SoilTerramechParams {
  // Interpolate between sand/loam/clay-like profiles based on cohesion.
  // Wet soils: lower kphi, higher K (more shear deformation = slip).
  const wetness = Math.max(0, Math.min(1, moisture));

  // Cohesive stiffness: clay is stiffer in cohesion than sand
  const kc = (5 + cohesion * 25) * (1 - wetness * 0.55);
  // Frictional stiffness: drops sharply when wet
  const kphi = (700 + (1 - cohesion) * 600) * (1 - wetness * 0.7);
  // Sinkage exponent: clays ~0.5, sand ~1.0
  const n = 0.55 + (1 - cohesion) * 0.45;
  // Cohesion in kPa-equivalent
  const c = cohesion * 12;
  // Shear modulus K grows with moisture (more slip before full shear mobilized)
  const K = 0.012 + wetness * 0.025;

  return { kc, kphi, n, c, phi: frictionAngle, K, rho: 1.6 };
}

// ── Per-shoe contact patch ──
export interface ShoeContact {
  load: number;         // normal force on this shoe (scaled N)
  area: number;         // contact area (scaled m²)
  width: number;        // shoe width (b)
  sinkage: number;      // z (m, in world units)
  shearJ: number;       // accumulated shear deformation
  slip: number;         // -1..1 (track vs ground)
}

export function bekkerSinkage(
  pressure: number,         // kPa-equivalent
  width: number,            // shoe width b in world units
  params: SoilTerramechParams,
): number {
  if (pressure <= 0) return 0;
  // p = (kc/b + kphi) z^n  →  z = (p / (kc/b + kphi))^(1/n)
  const denom = params.kc / Math.max(0.005, width) + params.kphi;
  const ratio = pressure / Math.max(0.01, denom);
  return Math.pow(Math.max(0, ratio), 1 / params.n) * SCALE * 600;
}

export function janosiShear(
  pressure: number,         // kPa
  shearDisp: number,        // j, in world meters
  params: SoilTerramechParams,
): number {
  // tau = (c + p tan phi) (1 - exp(-|j|/K))
  const tauMax = params.c + pressure * Math.tan(params.phi);
  const mob = 1 - Math.exp(-Math.abs(shearDisp) / Math.max(1e-4, params.K));
  return Math.sign(shearDisp) * tauMax * mob;
}

// Compute drawbar pull (net thrust) and motion resistance for a track
// given per-shoe normal loads and slip velocity.
//
// Returns: thrust (forward force), resistance (always opposes motion),
//          avgSinkage (m), saturated (true if shear is at limit).
export interface TrackForceResult {
  thrust: number;
  resistance: number;
  avgSinkage: number;
  saturated: boolean;
  shearMobilization: number; // 0..1
}

export function computeTrackForces(
  totalLoad: number,        // total normal force on track (scaled)
  shoeArea: number,         // total contact area (scaled m²)
  trackWidth: number,       // b
  trackLength: number,      // contact patch length
  trackVelocity: number,    // commanded forward velocity (world u/s)
  vehicleVelocity: number,  // actual chassis velocity along track
  dt: number,
  params: SoilTerramechParams,
  prevShearJ: number = 0,
): TrackForceResult & { newShearJ: number } {
  // Average ground pressure
  const p = totalLoad / Math.max(1e-4, shoeArea);

  // Bekker pressure-sinkage
  const sinkage = bekkerSinkage(p, trackWidth, params);

  // Slip ratio: i = (v_track - v_chassis) / max(|v_track|, |v_chassis|)
  const denomV = Math.max(0.001, Math.abs(trackVelocity), Math.abs(vehicleVelocity));
  const slip = (trackVelocity - vehicleVelocity) / denomV;

  // Integrate shear displacement: j_dot = slip * |v_track|
  // We integrate magnitude with sign of slip
  const newShearJ = prevShearJ + slip * Math.abs(trackVelocity) * dt;
  // Decay if velocities low (no traction event)
  const decayedJ = Math.abs(trackVelocity) < 1e-4
    ? prevShearJ * Math.max(0, 1 - 4 * dt)
    : newShearJ;

  // Janosi-Hanamoto shear stress
  const tau = janosiShear(p, decayedJ, params);
  // Thrust = tau * area (in direction of slip)
  const thrust = tau * shoeArea;

  // Motion resistance from compaction (Bekker integral form, simplified)
  // R_c = (b * (kc/b + kphi)) / (n+1) * z^(n+1)
  const Rc = (trackWidth * (params.kc / Math.max(0.005, trackWidth) + params.kphi))
             / (params.n + 1)
             * Math.pow(Math.max(0, sinkage / (SCALE * 600)), params.n + 1);
  // Per-track resistance (scaled back into our force units)
  const resistance = Rc * SCALE * 600 * trackLength * 8; // tunable gain

  // Shear mobilization 0..1
  const tauMax = params.c + p * Math.tan(params.phi);
  const mobilization = tauMax > 1e-6 ? Math.min(1, Math.abs(tau) / tauMax) : 0;
  const saturated = mobilization > 0.95;

  return {
    thrust,
    resistance,
    avgSinkage: sinkage,
    saturated,
    shearMobilization: mobilization,
    newShearJ: decayedJ,
  };
}
