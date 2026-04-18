// ── Spawn Drop & Landing Impact ──────────────────────────────────────
// Vehicles spawn slightly above terrain with a downward velocity, fall under
// gravity, and on contact apply an enhanced track imprint, dust burst, and
// chassis-pitch shake proportional to landing speed. This avoids the visual
// artifact of equipment intersecting the terrain at spawn time and produces
// a satisfying "drop in" cinematic moment.

import { VoxelField } from '../soil/VoxelField';
import { SoilSimulator } from '../soil/soilSim';
import { VehicleState } from './types';
import { RigidBodyState, applyChassisTorque } from './rigidBody';
import { getTerrainHeight } from './terrainInteraction';
import { craterImpact } from './impacts';

export interface SpawnDropState {
  active: boolean;          // true while still falling
  landed: boolean;          // true once first contact has been processed
  velY: number;             // current vertical velocity (m/s, world)
  spawnHeight: number;      // initial height above terrain (m)
  /** Track callback so renderer can show landing dust + crater on contact */
  onLanding?: (impactSpeed: number, pos: [number, number, number]) => void;
}

const GRAVITY = 9.81;

export function createSpawnDrop(spawnHeight = 0.18): SpawnDropState {
  return {
    active: true,
    landed: false,
    velY: 0,
    spawnHeight,
  };
}

/**
 * Place vehicle high above terrain at spawn. Call after initVehicleOnTerrain
 * so the (x,z) position is established and we know the surface height.
 */
export function elevateForSpawn(
  vehicle: VehicleState,
  field: VoxelField,
  drop: SpawnDropState,
  rideHeight: number,
) {
  const surfY = getTerrainHeight(field, vehicle.posX, vehicle.posZ);
  vehicle.posY = surfY + rideHeight + drop.spawnHeight;
  drop.velY = 0;
  drop.active = true;
  drop.landed = false;
}

/**
 * Apply gravity, detect ground contact, fire landing impact (dust + crater +
 * chassis pitch). Returns true while drop is still active (renderer should
 * suppress terrain-follow updates while active=true).
 */
export function stepSpawnDrop(
  drop: SpawnDropState,
  vehicle: VehicleState,
  rigidBody: RigidBodyState,
  field: VoxelField,
  sim: SoilSimulator,
  rideHeight: number,
  mass: number,
  dt: number,
): boolean {
  if (!drop.active) return false;

  drop.velY -= GRAVITY * dt * 0.45; // scaled gravity to match world-unit feel
  vehicle.posY += drop.velY * dt;

  const surfY = getTerrainHeight(field, vehicle.posX, vehicle.posZ);
  const targetY = surfY + rideHeight;

  if (vehicle.posY <= targetY) {
    // Landing!
    const impactSpeed = Math.abs(drop.velY);
    vehicle.posY = targetY;
    drop.velY = 0;
    drop.active = false;
    drop.landed = true;

    // Crater stamp under each track footprint (broader, shallower than dig)
    const ch = Math.cos(vehicle.heading);
    const sh = Math.sin(vehicle.heading);
    const halfTrack = 0.05;
    const craterRadius = 0.045 + impactSpeed * 0.012;
    const energyScale = Math.min(1, 0.25 + impactSpeed * 0.18);
    craterImpact(
      vehicle.posX + ch * halfTrack, surfY, vehicle.posZ - sh * halfTrack,
      craterRadius, field, sim,
    );
    craterImpact(
      vehicle.posX - ch * halfTrack, surfY, vehicle.posZ + sh * halfTrack,
      craterRadius, field, sim,
    );

    // Chassis bounce: nose dips then springs back
    applyChassisTorque(rigidBody, impactSpeed * mass * 0.4);
    // Vertical velocity kick into rigid body (small bounce via pitch oscillation)
    rigidBody.pitchVel += impactSpeed * 0.6;

    drop.onLanding?.(impactSpeed * energyScale, [vehicle.posX, surfY, vehicle.posZ]);
    return false;
  }

  return true;
}
