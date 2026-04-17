// ── Equipment-Terrain Interaction ────────────────────────────────────
// Handles how equipment modifies the SDF field, spawns MPM particles,
// and provides terrain height queries for vehicle following.

import { VoxelField } from '../soil/VoxelField';
import { SoilSimulator } from '../soil/soilSim';
import { VOXEL_SIZE, SURFACE_IY, PHI_SCALE, DEG } from '../soil/constants';
import { getMaterialAt } from '../soil/materialBrain';
import { ExcavatorState, BulldozerState, VehicleState } from './types';
import { computeExcavatorFK } from './excavator';
import { computeBladeGeometry } from './bulldozer';
import { worldToMPM } from '../mpm/bridge';
import { addParticle, MaterialType } from '../mpm/mpmSolver';
import { MAX_PARTICLES } from '../mpm/constants';

// ── World→Grid coordinate conversion ────────────────────────────────
function worldToGridX(wx: number, nx: number): number {
  return wx / VOXEL_SIZE + nx / 2;
}
function worldToGridY(wy: number): number {
  return wy / VOXEL_SIZE + SURFACE_IY;
}
function worldToGridZ(wz: number, nz: number): number {
  return wz / VOXEL_SIZE + nz / 2;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function gridToWorldY(iy: number): number {
  return (iy - SURFACE_IY) * VOXEL_SIZE;
}

function safePhi(field: VoxelField, ix: number, iy: number, iz: number): number {
  if (ix < 0 || ix > field.nx || iy < 0 || iy > field.ny || iz < 0 || iz > field.nz) {
    return 32767;
  }
  return field.phi[field.vidx(ix, iy, iz)];
}

function getColumnSurfaceY(field: VoxelField, ix: number, iz: number): number {
  const cx = Math.max(0, Math.min(field.nx, ix));
  const cz = Math.max(0, Math.min(field.nz, iz));

  for (let iy = field.ny; iy > 0; iy--) {
    const phiTop = safePhi(field, cx, iy, cz);
    const phiBottom = safePhi(field, cx, iy - 1, cz);
    if (phiTop >= 0 && phiBottom < 0) {
      const t = phiTop / Math.max(1, (phiTop - phiBottom));
      return lerp(gridToWorldY(iy), gridToWorldY(iy - 1), t);
    }
  }

  if (safePhi(field, cx, 0, cz) < 0) return gridToWorldY(0);
  return -SURFACE_IY * VOXEL_SIZE;
}

// ── Terrain Height Query ────────────────────────────────────────────
// Find the surface Y at a given world XZ by scanning the SDF column
export function getTerrainHeight(field: VoxelField, wx: number, wz: number): number {
  const gx = worldToGridX(wx, field.nx);
  const gz = worldToGridZ(wz, field.nz);

  const ix0 = Math.floor(gx);
  const iz0 = Math.floor(gz);
  const ix1 = ix0 + 1;
  const iz1 = iz0 + 1;

  const tx = gx - ix0;
  const tz = gz - iz0;

  const h00 = getColumnSurfaceY(field, ix0, iz0);
  const h10 = getColumnSurfaceY(field, ix1, iz0);
  const h01 = getColumnSurfaceY(field, ix0, iz1);
  const h11 = getColumnSurfaceY(field, ix1, iz1);

  const hx0 = lerp(h00, h10, tx);
  const hx1 = lerp(h01, h11, tx);
  return lerp(hx0, hx1, tz);
}

function computeSinkDepth(wx: number, surfaceY: number, wz: number, loadFactor: number): number {
  const mat = getMaterialAt(wx, surfaceY - 0.01, wz);
  const frictionNorm = clamp01((mat.frictionAngle / DEG - 15) / 25);
  // Softness: wet clay sinks most, dry gravel almost none
  const moistureFactor = mat.moisture * mat.moisture; // quadratic: only very wet soil sinks much
  const cohesionFactor = clamp01(1 - mat.cohesion * 0.8); // low cohesion = more sink
  const frictionFactor = clamp01(1 - frictionNorm); // low friction = more sink
  const softness = clamp01(
    moistureFactor * 0.5 +
    frictionFactor * 0.25 +
    cohesionFactor * 0.25,
  );
  // Base sink: 0.5mm minimum, up to ~5mm on very soft wet soil
  return 0.0005 + softness * 0.005 * loadFactor;
}

function applyCompactionBrush(
  field: VoxelField,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  depth: number,
  disturbanceAge: number,
) {
  const gx = worldToGridX(cx, field.nx);
  const gy = worldToGridY(cy);
  const gz = worldToGridZ(cz, field.nz);

  const rGrid = radius / VOXEL_SIZE;
  const margin = Math.ceil(rGrid) + 1;

  const ixMin = Math.max(0, Math.floor(gx - margin));
  const ixMax = Math.min(field.nx, Math.ceil(gx + margin));
  const iyMin = Math.max(0, Math.floor(gy - margin));
  const iyMax = Math.min(field.ny, Math.ceil(gy + margin));
  const izMin = Math.max(0, Math.floor(gz - margin));
  const izMax = Math.min(field.nz, Math.ceil(gz + margin));

  const scaledDepth = Math.max(0.0005, depth);

  for (let iz = izMin; iz <= izMax; iz++) {
    for (let iy = iyMin; iy <= iyMax; iy++) {
      for (let ix = ixMin; ix <= ixMax; ix++) {
        const dx = (ix - gx) * VOXEL_SIZE;
        const dy = (iy - gy) * VOXEL_SIZE * 1.6;
        const dz = (iz - gz) * VOXEL_SIZE;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist > radius) continue;

        const falloff = 1 - dist / radius;
        const phiDelta = Math.round((falloff * scaledDepth / PHI_SCALE) * 32767);
        if (phiDelta <= 0) continue;

        const idx = field.vidx(ix, iy, iz);
        const oldPhi = field.phi[idx];
        const nextPhi = Math.min(32767, oldPhi + phiDelta) as number;
        if (nextPhi === oldPhi) continue;

        field.phi[idx] = nextPhi;
        if (oldPhi < 0) {
          field.disturbanceAge[idx] = Math.min(field.disturbanceAge[idx], disturbanceAge);
        }
      }
    }
  }
}

