import { GRID_X, GRID_Y, GRID_Z, VOXEL_SIZE, PHI_SCALE, SURFACE_IY, WORLD_SEED } from './constants';
import { noise3D, fbm3D } from './noise';

export interface SoilMeshData {
  positions: Float32Array;
  normals: Float32Array;
  disturbanceAges: Float32Array;
  indices: Uint32Array;
}

export class VoxelField {
  readonly nx = GRID_X;
  readonly ny = GRID_Y;
  readonly nz = GRID_Z;
  readonly totalVerts: number;
  phi: Int16Array;
  disturbanceAge: Uint8Array;

  constructor() {
    this.totalVerts = (this.nx + 1) * (this.ny + 1) * (this.nz + 1);
    this.phi = new Int16Array(this.totalVerts);
    this.disturbanceAge = new Uint8Array(this.totalVerts);
    this.disturbanceAge.fill(255);
  }

  vidx(ix: number, iy: number, iz: number): number {
    return ix + iy * (this.nx + 1) + iz * (this.nx + 1) * (this.ny + 1);
  }

  worldX(ix: number): number { return (ix - this.nx / 2) * VOXEL_SIZE; }
  worldY(iy: number): number { return (iy - SURFACE_IY) * VOXEL_SIZE; }
  worldZ(iz: number): number { return (iz - this.nz / 2) * VOXEL_SIZE; }

  initTerrain(): void {
    const seed = WORLD_SEED;
    for (let iz = 0; iz <= this.nz; iz++) {
      for (let iy = 0; iy <= this.ny; iy++) {
        for (let ix = 0; ix <= this.nx; ix++) {
          const wx = this.worldX(ix);
          const wy = this.worldY(iy);
          const wz = this.worldZ(iz);

          const surfaceNoise =
            fbm3D(wx * 3, 0, wz * 3, 3, seed) * 0.06 +
            noise3D(wx * 0.8, 0, wz * 0.8, seed + 100) * 0.1;

          const dist = wy - surfaceNoise;
          const phiNorm = dist / PHI_SCALE;
          this.phi[this.vidx(ix, iy, iz)] = Math.round(
            Math.max(-1, Math.min(1, phiNorm)) * 32767
          );
        }
      }
    }
  }

