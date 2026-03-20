// ── Bulldozer Model & Physics ────────────────────────────────────────
// Tracked vehicle with adjustable blade height/tilt/angle + rear rippers

import { BulldozerState, DEG } from './types';

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

export function updateBulldozer(
  state: BulldozerState,
  dt: number,
  inputs: {
    leftTrack: number;
    rightTrack: number;
    bladeUp: number;      // -1 to 1
    bladeTiltInput: number; // -1 to 1
    bladeAngleInput: number; // -1 to 1
    toggleRippers: boolean;
  }
) {
  // Track drive — bulldozer is slower but more powerful
  state.vehicle.tracks.leftSpeed = inputs.leftTrack;
  state.vehicle.tracks.rightSpeed = inputs.rightTrack;
  
  const trackWidth = 0.14;
  const forward = (inputs.leftTrack + inputs.rightTrack) * 0.5;
  const turn = (inputs.rightTrack - inputs.leftTrack) / trackWidth;
  
  state.vehicle.speed = forward * 0.1 * dt;
  state.vehicle.turnRate = turn * 0.6 * dt;
  
  state.vehicle.heading += state.vehicle.turnRate;
  state.vehicle.posX += Math.sin(state.vehicle.heading) * state.vehicle.speed;
  state.vehicle.posZ += Math.cos(state.vehicle.heading) * state.vehicle.speed;
  
  state.vehicle.posX = Math.max(-0.7, Math.min(0.7, state.vehicle.posX));
  state.vehicle.posZ = Math.max(-0.7, Math.min(0.7, state.vehicle.posZ));
  
  // Blade controls
  state.bladeHeight += inputs.bladeUp * 0.15 * dt;
  state.bladeHeight = Math.max(state.bladeMinHeight, Math.min(state.bladeMaxHeight, state.bladeHeight));
  
  state.bladeTilt += inputs.bladeTiltInput * 20 * DEG * dt;
  state.bladeTilt = Math.max(-15 * DEG, Math.min(15 * DEG, state.bladeTilt));
  
  state.bladeAngle += inputs.bladeAngleInput * 25 * DEG * dt;
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
  samplePoints: [number, number, number][];  // points along blade edge for SDF stamps
}

export function computeBladeGeometry(state: BulldozerState): BladeGeometry {
  const v = state.vehicle;
  const ch = Math.cos(v.heading);
  const sh = Math.sin(v.heading);
  
  // Blade is at front of vehicle
  const bladeOffset = 0.09;
  const bladeY = v.posY + state.bladeHeight;
  
  const center: [number, number, number] = [
    v.posX + sh * bladeOffset,
    bladeY,
    v.posZ + ch * bladeOffset,
  ];
  
  // Perpendicular to heading (with blade angle)
  const bladeHeading = v.heading + state.bladeAngle;
  const cbh = Math.cos(bladeHeading);
  const sbh = Math.sin(bladeHeading);
  const halfWidth = state.bladeWidth / 2;
  
  // Tilt adjusts Y of left vs right
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
  
  // Blade normal (pushes forward)
  const bladeNormal: [number, number, number] = [sh, 0, ch];
  
  // Sample points along blade edge
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
