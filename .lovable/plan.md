

## Diagnosis

I read every file carefully. Here are the **three fatal bugs** causing the broken behavior:

### Bug 1: No SDF collision in the MPM grid
The `gridUpdate` function (mpmSolver.ts lines 306-341) only has box-wall boundary conditions. It has **zero awareness of the SDF terrain**. Particles fall under gravity, pass straight through the solid terrain, and land on the floor of the MPM domain. This is the primary cause of "particles falling through dirt."

### Bug 2: Spawning is too sparse and too selective  
`spawnParticlesFromSDF` (bridge.ts) requires:
- `phi >= 0 || phi < -8000` — only a narrow band of phi values qualify
- `disturbanceAge > 2` — only freshly disturbed voxels (age 0-2)
- Adjacent to air
- Gradient magnitude > 10
- Slope angle exceeds Mohr-Coulomb threshold

This produces maybe a dozen particles per dig. The user's intent is: **fill the entire carved cavity surface with a dense shell of particles** (like a 2-3 voxel thick skin of granular material), not just spawn from "unstable" voxels.

### Bug 3: Coordinate mapping renders particles in wrong space
The `ParticleCloud` renderer maps MPM [0,1]^3 → world using hardcoded ranges that may not match the actual SDF world bounds, and the SDF collision (which doesn't exist) would need the inverse mapping.

---

## Plan

### 1. Add SDF collision to MPM grid update
In `mpmSolver.ts`, modify `gridUpdate` to accept the VoxelField. For each grid node, sample the SDF (convert grid node position from MPM normalized coords → SDF world coords → voxel indices). If the SDF value is negative (inside solid), project the grid velocity to prevent penetration: compute the SDF gradient as the surface normal, remove the velocity component pointing into the solid.

This means `mpmStep` and `gridUpdate` need the VoxelField passed in, and `soilSim.ts` passes `this.field` through.

### 2. Rewrite particle spawning as dense shell filling
Replace the current slope-detection spawner with a **dense cavity shell filler**:
- After a dig, scan all voxels in the stamp radius
- For each voxel that is now air (phi > 0) but was recently solid (disturbanceAge == 0), AND is adjacent to a solid voxel:
  - Spawn **multiple particles** (2-4) at jittered positions within that voxel
  - Carve the adjacent solid voxel's phi upward so the SDF shell converts to particles
- Also spawn from solid voxels (phi < 0) that are within 2-3 voxels of the new air surface
- Remove the Mohr-Coulomb slope check from spawning — ALL exposed surface material becomes particles, not just "unstable" material. The MPM solver itself handles whether material flows or holds via Drucker-Prager.

### 3. Pass SDF to MPM solver for collision
- Change `mpmStep(state, dt)` → `mpmStep(state, dt, field)`
- In `gridUpdate`, for each active grid node, compute the SDF value at that node's world position. If SDF < 0 (inside terrain), compute gradient and enforce no-penetration boundary (zero normal velocity component, optionally apply friction to tangential).
- Add `worldToMPM`/`mpmToWorld` usage inside the solver.

### 4. Fix coordinate consistency
- Ensure `ParticleCloud` rendering uses the same `mpmToWorld` function from bridge.ts
- Ensure SDF sampling in grid update uses correct `mpmToWorld` for grid node positions

### Files to modify:
1. **`src/lib/mpm/mpmSolver.ts`** — Add VoxelField import, pass field to `mpmStep`→`gridUpdate`, add SDF collision sampling at grid nodes
2. **`src/lib/mpm/bridge.ts`** — Rewrite `spawnParticlesFromSDF` to densely fill the carved shell with particles instead of sparse slope-detection
3. **`src/lib/soil/soilSim.ts`** — Pass `this.field` to `mpmStep`
4. **`src/components/SoilViewer.tsx`** — Use `mpmToWorld` for particle rendering coordinates instead of hardcoded ranges

