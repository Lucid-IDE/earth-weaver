import { VoxelField } from './VoxelField';
import { getMaterialAt } from './materialBrain';
import { SIM_DEACTIVATE_FRAMES } from './constants';

export class SoilSimulator {
  field: VoxelField;
  simActive = false;
  idleFrames = 0;

  constructor(field: VoxelField) {
    this.field = field;
  }

  activate() {
    this.simActive = true;
    this.idleFrames = 0;
  }

  step(dt: number): boolean {
    if (!this.simActive) return false;
    const changed = this.slopeAndGravityPass(dt);

    if (changed) {
      this.idleFrames = 0;
    } else {
      this.idleFrames++;
      if (this.idleFrames > SIM_DEACTIVATE_FRAMES) this.simActive = false;
    }
    return changed;
  }

  private slopeAndGravityPass(dt: number): boolean {
    const f = this.field;
    const NX = f.nx, NY = f.ny, NZ = f.nz;
    let changed = false;

    for (let iz = 1; iz < NZ; iz++) {
      for (let iy = 1; iy < NY; iy++) {
        for (let ix = 1; ix < NX; ix++) {
          const idx = f.vidx(ix, iy, iz);
          const phi = f.phi[idx];

          // Only near-surface solid voxels
          if (phi >= 0 || phi < -20000) continue;

          // Must be adjacent to air
          let hasAir = false;
          const dirs: [number, number, number][] = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
          for (const [dx, dy, dz] of dirs) {
            const ni = ix + dx, nj = iy + dy, nk = iz + dz;
            if (ni < 0 || ni > NX || nj < 0 || nj > NY || nk < 0 || nk > NZ) continue;
            if (f.phi[f.vidx(ni, nj, nk)] > 0) { hasAir = true; break; }
          }
          if (!hasAir) continue;

          // Gradient → surface normal
          const [gx, gy, gz] = f.gradient(ix, iy, iz);
          const glen = Math.sqrt(gx * gx + gy * gy + gz * gz);
          if (glen < 10) continue;

          const nx = gx / glen;
          const ny = gy / glen;
          const nzn = gz / glen;

          // Slope angle from up vector
          const slopeAngle = Math.acos(Math.max(-1, Math.min(1, ny)));

          // Material properties via M(x)
          const wx = f.worldX(ix);
          const wy = f.worldY(iy);
          const wz = f.worldZ(iz);
          const mat = getMaterialAt(wx, wy, wz);

          // Mohr-Coulomb effective angle: friction + cohesion boost
          const effAngle = mat.frictionAngle + mat.cohesion * 0.9;
          if (slopeAngle <= effAngle) continue;

          const excess = slopeAngle - effAngle;
          const cohesionDamp = 1 - mat.cohesion * mat.cohesion;
          const transferBase = 28000 * dt * Math.sin(excess) * cohesionDamp * mat.specificWeight;
          const transferAmount = Math.round(Math.max(1, transferBase));
          if (transferAmount < 1) continue;

          let destIdx = -1;

          if (ny < 0.25) {
            // Steep / inverted → gravity drop straight down
            const landY = this.findLandingY(ix, iy, iz);
            if (landY >= 0 && landY !== iy) {
              destIdx = f.vidx(ix, landY, iz);
            }
          } else {
            // Gradual slope → transfer downhill along surface
            const projX = ny * nx;
            const projY = ny * ny - 1;
            const projZ = ny * nzn;
            const projLen = Math.sqrt(projX * projX + projY * projY + projZ * projZ);
            if (projLen < 0.01) continue;

            const dix = Math.round(projX / projLen);
            const diy = Math.round(projY / projLen);
            const diz = Math.round(projZ / projLen);
            const ti = ix + dix, tj = iy + diy, tk = iz + diz;
            if (ti < 0 || ti > NX || tj < 0 || tj > NY || tk < 0 || tk > NZ) continue;
            destIdx = f.vidx(ti, tj, tk);
          }

          if (destIdx < 0) continue;

          // Transfer: source becomes more air-like, dest more solid
          f.phi[idx] = Math.min(32767, f.phi[idx] + transferAmount) as number;
          f.phi[destIdx] = Math.max(-32767, f.phi[destIdx] - transferAmount) as number;
          f.disturbanceAge[idx] = 0;
          f.disturbanceAge[destIdx] = 0;
          changed = true;
        }
      }
    }
    return changed;
  }

  private findLandingY(ix: number, fromIy: number, iz: number): number {
    const f = this.field;
    for (let iy = fromIy - 1; iy >= 0; iy--) {
      if (f.phi[f.vidx(ix, iy, iz)] < -3000) {
        return iy + 1;
      }
    }
    return 0;
  }
}