function addSoilBrush(
  field: VoxelField,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  strength: number,
  disturbanceAge: number,
) {
  const gx = worldToGridX(cx, field.nx);
  const gy = worldToGridY(cy);
  const gz = worldToGridZ(cz, field.nz);

  const rGrid = radius / VOXEL_SIZE;
  const margin = Math.ceil(rGrid) + 1;

  const ixMin = Math.max(0, Math.floor(gx - margin));
  const ixMax = Math.min(field.nx, Math.ceil(gx + margin));
  const iyMin = Math.max(0, Math.floor(gy - margin));
  const iyMax = Math.min(field.ny, Math.ceil(gy + margin));
  const izMin = Math.max(0, Math.floor(gz - margin));
  const izMax = Math.min(field.nz, Math.ceil(gz + margin));

  for (let iz = izMin; iz <= izMax; iz++) {
    for (let iy = iyMin; iy <= iyMax; iy++) {
      for (let ix = ixMin; ix <= ixMax; ix++) {
        const dx = (ix - gx) * VOXEL_SIZE;
        const dy = (iy - gy) * VOXEL_SIZE;
        const dz = (iz - gz) * VOXEL_SIZE;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist > radius) continue;

        const falloff = 1 - dist / radius;
        const phiDelta = Math.round(falloff * strength);
        if (phiDelta <= 0) continue;

        const idx = field.vidx(ix, iy, iz);
        const oldPhi = field.phi[idx];
        const nextPhi = Math.max(-32767, oldPhi - phiDelta) as number;
        if (nextPhi === oldPhi) continue;

        field.phi[idx] = nextPhi;
        field.disturbanceAge[idx] = Math.min(field.disturbanceAge[idx], disturbanceAge);
      }
    }
  }
}

function classifyMaterial(friction: number, cohesion: number): number {
  if (cohesion > 0.6) return MaterialType.Clay;
  if (cohesion > 0.35) return MaterialType.Loam;
  if (cohesion > 0.2) return MaterialType.Organic;
  if (friction > 30 * DEG) return MaterialType.Sand;
  if (friction > 27 * DEG) return MaterialType.Gravel;
  return MaterialType.Silt;
}

