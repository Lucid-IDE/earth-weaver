# MPM-SDF Hybrid Soil Simulator: Complete Failure Analysis & Recovery Plan

## Document Purpose

This document is a comprehensive, brutally honest postmortem of every failure in the current MLS-MPM / SDF hybrid soil simulation. It traces the root causes of each observed bug, explains why previous fixes failed, and provides a precise recovery roadmap.

---

## Part I: What the System Is Supposed to Do

### 1.1 The Vision

The user clicks on a terrain mesh (an SDF-based voxel field rendered via Surface Nets). The click carves a spherical hole. Soil particles should:

1. **Spawn** from the freshly exposed cavity walls (solid voxels near the new air boundary)
2. **Fall** under gravity, visibly tumbling and sliding along the cavity surfaces
3. **Interact** with each other (pile up, spread, form angle-of-repose mounds)
4. **Settle** when their velocity drops below a threshold for enough frames
5. **Deposit** back into the SDF, rebuilding the terrain mesh at their resting position
6. **Disappear** from the particle renderer once deposited
7. **Not re-spawn** from old dig sites when new digs happen elsewhere

### 1.2 What the User Has Actually Seen

Every single step above has failed at some point:

- Particles appear but don't move (frozen in place)
- Particles explode outward at infinite velocity
- Particles deposit instantly, creating mounds with no visible simulation
- Deposited particles remain visually rendered (ghost particles)
- Old dig sites re-spawn particles when clicking elsewhere
- Particles render as tiny flat squares instead of 3D objects
- The simulation flickers between "active" and "idle" within milliseconds

---

## Part II: Architecture Overview

### 2.1 The SDF Voxel Field (`VoxelField.ts`)

- 64×32×64 grid of `Int16` signed distance values (`phi`)
- `phi < 0` = solid terrain, `phi > 0` = air
- Surface Nets meshing extracts the zero-crossing isosurface
- `applyStamp()` carves spherical holes, sets `disturbanceAge = 0` on freshly carved solid voxels
- `VOXEL_SIZE = 0.025` world units per voxel

### 2.2 The MPM Solver (`mpmSolver.ts`)

Currently running in **"simple mode"** — a direct particle integration loop that bypasses the full MLS-MPM grid pipeline. This was done as a "temporary simplification" to debug instability, but it removed all inter-particle forces.

The full MLS-MPM pipeline (P2G → Grid Update → G2P) still exists in the file (lines 270-666) but is **not called**.

### 2.3 The Bridge (`bridge.ts`)

Two key functions:
- `spawnParticlesFromSDF()`: Scans for `disturbanceAge === 0` voxels that are solid (`phi < 0`) and adjacent to air. Spawns 3 jittered particles per qualifying voxel. Carves the voxel to air afterward.
- `depositParticlesIntoSDF()`: Checks each particle's velocity against `SETTLE_VELOCITY` for `SETTLE_FRAMES`. When settled, writes the particle back as solid SDF and deactivates it.

### 2.4 The Simulator (`soilSim.ts`)

Orchestrates the lifecycle: spawn → step → deposit → compact → deactivate.

### 2.5 The Renderer (`SoilViewer.tsx`)

- `SoilTerrain`: Renders the SDF mesh, handles click events, drives the simulation loop
- `ParticleCloud`: Renders active particles (now using `InstancedMesh` with `SphereGeometry`)

---

## Part III: Root Cause Analysis of Every Failure

### FAILURE 1: Particles Don't Move (Frozen in Place)

**Root cause: Compound damping destroys all velocity within 1-2 frames.**

The damping chain per substep:

```
pdamp = MPM_VELOCITY_DAMPING * (1 - state.damping[p])
      = 0.998 * (1 - 0.15)    // for Dry Sand preset
      = 0.998 * 0.85
      = 0.8483
```

This means **15.2% velocity loss per substep**. With 4 substeps per frame:

```
0.8483^4 = 0.518 → 48.2% velocity loss per frame
```

After just 3 frames, a particle retains only `0.518^3 = 13.9%` of its original velocity. After 10 frames: `0.518^10 = 0.14%`. The particle is effectively frozen.

