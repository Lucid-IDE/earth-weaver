import { noise3D } from './noise';
import { WORLD_SEED, DEG } from './constants';

export interface SoilProperties {
  frictionAngle: number;
  cohesion: number;
  specificWeight: number;
  moisture: number;         // 0 = bone dry, 1 = saturated
  youngModulus: number;     // per-material stiffness
  poissonRatio: number;
  damping: number;          // velocity damping factor
}

// ── Soil Presets ─────────────────────────────────────────────────────
// Each preset defines physically distinct behavior

export const SOIL_PRESET_NAMES = [
  'Dry Sand', 'Wet Clay', 'Silt', 'Organic/Peat', 'Gravel', 'Loam', 'Sandy Silt'
] as const;

const PRESETS: Record<number, SoilProperties> = {
  0: { // Dry Sand — low cohesion, high friction, free-flowing
    frictionAngle: 33 * DEG, cohesion: 0.02, specificWeight: 1.0,
    moisture: 0.05, youngModulus: 400, poissonRatio: 0.25, damping: 0.15,
  },
  1: { // Wet Clay — high cohesion, low friction, sticky clumps
    frictionAngle: 18 * DEG, cohesion: 0.90, specificWeight: 1.15,
    moisture: 0.7, youngModulus: 200, poissonRatio: 0.35, damping: 0.25,
  },
  2: { // Silt — moderate everything
    frictionAngle: 27 * DEG, cohesion: 0.18, specificWeight: 1.0,
    moisture: 0.25, youngModulus: 350, poissonRatio: 0.28, damping: 0.18,
  },
  3: { // Organic/Peat — soft, compressible, damp
    frictionAngle: 22 * DEG, cohesion: 0.35, specificWeight: 0.75,
    moisture: 0.55, youngModulus: 100, poissonRatio: 0.3, damping: 0.22,
  },
  4: { // Gravel — stiff, heavy, low cohesion, bouncy
    frictionAngle: 35 * DEG, cohesion: 0.05, specificWeight: 1.4,
    moisture: 0.02, youngModulus: 800, poissonRatio: 0.18, damping: 0.08,
  },
  5: { // Loam — balanced, gardening soil, moderate moisture
    frictionAngle: 25 * DEG, cohesion: 0.50, specificWeight: 1.05,
    moisture: 0.4, youngModulus: 200, poissonRatio: 0.3, damping: 0.20,
  },
  6: { // Sandy Silt — between sand and silt
    frictionAngle: 30 * DEG, cohesion: 0.08, specificWeight: 1.0,
    moisture: 0.1, youngModulus: 350, poissonRatio: 0.25, damping: 0.15,
  },
};

const GRAVEL_PRESET = PRESETS[4];

// ── Active terrain preset (global for UI switching) ──────────────────
let _activePresetOverride: number | null = null;

export function setGlobalSoilPreset(presetId: number | null) {
  _activePresetOverride = presetId;
}

export function getGlobalSoilPreset(): number | null {
  return _activePresetOverride;
}

export function getSoilPreset(id: number): SoilProperties {
  return PRESETS[id] || PRESETS[6];
}

// ── Material lookup at world position ────────────────────────────────
export function getMaterialAt(wx: number, wy: number, wz: number): SoilProperties {
  // If a global preset override is active, return that everywhere
  if (_activePresetOverride !== null) {
    return PRESETS[_activePresetOverride] || PRESETS[0];
  }

  const bnLen = Math.sqrt(0.05 * 0.05 + 1 + 0.03 * 0.03);
  const bnx = 0.05 / bnLen, bny = 1 / bnLen, bnz = 0.03 / bnLen;

  const warp = noise3D(wx * 2.5, wy * 2.5, wz * 2.5, WORLD_SEED) * 0.04
             + noise3D(wx * 7, wy * 7, wz * 7, WORLD_SEED) * 0.012;
  const s = wx * bnx + wy * bny + wz * bnz + warp;

  const layerThickness = 0.055;
  const layerCoord = s / layerThickness;
  const layerId = (((Math.floor(layerCoord) % 7) + 7) % 7);

  // Gravel lens override
  const lens = noise3D(wx * 6, wy * 6, wz * 6, WORLD_SEED);
  if (lens > 0.55) return GRAVEL_PRESET;

  // Moisture adjustment by depth — deeper = wetter
  const preset = { ...(PRESETS[layerId] || PRESETS[6]) };
  const depthFactor = Math.max(0, Math.min(1, (-wy - 0.05) * 3));
  preset.moisture = Math.min(1, preset.moisture + depthFactor * 0.3);
  // Moisture increases cohesion (capillary forces)
  preset.cohesion *= (1 + preset.moisture * 0.5);

  return preset;
}
