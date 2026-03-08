// ── Hybrid Soil Simulator ────────────────────────────────────────────
// Combines the SDF voxel field with an MLS-MPM particle solver.
// The old slope-transfer sim is replaced by the particle bridge:
//   - After dig: spawn particles from unstable surface voxels
//   - Each frame: step MPM solver (multiple substeps)
//   - Settled particles deposit back into SDF

import { VoxelField } from './VoxelField';
import { SIM_DEACTIVATE_FRAMES } from './constants';
import {
  MPMSolverState, createSolverState, mpmStep, getActiveParticleCount,
} from '../mpm/mpmSolver';
import { MPM_DT, MPM_STEPS_PER_FRAME } from '../mpm/constants';
import { spawnParticlesFromSDF, depositParticlesIntoSDF } from '../mpm/bridge';

export class SoilSimulator {
  field: VoxelField;
  mpm: MPMSolverState;
  simActive = false;
  idleFrames = 0;

  constructor(field: VoxelField) {
    this.field = field;
    this.mpm = createSolverState();
  }

  activate() {
    this.simActive = true;
    this.idleFrames = 0;

    // Spawn particles from newly unstable surface
    spawnParticlesFromSDF(this.field, this.mpm);
  }

  step(_dt: number): boolean {
    if (!this.simActive) return false;

    const activeCount = getActiveParticleCount(this.mpm);
    if (activeCount === 0) {
      this.idleFrames++;
      if (this.idleFrames > SIM_DEACTIVATE_FRAMES) this.simActive = false;
      return false;
    }

    // Run MPM substeps with SDF collision
    for (let i = 0; i < MPM_STEPS_PER_FRAME; i++) {
      mpmStep(this.mpm, MPM_DT, this.field);
    }

    // Try to deposit settled particles back into SDF
    depositParticlesIntoSDF(this.field, this.mpm);

    this.idleFrames = 0;
    return true;
  }

  getActiveParticles(): number {
    return getActiveParticleCount(this.mpm);
  }
}