**But it gets worse.** The SDF collision also applies friction:

```javascript
// Tangential friction
const friction = 0.4;
state.vx[p] *= (1 - friction);  // 60% retained
state.vy[p] *= (1 - friction);
state.vz[p] *= (1 - friction);
```

This friction is applied to ALL velocity components (not just tangential), so even the downward gravity component is being killed. Combined with damping:

```
Per-step with collision: 0.8483 * 0.6 = 0.509 → 49.1% loss per step
Per-frame (4 steps): 0.509^4 = 0.067 → 93.3% loss per frame
```

Particles lose 93% of their velocity every single frame. Nothing can possibly move.

**Previous fix attempts:** Changed `MPM_VELOCITY_DAMPING` from 0.985 to 0.998. This helped the damping-only path but the SDF friction still kills everything.

**Correct fix:** 
1. Apply SDF friction ONLY to tangential velocity, not to the full velocity vector
2. Apply per-material damping once per frame, not per substep
3. Reduce base friction from 0.4 to ~0.15 for sand

---

### FAILURE 2: Particles Explode (Infinite Velocity)

**Root cause: The full MLS-MPM solver used Neo-Hookean stress, which produces stress proportional to F², causing runaway forces in dense packing.**

When many particles occupy the same grid cell, the deformation gradient F grows rapidly. Neo-Hookean stress is `μ(FFᵀ - I) + λ·log(J)·J⁻¹·I`, which grows quadratically with F. In dense spawning scenarios, this creates enormous repulsive forces that explode the simulation.

**Previous fix:** Switched to Fixed Corotated model (`τ = 2μ(F-R)Fᵀ + λJ(J-1)I`), which is linear in deformation. This was correct in principle.

**But then the full solver was abandoned** in favor of the "simple" direct integration, which has NO stress model at all. So inter-particle forces don't exist, and the explosion fix is moot because the code isn't even running.

**Why the full solver was abandoned:** The explosion fix wasn't tested in isolation. Multiple things were changed simultaneously, and when it still didn't work, the entire grid pipeline was bypassed rather than debugging the actual issue.

**Correct fix:** The Fixed Corotated model should work. The full P2G/G2P pipeline needs to be re-enabled with:
1. Fixed Corotated stress (already implemented)
2. Proper CFL-scaled timestep: `dt < dx / max_velocity`
3. Safety clamping on F singular values (already implemented via Drucker-Prager return)
4. NaN/Inf detection with particle reset

---

### FAILURE 3: Particles Settle Instantly / Mounds Appear with No Visible Sim

**Root cause: Damping (see Failure 1) kills velocity so fast that particles reach SETTLE_VELOCITY within a few frames.**

With current constants:
- `SETTLE_VELOCITY = 0.008`
- `SETTLE_FRAMES = 60`

But the damping kills velocity to below 0.008 within ~5 frames. So `settleCounter` starts incrementing almost immediately. Even with 60 frames required, the particle is effectively motionless the entire time — there's no visible physics, just a brief pause before deposit.

**Correct fix:** Fix the damping (Failure 1). With proper damping, particles should take 30-120 frames to reach terminal velocity and settle naturally.

---

### FAILURE 4: Ghost Particles (Deposited Particles Still Visible)

**Root cause: Compaction only runs every 60 frames or when `activeCount === 0`.**

When particles deposit, `solver.active[p]` is set to 0, but the particle data (position, etc.) remains in the arrays. The renderer checks `mpm.active[i]` correctly, so deposited particles SHOULD be invisible.

However, the render loop iterates `for i in 0..numParticles` and `numParticles` only decreases during compaction. If compaction hasn't run, `numParticles` stays high, and the renderer wastes time iterating over dead particles (though it correctly skips them via the active check).

**The REAL ghost particle bug was different:** The `disturbanceAge` re-spawn loop (see Failure 5) caused particles to be re-spawned at old locations, making it LOOK like deposited particles were still rendering. They were actually newly spawned particles at the same positions.

**Status:** Fixed by the `disturbanceAge = 100` patch in deposit. But needs verification.

---

