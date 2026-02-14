import { noise3D } from './noise';
import { WORLD_SEED, DEG } from './constants';

export interface SoilProperties {
  frictionAngle: number;
  cohesion: number;
  specificWeight: number;
}

const PRESETS: Record<number, SoilProperties> = {
  0: { frictionAngle: 32 * DEG, cohesion: 0.03, specificWeight: 1.0 },   // dry sand
  1: { frictionAngle: 20 * DEG, cohesion: 0.80, specificWeight: 1.1 },   // clay
  2: { frictionAngle: 28 * DEG, cohesion: 0.15, specificWeight: 1.0 },   // silt
  3: { frictionAngle: 25 * DEG, cohesion: 0.30, specificWeight: 0.8 },   // organic
  4: { frictionAngle: 30 * DEG, cohesion: 0.12, specificWeight: 1.3 },   // gravel
  5: { frictionAngle: 26 * DEG, cohesion: 0.45, specificWeight: 1.05 },  // loam
  6: { frictionAngle: 30 * DEG, cohesion: 0.08, specificWeight: 1.0 },   // sandy silt
};

const GRAVEL_PRESET: SoilProperties = { frictionAngle: 30 * DEG, cohesion: 0.12, specificWeight: 1.3 };

export function getMaterialAt(wx: number, wy: number, wz: number): SoilProperties {
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

  return PRESETS[layerId] || PRESETS[6];
}