interface TerrainFollowConfig {
  trackWidth: number;
  trackLength: number;
  /** Height of vehicle origin above track pad bottom.
   *  Must match renderer: trackHeight * 0.88 so pads sit ON the surface. */
  rideHeight: number;
  loadFactor: number;
  followSharpness: number;
  maxDropSpeed: number;
  allowTrackMarks: boolean;
}

const DEFAULT_FOLLOW_CONFIG: TerrainFollowConfig = {
  trackWidth: 0.09,
  trackLength: 0.16,
  rideHeight: 0.025,  // th * 0.88
  loadFactor: 1,
  followSharpness: 0.55,
  maxDropSpeed: 0.6,
  allowTrackMarks: true,
};

function stampTrackMarks(
  field: VoxelField,
  vehicle: VehicleState,
  cfg: TerrainFollowConfig,
  driveIntensity: number,
) {
  const ch = Math.cos(vehicle.heading);
  const sh = Math.sin(vehicle.heading);

  const fwdX = sh;
  const fwdZ = ch;
  const rightX = ch;
  const rightZ = -sh;

  const halfTrackWidth = cfg.trackWidth * 0.5;
  const segments = 5;
  const sinkBoost = vehicle.contactSink * 0.8;
  const depthBase = 0.0012 + driveIntensity * 0.003 + sinkBoost;

  for (const side of [-1, 1]) {
    for (let i = 0; i < segments; i++) {
      const t = (i / (segments - 1) - 0.5) * cfg.trackLength * 0.95;
      const px = vehicle.posX + fwdX * t + rightX * halfTrackWidth * side;
      const pz = vehicle.posZ + fwdZ * t + rightZ * halfTrackWidth * side;
      const terrainY = getTerrainHeight(field, px, pz);
      const trackBottom = vehicle.posY - cfg.rideHeight;
      const penetration = terrainY - trackBottom;

      if (penetration < -0.004) continue;

      const imprintDepth = Math.max(0.001, Math.min(0.008, depthBase + Math.max(0, penetration) * 0.5));
      const imprintRadius = 0.010 + driveIntensity * 0.003;
      applyCompactionBrush(
        field,
        px,
        terrainY - imprintDepth * 0.5,
        pz,
        imprintRadius,
        imprintDepth,
        16,
      );
    }
  }
}

// ── Snap vehicle to terrain (call once on init or when spawning) ────
export function initVehicleOnTerrain(
  vehicle: VehicleState,
  field: VoxelField,
  config: Partial<TerrainFollowConfig> = {},
) {
  const cfg = { ...DEFAULT_FOLLOW_CONFIG, ...config };
  const ch = Math.cos(vehicle.heading);
  const sh = Math.sin(vehicle.heading);
  const fwdX = sh, fwdZ = ch, rightX = ch, rightZ = -sh;
  const halfLen = cfg.trackLength * 0.5;
  const halfWidth = cfg.trackWidth * 0.5;

  // Sample terrain at the 4 track corners
  const corners = [
    getTerrainHeight(field, vehicle.posX + fwdX * halfLen + rightX * halfWidth, vehicle.posZ + fwdZ * halfLen + rightZ * halfWidth),
    getTerrainHeight(field, vehicle.posX + fwdX * halfLen - rightX * halfWidth, vehicle.posZ + fwdZ * halfLen - rightZ * halfWidth),
    getTerrainHeight(field, vehicle.posX - fwdX * halfLen + rightX * halfWidth, vehicle.posZ - fwdZ * halfLen + rightZ * halfWidth),
    getTerrainHeight(field, vehicle.posX - fwdX * halfLen - rightX * halfWidth, vehicle.posZ - fwdZ * halfLen - rightZ * halfWidth),
  ];

  const avg = corners.reduce((a, b) => a + b, 0) / corners.length;
  vehicle.posY = avg + cfg.rideHeight;

  const frontAvg = (corners[0] + corners[1]) * 0.5;
  const backAvg = (corners[2] + corners[3]) * 0.5;
  vehicle.pitch = Math.atan2(frontAvg - backAvg, cfg.trackLength);
  vehicle.contactSink = 0;
  vehicle.groundClearance = cfg.rideHeight;
}

