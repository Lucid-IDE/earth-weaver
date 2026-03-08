// ── CPU MLS-MPM Solver with Drucker-Prager Elastoplasticity ──────────
// Based on the MLS-MPM formulation (Hu et al. 2018) with:
//   - Neo-Hookean hyperelastic stress
//   - SVD-based Drucker-Prager return mapping
//   - Full deformation gradient tracking (F, stored per particle)
//   - APIC affine velocity field (C matrix)
//   - SDF terrain collision at grid nodes

import { svd3x3, svdRecompose } from './svd3';
import {
  MPM_GRID, MPM_DX, MPM_INV_DX, MPM_DT, MPM_GRAVITY,
  MAX_PARTICLES, MU_0, LAMBDA_0,
  MPM_VELOCITY_DAMPING,
  MPM_WORLD_MIN_X, MPM_WORLD_MAX_X,
  MPM_WORLD_MIN_Y, MPM_WORLD_MAX_Y,
  MPM_WORLD_MIN_Z, MPM_WORLD_MAX_Z,
} from './constants';
import { VoxelField } from '../soil/VoxelField';
import { VOXEL_SIZE, SURFACE_IY } from '../soil/constants';

// ── Particle data ────────────────────────────────────────────────────
export const enum MaterialType {
  Sand = 0,
  Clay = 1,
  Silt = 2,
  Organic = 3,
  Gravel = 4,
  Loam = 5,
}

export interface MPMSolverState {
  px: Float32Array;  py: Float32Array;  pz: Float32Array;
  vx: Float32Array;  vy: Float32Array;  vz: Float32Array;
  F: Float32Array;
  C: Float32Array;
  mass: Float32Array;
  volume: Float32Array;
  materialType: Uint8Array;
  frictionAngle: Float32Array;
  cohesion: Float32Array;
  mu: Float32Array;       // per-particle shear modulus
  lambda: Float32Array;   // per-particle Lamé first parameter
  damping: Float32Array;  // per-particle velocity damping
  moisture: Float32Array;  // per-particle moisture level
  settleCounter: Uint16Array;
  active: Uint8Array;
  numParticles: number;
  gridMass: Float32Array;
  gridVx: Float32Array;
  gridVy: Float32Array;
  gridVz: Float32Array;
}

const GRID_TOTAL = (MPM_GRID + 1) * (MPM_GRID + 1) * (MPM_GRID + 1);

export function createSolverState(): MPMSolverState {
  return {
    px: new Float32Array(MAX_PARTICLES),
    py: new Float32Array(MAX_PARTICLES),
    pz: new Float32Array(MAX_PARTICLES),
    vx: new Float32Array(MAX_PARTICLES),
    vy: new Float32Array(MAX_PARTICLES),
    vz: new Float32Array(MAX_PARTICLES),
    F: new Float32Array(MAX_PARTICLES * 9),
    C: new Float32Array(MAX_PARTICLES * 9),
    mass: new Float32Array(MAX_PARTICLES),
    volume: new Float32Array(MAX_PARTICLES),
    materialType: new Uint8Array(MAX_PARTICLES),
    frictionAngle: new Float32Array(MAX_PARTICLES),
    cohesion: new Float32Array(MAX_PARTICLES),
    settleCounter: new Uint16Array(MAX_PARTICLES),
    active: new Uint8Array(MAX_PARTICLES),
    numParticles: 0,
    gridMass: new Float32Array(GRID_TOTAL),
    gridVx: new Float32Array(GRID_TOTAL),
    gridVy: new Float32Array(GRID_TOTAL),
    gridVz: new Float32Array(GRID_TOTAL),
  };
}

export function initParticleF(state: MPMSolverState, idx: number) {
  const off = idx * 9;
  state.F[off + 0] = 1; state.F[off + 1] = 0; state.F[off + 2] = 0;
  state.F[off + 3] = 0; state.F[off + 4] = 1; state.F[off + 5] = 0;
  state.F[off + 6] = 0; state.F[off + 7] = 0; state.F[off + 8] = 1;
}