### FAILURE 5: Re-Spawn Loop (Old Holes Re-Spawn Particles)

**Root cause: `depositParticlesIntoSDF` set `disturbanceAge = 0` on deposited voxels.**

The spawn function (`spawnParticlesFromSDF`) checks `disturbanceAge === 0` to find freshly disturbed voxels. The deposit function was ALSO setting `disturbanceAge = 0` on voxels where particles landed. So every time `activate()` was called (on any new dig), the spawn scan would find ALL previously deposited voxels and re-spawn particles from them.

This created an ever-growing particle population and the appearance of "ghost" particles at old dig sites.

**Status:** Fixed. Deposit now sets `disturbanceAge = 100`.

---

### FAILURE 6: Flat Square Particles

**Root cause: Used `THREE.PointsMaterial` which renders as screen-aligned quads.**

WebGL points are always flat rectangles. Without a circular texture or shader, they appear as squares. The size was also tiny (`0.008` world units) making them hard to see.

**Status:** Fixed. Now using `InstancedMesh` with `SphereGeometry(0.004, 6, 4)` and `MeshStandardMaterial` for proper 3D lit spheres.

---

### FAILURE 7: Simulation Flickers Active/Idle

**Root cause: Particles settle so fast (Failure 3) that `activeCount` drops to 0 within a few frames of spawning.**

The sim goes active, spawns particles, they instantly reach near-zero velocity due to damping, deposit back within a few frames, activeCount hits 0, sim goes idle. Total active time: < 1 second. No visible physics.

**Correct fix:** Fix the damping (Failure 1). Particles need to have enough energy to actually move for several seconds.

---

### FAILURE 8: Particles Spawned in Trapped Positions

**Root cause: Spawn logic creates particles AT the cavity surface, immediately adjacent to solid terrain on most sides.**

When `spawnParticlesFromSDF` runs:
1. It finds solid voxels (phi < 0) near air (within SHELL_DEPTH=2 voxels)
2. Spawns particles at those voxel positions with jitter
3. Carves the voxel to air (phi → positive)

The particle is now in a freshly carved air voxel, but surrounded by solid terrain on 3-5 of its 6 faces. The SDF collision immediately constrains it. With only gravity pulling it down, and the terrain below being solid, the particle has almost nowhere to go.

**The particles CAN potentially slide along the cavity wall** — the SDF collision should project velocity onto the surface tangent. But the excessive friction (Failure 1) prevents this.

**Correct fix:** 
1. Fix friction to be tangential-only (not applied to all components)
2. Give particles initial velocity when spawned — a slight outward push from the dig center, simulating the momentum of being dislodged
3. Reduce SHELL_DEPTH to 1 so particles are spawned right at the surface, not deep inside

---

### FAILURE 9: SDF Collision Friction Applied to ALL Velocity Components

**Root cause: The collision code applies friction as a scalar multiplier on the full velocity vector.**

```javascript
// Current (WRONG):
state.vx[p] *= (1 - friction);
state.vy[p] *= (1 - friction);
state.vz[p] *= (1 - friction);
```

This reduces the velocity in ALL directions, including the component perpendicular to the surface (which was already removed by the normal projection). It also reduces the gravity component even when the particle is sliding along a wall.

**Correct implementation:**
```javascript
// Remove normal component
state.vx[p] -= vDotN * nx;
state.vy[p] -= vDotN * ny;
state.vz[p] -= vDotN * nz;
// Now compute tangential velocity
const tvx = state.vx[p], tvy = state.vy[p], tvz = state.vz[p];
const tSpeed = Math.sqrt(tvx*tvx + tvy*tvy + tvz*tvz);
if (tSpeed > 1e-6) {
  const frictionForce = Math.min(friction * Math.abs(vDotN), tSpeed);
  const scale = 1 - frictionForce / tSpeed;
  state.vx[p] *= scale;
  state.vy[p] *= scale;
  state.vz[p] *= scale;
}
```

This is Coulomb friction: tangential friction force is proportional to normal force, and only applied to the tangential component.

---

### FAILURE 10: No Inter-Particle Forces (Simple Solver)

