// ── Impact & Crater System ───────────────────────────────────────────
// Various impact styles: drop, crater, explosive with chunks

import { VoxelField } from '../soil/VoxelField';
import { SoilSimulator } from '../soil/soilSim';
import { VOXEL_SIZE, SURFACE_IY } from '../soil/constants';
import { addParticle } from '../mpm/mpmSolver';
import { worldToMPM, mpmToWorld } from '../mpm/bridge';
import { getMaterialAt } from '../soil/materialBrain';
import { MAX_PARTICLES } from '../mpm/constants';

export type CraterProfile = 'bowl' | 'cone' | 'rimSplash' | 'explosive';

export interface ImpactConfig {
  position: [number, number, number];
  radius: number;
  energy: number;        // 0-1, scales ejection velocity and debris
  profile: CraterProfile;
}

// Crater shape functions — return SDF offset at distance d/radius
function craterSDF(profile: CraterProfile, normalizedDist: number, energy: number): number {
  switch (profile) {
    case 'bowl':
      // Smooth parabolic bowl
      if (normalizedDist > 1) return 0;
      return -(1 - normalizedDist * normalizedDist);
      
    case 'cone':
      // Sharp V-shaped crater
      if (normalizedDist > 1) return 0;
      return -(1 - normalizedDist);
      
    case 'rimSplash': {
      // Bowl with raised rim
      if (normalizedDist > 1.4) return 0;
      if (normalizedDist > 1.0) {
        // Rim: raised ring
        const rimDist = (normalizedDist - 1.0) / 0.4;
        return 0.3 * (1 - rimDist * rimDist) * energy;
      }
      return -(1 - normalizedDist * normalizedDist);
    }
      
    case 'explosive': {
      // Deep center with high rim and scattered ejecta
      if (normalizedDist > 1.5) return 0;
      if (normalizedDist > 1.0) {
        const rimDist = (normalizedDist - 1.0) / 0.5;
        return 0.5 * (1 - rimDist) * energy;
      }
      // Extra deep center
      const depth = 1 - normalizedDist * normalizedDist;
      return -depth * (1 + energy * 0.5);
    }
  }
}

// Apply an impact to the terrain
export function applyImpact(
  config: ImpactConfig,
  field: VoxelField,
  sim: SoilSimulator,
): number {
  const [cx, cy, cz] = config.position;
  const radius = config.radius;
  const energy = config.energy;
  
  const gx = cx / VOXEL_SIZE + field.nx / 2;
  const gy = cy / VOXEL_SIZE + SURFACE_IY;
  const gz = cz / VOXEL_SIZE + field.nz / 2;
  const rGrid = (radius * 1.5) / VOXEL_SIZE; // extra margin for rim
  const margin = Math.ceil(rGrid) + 3;
  
  const ixMin = Math.max(0, Math.floor(gx - margin));
  const ixMax = Math.min(field.nx, Math.ceil(gx + margin));
  const iyMin = Math.max(0, Math.floor(gy - margin));
  const iyMax = Math.min(field.ny, Math.ceil(gy + margin));
  const izMin = Math.max(0, Math.floor(gz - margin));
  const izMax = Math.min(field.nz, Math.ceil(gz + margin));
  
  let modified = 0;
  
  for (let iz = izMin; iz <= izMax; iz++) {
    for (let iy = iyMin; iy <= iyMax; iy++) {
      for (let ix = ixMin; ix <= ixMax; ix++) {
        const dx = ix - gx;
        const dy = iy - gy;
        const dz = iz - gz;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) * VOXEL_SIZE;
        const normalizedDist = dist / radius;
        
        const craterOffset = craterSDF(config.profile, normalizedDist, energy);
        if (Math.abs(craterOffset) < 0.01) continue;
        
        const idx = field.vidx(ix, iy, iz);
        const oldPhi = field.phi[idx];
        
        // Apply crater shape
        const phiChange = Math.round(craterOffset * 32767 * 0.8);
        
        if (craterOffset < 0) {
          // Carving (negative crater = dig into surface)
          const newPhi = Math.min(32767, Math.max(-32767, oldPhi - phiChange));
          if (newPhi !== oldPhi) {
            field.phi[idx] = newPhi;
            if (oldPhi < 0) {
              field.disturbanceAge[idx] = 0;
            }
            modified++;
          }
        } else {
          // Building up (rim)
          const newPhi = Math.max(-32767, Math.min(32767, oldPhi - Math.round(craterOffset * 32767 * 0.3)));
          if (newPhi !== oldPhi) {
            field.phi[idx] = newPhi;
            field.disturbanceAge[idx] = 50;
            modified++;
          }
        }
      }
    }
  }
  
  // Spawn chunks for explosive impacts
  let chunksSpawned = 0;
  if (config.profile === 'explosive' || config.profile === 'rimSplash') {
    chunksSpawned = spawnExplosiveChunks(config, sim);
  }
  
  sim.activate();
  
  return modified + chunksSpawned;
}

