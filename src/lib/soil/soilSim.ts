// ── Hybrid Soil Simulator ────────────────────────────────────────────
// Combines the SDF voxel field with an MLS-MPM particle solver.
//   - After dig: spawn particles from unstable surface voxels
//   - Each frame: step MPM solver (multiple substeps)
//   - Settled particles deposit back into SDF
//   - Compact particle arrays to reclaim dead slots

import { VoxelField } from './VoxelField';
import { SIM_DEACTIVATE_FRAMES } from './constants';
import {
  MPMSolverState, createSolverState, mpmStep, getActiveParticleCount,
  initParticleF,
} from '../mpm/mpmSolver';
import { spawnParticlesFromSDF, depositParticlesIntoSDF } from '../mpm/bridge';

const MAX_PARTICLE_LIFETIME = 300; // frames before forced deposit

export class SoilSimulator {
  field: VoxelField;
  mpm: MPMSolverState;
  simActive = false;
  idleFrames = 0;
  private frameCounter = 0;
  private particleAge: Uint16Array;

  constructor(field: VoxelField) {
    this.field = field;
    this.mpm = createSolverState();
    this.particleAge = new Uint16Array(this.mpm.px.length);
  }

  activate() {
    this.simActive = true;
    this.idleFrames = 0;

    // Spawn particles from newly unstable surface
    spawnParticlesFromSDF(this.field, this.mpm);
    // Reset age for newly spawned particles
    for (let i = 0; i < this.mpm.numParticles; i++) {
      if (this.mpm.active[i] && this.particleAge[i] === 0) {
        this.particleAge[i] = 1;
      }
    }
  }

  step(dt: number): boolean {
    if (!this.simActive) return false;
    this.frameCounter++;

    // Age all active particles and force-deposit old ones
    for (let p = 0; p < this.mpm.numParticles; p++) {
      if (!this.mpm.active[p]) continue;
      this.particleAge[p]++;
      if (this.particleAge[p] > MAX_PARTICLE_LIFETIME) {
        this.mpm.active[p] = 0;
        this.particleAge[p] = 0;
      }
    }

    const activeCount = getActiveParticleCount(this.mpm);
    if (activeCount === 0) {
      this.compactParticles();
      this.idleFrames++;
      if (this.idleFrames > SIM_DEACTIVATE_FRAMES) this.simActive = false;
      return false;
    }

    // Use the dt passed from the render loop (real frame time)
    // The simple direct-integration solver is stable at these timesteps
    mpmStep(this.mpm, dt, this.field);

    // Try to deposit settled particles back into SDF
    const deposited = depositParticlesIntoSDF(this.field, this.mpm);

    // Reset age for deposited particles
    if (deposited > 0) {
      for (let p = 0; p < this.mpm.numParticles; p++) {
        if (!this.mpm.active[p]) this.particleAge[p] = 0;
      }
    }

    // Periodically compact to reclaim slots
    if (this.frameCounter % 60 === 0) {
      this.compactParticles();
    }

    this.idleFrames = 0;
    return true;
  }

  // Compact particle arrays — move active particles to front, reduce numParticles
  private compactParticles() {
    const mpm = this.mpm;
    let writeIdx = 0;
    for (let readIdx = 0; readIdx < mpm.numParticles; readIdx++) {
      if (!mpm.active[readIdx]) continue;
      if (writeIdx !== readIdx) {
        // Copy all particle data
        mpm.px[writeIdx] = mpm.px[readIdx];
        mpm.py[writeIdx] = mpm.py[readIdx];
        mpm.pz[writeIdx] = mpm.pz[readIdx];
        mpm.vx[writeIdx] = mpm.vx[readIdx];
        mpm.vy[writeIdx] = mpm.vy[readIdx];
        mpm.vz[writeIdx] = mpm.vz[readIdx];
        mpm.mass[writeIdx] = mpm.mass[readIdx];
        mpm.volume[writeIdx] = mpm.volume[readIdx];
        mpm.materialType[writeIdx] = mpm.materialType[readIdx];
        mpm.frictionAngle[writeIdx] = mpm.frictionAngle[readIdx];
        mpm.cohesion[writeIdx] = mpm.cohesion[readIdx];
        mpm.mu[writeIdx] = mpm.mu[readIdx];
        mpm.lambda[writeIdx] = mpm.lambda[readIdx];
        mpm.damping[writeIdx] = mpm.damping[readIdx];
        mpm.moisture[writeIdx] = mpm.moisture[readIdx];
        mpm.settleCounter[writeIdx] = mpm.settleCounter[readIdx];
        mpm.active[writeIdx] = 1;
        this.particleAge[writeIdx] = this.particleAge[readIdx];
        // Copy F and C (9 elements each)
        const rOff = readIdx * 9, wOff = writeIdx * 9;
        for (let k = 0; k < 9; k++) {
          mpm.F[wOff + k] = mpm.F[rOff + k];
          mpm.C[wOff + k] = mpm.C[rOff + k];
        }
      }
      writeIdx++;
    }
    // Clear slots beyond the new count
    for (let i = writeIdx; i < mpm.numParticles; i++) {
      mpm.active[i] = 0;
      this.particleAge[i] = 0;
    }
    mpm.numParticles = writeIdx;
  }

  getActiveParticles(): number {
    return getActiveParticleCount(this.mpm);
  }
}
