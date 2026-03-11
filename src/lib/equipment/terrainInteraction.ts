// ── Equipment-Terrain Interaction ────────────────────────────────────
// Handles how equipment modifies the SDF field, spawns MPM particles,
// and provides terrain height queries for vehicle following.

import { VoxelField } from '../soil/VoxelField';
import { SoilSimulator } from '../soil/soilSim';
import { VOXEL_SIZE, SURFACE_IY } from '../soil/constants';
import { ExcavatorState, BulldozerState, VehicleState } from './types';
import { computeExcavatorFK } from './excavator';
import { computeBladeGeometry } from './bulldozer';

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

// ── Terrain Height Query ────────────────────────────────────────────
// Find the surface Y at a given world XZ by scanning the SDF column
export function getTerrainHeight(field: VoxelField, wx: number, wz: number): number {
  const gx = worldToGridX(wx, field.nx);
  const gz = worldToGridZ(wz, field.nz);
  
  const ix = Math.round(gx);
  const iz = Math.round(gz);
  
  if (ix < 0 || ix > field.nx || iz < 0 || iz > field.nz) return 0;
  
  // Scan from top down to find first voxel where phi < 0 (inside terrain)
  for (let iy = field.ny; iy >= 0; iy--) {
    const phi = field.phi[field.vidx(
      Math.max(0, Math.min(field.nx, ix)),
      iy,
      Math.max(0, Math.min(field.nz, iz))
    )];
    if (phi < 0) {
      // Found surface — interpolate for smoother result
      const surfaceY = (iy - SURFACE_IY) * VOXEL_SIZE;
      return surfaceY;
    }
  }
  
  // No terrain found, return bottom
  return -SURFACE_IY * VOXEL_SIZE;
}

// ── Update vehicle Y to follow terrain ──────────────────────────────
export function updateVehicleTerrainFollow(vehicle: VehicleState, field: VoxelField) {
  // Sample at multiple points under the vehicle for stability
  const ch = Math.cos(vehicle.heading);
  const sh = Math.sin(vehicle.heading);
  const halfLen = 0.06; // half track length
  
  // Sample at front, back, and center
  const centerY = getTerrainHeight(field, vehicle.posX, vehicle.posZ);
  const frontY = getTerrainHeight(field, 
    vehicle.posX + sh * halfLen, 
    vehicle.posZ + ch * halfLen
  );
  const backY = getTerrainHeight(field, 
    vehicle.posX - sh * halfLen, 
    vehicle.posZ - ch * halfLen
  );
  
  // Average for center height, use front/back for pitch
  const avgY = (centerY + frontY + backY) / 3;
  
  // Smooth follow — don't snap instantly
  const targetY = avgY + 0.015; // offset so tracks sit ON surface, not inside it
  vehicle.posY += (targetY - vehicle.posY) * 0.3;
  
  // Calculate pitch from front/back difference
  const pitchAngle = Math.atan2(backY - frontY, halfLen * 2);
  vehicle.pitch += (pitchAngle - vehicle.pitch) * 0.2;
}

// ── SDF sampling helper ─────────────────────────────────────────────
function sampleSDF(field: VoxelField, wx: number, wy: number, wz: number): number {
  const gx = worldToGridX(wx, field.nx);
  const gy = worldToGridY(wy);
  const gz = worldToGridZ(wz, field.nz);
  
  const ix = Math.round(gx);
  const iy = Math.round(gy);
  const iz = Math.round(gz);
  
  if (ix < 0 || ix > field.nx || iy < 0 || iy > field.ny || iz < 0 || iz > field.nz) {
    return 32767; // outside bounds = air
  }
  
  return field.phi[field.vidx(ix, iy, iz)];
}

// ── Excavator bucket dig ────────────────────────────────────────────
export function excavatorDig(
  state: ExcavatorState,
  field: VoxelField,
  sim: SoilSimulator,
  digRadius: number = 0.03,
): boolean {
  const fk = computeExcavatorFK(state);
  let didDig = false;
  
  for (const tooth of fk.bucketTeeth) {
    const phi = sampleSDF(field, tooth[0], tooth[1], tooth[2]);
    if (phi < 0) {
      // Tooth is inside terrain — dig!
      field.applyStamp(tooth[0], tooth[1], tooth[2], digRadius);
      didDig = true;
    }
  }
  
  // Also check bucket tip
  const tipPhi = sampleSDF(field, fk.bucketTip[0], fk.bucketTip[1], fk.bucketTip[2]);
  if (tipPhi < 0) {
    field.applyStamp(fk.bucketTip[0], fk.bucketTip[1], fk.bucketTip[2], digRadius * 1.2);
    didDig = true;
  }
  
  if (didDig) {
    sim.activate();
  }
  
  return didDig;
}

// ── Bulldozer blade push ────────────────────────────────────────────
export function bulldozerPush(
  state: BulldozerState,
  field: VoxelField,
  sim: SoilSimulator,
): boolean {
  // Only push when blade is at or below surface level  
  if (state.bladeHeight > 0.02) return false;
  
  const blade = computeBladeGeometry(state);
  let didPush = false;
  
  const pushRadius = 0.018;
  
  for (const point of blade.samplePoints) {
    const phi = sampleSDF(field, point[0], point[1], point[2]);
    if (phi < 0) {
      // Blade intersects terrain — carve and push
      field.applyStamp(point[0], point[1], point[2], pushRadius);
      
      // Deposit material in front of blade (push effect)
      const pushDist = 0.035;
      const depositX = point[0] + blade.bladeNormal[0] * pushDist;
      const depositY = point[1];
      const depositZ = point[2] + blade.bladeNormal[2] * pushDist;
      
      const dgx = worldToGridX(depositX, field.nx);
      const dgy = worldToGridY(depositY);
      const dgz = worldToGridZ(depositZ, field.nz);
      
      const dix = Math.round(dgx);
      const diy = Math.round(dgy);
      const diz = Math.round(dgz);
      
      if (dix >= 0 && dix <= field.nx && diy >= 0 && diy <= field.ny && diz >= 0 && diz <= field.nz) {
        const didx = field.vidx(dix, diy, diz);
        field.phi[didx] = Math.max(-32767, field.phi[didx] - 5000) as number;
        field.disturbanceAge[didx] = 0;
      }
      
      didPush = true;
    }
  }
  
  if (didPush) {
    sim.activate();
  }
  
  return didPush;
}