function clearC(state: MPMSolverState, idx: number) {
  const off = idx * 9;
  for (let k = 0; k < 9; k++) state.C[off + k] = 0;
}

export function addParticle(
  state: MPMSolverState,
  x: number, y: number, z: number,
  matType: number,
  friction: number, coh: number,
  particleMass: number = 1.0,
): number {
  if (state.numParticles >= MAX_PARTICLES) return -1;
  const i = state.numParticles++;
  state.px[i] = x; state.py[i] = y; state.pz[i] = z;
  state.vx[i] = 0; state.vy[i] = 0; state.vz[i] = 0;
  state.mass[i] = particleMass;
  state.volume[i] = MPM_DX * MPM_DX * MPM_DX;
  state.materialType[i] = matType;
  state.frictionAngle[i] = friction;
  state.cohesion[i] = coh;
  state.settleCounter[i] = 0;
  state.active[i] = 1;
  initParticleF(state, i);
  clearC(state, i);
  return i;
}

// ── Grid helpers ─────────────────────────────────────────────────────
const GS = MPM_GRID + 1;
function gidx(i: number, j: number, k: number): number {
  return i + j * GS + k * GS * GS;
}

function bsplineWeight(x: number): number {
  const ax = Math.abs(x);
  if (ax < 0.5) return 0.75 - ax * ax;
  if (ax < 1.5) { const t = 1.5 - ax; return 0.5 * t * t; }
  return 0;
}

// ── SDF sampling helpers ─────────────────────────────────────────────
// Convert MPM grid node to world coordinates
function gridNodeToWorld(gi: number, gj: number, gk: number): [number, number, number] {
  const mx = gi * MPM_DX;
  const my = gj * MPM_DX;
  const mz = gk * MPM_DX;
  return [
    mx * (MPM_WORLD_MAX_X - MPM_WORLD_MIN_X) + MPM_WORLD_MIN_X,
    my * (MPM_WORLD_MAX_Y - MPM_WORLD_MIN_Y) + MPM_WORLD_MIN_Y,
    mz * (MPM_WORLD_MAX_Z - MPM_WORLD_MIN_Z) + MPM_WORLD_MIN_Z,
  ];
}

// Sample SDF phi at world position, returns normalized phi (-1 to 1) and gradient
function sampleSDF(field: VoxelField, wx: number, wy: number, wz: number): { phi: number; gx: number; gy: number; gz: number } {
  // World → voxel index (floating point)
  const fix = wx / VOXEL_SIZE + field.nx / 2;
  const fiy = wy / VOXEL_SIZE + SURFACE_IY;
  const fiz = wz / VOXEL_SIZE + field.nz / 2;

  const ix = Math.round(fix);
  const iy = Math.round(fiy);
  const iz = Math.round(fiz);

  if (ix < 0 || ix > field.nx || iy < 0 || iy > field.ny || iz < 0 || iz > field.nz) {
    return { phi: 1, gx: 0, gy: 1, gz: 0 }; // outside = air
  }

  const phi = field.phi[field.vidx(ix, iy, iz)] / 32767; // normalize to [-1, 1]

  // Compute gradient for surface normal
  const [gradX, gradY, gradZ] = field.gradient(
    Math.max(0, Math.min(field.nx, ix)),
    Math.max(0, Math.min(field.ny, iy)),
    Math.max(0, Math.min(field.nz, iz)),
  );

  return { phi, gx: gradX, gy: gradY, gz: gradZ };
}

// ── MLS-MPM Step ─────────────────────────────────────────────────────

export function mpmStep(state: MPMSolverState, dt: number = MPM_DT, field?: VoxelField): void {
  clearGrid(state);
  particleToGrid(state, dt);
  gridUpdate(state, dt, field);
  gridToParticle(state, dt);
}

function clearGrid(state: MPMSolverState) {
  state.gridMass.fill(0);
  state.gridVx.fill(0);
  state.gridVy.fill(0);
  state.gridVz.fill(0);
}