// Spawn ballistic chunks flying outward from explosion
function spawnExplosiveChunks(
  config: ImpactConfig,
  sim: SoilSimulator,
): number {
  const [cx, cy, cz] = config.position;
  const energy = config.energy;
  const numChunks = Math.floor(30 + energy * 100);
  const solver = sim.mpm;
  let spawned = 0;
  
  for (let i = 0; i < numChunks; i++) {
    if (solver.numParticles >= MAX_PARTICLES - 5) break;
    
    // Random direction on upper hemisphere
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.random() * Math.PI * 0.4; // mostly upward
    const r = config.radius * (0.3 + Math.random() * 0.7);
    
    const px = cx + Math.sin(theta) * Math.cos(phi) * r * 0.5;
    const py = cy + Math.sin(phi) * r * 0.3;
    const pz = cz + Math.cos(theta) * Math.cos(phi) * r * 0.5;
    
    const [mx, my, mz] = worldToMPM(px, py, pz);
    if (mx < 0.05 || mx > 0.95 || my < 0.05 || my > 0.95 || mz < 0.05 || mz > 0.95) continue;
    
    const mat = getMaterialAt(cx, cy, cz);
    const matType = i % 5; // varied material for visual interest
    
    const ejSpeed = energy * 1.5 + Math.random() * 0.5;
    const ejX = Math.sin(theta) * Math.cos(phi) * ejSpeed;
    const ejY = Math.sin(phi) * ejSpeed * 1.5 + 0.3; // bias upward
    const ejZ = Math.cos(theta) * Math.cos(phi) * ejSpeed;
    
    const pidx = addParticle(
      solver, mx, my, mz, matType,
      mat.frictionAngle, mat.cohesion,
      mat.specificWeight * (0.8 + Math.random() * 0.4),
      mat.youngModulus, mat.poissonRatio,
      mat.damping, mat.moisture,
      3,
    );
    
    if (pidx >= 0) {
      const scaleX = 1 / 1.6;
      const scaleY = 1 / 0.8;
      const scaleZ = 1 / 1.6;
      solver.vx[pidx] = ejX * scaleX + (Math.random() - 0.5) * 0.2;
      solver.vy[pidx] = ejY * scaleY;
      solver.vz[pidx] = ejZ * scaleZ + (Math.random() - 0.5) * 0.2;
      spawned++;
    }
  }
  
  return spawned;
}

// Quick helpers for common impact types
export function dropImpact(x: number, y: number, z: number, radius: number, field: VoxelField, sim: SoilSimulator) {
  return applyImpact({ position: [x, y, z], radius, energy: 0.3, profile: 'bowl' }, field, sim);
}

export function craterImpact(x: number, y: number, z: number, radius: number, field: VoxelField, sim: SoilSimulator) {
  return applyImpact({ position: [x, y, z], radius, energy: 0.6, profile: 'rimSplash' }, field, sim);
}

export function explosiveImpact(x: number, y: number, z: number, radius: number, field: VoxelField, sim: SoilSimulator) {
  return applyImpact({ position: [x, y, z], radius, energy: 1.0, profile: 'explosive' }, field, sim);
}