// ── Update vehicle Y to follow terrain ──────────────────────────────
export function updateVehicleTerrainFollow(
  vehicle: VehicleState,
  field: VoxelField,
  dt: number = 1 / 60,
  config: Partial<TerrainFollowConfig> = {},
) {
  const cfg = { ...DEFAULT_FOLLOW_CONFIG, ...config };
  const ch = Math.cos(vehicle.heading);
  const sh = Math.sin(vehicle.heading);

  const fwdX = sh;
  const fwdZ = ch;
  const rightX = ch;
  const rightZ = -sh;

  const halfLen = cfg.trackLength * 0.5;
  const halfWidth = cfg.trackWidth * 0.5;

  // 8-point contact: 4 corners + 4 midpoints for more stable sampling
  const contacts = [
    // Corners
    { x: vehicle.posX + fwdX * halfLen + rightX * halfWidth, z: vehicle.posZ + fwdZ * halfLen + rightZ * halfWidth },
    { x: vehicle.posX + fwdX * halfLen - rightX * halfWidth, z: vehicle.posZ + fwdZ * halfLen - rightZ * halfWidth },
    { x: vehicle.posX - fwdX * halfLen + rightX * halfWidth, z: vehicle.posZ - fwdZ * halfLen + rightZ * halfWidth },
    { x: vehicle.posX - fwdX * halfLen - rightX * halfWidth, z: vehicle.posZ - fwdZ * halfLen - rightZ * halfWidth },
    // Track midpoints (left and right)
    { x: vehicle.posX + rightX * halfWidth, z: vehicle.posZ + rightZ * halfWidth },
    { x: vehicle.posX - rightX * halfWidth, z: vehicle.posZ - rightZ * halfWidth },
    // Front/back centers
    { x: vehicle.posX + fwdX * halfLen, z: vehicle.posZ + fwdZ * halfLen },
    { x: vehicle.posX - fwdX * halfLen, z: vehicle.posZ - fwdZ * halfLen },
  ];

  const surfaceYs = contacts.map((c) => getTerrainHeight(field, c.x, c.z));
  const sinkYs = contacts.map((c, i) => computeSinkDepth(c.x, surfaceYs[i], c.z, cfg.loadFactor));

  // Use the HIGHEST contact point (tracks bridge over dips, don't average into holes)
  // This prevents the machine from sinking into uneven terrain
  const contactYs = surfaceYs.map((y, i) => y - sinkYs[i]);

  // For Y: use a weighted approach — mostly highest point, slightly avg to prevent hovering
  const maxContact = Math.max(...contactYs);
  const avgContact = contactYs.reduce((a, b) => a + b, 0) / contactYs.length;
  // Blend: 70% max (prevents sinking), 30% avg (prevents hovering over bumps)
  const blendedY = maxContact * 0.6 + avgContact * 0.4;
  const targetY = blendedY + cfg.rideHeight;

  // Stiff spring going UP (ground pushes vehicle up instantly)
  // Gravity-limited going DOWN (vehicle falls at realistic rate)
  if (targetY > vehicle.posY) {
    // Going up: stiff spring, nearly instant for small bumps
    const upDelta = targetY - vehicle.posY;
    const upRate = upDelta < 0.005 ? 0.95 : Math.min(1, cfg.followSharpness * 2.5);
    vehicle.posY += upDelta * upRate;
  } else {
    // Going down: gravity-limited drop
    const maxDrop = cfg.maxDropSpeed * dt;
    const downDelta = vehicle.posY - targetY;
    // Smooth approach: faster when far, slower when close
    const dropAmount = Math.min(downDelta, maxDrop, downDelta * cfg.followSharpness * 3);
    vehicle.posY -= dropAmount;
  }

  // Pitch from front-back height difference
  const frontAvg = (contactYs[0] + contactYs[1] + contactYs[6]) / 3; // front corners + front center
  const backAvg = (contactYs[2] + contactYs[3] + contactYs[7]) / 3;  // back corners + back center
  const targetPitch = Math.atan2(frontAvg - backAvg, cfg.trackLength);
  vehicle.pitch += (targetPitch - vehicle.pitch) * Math.min(1, cfg.followSharpness * 1.5);

  const avgSurface = surfaceYs.reduce((a, b) => a + b, 0) / surfaceYs.length;
  const avgSink = sinkYs.reduce((a, b) => a + b, 0) / sinkYs.length;
  vehicle.contactSink = avgSink;
  vehicle.groundClearance = Math.max(0, vehicle.posY - cfg.rideHeight - avgSurface);

  const driveIntensity = clamp01((Math.abs(vehicle.tracks.leftSpeed) + Math.abs(vehicle.tracks.rightSpeed)) * 0.5);
  if (cfg.allowTrackMarks && driveIntensity > 0.08) {
    stampTrackMarks(field, vehicle, cfg, driveIntensity);
  }
}