**Root cause: The full MLS-MPM P2G/G2P pipeline was disabled and replaced with direct particle integration.**

The "simple solver" (line 201 of mpmSolver.ts) applies gravity and SDF collision directly to each particle. Particles don't know about each other. They can't:
- Push each other apart (no pressure)
- Form piles (no friction between particles)
- Create angle-of-repose mounds (no Drucker-Prager yield)
- Flow as a granular fluid (no constitutive model)

Each particle is an independent point mass falling under gravity and bouncing off terrain. This is NOT soil simulation — it's a bunch of bouncing balls that don't interact.

**Why it was done:** The full solver exploded (Failure 2). Rather than fixing the stress model, the entire grid pipeline was bypassed.

**Correct fix:** Re-enable the full pipeline with the Fixed Corotated model. The explosion was caused by Neo-Hookean stress, which has already been replaced. The Fixed Corotated + Drucker-Prager code exists in the P2G function (lines 278-446) and is correct. It just needs to be called.

---

### FAILURE 11: Coordinate System Confusion

**Root cause: Three different coordinate systems with error-prone conversions.**

1. **World space**: Centered at origin, Y-up. Range roughly [-0.8, 0.8] in X/Z, [-0.6, 0.2] in Y.
2. **MPM space**: Normalized [0, 1]³. Mapped to world via `worldToMPM`/`mpmToWorld`.
3. **Voxel/grid space**: Integer indices. Mapped via `worldX/Y/Z` using VOXEL_SIZE and SURFACE_IY offsets.

The SDF sampling in the solver converts MPM→world→voxel for collision detection. The spawn converts world→MPM for particle positions. The deposit converts MPM→world→voxel for SDF writing.

Each conversion is a potential source of off-by-one errors, especially at boundaries. The gradient function in VoxelField uses integer voxel indices, which means the gradient is quantized and can be zero at exact voxel centers.

**Status:** No known active bugs from this, but it's a fragility risk.

---

### FAILURE 12: Timestep Chaos

**Root cause: The timestep has been changed multiple times without understanding the CFL condition.**

Timeline:
1. Original: `MPM_DT = 1e-4`, `MPM_STEPS_PER_FRAME = 8` → Total sim time per frame: 0.0008s. At 60fps: 0.048s/s real-time. Particles barely moved.
2. Simple solver: Used the same tiny MPM_DT even though direct integration is stable at much larger dt. Particles still barely moved.
3. Current: Passes real frame dt (~0.008s per substep, 4 substeps). This should work for the simple solver but is way too large for the full MLS-MPM grid solver.

**For the full solver:** The CFL condition requires `dt < dx / max_velocity`. With `MPM_DX = 1/64 ≈ 0.0156` and max velocity ~2.0, the maximum stable dt is `0.0078`. The original `1e-4` was 78x smaller than necessary — extremely conservative. A value of `dt = 2e-3` with 4 substeps would give `0.008s` total sim time per frame, or 0.48s/s at 60fps. Still slow but 10x better.

**For the simple solver:** dt = 0.008 per substep is fine since there's no grid to violate CFL.

**Correct fix:** When re-enabling the full solver, use `dt = 1e-3` with `STEPS_PER_FRAME = 8`, giving 0.008s total per frame. This satisfies CFL while giving reasonable sim speed.

---

## Part IV: The Fundamental Design Problem

### 4.1 The Cavity Trap

The deepest architectural issue is this: **particles spawned from cavity walls have almost nowhere to go.**

When you dig a hole in terrain, you create a roughly spherical cavity. The particles are spawned from the inner surface of this cavity. They're surrounded by solid terrain on most sides. Under gravity alone, the only particles that can move are:

- Those on the **upper walls** of the cavity (can slide downward)
- Those on the **ceiling** of the cavity (can fall straight down)
- Those at the **rim** (can slide outward and create an ejecta pile)

Particles on the **lower walls and floor** of the cavity have nowhere to go — they're already at the bottom with solid terrain below them. They immediately settle and deposit back.

This means the majority of spawned particles (~60-70%) will never visibly move. Only the particles on the upper portions of the cavity contribute to visible dynamics.