// ── P2G: Particle to Grid ────────────────────────────────────────────
function particleToGrid(state: MPMSolverState, dt: number) {
  const invDx = MPM_INV_DX;
  const dx = MPM_DX;

  for (let p = 0; p < state.numParticles; p++) {
    if (!state.active[p]) continue;

    const x = state.px[p], y = state.py[p], z = state.pz[p];
    const pmass = state.mass[p];
    const pvol = state.volume[p];

    // Base grid node
    const bx = Math.floor(x * invDx - 0.5);
    const by = Math.floor(y * invDx - 0.5);
    const bz = Math.floor(z * invDx - 0.5);

    // Fractional position relative to base node
    const fx = x * invDx - bx;
    const fy = y * invDx - by;
    const fz = z * invDx - bz;

    // ── Compute stress via Neo-Hookean + Drucker-Prager ──
    const fOff = p * 9;
    const F: [number,number,number,number,number,number,number,number,number] = [
      state.F[fOff], state.F[fOff+1], state.F[fOff+2],
      state.F[fOff+3], state.F[fOff+4], state.F[fOff+5],
      state.F[fOff+6], state.F[fOff+7], state.F[fOff+8],
    ];

    // SVD: F = U Σ V^T
    const { U, sigma, V } = svd3x3(F);

    // ── Drucker-Prager return mapping on singular values ──
    const friction = state.frictionAngle[p];
    const coh = state.cohesion[p];

    // Log-strain: ε = log(σ_i)
    const eps = [Math.log(Math.max(1e-8, sigma[0])),
                 Math.log(Math.max(1e-8, sigma[1])),
                 Math.log(Math.max(1e-8, sigma[2]))];

    const epsTrace = eps[0] + eps[1] + eps[2];

    // Deviatoric strain
    const epsDev = [eps[0] - epsTrace / 3, eps[1] - epsTrace / 3, eps[2] - epsTrace / 3];
    const epsDevNorm = Math.sqrt(epsDev[0]*epsDev[0] + epsDev[1]*epsDev[1] + epsDev[2]*epsDev[2]);

    // Drucker-Prager yield function
    const sinPhi = Math.sin(friction);
    const cosPhi = Math.cos(friction);
    const alpha = Math.sqrt(2/3) * 2 * sinPhi / (3 - sinPhi);
    const kc = Math.sqrt(2/3) * 2 * coh * cosPhi / (3 - sinPhi);

    const yieldFunc = epsDevNorm + alpha * epsTrace - kc;

    let projSigma: [number, number, number];

    if (epsTrace > 0) {
      // Tension → clamp to identity (material separates)
      projSigma = [1, 1, 1];
    } else if (yieldFunc > 0) {
      // Yielding → project back onto yield surface
      const deltaGamma = yieldFunc / (1 + alpha * alpha);
      const projEps = [
        eps[0] - deltaGamma * (epsDev[0] / (epsDevNorm + 1e-10)),
        eps[1] - deltaGamma * (epsDev[1] / (epsDevNorm + 1e-10)),
        eps[2] - deltaGamma * (epsDev[2] / (epsDevNorm + 1e-10)),
      ];
      projSigma = [Math.exp(projEps[0]), Math.exp(projEps[1]), Math.exp(projEps[2])];
    } else {
      // Elastic — keep current singular values
      projSigma = [sigma[0], sigma[1], sigma[2]];
    }

    // Reconstruct projected F
    const Fproj = svdRecompose(U, projSigma, V);
    for (let k = 0; k < 9; k++) state.F[fOff + k] = Fproj[k];

    // Determinant J
    const J = projSigma[0] * projSigma[1] * projSigma[2];
    const logJ = Math.log(Math.max(1e-10, J));

    // Neo-Hookean Kirchhoff stress: τ = μ(FFᵀ - I) + λ ln(J) I
    // For MLS-MPM we need: stress = -pvol * 4/dx² * τ
    // We compute Cauchy stress σ = τ / J, then multiply
    const mu = MU_0;
    const lam = LAMBDA_0;

    // FFᵀ
    const FFt = [
      Fproj[0]*Fproj[0]+Fproj[1]*Fproj[1]+Fproj[2]*Fproj[2],
      Fproj[0]*Fproj[3]+Fproj[1]*Fproj[4]+Fproj[2]*Fproj[5],
      Fproj[0]*Fproj[6]+Fproj[1]*Fproj[7]+Fproj[2]*Fproj[8],
      Fproj[3]*Fproj[0]+Fproj[4]*Fproj[1]+Fproj[5]*Fproj[2],
      Fproj[3]*Fproj[3]+Fproj[4]*Fproj[4]+Fproj[5]*Fproj[5],
      Fproj[3]*Fproj[6]+Fproj[4]*Fproj[7]+Fproj[5]*Fproj[8],
      Fproj[6]*Fproj[0]+Fproj[7]*Fproj[1]+Fproj[8]*Fproj[2],
      Fproj[6]*Fproj[3]+Fproj[7]*Fproj[4]+Fproj[8]*Fproj[5],
      Fproj[6]*Fproj[6]+Fproj[7]*Fproj[7]+Fproj[8]*Fproj[8],
    ];

    // Kirchhoff stress τ = μ(FFᵀ - I) + λ ln(J) I
    const tau = [
      mu * (FFt[0] - 1) + lam * logJ,
      mu * FFt[1],
      mu * FFt[2],
      mu * FFt[3],
      mu * (FFt[4] - 1) + lam * logJ,
      mu * FFt[5],
      mu * FFt[6],
      mu * FFt[7],
      mu * (FFt[8] - 1) + lam * logJ,
    ];

    // MLS-MPM stress contribution: -pvol * 4 * invDx² * τ * dt
    const stressScale = -pvol * 4 * invDx * invDx * dt;

    // APIC C matrix
    const cOff = p * 9;

    // Scatter to 3×3×3 grid neighborhood
    for (let di = 0; di < 3; di++) {
      for (let dj = 0; dj < 3; dj++) {
        for (let dk = 0; dk < 3; dk++) {
          const gi = bx + di, gj = by + dj, gk = bz + dk;
          if (gi < 0 || gi >= GS || gj < 0 || gj >= GS || gk < 0 || gk >= GS) continue;

          const wx = bsplineWeight(fx - di);
          const wy = bsplineWeight(fy - dj);
          const wz = bsplineWeight(fz - dk);
          const w = wx * wy * wz;
          if (w < 1e-12) continue;

          // Grid-to-particle offset (in grid space)
          const dpos_x = (di - fx) * dx;
          const dpos_y = (dj - fy) * dx;
          const dpos_z = (dk - fz) * dx;

          // APIC momentum transfer: m_p * (v_p + C_p * dpos)
          const apic_vx = state.vx[p] + state.C[cOff+0]*dpos_x + state.C[cOff+1]*dpos_y + state.C[cOff+2]*dpos_z;
          const apic_vy = state.vy[p] + state.C[cOff+3]*dpos_x + state.C[cOff+4]*dpos_y + state.C[cOff+5]*dpos_z;
          const apic_vz = state.vz[p] + state.C[cOff+6]*dpos_x + state.C[cOff+7]*dpos_y + state.C[cOff+8]*dpos_z;

          // Stress force: τ * dpos
          const force_x = tau[0]*dpos_x + tau[1]*dpos_y + tau[2]*dpos_z;
          const force_y = tau[3]*dpos_x + tau[4]*dpos_y + tau[5]*dpos_z;
          const force_z = tau[6]*dpos_x + tau[7]*dpos_y + tau[8]*dpos_z;

          const idx = gidx(gi, gj, gk);
          const wm = w * pmass;
          state.gridMass[idx] += wm;
          state.gridVx[idx] += wm * apic_vx + stressScale * w * force_x;
          state.gridVy[idx] += wm * apic_vy + stressScale * w * force_y;
          state.gridVz[idx] += wm * apic_vz + stressScale * w * force_z;
        }
      }
    }
  }
}