// ── SDF sampling helper ─────────────────────────────────────────────
function sampleSDF(field: VoxelField, wx: number, wy: number, wz: number): number {
  const gx = worldToGridX(wx, field.nx);
  const gy = worldToGridY(wy);
  const gz = worldToGridZ(wz, field.nz);

  const ix0 = Math.floor(gx);
  const iy0 = Math.floor(gy);
  const iz0 = Math.floor(gz);
  const tx = gx - ix0;
  const ty = gy - iy0;
  const tz = gz - iz0;

  const ix1 = ix0 + 1;
  const iy1 = iy0 + 1;
  const iz1 = iz0 + 1;

  if (ix0 < 0 || iy0 < 0 || iz0 < 0 || ix1 > field.nx || iy1 > field.ny || iz1 > field.nz) {
    return 32767; // outside bounds = air
  }

  const p000 = safePhi(field, ix0, iy0, iz0);
  const p100 = safePhi(field, ix1, iy0, iz0);
  const p010 = safePhi(field, ix0, iy1, iz0);
  const p110 = safePhi(field, ix1, iy1, iz0);
  const p001 = safePhi(field, ix0, iy0, iz1);
  const p101 = safePhi(field, ix1, iy0, iz1);
  const p011 = safePhi(field, ix0, iy1, iz1);
  const p111 = safePhi(field, ix1, iy1, iz1);

  const c00 = lerp(p000, p100, tx);
  const c10 = lerp(p010, p110, tx);
  const c01 = lerp(p001, p101, tx);
  const c11 = lerp(p011, p111, tx);
  const c0 = lerp(c00, c10, ty);
  const c1 = lerp(c01, c11, ty);
  return lerp(c0, c1, tz);
}

