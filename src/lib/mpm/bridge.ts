// ── SDF ↔ MPM Particle Bridge ────────────────────────────────────────
// Handles the two-way conversion between the static SDF voxel field and
// dynamic MLS-MPM particles:
//   1. SPAWN: Dense shell of particles along newly exposed cavity surface
//   2. DEPOSIT: Detect settled particles → write back into SDF, deactivate

import { VoxelField } from '../soil/VoxelField';
import { getMaterialAt } from '../soil/materialBrain';
import { VOXEL_SIZE, GRID_X, GRID_Z, SURFACE_IY, DEG } from '../soil/constants';
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
export function worldToMPM(wx: number, wy: number, wz: number): [number, number, number] {
  return [
    (wx - MPM_WORLD_MIN_X) / (MPM_WORLD_MAX_X - MPM_WORLD_MIN_X),
    (wy - MPM_WORLD_MIN_Y) / (MPM_WORLD_MAX_Y - MPM_WORLD_MIN_Y),
    (wz - MPM_WORLD_MIN_Z) / (MPM_WORLD_MAX_Z - MPM_WORLD_MIN_Z),
  ];
}

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

// Simple seeded random for jittering particle positions
let _seed = 12345;
function srand(): number {
  _seed = (_seed * 16807 + 0) % 2147483647;
  return (_seed & 0x7fffffff) / 0x7fffffff;
}

// ── SPAWN: Dense shell filling along cavity surface ──────────────────
// Called after a dig event. Scans voxels within the dig radius:
// - For each solid voxel (phi < 0) that is adjacent to air (phi > 0)
//   and within SHELL_DEPTH voxels of the newly carved surface:
//   spawn 2-4 particles at jittered positions, then carve that voxel to air.
// This creates a dense granular shell that the MPM solver will simulate.

const SHELL_DEPTH = 2;         // how many voxels deep to convert to particles
const PARTICLES_PER_VOXEL = 3; // density of spawning

export function spawnParticlesFromSDF(
  field: VoxelField,
  solver: MPMSolverState,
  _maxSpawnPerCall: number = 8192,
): number {
  const NX = field.nx, NY = field.ny, NZ = field.nz;
  let spawned = 0;

  // Scan all voxels looking for freshly disturbed ones (disturbanceAge == 0)
  // that are solid and adjacent to air — these form the cavity shell
  for (let iz = 1; iz < NZ && spawned < _maxSpawnPerCall; iz++) {
    for (let iy = 1; iy < NY && spawned < _maxSpawnPerCall; iy++) {
      for (let ix = 1; ix < NX && spawned < _maxSpawnPerCall; ix++) {
        const idx = field.vidx(ix, iy, iz);

        // Only freshly disturbed voxels
        if (field.disturbanceAge[idx] !== 0) continue;

        const phi = field.phi[idx];

        // We want solid voxels near the new surface
        if (phi >= 0) continue; // already air

        // Check if adjacent to air (within SHELL_DEPTH)
        let nearAir = false;
        for (let sd = 1; sd <= SHELL_DEPTH && !nearAir; sd++) {
          const dirs: [number,number,number][] = [[sd,0,0],[-sd,0,0],[0,sd,0],[0,-sd,0],[0,0,sd],[0,0,-sd]];
          for (const [dx, dy, dz] of dirs) {
            const ni = ix+dx, nj = iy+dy, nk = iz+dz;
            if (ni < 0 || ni > NX || nj < 0 || nj > NY || nk < 0 || nk > NZ) continue;
            if (field.phi[field.vidx(ni, nj, nk)] > 0) { nearAir = true; break; }
          }
        }
        if (!nearAir) continue;

        // Get world position for this voxel
        const wx = field.worldX(ix);
        const wy = field.worldY(iy);
        const wz = field.worldZ(iz);

        // Check if in MPM domain (with margin)
        const [mx, my, mz] = worldToMPM(wx, wy, wz);
        if (mx < 0.06 || mx > 0.94 || my < 0.06 || my > 0.94 || mz < 0.06 || mz > 0.94) continue;

        if (solver.numParticles >= MAX_PARTICLES - PARTICLES_PER_VOXEL) return spawned;

        // Get material properties
        const mat = getMaterialAt(wx, wy, wz);
        const matType = classifyMaterial(mat.frictionAngle, mat.cohesion);

        // Spawn multiple jittered particles within this voxel
        for (let pp = 0; pp < PARTICLES_PER_VOXEL; pp++) {
          // Jitter within the voxel in MPM space
          const jx = (srand() - 0.5) * VOXEL_SIZE;
          const jy = (srand() - 0.5) * VOXEL_SIZE;
          const jz = (srand() - 0.5) * VOXEL_SIZE;
          const [pmx, pmy, pmz] = worldToMPM(wx + jx, wy + jy, wz + jz);

          addParticle(solver, pmx, pmy, pmz, matType, mat.frictionAngle, mat.cohesion, 1.0);
          spawned++;
        }

        // Carve this voxel to air so the SDF mesh recedes
        field.phi[idx] = Math.min(32767, Math.max(phi + 20000, 1000)) as number;
        field.disturbanceAge[idx] = 1; // mark as processed so we don't re-spawn
      }
    }
  }
  return spawned;
}

// ── DEPOSIT: Particles → SDF ─────────────────────────────────────────
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