// ── Grid Update: gravity + SDF collision + boundary conditions ───────
function gridUpdate(state: MPMSolverState, dt: number, field?: VoxelField) {
  const boundary = 3;

  for (let k = 0; k < GS; k++) {
    for (let j = 0; j < GS; j++) {
      for (let i = 0; i < GS; i++) {
        const idx = gidx(i, j, k);
        const m = state.gridMass[idx];
        if (m < 1e-10) continue;

        // Normalize momentum → velocity
        const invM = 1.0 / m;
        let vx = state.gridVx[idx] * invM;
        let vy = state.gridVy[idx] * invM;
        let vz = state.gridVz[idx] * invM;

        // Apply gravity
        vy += MPM_GRAVITY * dt;

        // ── SDF terrain collision ────────────────────────────
        if (field) {
          const [wx, wy, wz] = gridNodeToWorld(i, j, k);
          const sdf = sampleSDF(field, wx, wy, wz);

          // phi < 0 means inside solid terrain
          if (sdf.phi < 0) {
            const glen = Math.sqrt(sdf.gx * sdf.gx + sdf.gy * sdf.gy + sdf.gz * sdf.gz);
            if (glen > 1e-6) {
              // Surface normal points outward (toward air = positive phi)
              const nx = sdf.gx / glen;
              const ny = sdf.gy / glen;
              const nz = sdf.gz / glen;

              // Velocity component into the solid (negative = penetrating)
              const vDotN = vx * nx + vy * ny + vz * nz;

              if (vDotN < 0) {
                // Remove normal component (no-penetration)
                vx -= vDotN * nx;
                vy -= vDotN * ny;
                vz -= vDotN * nz;

                // Apply friction to tangential component
                const frictionCoeff = 0.5;
                const tvx = vx - (vx * nx + vy * ny + vz * nz) * nx; // should be ~0 normal now
                const tvy = vy - (vx * nx + vy * ny + vz * nz) * ny;
                const tvz = vz - (vx * nx + vy * ny + vz * nz) * nz;
                const tSpeed = Math.sqrt(tvx * tvx + tvy * tvy + tvz * tvz);
                if (tSpeed > 1e-8) {
                  const frictionForce = Math.min(frictionCoeff * Math.abs(vDotN), tSpeed);
                  const scale = 1 - frictionForce / tSpeed;
                  vx = (vx - tvx) + tvx * scale;
                  vy = (vy - tvy) + tvy * scale;
                  vz = (vz - tvz) + tvz * scale;
                }
              }
            }
          }
        }

        // Domain boundary: sticky walls, slip floor
        if (i < boundary || i >= GS - boundary) vx = 0;
        if (k < boundary || k >= GS - boundary) vz = 0;
        if (j < boundary) {
          vy = Math.max(0, vy); // floor: no downward velocity
        }
        if (j >= GS - boundary) {
          vy = Math.min(0, vy);
        }

        state.gridVx[idx] = vx;
        state.gridVy[idx] = vy;
        state.gridVz[idx] = vz;
      }
    }
  }
}