  applyStamp(cx: number, cy: number, cz: number, radius: number): void {
    const gx = cx / VOXEL_SIZE + this.nx / 2;
    const gy = cy / VOXEL_SIZE + SURFACE_IY;
    const gz = cz / VOXEL_SIZE + this.nz / 2;
    const rGrid = radius / VOXEL_SIZE;
    const margin = Math.ceil(rGrid) + 2;

    const ixMin = Math.max(0, Math.floor(gx - margin));
    const ixMax = Math.min(this.nx, Math.ceil(gx + margin));
    const iyMin = Math.max(0, Math.floor(gy - margin));
    const iyMax = Math.min(this.ny, Math.ceil(gy + margin));
    const izMin = Math.max(0, Math.floor(gz - margin));
    const izMax = Math.min(this.nz, Math.ceil(gz + margin));

    for (let iz = izMin; iz <= izMax; iz++) {
      for (let iy = iyMin; iy <= iyMax; iy++) {
        for (let ix = ixMin; ix <= ixMax; ix++) {
          const dx = ix - gx;
          const dy = iy - gy;
          const dz = iz - gz;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) * VOXEL_SIZE;

          const stampSDF = dist - radius;
          const negStampPhi = Math.round(
            Math.max(-1, Math.min(1, -stampSDF / PHI_SCALE)) * 32767
          );

          const idx = this.vidx(ix, iy, iz);
          const oldPhi = this.phi[idx];
          const newPhi = Math.max(oldPhi, negStampPhi);

          if (newPhi !== oldPhi) {
            this.phi[idx] = newPhi;
            if (oldPhi < 0) {
              this.disturbanceAge[idx] = 0;
            }
          }
        }
      }
    }
  }

  gradient(ix: number, iy: number, iz: number): [number, number, number] {
    const x0 = Math.max(0, ix - 1);
    const x1 = Math.min(this.nx, ix + 1);
    const y0 = Math.max(0, iy - 1);
    const y1 = Math.min(this.ny, iy + 1);
    const z0 = Math.max(0, iz - 1);
    const z1 = Math.min(this.nz, iz + 1);

    return [
      this.phi[this.vidx(x1, iy, iz)] - this.phi[this.vidx(x0, iy, iz)],
      this.phi[this.vidx(ix, y1, iz)] - this.phi[this.vidx(ix, y0, iz)],
      this.phi[this.vidx(ix, iy, z1)] - this.phi[this.vidx(ix, iy, z0)],
    ];
  }

  extractMesh(): SoilMeshData {
    const positions: number[] = [];
    const normals: number[] = [];
    const ages: number[] = [];
    const indices: number[] = [];

    const NX = this.nx, NY = this.ny, NZ = this.nz;
    const vertMap = new Int32Array(NX * NY * NZ).fill(-1);
    const ci = (cx: number, cy: number, cz: number) => cx + cy * NX + cz * NX * NY;

    // Corner offsets for the 8 corners of a cell
    const CO: [number, number, number][] = [
      [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
      [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
    ];

    // 12 edges as pairs of corner indices
    const EP: [number, number][] = [
      [0, 1], [2, 3], [4, 5], [6, 7], // x-directed
      [0, 2], [1, 3], [4, 6], [5, 7], // y-directed
      [0, 4], [1, 5], [2, 6], [3, 7], // z-directed
    ];

    // Phase 1: compute a surface vertex for each cell crossing the isosurface
    for (let cz = 0; cz < NZ; cz++) {
      for (let cy = 0; cy < NY; cy++) {
        for (let cx = 0; cx < NX; cx++) {
          const vals: number[] = [];
          let inside = 0;
          for (let c = 0; c < 8; c++) {
            const v = this.phi[this.vidx(cx + CO[c][0], cy + CO[c][1], cz + CO[c][2])];
            vals.push(v);
            if (v < 0) inside++;
          }
          if (inside === 0 || inside === 8) continue;

          let vx = 0, vy = 0, vz = 0, cnt = 0, ageAcc = 0;
          for (const [a, b] of EP) {
            if ((vals[a] < 0) !== (vals[b] < 0)) {
              const t = vals[a] / (vals[a] - vals[b]);
              vx += CO[a][0] + t * (CO[b][0] - CO[a][0]);
              vy += CO[a][1] + t * (CO[b][1] - CO[a][1]);
              vz += CO[a][2] + t * (CO[b][2] - CO[a][2]);
              cnt++;

              const mi = this.vidx(
                Math.min(NX, cx + Math.round(CO[a][0] + t * (CO[b][0] - CO[a][0]))),
                Math.min(NY, cy + Math.round(CO[a][1] + t * (CO[b][1] - CO[a][1]))),
                Math.min(NZ, cz + Math.round(CO[a][2] + t * (CO[b][2] - CO[a][2])))
              );
              ageAcc += this.disturbanceAge[mi];
            }
          }
          if (!cnt) continue;

          vx /= cnt; vy /= cnt; vz /= cnt;

          const wx = this.worldX(cx + vx);
          const wy = this.worldY(cy + vy);
          const wz = this.worldZ(cz + vz);

          const gi = Math.max(0, Math.min(NX, Math.round(cx + vx)));
          const gj = Math.max(0, Math.min(NY, Math.round(cy + vy)));
          const gk = Math.max(0, Math.min(NZ, Math.round(cz + vz)));
          const [gxv, gyv, gzv] = this.gradient(gi, gj, gk);
          const gl = Math.sqrt(gxv * gxv + gyv * gyv + gzv * gzv) || 1;

          const vi = positions.length / 3;
          vertMap[ci(cx, cy, cz)] = vi;
          positions.push(wx, wy, wz);
          normals.push(gxv / gl, gyv / gl, gzv / gl);
          ages.push(ageAcc / cnt / 255);
        }
      }
    }

    // Phase 2: emit quads for each voxel edge crossing the surface.
    // Each edge is shared by 4 cells; connect their surface vertices.

    // X-edges: vertex (ix,iy,iz) to (ix+1,iy,iz)
    for (let iz = 1; iz < NZ; iz++) {
      for (let iy = 1; iy < NY; iy++) {
        for (let ix = 0; ix < NX; ix++) {
          const a = this.phi[this.vidx(ix, iy, iz)];
          const b = this.phi[this.vidx(ix + 1, iy, iz)];
          if ((a < 0) === (b < 0)) continue;
          const v0 = vertMap[ci(ix, iy - 1, iz - 1)];
          const v1 = vertMap[ci(ix, iy, iz - 1)];
          const v2 = vertMap[ci(ix, iy, iz)];
          const v3 = vertMap[ci(ix, iy - 1, iz)];
          if (v0 < 0 || v1 < 0 || v2 < 0 || v3 < 0) continue;
          if (a < 0) { indices.push(v0, v1, v2, v0, v2, v3); }
          else { indices.push(v0, v2, v1, v0, v3, v2); }
        }
      }
    }

    // Y-edges: vertex (ix,iy,iz) to (ix,iy+1,iz)
    for (let iz = 1; iz < NZ; iz++) {
      for (let iy = 0; iy < NY; iy++) {
        for (let ix = 1; ix < NX; ix++) {
          const a = this.phi[this.vidx(ix, iy, iz)];
          const b = this.phi[this.vidx(ix, iy + 1, iz)];
          if ((a < 0) === (b < 0)) continue;
          const v0 = vertMap[ci(ix - 1, iy, iz - 1)];
          const v1 = vertMap[ci(ix, iy, iz - 1)];
          const v2 = vertMap[ci(ix, iy, iz)];
          const v3 = vertMap[ci(ix - 1, iy, iz)];
          if (v0 < 0 || v1 < 0 || v2 < 0 || v3 < 0) continue;
          if (a < 0) { indices.push(v0, v2, v1, v0, v3, v2); }
          else { indices.push(v0, v1, v2, v0, v2, v3); }
        }
      }
    }

    // Z-edges: vertex (ix,iy,iz) to (ix,iy,iz+1)
    for (let iz = 0; iz < NZ; iz++) {
      for (let iy = 1; iy < NY; iy++) {
        for (let ix = 1; ix < NX; ix++) {
          const a = this.phi[this.vidx(ix, iy, iz)];
          const b = this.phi[this.vidx(ix, iy, iz + 1)];
          if ((a < 0) === (b < 0)) continue;
          const v0 = vertMap[ci(ix - 1, iy - 1, iz)];
          const v1 = vertMap[ci(ix, iy - 1, iz)];
          const v2 = vertMap[ci(ix, iy, iz)];
          const v3 = vertMap[ci(ix - 1, iy, iz)];
          if (v0 < 0 || v1 < 0 || v2 < 0 || v3 < 0) continue;
          if (a < 0) { indices.push(v0, v1, v2, v0, v2, v3); }
          else { indices.push(v0, v2, v1, v0, v3, v2); }
        }
      }
    }

    return {
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      disturbanceAges: new Float32Array(ages),
      indices: new Uint32Array(indices),
    };
  }
}
