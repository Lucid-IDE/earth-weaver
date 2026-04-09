// ── Bulldozer Model & Physics ────────────────────────────────────────
// Tracked vehicle with adjustable blade height/tilt/angle + rear rippers

import { BulldozerState, DEG } from './types';
import { hydraulicActuatorSpeed, HydraulicSystem } from './vehiclePhysics';

export function createBulldozerState(): BulldozerState {
  return {
    vehicle: {
      posX: -0.3, posY: 0, posZ: 0.3,
      heading: Math.PI / 4,
      pitch: 0,
      contactSink: 0,
      groundClearance: 0,
      tracks: { leftSpeed: 0, rightSpeed: 0 },
      speed: 0,
      turnRate: 0,
    },
    bladeHeight: 0.0,
    bladeTilt: 0,
    bladeAngle: 0,
    bladeWidth: 0.16,
    bladeMinHeight: -0.12,
    bladeMaxHeight: 0.06,
    rippersDown: false,
  };
}

/**
 * Update bulldozer blade/ripper controls. Hydraulic-limited when system provided.
 * NOTE: Track drive is handled by vehiclePhysics.updateVehiclePhysics()
 */
export function updateBulldozer(
  state: BulldozerState,
  dt: number,
  inputs: {
    leftTrack: number;
    rightTrack: number;
    bladeUp: number;
    bladeTiltInput: number;
    bladeAngleInput: number;
    toggleRippers: boolean;
  },
  hydraulics?: HydraulicSystem | null,
) {
  // Store track input for renderer (actual drive handled by physics engine)
  state.vehicle.tracks.leftSpeed = inputs.leftTrack;
  state.vehicle.tracks.rightSpeed = inputs.rightTrack;
  
  // Blade controls with hydraulic speed limiting
  const bladeBaseSpeed = 0.15; // m/s blade lift speed
  const tiltBaseSpeed = 20 * DEG;
  const angleBaseSpeed = 25 * DEG;
  
  if (hydraulics) {
    // Blade lift: heavy load (fighting gravity + soil)
    const liftLoad = 0.5 + (inputs.bladeUp < 0 ? 0.3 : 0); // lowering is heavier (pushing into soil)
    const bladeSpeed = hydraulicActuatorSpeed(hydraulics, bladeBaseSpeed, liftLoad);
    state.bladeHeight += inputs.bladeUp * bladeSpeed * dt;
    
    const tiltSpeed = hydraulicActuatorSpeed(hydraulics, tiltBaseSpeed, 0.4);
    state.bladeTilt += inputs.bladeTiltInput * tiltSpeed * dt;
    
    const angleSpeed = hydraulicActuatorSpeed(hydraulics, angleBaseSpeed, 0.3);
    state.bladeAngle += inputs.bladeAngleInput * angleSpeed * dt;
  } else {
    state.bladeHeight += inputs.bladeUp * bladeBaseSpeed * dt;
    state.bladeTilt += inputs.bladeTiltInput * tiltBaseSpeed * dt;
    state.bladeAngle += inputs.bladeAngleInput * angleBaseSpeed * dt;
  }
  
  state.bladeHeight = Math.max(state.bladeMinHeight, Math.min(state.bladeMaxHeight, state.bladeHeight));
  state.bladeTilt = Math.max(-15 * DEG, Math.min(15 * DEG, state.bladeTilt));
  state.bladeAngle = Math.max(-20 * DEG, Math.min(20 * DEG, state.bladeAngle));
  
  if (inputs.toggleRippers) {
    state.rippersDown = !state.rippersDown;
  }
}

// Compute blade edge points in world space for SDF interaction
export interface BladeGeometry {
  center: [number, number, number];
  left: [number, number, number];
  right: [number, number, number];
  bladeNormal: [number, number, number];
  samplePoints: [number, number, number][];
}

export function computeBladeGeometry(state: BulldozerState): BladeGeometry {
  const v = state.vehicle;
  const ch = Math.cos(v.heading);
  const sh = Math.sin(v.heading);
  
  const bladeOffset = 0.09;
  const bladeY = v.posY + state.bladeHeight;
  
  const center: [number, number, number] = [
    v.posX + sh * bladeOffset,
    bladeY,
    v.posZ + ch * bladeOffset,
  ];
  
  const bladeHeading = v.heading + state.bladeAngle;
  const cbh = Math.cos(bladeHeading);
  const sbh = Math.sin(bladeHeading);
  const halfWidth = state.bladeWidth / 2;
  
  const tiltDelta = Math.sin(state.bladeTilt) * halfWidth;
  
  const left: [number, number, number] = [
    center[0] + cbh * halfWidth,
    center[1] - tiltDelta,
    center[2] - sbh * halfWidth,
  ];
  
  const right: [number, number, number] = [
    center[0] - cbh * halfWidth,
    center[1] + tiltDelta,
    center[2] + sbh * halfWidth,
  ];
  
  const bladeNormal: [number, number, number] = [sh, 0, ch];
  
  const numSamples = 7;
  const samplePoints: [number, number, number][] = [];
  for (let i = 0; i < numSamples; i++) {
    const t = i / (numSamples - 1);
    samplePoints.push([
      left[0] + (right[0] - left[0]) * t,
      left[1] + (right[1] - left[1]) * t,
      left[2] + (right[2] - left[2]) * t,
    ]);
  }
  
  return { center, left, right, bladeNormal, samplePoints };
}