// ── G2P: Grid to Particle ────────────────────────────────────────────
function gridToParticle(state: MPMSolverState, dt: number) {
  const invDx = MPM_INV_DX;
  const dx = MPM_DX;

  for (let p = 0; p < state.numParticles; p++) {
    if (!state.active[p]) continue;

    const x = state.px[p], y = state.py[p], z = state.pz[p];
    const bx = Math.floor(x * invDx - 0.5);
    const by = Math.floor(y * invDx - 0.5);
    const bz = Math.floor(z * invDx - 0.5);
    const fx = x * invDx - bx;
    const fy = y * invDx - by;
    const fz = z * invDx - bz;

    let newVx = 0, newVy = 0, newVz = 0;

    // New APIC C matrix
    const cOff = p * 9;
    for (let k = 0; k < 9; k++) state.C[cOff + k] = 0;

    for (let di = 0; di < 3; di++) {
      for (let dj = 0; dj < 3; dj++) {
        for (let dk = 0; dk < 3; dk++) {
          const gi = bx + di, gj = by + dj, gk = bz + dk;
          if (gi < 0 || gi >= GS || gj < 0 || gj >= GS || gk < 0 || gk >= GS) continue;

          const wx = bsplineWeight(fx - di);
          const wy = bsplineWeight(fy - dj);
          const wz = bsplineWeight(fz - dk);
          const w = wx * wy * wz;
          if (w < 1e-12) continue;

          const idx = gidx(gi, gj, gk);
          const gvx = state.gridVx[idx];
          const gvy = state.gridVy[idx];
          const gvz = state.gridVz[idx];

          newVx += w * gvx;
          newVy += w * gvy;
          newVz += w * gvz;

          // APIC: C += 4/dx² * w * v_i ⊗ dpos
          const dpos_x = (di - fx) * dx;
          const dpos_y = (dj - fy) * dx;
          const dpos_z = (dk - fz) * dx;
          const scale = 4 * invDx * invDx * w;

          state.C[cOff + 0] += scale * gvx * dpos_x;
          state.C[cOff + 1] += scale * gvx * dpos_y;
          state.C[cOff + 2] += scale * gvx * dpos_z;
          state.C[cOff + 3] += scale * gvy * dpos_x;
          state.C[cOff + 4] += scale * gvy * dpos_y;
          state.C[cOff + 5] += scale * gvy * dpos_z;
          state.C[cOff + 6] += scale * gvz * dpos_x;
          state.C[cOff + 7] += scale * gvz * dpos_y;
          state.C[cOff + 8] += scale * gvz * dpos_z;
        }
      }
    }

    state.vx[p] = newVx;
    state.vy[p] = newVy;
    state.vz[p] = newVz;

    // Update deformation gradient: F = (I + dt * C) * F_old
    const fOff = p * 9;
    const Fold = [
      state.F[fOff], state.F[fOff+1], state.F[fOff+2],
      state.F[fOff+3], state.F[fOff+4], state.F[fOff+5],
      state.F[fOff+6], state.F[fOff+7], state.F[fOff+8],
    ];

    // (I + dt*C)
    const A = [
      1 + dt * state.C[cOff+0], dt * state.C[cOff+1], dt * state.C[cOff+2],
      dt * state.C[cOff+3], 1 + dt * state.C[cOff+4], dt * state.C[cOff+5],
      dt * state.C[cOff+6], dt * state.C[cOff+7], 1 + dt * state.C[cOff+8],
    ];

    // F_new = A * F_old
    state.F[fOff + 0] = A[0]*Fold[0] + A[1]*Fold[3] + A[2]*Fold[6];
    state.F[fOff + 1] = A[0]*Fold[1] + A[1]*Fold[4] + A[2]*Fold[7];
    state.F[fOff + 2] = A[0]*Fold[2] + A[1]*Fold[5] + A[2]*Fold[8];
    state.F[fOff + 3] = A[3]*Fold[0] + A[4]*Fold[3] + A[5]*Fold[6];
    state.F[fOff + 4] = A[3]*Fold[1] + A[4]*Fold[4] + A[5]*Fold[7];
    state.F[fOff + 5] = A[3]*Fold[2] + A[4]*Fold[5] + A[5]*Fold[8];
    state.F[fOff + 6] = A[6]*Fold[0] + A[7]*Fold[3] + A[8]*Fold[6];
    state.F[fOff + 7] = A[6]*Fold[1] + A[7]*Fold[4] + A[8]*Fold[7];
    state.F[fOff + 8] = A[6]*Fold[2] + A[7]*Fold[5] + A[8]*Fold[8];

    // Advect position
    state.px[p] += dt * newVx;
    state.py[p] += dt * newVy;
    state.pz[p] += dt * newVz;

    // Clamp to domain
    const margin = 3 * dx;
    state.px[p] = Math.max(margin, Math.min(1 - margin, state.px[p]));
    state.py[p] = Math.max(margin, Math.min(1 - margin, state.py[p]));
    state.pz[p] = Math.max(margin, Math.min(1 - margin, state.pz[p]));
  }
}

// ── Utilities ────────────────────────────────────────────────────────
export function getActiveParticleCount(state: MPMSolverState): number {
  let count = 0;
  for (let i = 0; i < state.numParticles; i++) {
    if (state.active[i]) count++;
  }
  return count;
}