// ── Excavator bucket dig ────────────────────────────────────────────
// Returns { changed, reactionForce } where reactionForce is the upward+backward
// force the soil exerts on the bucket (used for chassis weight transfer).
export function excavatorDig(
  state: ExcavatorState,
  field: VoxelField,
  sim: SoilSimulator,
  options: {
    digRadius?: number;
    bucketInput?: number;
    dt?: number;
  } = {},
): { changed: boolean; reactionForce: number } {
  const digRadius = options.digRadius ?? 0.03;
  const bucketInput = options.bucketInput ?? 0;
  const dt = options.dt ?? 1 / 60;
  const fk = computeExcavatorFK(state);
  let didChange = false;
  let cutMetric = 0;
  let reactionForce = 0;

  for (const tooth of fk.bucketTeeth) {
    const terrainY = getTerrainHeight(field, tooth[0], tooth[2]);
    const penetration = terrainY - tooth[1];
    const phi = sampleSDF(field, tooth[0], tooth[1], tooth[2]);
    if (phi < 0 || penetration > 0.002) {
      const localRadius = digRadius * (1 + Math.min(0.8, Math.max(0, penetration) * 18));
      field.applyStamp(tooth[0], tooth[1] - 0.002, tooth[2], localRadius);
      const cut = Math.max(0.002, penetration + 0.004);
      cutMetric += cut;
      const mat = getMaterialAt(tooth[0], tooth[1] - 0.005, tooth[2]);
      // Reaction force ∝ (cut depth) × (cohesion + density)
      reactionForce += cut * (8 + mat.cohesion * 14 + mat.specificWeight * 6);
      didChange = true;
    }
  }

  // Also check bucket tip
  const tipTerrain = getTerrainHeight(field, fk.bucketTip[0], fk.bucketTip[2]);
  const tipPenetration = tipTerrain - fk.bucketTip[1];
  const tipPhi = sampleSDF(field, fk.bucketTip[0], fk.bucketTip[1], fk.bucketTip[2]);
  if (tipPhi < 0 || tipPenetration > 0.0015) {
    field.applyStamp(
      fk.bucketTip[0],
      fk.bucketTip[1] - 0.003,
      fk.bucketTip[2],
      digRadius * 1.15,
    );
    const cut = Math.max(0.003, tipPenetration + 0.005);
    cutMetric += cut;
    const mat = getMaterialAt(fk.bucketTip[0], fk.bucketTip[1] - 0.008, fk.bucketTip[2]);
    reactionForce += cut * (10 + mat.cohesion * 18 + mat.specificWeight * 6);
    didChange = true;
  }

  if (cutMetric > 0) {
    const material = getMaterialAt(fk.bucketTip[0], fk.bucketTip[1] - 0.01, fk.bucketTip[2]);
    // ── Volumetric scoop conservation ──
    // Swept-volume estimate: cut depth × bucket cross-section × 1 frame
    // Bucket capacity is normalized 0..1; gain scales with material density.
    const bucketCrossSection = 0.014; // ≈ bucket mouth area in world units²
    const sweptVolume = cutMetric * bucketCrossSection;
    // Density factor: heavier soils fill faster (less air gaps)
    const densityGain = 0.6 + material.specificWeight * 0.4;
    // Cohesion bonus: clay sticks together → fills more efficiently
    const fillGain = Math.min(0.18, sweptVolume * 320 * densityGain * (1 + material.cohesion * 0.5));
    if (bucketInput > -0.2) {
      state.bucketFill = clamp01(state.bucketFill + fillGain);
    }
  }

  // ── Spillage at angles exceeding angle of repose ──
  // Bucket "tilt" relative to horizontal. If the open mouth tips below repose,
  // cohesionless material spills out.
  if (state.bucketFill > 0.02) {
    const bucketAbsAngle = state.boom.angle + state.stick.angle + state.bucket.angle;
    // When bucketAbsAngle > 0 the mouth points up-ish (holds material).
    // When < -repose, material spills over the lip.
    const mat = getMaterialAt(fk.bucketTip[0], fk.bucketTip[1] - 0.01, fk.bucketTip[2]);
    const repose = mat.frictionAngle * 0.85; // slightly less than friction angle
    const spillAngle = -repose - 0.15; // grace zone
    if (bucketAbsAngle < spillAngle) {
      const overTilt = spillAngle - bucketAbsAngle;
      // Cohesion holds material in (clay sticks); sand pours freely.
      const spillRate = (1 - mat.cohesion * 0.85) * overTilt * dt * 1.2;
      const spillAmount = Math.min(state.bucketFill, spillRate);
      if (spillAmount > 0.0005) {
        dumpBucketMaterial(state, field, sim, fk, spillAmount * 0.6);
        state.bucketFill = Math.max(0, state.bucketFill - spillAmount);
        didChange = true;
      }
    }
  }

  const canDump = state.bucketFill > 0.01 && bucketInput < -0.15 && fk.bucketTip[1] > tipTerrain - 0.015;
  if (canDump) {
    const dumpAmount = Math.min(state.bucketFill, (0.02 + (-bucketInput) * 0.04) * Math.max(1, dt * 60));
    dumpBucketMaterial(state, field, sim, fk, dumpAmount);
    state.bucketFill = Math.max(0, state.bucketFill - dumpAmount);
    didChange = true;
  }

  if (didChange) {
    sim.activate();
  }

  return { changed: didChange, reactionForce };
}