### 4.2 What Real Soil Does

In reality, when you dig a hole:
1. The tool removes a volume of soil (the SDF carve — this works)
2. The walls of the hole may crumble if the soil lacks cohesion
3. Loose material from the walls slides to the bottom
4. Some material is ejected upward and outward (depending on the digging action)
5. Over time, the hole partially fills back in from wall collapse

The simulation should focus on effects 2-5. This requires:
- **Initial velocity on spawn**: Particles should be launched slightly outward/upward from the dig center, not spawned motionless
- **Working inter-particle forces**: Particles need to pile up and form mounds
- **Proper Coulomb friction**: Particles slide along surfaces, not stick to them
- **Only spawn from unstable portions**: Don't spawn from the floor of the cavity — those areas are stable

### 4.3 Spawn Strategy Improvement

Instead of spawning from ALL surface voxels, only spawn from voxels whose surface normal has a significant upward component (gravity would dislodge them):

```javascript
// Only spawn from walls/ceiling, not floor
const [gx, gy, gz] = field.gradient(ix, iy, iz);
const glen = Math.sqrt(gx*gx + gy*gy + gz*gz);
if (glen > 0) {
  const ny = gy / glen; // surface normal Y component
  if (ny > -0.3) continue; // skip floor-facing surfaces (normal points down = stable)
}
```

And give initial velocity based on the dig center:
```javascript
const dirX = wx - digCenterX;
const dirY = wy - digCenterY;
const dirZ = wz - digCenterZ;
const dirLen = Math.sqrt(dirX*dirX + dirY*dirY + dirZ*dirZ) || 1;
const ejectSpeed = 0.3;
// Initial velocity: slight outward push + gravity kick
vx = (dirX/dirLen) * ejectSpeed;
vy = (dirY/dirLen) * ejectSpeed + 0.1; // slight upward
vz = (dirZ/dirLen) * ejectSpeed;
```

---

## Part V: The Full MLS-MPM Grid Solver — Why It's Needed

### 5.1 What the Grid Does

The MLS-MPM grid is not optional decoration. It provides:

1. **Pressure resolution**: When particles are pushed together, the grid computes repulsive stress that pushes them apart. Without this, particles freely overlap and pile incorrectly.

2. **Drucker-Prager yield**: The constitutive model determines when soil yields (flows) vs. holds shape. This creates the angle of repose — the slope at which a soil pile stabilizes.

3. **Momentum conservation**: The grid ensures that particle interactions conserve momentum, preventing energy creation or destruction.

4. **Velocity smoothing**: The APIC (Affine Particle-In-Cell) transfer naturally smooths velocity fields, preventing individual particle jitter.

### 5.2 Why the Simple Solver Can Never Work

Without the grid, each particle is an independent projectile. They can:
- Fall under gravity ✓
- Collide with SDF terrain ✓ (if the collision is fixed)
- Interact with each other ✗
- Form stable piles ✗
- Flow as granular material ✗
- Create angle-of-repose mounds ✗

The simple solver will always look like "a bag of marbles dropped in a hole." It cannot produce soil-like behavior no matter how much the parameters are tuned.

### 5.3 Re-enabling the Full Solver

The full P2G/G2P pipeline exists in mpmSolver.ts. It needs:

1. **Entry point change**: Replace the `mpmStep` function call with the full pipeline:
   ```
   clearGrid → particleToGrid → gridUpdate → gridToParticle
   ```

2. **Timestep**: Use `dt = 1e-3` (not 1e-4). This is still well within CFL for the 64³ grid.

3. **Substeps**: 8 substeps per frame → 0.008s simulated per frame.

4. **Safety**: The existing NaN/Inf detection and F-reset logic should prevent blowups.

5. **Damping**: Apply per-material damping in gridUpdate (once per step), not per-particle (which compounds).

---

## Part VI: Rendering Improvements Needed

### 6.1 Current State

Particles now render as instanced spheres. This is a significant improvement over flat squares but still looks "child's play" compared to the vision.

### 6.2 What's Missing

