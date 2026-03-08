// ── SDF ↔ MPM Particle Bridge ────────────────────────────────────────
// Handles the two-way conversion between the static SDF voxel field and
// dynamic MLS-MPM particles:
//   1. SPAWN: Detect unstable SDF surface voxels → create particles, carve SDF
//   2. DEPOSIT: Detect settled particles → write back into SDF, deactivate

import { VoxelField } from '../soil/VoxelField';
import { getMaterialAt } from '../soil/materialBrain';
import { VOXEL_SIZE, GRID_X, GRID_Y, GRID_Z, SURFACE_IY, DEG } from '../soil/constants';
import {
  MPMSolverState, addParticle, MaterialType,
} from './mpmSolver';
import {
  SETTLE_VELOCITY, SETTLE_FRAMES,
  MPM_WORLD_MIN_X, MPM_WORLD_MAX_X,
  MPM_WORLD_MIN_Y, MPM_WORLD_MAX_Y,
  MPM_WORLD_MIN_Z, MPM_WORLD_MAX_Z,
  MAX_PARTICLES,
} from './constants';

// ── World ↔ MPM coordinate mapping ──────────────────────────────────
// SDF world coords → MPM normalized [0,1]^3
export function worldToMPM(wx: number, wy: number, wz: number): [number, number, number] {
  return [
    (wx - MPM_WORLD_MIN_X) / (MPM_WORLD_MAX_X - MPM_WORLD_MIN_X),
    (wy - MPM_WORLD_MIN_Y) / (MPM_WORLD_MAX_Y - MPM_WORLD_MIN_Y),
    (wz - MPM_WORLD_MIN_Z) / (MPM_WORLD_MAX_Z - MPM_WORLD_MIN_Z),
  ];
}

// MPM normalized [0,1]^3 → SDF world coords
export function mpmToWorld(mx: number, my: number, mz: number): [number, number, number] {
  return [
    mx * (MPM_WORLD_MAX_X - MPM_WORLD_MIN_X) + MPM_WORLD_MIN_X,
    my * (MPM_WORLD_MAX_Y - MPM_WORLD_MIN_Y) + MPM_WORLD_MIN_Y,
    mz * (MPM_WORLD_MAX_Z - MPM_WORLD_MIN_Z) + MPM_WORLD_MIN_Z,
  ];
}

// Map material brain properties to MaterialType enum
function classifyMaterial(friction: number, cohesion: number): MaterialType {
  if (cohesion > 0.6) return MaterialType.Clay;
  if (cohesion > 0.35) return MaterialType.Loam;
  if (cohesion > 0.2) return MaterialType.Organic;
  if (friction > 30 * DEG) return MaterialType.Sand;
  if (friction > 27 * DEG) return MaterialType.Gravel;
  return MaterialType.Silt;
}

// ── SPAWN: SDF → Particles ───────────────────────────────────────────
// Called after a dig event. Scans disturbed surface voxels, checks
// Mohr-Coulomb slope stability, and spawns particles from unstable ones.

