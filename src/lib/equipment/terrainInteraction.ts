// ── Equipment-Terrain Interaction ────────────────────────────────────
// Handles how equipment modifies the SDF field and spawns MPM particles

import { VoxelField } from '../soil/VoxelField';
import { SoilSimulator } from '../soil/soilSim';
import { ExcavatorState, BulldozerState } from './types';
import { computeExcavatorFK } from './excavator';
import { computeBladeGeometry } from './bulldozer';

// Excavator bucket dig — applies stamp at each tooth position
export function excavatorDig(
  state: ExcavatorState,
  field: VoxelField,
  sim: SoilSimulator,
  digRadius: number = 0.035,
): boolean {
  const fk = computeExcavatorFK(state);
  
  // Check if bucket tip is below surface (in terrain)
  // Sample SDF at bucket tip
  let didDig = false;
  
  for (const tooth of fk.bucketTeeth) {
    // Check if tooth is in terrain
    const ix = Math.round(tooth[0] / 0.025 + field.nx / 2);
    const iy = Math.round(tooth[1] / 0.025 + 24); // SURFACE_IY
    const iz = Math.round(tooth[2] / 0.025 + field.nz / 2);
    
    if (ix < 0 || ix > field.nx || iy < 0 || iy > field.ny || iz < 0 || iz > field.nz) continue;
    
    const phi = field.phi[field.vidx(ix, iy, iz)];
    if (phi < 0) {
      // Tooth is inside terrain — dig!
      field.applyStamp(tooth[0], tooth[1], tooth[2], digRadius);
      didDig = true;
    }
  }
  
  if (didDig) {
    sim.activate();
  }
  
  return didDig;
}

// Bulldozer blade push — displaces soil forward along blade normal
export function bulldozerPush(
  state: BulldozerState,
  field: VoxelField,
  sim: SoilSimulator,
): boolean {
  // Only push when blade is at or below surface level
  if (state.bladeHeight > 0.01) return false;
  
  const blade = computeBladeGeometry(state);
  let didPush = false;
  
  const pushRadius = 0.02;
  
  for (const point of blade.samplePoints) {
    // Check if blade point intersects terrain
    const ix = Math.round(point[0] / 0.025 + field.nx / 2);
    const iy = Math.round(point[1] / 0.025 + 24);
    const iz = Math.round(point[2] / 0.025 + field.nz / 2);
    
    if (ix < 0 || ix > field.nx || iy < 0 || iy > field.ny || iz < 0 || iz > field.nz) continue;
    
    const phi = field.phi[field.vidx(ix, iy, iz)];
    if (phi < 0) {
      // Blade intersects terrain — carve and push
      field.applyStamp(point[0], point[1], point[2], pushRadius);
      
      // Also deposit material in front of blade (push effect)
      const pushDist = 0.04;
      const depositX = point[0] + blade.bladeNormal[0] * pushDist;
      const depositY = point[1];
      const depositZ = point[2] + blade.bladeNormal[2] * pushDist;
      
      const dix = Math.round(depositX / 0.025 + field.nx / 2);
      const diy = Math.round(depositY / 0.025 + 24);
      const diz = Math.round(depositZ / 0.025 + field.nz / 2);
      
      if (dix >= 0 && dix <= field.nx && diy >= 0 && diy <= field.ny && diz >= 0 && diz <= field.nz) {
        const didx = field.vidx(dix, diy, diz);
        field.phi[didx] = Math.max(-32767, field.phi[didx] - 5000) as number;
        field.disturbanceAge[didx] = 100;
      }
      
      didPush = true;
    }
  }
  
  if (didPush) {
    sim.activate();
  }
  
  return didPush;
}