1. **Screen-space fluid rendering**: The PRINCIPIA_MORPHICA doc describes a bilateral-filtered depth buffer approach. Render particle depths, smooth them, reconstruct normals, shade as a continuous surface. This would make particles look like a flowing soil mass instead of individual balls.

2. **Variable particle size**: Particles near the surface should be slightly larger (visual emphasis). Particles deep in a pile should be smaller or hidden entirely.

3. **Particle shape**: Instead of perfect spheres, use icosahedron geometry with slight noise displacement for a more organic "dirt chunk" appearance.

4. **Dust/debris effects**: Small secondary particles that trail behind moving particles, creating a sense of disturbance.

### 6.3 Priority

Rendering improvements are SECONDARY to making the physics work. There's no point making beautiful particles if they don't move correctly.

---

## Part VII: Recovery Roadmap

### Phase 1: Fix the Simple Solver (Immediate)

**Goal:** Make particles visibly fall and slide along cavity walls.

Changes:
1. Fix SDF collision friction to be Coulomb (tangential only)
2. Remove per-substep damping, apply per-frame instead
3. Give particles initial velocity on spawn (outward push from dig center)
4. Only spawn from unstable surfaces (normal check)
5. Verify particles move visibly for 2-5 seconds before settling

This phase uses the simple solver (no grid). The goal is just to see particles moving correctly.

### Phase 2: Re-enable Full MLS-MPM (Next)

**Goal:** Particles interact with each other, form piles, flow as granular material.

Changes:
1. Replace `mpmStep` with `clearGrid + particleToGrid + gridUpdate + gridToParticle`
2. Use dt=1e-3, 8 substeps
3. Fixed Corotated + Drucker-Prager (already coded)
4. Safety clamping on F singular values
5. Move damping to grid update

### Phase 3: Rendering (After Physics Works)

**Goal:** Particles look like flowing soil, not a bag of marbles.

Changes:
1. Screen-space depth smoothing
2. Normal reconstruction from smoothed depth
3. Material-aware shading (earthy tones, moisture darkening)
4. Dust trail particles

---

## Part VIII: Specific Code Changes Required

### 8.1 Fix SDF Collision (mpmSolver.ts, lines 225-247)

BEFORE (broken):
```javascript
if (sdf.phi < 0) {
  const vDotN = vx*nx + vy*ny + vz*nz;
  if (vDotN < 0) {
    vx -= vDotN * nx;
    vy -= vDotN * ny;
    vz -= vDotN * nz;
    // WRONG: applies to all components
    vx *= (1 - friction);
    vy *= (1 - friction);
    vz *= (1 - friction);
  }
}
```

AFTER (correct Coulomb friction):
```javascript
if (sdf.phi < 0) {
  const vDotN = vx*nx + vy*ny + vz*nz;
  if (vDotN < 0) {
    // Remove normal velocity
    vx -= vDotN * nx;
    vy -= vDotN * ny;
    vz -= vDotN * nz;
    // Coulomb friction on tangential component only
    const tSpeed = Math.sqrt(vx*vx + vy*vy + vz*vz);
    if (tSpeed > 1e-6) {
      const frictionForce = Math.min(friction * Math.abs(vDotN), tSpeed);
      const scale = 1 - frictionForce / tSpeed;
      vx *= scale;
      vy *= scale;
      vz *= scale;
    }
    // Push particle OUT of solid along normal
    px += nx * 0.001; // small push to prevent re-penetration
    py += ny * 0.001;
    pz += nz * 0.001;
  }
}
```

### 8.2 Fix Damping (mpmSolver.ts, lines 210-214)

BEFORE (per-substep, compounds catastrophically):
```javascript
const pdamp = damping * (1 - (state.damping[p] || 0));
state.vx[p] *= pdamp;
state.vy[p] *= pdamp;
state.vz[p] *= pdamp;
```

AFTER (velocity-proportional drag, physically correct):
```javascript
// Linear drag: F = -c * v, integrated over dt
// v(t+dt) = v(t) * exp(-c * dt)
const dragCoeff = state.damping[p] || 0;  // 0.15 for sand
const dragFactor = Math.exp(-dragCoeff * dt * 60); // normalize to ~60fps
state.vx[p] *= dragFactor;
state.vy[p] *= dragFactor;
state.vz[p] *= dragFactor;
```