function dumpBucketMaterial(
  state: ExcavatorState,
  field: VoxelField,
  sim: SoilSimulator,
  fk: ReturnType<typeof computeExcavatorFK>,
  amount: number,
) {
  const dirX = fk.bucketTip[0] - fk.stickEnd[0];
  const dirY = fk.bucketTip[1] - fk.stickEnd[1];
  const dirZ = fk.bucketTip[2] - fk.stickEnd[2];
  const len = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ) || 1;

  const ndx = dirX / len;
  const ndy = dirY / len;
  const ndz = dirZ / len;

  const sideX = ndz;
  const sideZ = -ndx;
  const drops = Math.max(2, Math.min(8, Math.ceil(amount * 10)));

  for (let i = 0; i < drops; i++) {
    const spread = (i / Math.max(1, drops - 1) - 0.5) * 0.028;
    const px = fk.bucketTip[0] + ndx * 0.016 + sideX * spread;
    const pz = fk.bucketTip[2] + ndz * 0.016 + sideZ * spread;
    const terrainY = getTerrainHeight(field, px, pz);
    const py = Math.min(fk.bucketTip[1] - 0.008, terrainY + 0.035);

    addSoilBrush(
      field,
      px,
      py,
      pz,
      0.010 + amount * 0.012,
      3800 + amount * 8200,
      12,
    );

    const mat = getMaterialAt(px, py - 0.01, pz);
    const matType = classifyMaterial(mat.frictionAngle, mat.cohesion);
    const particleCount = Math.max(1, Math.floor(2 + amount * 6));

    for (let k = 0; k < particleCount; k++) {
      if (sim.mpm.numParticles >= MAX_PARTICLES - 1) return;

      const jx = (Math.random() - 0.5) * 0.015;
      const jy = Math.random() * 0.01;
      const jz = (Math.random() - 0.5) * 0.015;
      const [mx, my, mz] = worldToMPM(px + jx, py + jy, pz + jz);

      if (mx < 0.05 || mx > 0.95 || my < 0.05 || my > 0.95 || mz < 0.05 || mz > 0.95) continue;

      const pidx = addParticle(
        sim.mpm,
        mx,
        my,
        mz,
        matType,
        mat.frictionAngle,
        mat.cohesion,
        mat.specificWeight,
        mat.youngModulus,
        mat.poissonRatio,
        mat.damping,
        mat.moisture,
        3,
      );

      if (pidx >= 0) {
        const spill = Math.max(0.02, 0.08 * amount);
        sim.mpm.vx[pidx] = ndx * spill + (Math.random() - 0.5) * 0.03;
        sim.mpm.vy[pidx] = -0.02 - Math.random() * 0.03 + ndy * 0.01;
        sim.mpm.vz[pidx] = ndz * spill + (Math.random() - 0.5) * 0.03;
      }
    }
  }

  // Slight passive spillage when carrying heavy load with open bucket
  if (state.bucketFill > 0.65 && state.bucket.angle < -95 * DEG) {
    state.bucketFill = Math.max(0, state.bucketFill - 0.003);
  }
}

// ── Bulldozer blade push ────────────────────────────────────────────
// Returns reaction force pushing back on chassis (used for pitch torque).
export function bulldozerPush(
  state: BulldozerState,
  field: VoxelField,
  sim: SoilSimulator,
): { changed: boolean; reactionForce: number } {
  const driveIntensity = clamp01((Math.abs(state.vehicle.tracks.leftSpeed) + Math.abs(state.vehicle.tracks.rightSpeed)) * 0.5);
  if (driveIntensity < 0.08) return { changed: false, reactionForce: 0 };

  const blade = computeBladeGeometry(state);
  let didPush = false;
  let reactionForce = 0;

  for (const point of blade.samplePoints) {
    const terrainY = getTerrainHeight(field, point[0], point[2]);
    const penetration = terrainY - point[1];
    const phi = sampleSDF(field, point[0], point[1], point[2]);

    if (penetration > 0.001 || phi < 0) {
      const cutRadius = 0.013 + Math.min(0.012, Math.max(0, penetration) * 0.5);
      field.applyStamp(point[0], point[1] - 0.002, point[2], cutRadius);

      const pen = Math.max(0.001, penetration);
      const mat = getMaterialAt(point[0], point[1] - 0.005, point[2]);
      reactionForce += pen * (15 + mat.cohesion * 22 + mat.specificWeight * 8) * driveIntensity;

      // Deposit material in front of blade (berm buildup)
      const pushDist = 0.026 + driveIntensity * 0.02 + pen * 0.4;
      const depositX = point[0] + blade.bladeNormal[0] * pushDist;
      const depositY = terrainY + 0.006;
      const depositZ = point[2] + blade.bladeNormal[2] * pushDist;

      addSoilBrush(
        field,
        depositX,
        depositY,
        depositZ,
        0.010 + driveIntensity * 0.006,
        3200 + driveIntensity * 4200,
        22,
      );

      didPush = true;
    }
  }

  if (didPush) {
    sim.activate();
  }

  return { changed: didPush, reactionForce };
}