export function spawnParticlesFromSDF(
  field: VoxelField,
  solver: MPMSolverState,
  maxSpawnPerCall: number = 2048,
): number {
  const NX = field.nx, NY = field.ny, NZ = field.nz;
  let spawned = 0;

  for (let iz = 1; iz < NZ && spawned < maxSpawnPerCall; iz++) {
    for (let iy = 1; iy < NY && spawned < maxSpawnPerCall; iy++) {
      for (let ix = 1; ix < NX && spawned < maxSpawnPerCall; ix++) {
        const idx = field.vidx(ix, iy, iz);
        const phi = field.phi[idx];

        // Only near-surface solid voxels (recently disturbed)
        if (phi >= 0 || phi < -8000) continue;
        if (field.disturbanceAge[idx] > 2) continue; // only freshly disturbed

        // Must be adjacent to air
        let hasAir = false;
        const dirs: [number,number,number][] = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
        for (const [dx, dy, dz] of dirs) {
          const ni = ix+dx, nj = iy+dy, nk = iz+dz;
          if (ni < 0 || ni > NX || nj < 0 || nj > NY || nk < 0 || nk > NZ) continue;
          if (field.phi[field.vidx(ni, nj, nk)] > 0) { hasAir = true; break; }
        }
        if (!hasAir) continue;

        // Gradient → surface normal
        const [gx, gy, gz] = field.gradient(ix, iy, iz);
        const glen = Math.sqrt(gx*gx + gy*gy + gz*gz);
        if (glen < 10) continue;

        const ny_n = gy / glen; // up component of normal

        // Slope angle
        const slopeAngle = Math.acos(Math.max(-1, Math.min(1, ny_n)));

        // Material properties
        const wx = field.worldX(ix);
        const wy = field.worldY(iy);
        const wz = field.worldZ(iz);
        const mat = getMaterialAt(wx, wy, wz);

        // Mohr-Coulomb: slope must exceed effective friction angle
        const effAngle = mat.frictionAngle + mat.cohesion * 0.9;
        if (slopeAngle <= effAngle) continue;

        // Check if in MPM domain
        const [mx, my, mz] = worldToMPM(wx, wy, wz);
        if (mx < 0.05 || mx > 0.95 || my < 0.05 || my > 0.95 || mz < 0.05 || mz > 0.95) continue;

        if (solver.numParticles >= MAX_PARTICLES) return spawned;

        // Spawn particle
        const matType = classifyMaterial(mat.frictionAngle, mat.cohesion);
        addParticle(solver, mx, my, mz, matType, mat.frictionAngle, mat.cohesion, 1.0);

        // Carve SDF: make this voxel more air-like
        field.phi[idx] = Math.min(32767, phi + 12000) as number;
        field.disturbanceAge[idx] = 0;

        spawned++;
      }
    }
  }
  return spawned;
}

// ── DEPOSIT: Particles → SDF ─────────────────────────────────────────
// Scans particles. If velocity is below threshold for enough frames,
// deposits the particle back into the SDF field and deactivates it.

export function depositParticlesIntoSDF(
  field: VoxelField,
  solver: MPMSolverState,
): number {
  let deposited = 0;

  for (let p = 0; p < solver.numParticles; p++) {
    if (!solver.active[p]) continue;

    const speed = Math.sqrt(
      solver.vx[p]*solver.vx[p] +
      solver.vy[p]*solver.vy[p] +
      solver.vz[p]*solver.vz[p]
    );

    if (speed < SETTLE_VELOCITY) {
      solver.settleCounter[p]++;
    } else {
      solver.settleCounter[p] = 0;
    }

    if (solver.settleCounter[p] < SETTLE_FRAMES) continue;

    // Convert MPM position back to SDF world coords
    const [wx, wy, wz] = mpmToWorld(solver.px[p], solver.py[p], solver.pz[p]);

    // Convert to grid indices
    const gx = wx / VOXEL_SIZE + GRID_X / 2;
    const gy = wy / VOXEL_SIZE + SURFACE_IY;
    const gz = wz / VOXEL_SIZE + GRID_Z / 2;

    const ix = Math.round(gx);
    const iy = Math.round(gy);
    const iz = Math.round(gz);

    if (ix < 0 || ix > field.nx || iy < 0 || iy > field.ny || iz < 0 || iz > field.nz) {
      solver.active[p] = 0;
      continue;
    }

    // Deposit: make this voxel more solid
    const idx = field.vidx(ix, iy, iz);
    field.phi[idx] = Math.max(-32767, field.phi[idx] - 10000) as number;
    field.disturbanceAge[idx] = 0;

    // Also fill neighbors slightly for smoother deposition
    const neighborDirs: [number,number,number][] = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
    for (const [dx, dy, dz] of neighborDirs) {
      const ni = ix+dx, nj = iy+dy, nk = iz+dz;
      if (ni < 0 || ni > field.nx || nj < 0 || nj > field.ny || nk < 0 || nk > field.nz) continue;
      const nidx = field.vidx(ni, nj, nk);
      if (field.phi[nidx] > 0) {
        field.phi[nidx] = Math.max(-32767, field.phi[nidx] - 3000) as number;
        field.disturbanceAge[nidx] = 0;
      }
    }

    solver.active[p] = 0;
    deposited++;
  }
  return deposited;
}