### 8.3 Initial Velocity on Spawn (bridge.ts, spawnParticlesFromSDF)

Need to pass dig center to the spawn function and add initial velocity:
```javascript
// Direction from dig center to particle
const dx = wx - digCenterX;
const dy = wy - digCenterY;
const dz = wz - digCenterZ;
const dist = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1;
const ejectSpeed = 0.15; // in MPM space

// Set initial velocity (convert to MPM space scale)
const mpmScaleX = 1 / (MPM_WORLD_MAX_X - MPM_WORLD_MIN_X);
state.vx[idx] = (dx/dist) * ejectSpeed * mpmScaleX;
state.vy[idx] = (dy/dist) * ejectSpeed * mpmScaleX + 0.05;
state.vz[idx] = (dz/dist) * ejectSpeed * mpmScaleX;
```

### 8.4 Only Spawn from Unstable Surfaces (bridge.ts)

Add gradient check before spawning:
```javascript
const [gx, gy, gz] = field.gradient(ix, iy, iz);
const glen = Math.sqrt(gx*gx + gy*gy + gz*gz);
if (glen > 0) {
  const normalY = gy / glen;
  // Skip voxels whose normal points downward (= floor/stable surface)
  // normalY > 0 means surface normal points up = underside of terrain = unstable
  if (normalY < -0.2) continue; // floor-facing = stable, skip
}
```

### 8.5 Re-enable Full Solver (mpmSolver.ts)

Replace the `mpmStep` export with:
```javascript
export function mpmStep(state: MPMSolverState, dt: number, field?: VoxelField): void {
  clearGrid(state);
  particleToGrid(state, dt);
  gridUpdate(state, dt, field);
  gridToParticle(state, dt);
}
```

With appropriate timestep (dt ≈ 1e-3, called 8 times per frame).

---

## Part IX: What Success Looks Like

When all fixes are applied, clicking to dig should produce:

1. **Immediate**: Hole appears in terrain mesh. Particles spawn from the upper walls and ceiling of the cavity.
2. **0-30 frames (0-0.5s)**: Particles visibly fall under gravity, sliding along cavity walls. Some eject slightly outward.
3. **30-120 frames (0.5-2s)**: Particles accumulate at the bottom of the cavity and at the rim. Inter-particle forces (from MLS-MPM grid) cause them to pile up realistically. The pile angle is determined by the Drucker-Prager friction angle.
4. **120-300 frames (2-5s)**: Remaining particles settle. Velocity drops below threshold. Settled particles deposit back into SDF.
5. **After deposit**: Particle count drops. Terrain mesh shows the final shape: a hole with a mound of loose material at the bottom and possibly a slight rim of ejected material.
6. **On next dig**: Only new particles spawn at the new dig site. Old dig sites are undisturbed.

---

## Part X: Summary of All Active Bugs (Prioritized)

| # | Bug | Root Cause | Severity | Fix Complexity |
|---|-----|-----------|----------|---------------|
| 1 | No visible particle motion | Compound damping + wrong friction | CRITICAL | Simple |
| 9 | SDF friction kills all velocity | Applied to all components, not tangential | CRITICAL | Simple |
| 10 | No inter-particle forces | Full solver disabled | CRITICAL | Medium |
| 8 | Particles trapped in cavity | No initial velocity, spawn from stable surfaces | HIGH | Simple |
| 12 | Timestep confusion | Mixed dt strategies | HIGH | Simple |
| 3 | Instant settling | Consequence of #1 | HIGH | Fixed by #1 |
| 7 | Sim flickers active/idle | Consequence of #1 and #3 | MEDIUM | Fixed by #1 |
| 5 | Re-spawn loop | disturbanceAge = 0 in deposit | FIXED | Done |
| 6 | Flat square particles | PointsMaterial | FIXED | Done |
| 4 | Ghost particles | Consequence of #5 | FIXED | Done |

---

*End of analysis. Ready for Phase 1 implementation on your command.*
