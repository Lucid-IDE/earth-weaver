# MLS-MPM 3D Soil Simulation: Complete Research & Implementation Guide

## Authoritative Reference

This document is based on careful analysis of the **canonical 88-line MLS-MPM implementation** by Yuanming Hu (SIGGRAPH 2018), its JavaScript port by Roberto Toro, and the project's own PRINCIPIA MORPHICA design document. Every claim is traced to source code or published equations.

**Reference repos:**
- C++: https://github.com/yuanming-hu/taichi_mpm (mls-mpm88-explained.cpp)
- JavaScript: https://github.com/r03ert0/mls-mpm.js (mls-mpm.js)
- Paper: "A Moving Least Squares Material Point Method" (Hu et al., ACM TOG 2018)

---

## Part I: How the Reference MLS-MPM Actually Works

### 1.1 The Complete Algorithm (One Timestep)

The MLS-MPM algorithm has exactly 4 phases per timestep:

```
1. CLEAR GRID     — Zero all grid nodes (mass, momentum)
2. P2G            — Scatter particle mass, momentum, and stress to grid
3. GRID UPDATE    — Normalize by mass, apply gravity, enforce boundaries
4. G2P            — Gather grid velocities back to particles, update F, advect
```

This is NOT optional. The grid is the mechanism by which particles interact. Without it, you have independent projectiles, not a continuum.

### 1.2 Reference Constants (2D, from mls-mpm88)

```javascript
const n = 80;              // grid resolution
const dt = 1e-4;           // timestep
const dx = 1.0 / n;        // = 0.0125
const inv_dx = n;           // = 80
const particle_mass = 1.0;  // unit mass
const vol = 1.0;            // unit volume (NOT dx^dim!)
const E = 1e4;              // Young's modulus = 10,000
const nu = 0.2;             // Poisson's ratio
const gravity = -200;       // gravity in GRID SPACE (not -9.81!)
```

**Critical observation: vol = 1.0, NOT dx² or dx³.**

### 1.3 Our Constants (3D) — BEFORE FIX

```javascript
const MPM_GRID = 64;
const MPM_DX = 1/64;       // = 0.015625
const MPM_DT = 2e-4;
const MPM_GRAVITY = -9.81;  // ← WRONG: this is world-space gravity, not MPM-space
const particle_mass = 1.0;  // from specificWeight
const vol = (MPM_DX³) / 3;  // = (0.015625)³ / 3 ≈ 1.27e-6  ← CATASTROPHICALLY SMALL
const E = 800;               // Young's modulus
```

---

## Part II: Root Cause — The Volume/Stress Catastrophe

### 2.1 The Force Balance Problem

In P2G, the grid receives two contributions per particle:
1. **Momentum**: `weight * mass * (velocity + C * dpos)` — scales with `mass`
2. **Stress force**: `weight * (-vol * 4 * inv_dx² * dt) * stress * dpos` — scales with `vol`

For particles to interact (push each other, form piles, resist compression), the stress force must be **comparable in magnitude** to the momentum/gravity forces.

### 2.2 Reference Force Balance

In the reference:
```
Momentum contribution per substep: mass * gravity * dt = 1.0 * 200 * 1e-4 = 0.02
Stress contribution (order of magnitude): vol * 4 * inv_dx² * dt * E ≈ 1.0 * 4 * 6400 * 1e-4 * 10000 ≈ 2560
```

Stress >> gravity momentum change per step. **This is correct.** It means inter-particle repulsion dominates, preventing particles from overlapping. Gravity slowly pulls particles down while stress keeps them from interpenetrating.

### 2.3 OUR Force Balance (BROKEN)

```
Momentum contribution per substep: mass * gravity * dt = 1.0 * 9.81 * 2e-4 = 0.00196
Stress contribution: vol * 4 * inv_dx² * dt * E ≈ 1.27e-6 * 4 * 4096 * 2e-4 * 800 ≈ 0.00335
```

Stress ≈ gravity. **This is marginal at best.** But it gets worse — the gravity is applied every substep, while the stress depends on deformation (which starts at zero). So initially, gravity dominates completely and particles free-fall through each other before stress can build up.

### 2.4 What Happens With Wrong Volume

With `vol ≈ 1e-6`:
1. Particles spawn with F = Identity (no deformation)
2. Stress = 0 (because F - R = 0 when F = I)
3. Gravity pulls particles down
4. Particles overlap in the same grid cells
5. F starts to deviate from identity, but the stress from `vol * stress` is ~1e-6 scale
6. Gravity force (~1e-3 scale) overwhelms the stress by 1000x
7. Particles pile up with zero resistance → no pile formation, no angle of repose
8. OR: if particles somehow get large F, stress explodes because the ratio is wrong → instability

**This is THE fundamental bug.** Everything else (damping, friction, spawn velocity) is secondary.

---

## Part III: The Gravity Scaling Problem

### 3.1 MPM Space vs World Space

Our simulation runs in normalized MPM space [0,1]³ which maps to world space:
- X: [-0.8, 0.8] = 1.6 world units
- Y: [-0.6, 0.2] = 0.8 world units
- Z: [-0.8, 0.8] = 1.6 world units

Gravity in world space is -9.81 m/s². But 1 MPM unit in Y = 0.8 world units.

### 3.2 The Reference Uses Tuned Gravity

The reference uses `gravity = -200` in a [0,1]² domain. This is NOT -9.81. It's been tuned so particles fall at a visually satisfying rate with dt=1e-4 and 80 grid cells.

For our 3D solver in [0,1]³ with dt=2e-4 and 64 grid cells, we need gravity scaled similarly. The key constraint is the CFL condition: `dt * max_velocity < dx`.

With gravity = -200, after one substep: `v = 200 * 2e-4 = 0.04`. After 100 substeps: `v = 4.0`. With dx = 1/64 ≈ 0.0156, CFL requires v < dx/dt = 0.0156/2e-4 = 78. So v=4 is well within CFL.

### 3.3 Correct Gravity for Our Solver

We should use gravity ≈ **-200** (same as reference), not -9.81. Alternatively, we can think of it as: the [0,1] domain represents about 0.8 meters of physical space, and we want particles to traverse it in about 1-2 seconds of simulation time. Free fall distance: `d = 0.5 * g * t²`. For d=0.5 (half the domain) in t=0.7s: `g = 2*0.5/0.49 ≈ 2.0`. But with dt=2e-4 and 16 substeps/frame at 60fps: sim_time_per_second = 16 * 2e-4 * 60 = 0.192 s/s. So real-time 1 second = 0.192 sim seconds. For particles to visibly fall in 2 real seconds (0.384 sim seconds): `g = 2*0.5/0.147 ≈ 6.8`.

But the reference just uses -200 and it works beautifully. Let's not overthink this.

---

## Part IV: Complete Comparison — Reference vs Our Implementation

### 4.1 P2G Phase

**Reference (2D JS):**
```javascript
// Quadratic B-spline weights
const w = [
    had2D([0.5,0.5], sub2D([1.5,1.5], fx).map(o=>o*o)),      // 0.5*(1.5-fx)²
    sub2D([0.75,0.75], sub2D(fx, [1.0,1.0]).map(o=>o*o)),     // 0.75-(fx-1)²
    had2D([0.5,0.5], sub2D(fx, [0.5,0.5]).map(o=>o*o))        // 0.5*(fx-0.5)²
];

// Stress: Fixed Corotated
const J = determinant(F);
const {R, S} = polar_decomp(F);
const k1 = -4 * inv_dx * inv_dx * dt * vol;
const k2 = lambda * (J-1) * J;
const stress = k1 * (2*mu*(F^T - R)*F + k2*I);  // Note: Taichi transpose convention
const affine = stress + particle_mass * C;

// Scatter
for di in 0..3, dj in 0..3:
    dpos = (di - fx) * dx
    weight = w[di] * w[dj]
    grid[idx] += weight * (mass*v + affine * dpos, mass)
```

**Our 3D implementation:**
```typescript
// B-spline weights — CORRECT ✓
function bsplineWeight(x) {
    const ax = Math.abs(x);
    if (ax < 0.5) return 0.75 - ax*ax;
    if (ax < 1.5) { const t = 1.5-ax; return 0.5*t*t; }
    return 0;
}

// Stress: Fixed Corotated with Drucker-Prager return mapping — CORRECT ✓
// (SVD → log-strain → yield check → project singular values → reconstruct F)
// R = U * V^T
// tau = 2*mu*(F-R)*F^T + lambda*J*(J-1)*I

// Scatter — CORRECT structure ✓
// BUT: stressScale = -pvol * 4 * invDx² * dt
// WHERE pvol = (dx³) / particlesPerCell ≈ 1.27e-6  ← CATASTROPHICALLY WRONG
```

**Verdict on P2G:** The mathematical structure is correct. The B-spline weights are correct. The stress model is correct (and actually more sophisticated than the reference, with Drucker-Prager yield). **The ONLY problem is the volume value.**

### 4.2 Grid Update Phase

**Reference:**
```javascript
for all grid nodes:
    if mass > 0:
        velocity = momentum / mass    // normalize
        velocity.y += -200 * dt       // gravity (= -200, not -9.81!)
        // Boundaries: sticky walls, slip floor
        if near_wall: velocity = 0
        if near_floor: velocity.y = max(0, velocity.y)
```

**Ours:**
```typescript
// Normalize — CORRECT ✓
vx = gridVx[idx] / mass;

// Gravity — WRONG VALUE
vy += MPM_GRAVITY * dt;  // MPM_GRAVITY = -9.81, should be ~-200

// SDF collision — CORRECT APPROACH ✓ (better than reference: we have terrain)
// Samples SDF at grid node, projects velocity onto surface

// Boundary — CORRECT ✓
```

**Verdict on Grid Update:** Structure correct. SDF collision is actually superior to the reference's simple box boundaries. **Gravity value is too small by ~20x.**

### 4.3 G2P Phase

**Reference:**
```javascript
p.v = [0, 0];      // reset velocity
p.C = [0,0, 0,0];  // reset APIC matrix

for di, dj:
    weight = w[di] * w[dj]
    p.v += weight * grid[idx]                    // gather velocity
    p.C += 4*inv_dx * weight * outer(grid_v, dpos)  // APIC

// Advect
p.x += dt * p.v

// Update F: F_new = (I + dt*C) * F_old  (in Taichi convention)
// JS version: F_new = F_old * (I + dt*C)  (transposed convention)

// Plasticity: SVD → clamp singular values → reconstruct
```

**Ours:**
```typescript
// Reset and gather — CORRECT ✓
// APIC C matrix — CORRECT ✓ (scale = 4*invDx*invDx*w, matches reference's 4*inv_dx)

// Damping — PROBLEMATIC (see Part V)
const damp = MPM_VELOCITY_DAMPING;
newVx *= damp;  // applied every substep → compounds

// F update: F_new = (I + dt*C) * F_old — CORRECT ✓
// NaN/Inf safety — CORRECT ✓ (reference doesn't have this, we're more robust)

// Advect — CORRECT ✓
```

**Verdict on G2P:** Mathematically correct. The damping application is questionable but with DAMPING ≈ 0.9998, the per-substep compounding is minimal: 0.9998^16 = 0.9968, only 0.3% loss per frame. **This is acceptable now.**

### 4.4 Summary of Differences

| Aspect | Reference | Ours | Status |
|--------|-----------|------|--------|
| B-spline weights | Quadratic | Quadratic | ✅ CORRECT |
| Stress model | Fixed Corotated | Fixed Corotated + Drucker-Prager | ✅ CORRECT (better) |
| P2G scatter | mass*v + (stress + mass*C)*dpos | mass*(v+C*dpos) + stressScale*tau*dpos | ✅ EQUIVALENT |
| Particle volume | **vol = 1.0** | **vol = dx³/3 ≈ 1.27e-6** | ❌ **CATASTROPHIC** |
| Gravity | **-200** | **-9.81** | ❌ **20x too weak** |
| Grid update | normalize + gravity + boundary | normalize + gravity + SDF collision | ✅ CORRECT (better) |
| G2P gather | v, C, F update | v, C, F update + safety | ✅ CORRECT |
| Damping | None | 0.9998/substep | ⚠️ ACCEPTABLE |
| SDF collision | None (box only) | Full SDF sampling | ✅ CORRECT (better) |
| Drucker-Prager | Not in reference | Full yield surface | ✅ CORRECT |
| F safety clamp | Not in reference | Reset on NaN/Inf/|F|>5 | ✅ CORRECT |

---

## Part V: The Damping History — A Forensic Timeline

### 5.1 Original Sin

The original damping constant was `MPM_VELOCITY_DAMPING = 0.985`. Per-substep with 8 substeps:
```
0.985^8 = 0.886 → 11.4% loss per frame → 50% loss in 6 frames → particle frozen in <0.5s
```

### 5.2 First "Fix"

Changed to 0.998. With 8 substeps:
```
0.998^8 = 0.984 → 1.6% loss per frame → still compounds
```

But then per-particle `damping[p] = 0.15` was applied multiplicatively:
```
effective = 0.998 * (1 - 0.15) = 0.8483
0.8483^8 = 0.247 → 75% velocity loss per frame!
```

### 5.3 Current State

Changed to 0.9998. Per-material damping removed from the calculation. With 16 substeps:
```
0.9998^16 = 0.9968 → 0.32% loss per frame → ~50% loss over 200 frames (3.3 seconds)
```

**This is now acceptable.** Particles will visibly move for several seconds before damping matters.

### 5.4 Correct Approach

The reference has NO damping at all. The natural dissipation in MLS-MPM comes from:
1. **The grid transfer itself** — P2G → G2P is inherently dissipative (velocity smoothing)
2. **Drucker-Prager yield** — plastic deformation dissipates energy
3. **Boundary friction** — SDF collision friction removes tangential kinetic energy

Additional damping should be used sparingly, and only to prevent ringing artifacts.

---

## Part VI: The Friction Problem

### 6.1 Wrong Friction (Historical)

Previous simple solver applied friction to ALL velocity components:
```javascript
// WRONG:
state.vx[p] *= (1 - friction);  // kills vertical velocity too
state.vy[p] *= (1 - friction);
state.vz[p] *= (1 - friction);
```

### 6.2 Grid-Level Friction (Current, Correct)

The grid update function now implements proper Coulomb friction:
```javascript
// After removing normal component:
const tvx = vx - vDotN_new * nx;  // tangential velocity
const tSpeed = Math.sqrt(tvx² + tvy² + tvz²);
const frictionForce = Math.min(frictionCoeff * |vDotN|, tSpeed);
const scale = 1 - frictionForce / tSpeed;
// Apply only to tangential component
```

**This is correct.** Coulomb friction: tangential force ≤ μ * normal force.

### 6.3 Why Grid-Level Friction is Superior

When using the full MLS-MPM pipeline, friction should be applied at the **grid level** (in `gridUpdate`), not at the particle level. This is because:

1. Grid nodes represent shared velocity fields — friction applied there affects all nearby particles consistently
2. The SDF normal is more meaningful at grid resolution than at particle jitter positions
3. Multiple particles sharing a grid node will all respect the same friction constraint

The reference handles boundaries in `gridUpdate`, not in G2P. Our implementation correctly does this.

---

## Part VII: Spawn Strategy

### 7.1 Current Approach

Spawn from all solid voxels adjacent to air within SHELL_DEPTH=2 voxels of freshly carved surface. No stability check. Recently added: ejection velocity along SDF gradient.

### 7.2 Improvements Needed

1. **Stability filter**: Don't spawn from floor-facing surfaces. The SDF gradient at a voxel tells us the surface normal. If the normal points downward (solid below, air above), the voxel is stable and shouldn't dislodge.

```javascript
const [gx, gy, gz] = field.gradient(ix, iy, iz);
const normalY = gy / Math.sqrt(gx*gx + gy*gy + gz*gz);
if (normalY < -0.3) continue;  // floor = stable, skip
```

2. **Ejection velocity**: Already implemented. Particles get initial velocity along the SDF gradient (outward from the solid into the cavity). This simulates the dislodging force.

3. **Volume conservation**: The number of particles spawned should correspond to the volume of solid removed. Each voxel carved = `VOXEL_SIZE³` volume removed = N particles of volume `particleVolume` each.

---

## Part VIII: The CFL Condition

### 8.1 What CFL Means

The Courant-Friedrichs-Lewy (CFL) condition ensures numerical stability: information must not travel more than one grid cell per timestep.

```
dt * max_velocity < dx
```

For our solver: `dx = 1/64 ≈ 0.0156`.

### 8.2 Maximum Stable Timestep

With gravity = -200 and velocity clamp at 2.0:
```
dt_max = dx / v_max = 0.0156 / 2.0 = 0.0078
```

Our dt = 2e-4 is well within this limit (39x safety margin).

### 8.3 Substeps Per Frame

At 60 FPS with 16 substeps of dt=2e-4:
```
sim_time_per_frame = 16 * 2e-4 = 3.2e-3 seconds
sim_time_per_real_second = 3.2e-3 * 60 = 0.192 seconds
```

This means the simulation runs at ~19% real-time speed. A particle free-falling from the top of the domain takes:
```
t = sqrt(2 * 0.5 / 200) = 0.0707 sim seconds = 0.368 real seconds
```

That's about 22 frames — **visually fast enough** to see particles tumbling.

### 8.4 Can We Use Larger dt?

With dt=1e-3 and 8 substeps:
```
sim_time_per_frame = 8e-3 seconds
sim_time_per_real_second = 0.48 seconds
```

CFL: `1e-3 * 2.0 = 0.002 < 0.0156` ✓ (still safe)

This gives 2.5x faster simulation. Free fall time = 0.147 real seconds = 9 frames. **Very fast, very visible.**

### 8.5 Recommended Settings

```javascript
const MPM_DT = 5e-4;              // 5x larger than current — still 15x CFL margin
const MPM_STEPS_PER_FRAME = 12;   // 12 substeps
const MPM_GRAVITY = -200;         // match reference
// sim_time/frame = 6e-3, sim_speed = 36% real-time
// free fall half-domain = 14 frames ≈ 0.23 real seconds
```

---

## Part IX: The Volume Fix — The Most Important Change

### 9.1 What Volume Controls

Particle volume (`vol` or `pvol`) directly scales the stress contribution in P2G:

```
stress_force = -vol * 4 * inv_dx² * dt * Kirchhoff_stress * dpos
```

If `vol` is too small, stress forces vanish and particles act as independent projectiles.
If `vol` is too large, stress forces dominate and the material becomes infinitely rigid.

### 9.2 Reference Value

The reference uses `vol = 1.0` for **all** particles. This is the volume of the entire domain. It's not physically "correct" in an SI sense — it's a normalized value that produces the right force balance with `mass = 1.0` and `E = 10,000`.

### 9.3 Our Current Value (WRONG)

```javascript
state.volume[i] = (MPM_DX * MPM_DX * MPM_DX) / particlesPerCell;
// = (1/64)³ / 3
// = 3.8e-6 / 3
// = 1.27e-6
```

This is **788,000x smaller** than the reference value. Stress forces are essentially zero.

### 9.4 Correct Approach for 3D

In 3D MLS-MPM, the standard per-particle volume is:

```
vol_particle = (dx^3) * density / particle_mass
```

But in practice, the reference simply uses `vol = 1.0`. For a 3D simulation with `N_particles` total particles in a domain of volume 1.0, the per-particle volume should be:

```
vol_particle = domain_volume / N_particles = 1.0 / N
```

For 1000 particles: vol = 0.001. For 100 particles: vol = 0.01.

**BUT** — this makes the stress depend on particle count, which is undesirable. The reference sidesteps this by using vol=1.0 regardless.

### 9.5 The Practical Fix

The simplest fix that matches the reference: **use vol = 1.0** and adjust Young's modulus to compensate. With vol=1.0 and E=1000:

```
Stress per substep ≈ vol * 4 * invDx² * dt * E
                    = 1.0 * 4 * 4096 * 5e-4 * 1000
                    = 8192
```

This is much larger than gravity momentum per substep:
```
mass * gravity * dt = 1.0 * 200 * 5e-4 = 0.1
```

**Stress >> Gravity change per step.** This is the correct regime: inter-particle forces prevent overlap, while gravity slowly drives the flow.

### 9.6 Alternative: Scale Volume Correctly

If we want to keep the per-cell volume approach, we need to compensate with much higher E:

```
vol = dx³/3 = 1.27e-6
E_needed = E_reference * (vol_reference / vol_ours) = 10000 * (1.0 / 1.27e-6) ≈ 7.87e9
```

This is numerically ugly. **Just use vol = 1.0.**

---

## Part X: Complete Fix Specification

### 10.1 Constants (constants.ts)

```typescript
export const MPM_DT = 5e-4;              // timestep (was 2e-4)
export const MPM_GRAVITY = -200;          // gravity in MPM space (was -9.81)
export const MPM_STEPS_PER_FRAME = 12;    // substeps (was 16)
export const MPM_VELOCITY_DAMPING = 0.9999; // very light (was 0.9998)
```

### 10.2 Particle Volume (mpmSolver.ts, addParticle)

```typescript
// BEFORE (wrong):
state.volume[i] = (MPM_DX * MPM_DX * MPM_DX) / particlesPerCell;

// AFTER (correct):
state.volume[i] = 1.0;  // unit volume, matching reference
```

### 10.3 Young's Modulus (materialBrain.ts)

Scale down since we're using vol=1.0 (stress is vol*E, so reducing E compensates):

```typescript
// With vol=1.0, E should be tuned for the desired stiffness
// Reference: E=10000, vol=1.0, gravity=200
// For soil (softer than snow): E=200-2000 depending on material
```

| Material | Old E | New E (with vol=1.0) |
|----------|-------|---------------------|
| Dry Sand | 800 | 400 |
| Wet Clay | 500 | 200 |
| Silt | 700 | 350 |
| Organic | 300 | 100 |
| Gravel | 1500 | 800 |
| Loam | 500 | 200 |
| Sandy Silt | 750 | 350 |

### 10.4 Solver Entry Point (mpmSolver.ts)

```typescript
export function mpmStep(state, dt, field?) {
    clearGrid(state);
    particleToGrid(state, dt);
    gridUpdate(state, dt, field);
    gridToParticle(state, dt);
}
```

**ALREADY DONE** — this was implemented in the previous change.

### 10.5 Simulation Loop (soilSim.ts)

```typescript
step(dt: number): boolean {
    // ... age particles, check active count ...
    
    for (let sub = 0; sub < MPM_STEPS_PER_FRAME; sub++) {
        mpmStep(this.mpm, MPM_DT, this.field);
    }
    
    // ... deposit settled particles ...
}
```

**ALREADY DONE.**

---

## Part XI: What the SVD and Drucker-Prager Actually Do

### 11.1 SVD of Deformation Gradient

F = U Σ V^T, where:
- **U** = rotation of output space (left rotation)
- **Σ** = diagonal matrix of singular values (stretch amounts along principal axes)
- **V** = rotation of input space (right rotation)

The rotation part: **R = U V^T** (polar decomposition rotation).
The stretch part: **S = V Σ V^T**.

### 11.2 Fixed Corotated Stress

```
τ = 2μ(F - R)F^T + λJ(J-1)I
```

- `(F - R)` = the "non-rotational" part of deformation. Zero when F is pure rotation.
- `(F - R)F^T` = converts to Kirchhoff stress space
- `λJ(J-1)` = volumetric penalty. Zero when J=1 (volume preserved). Positive when compressed (J<1 → pushes apart). Negative when expanded (J>1 → pulls together).

This is **much more stable** than Neo-Hookean for large deformations because:
- Neo-Hookean: stress ~ F * F^T (quadratic in deformation → explodes)
- Fixed Corotated: stress ~ (F - R) * F^T (linear in deformation deviation → stable)

### 11.3 Drucker-Prager Yield

Applied in **log-strain space** on the singular values:

```
ε_i = log(σ_i)           — logarithmic strain per principal direction
ε_trace = Σ ε_i           — volumetric strain
ε_dev = ε_i - ε_trace/3  — deviatoric (shape-changing) strain
```

Yield function: `f = |ε_dev| + α * ε_trace - k_c`

Where:
- `α = sqrt(2/3) * 2*sin(φ) / (3 - sin(φ))` — friction angle cone
- `k_c = sqrt(2/3) * 2*c*cos(φ) / (3 - sin(φ))` — cohesion tip

When `f > 0`, the material has yielded (is flowing). We project the strain back onto the yield surface by reducing deviatoric strain. **This is what creates angle-of-repose behavior.**

When `ε_trace > 0` (material in tension), we clamp to identity → material separates (no tensile strength in soil).

### 11.4 Why This Matters for Soil

Different materials yield at different angles:
- **Sand** (φ=33°): steep piles, free-flowing
- **Clay** (φ=18°, high cohesion): shallow piles but holds shape, sticky
- **Gravel** (φ=35°): very steep piles, bouncy
- **Organic** (φ=22°): soft, compressible, spreads easily

The Drucker-Prager model captures all of this from just two parameters (friction angle and cohesion). **This is correct and sophisticated — our constitutive model is actually good.**

---

## Part XII: Performance Considerations

### 12.1 Grid Size

Our grid is 65³ = 274,625 nodes. Each node stores mass + 3 velocity components = 4 floats = 16 bytes.
Total grid memory: 274,625 * 16 = 4.4 MB.

Clearing the grid each substep: zeroing 4.4 MB. With 12 substeps/frame: 52.8 MB/frame of writes just for clearing.

### 12.2 P2G Cost

Each particle scatters to 3³ = 27 grid nodes. With 1000 active particles:
- 27,000 grid node updates per substep
- Each update: compute weight (3 multiplies), compute stress contribution (matrix multiply), accumulate

### 12.3 G2P Cost

Each particle gathers from 27 grid nodes. Similar cost to P2G.

### 12.4 Total Per-Frame Cost

12 substeps × (clear + P2G + grid_update + G2P) with 1000 particles:
- Clear: 12 × 274K zero ops
- P2G: 12 × 1000 × 27 scatter ops (each with SVD + stress)
- Grid: 12 × 274K conditional ops
- G2P: 12 × 1000 × 27 gather ops

The SVD in P2G is expensive (12 Jacobi iterations × 3 rotations = 36 matrix operations per particle per substep). With 1000 particles and 12 substeps: 432,000 SVD-related matrix ops per frame.

### 12.5 Optimization Opportunities

1. **Skip inactive grid regions**: Only process grid nodes that received mass in P2G
2. **Reduce SVD iterations**: 6-8 Jacobi iterations often sufficient for near-identity F
3. **Skip stress for near-identity F**: If |F - I| < ε, stress ≈ 0, skip SVD entirely
4. **Spatial hashing**: Sort particles by grid cell for cache-friendly access

---

## Part XIII: Rendering Pipeline

### 13.1 Current State

InstancedMesh with SphereGeometry(0.004, 6, 4). Per-particle color based on material type + moisture. Up to 16,384 displayed particles.

### 13.2 What "Dirt Chunks" Would Require

Instead of perfect spheres:
1. Use IcosahedronGeometry with per-vertex noise displacement
2. Random scale per particle (0.7x - 1.3x)
3. Random rotation per particle
4. Material-dependent geometry (sand = smaller, angular; clay = larger, rounded)

### 13.3 Screen-Space Fluid Rendering (Future)

As described in PRINCIPIA MORPHICA:
1. Render particle depths to a texture
2. Bilateral filter the depth texture (smooth while preserving edges)
3. Reconstruct normals from smoothed depth
4. Shade as a continuous surface with material properties
5. Composite over the terrain mesh

This would make particles look like a flowing mass rather than individual objects.

---

## Part XIV: What Success Looks Like (Revised)

With all fixes applied:

1. **Frame 0**: User clicks terrain. Spherical hole carved. ~200-500 particles spawn from cavity walls (not floor). Each has initial velocity outward along SDF gradient.

2. **Frames 1-15 (0.25s)**: Particles visibly fall and tumble. The MLS-MPM grid provides inter-particle pressure, preventing overlap. Particles near the cavity walls slide along them (Coulomb friction at grid level). Some particles eject slightly upward from the rim.

3. **Frames 15-60 (1s)**: Particles accumulate at the bottom of the cavity. The pile grows with a characteristic angle determined by the Drucker-Prager friction angle. Sand forms steep (~30°) piles. Clay forms shallow (~18°) but sticky piles.

4. **Frames 60-180 (3s)**: Remaining particles settle. The pile reaches equilibrium. Velocity drops below SETTLE_VELOCITY for SETTLE_FRAMES consecutive frames.

5. **Frames 180+**: Settled particles deposit back into SDF. Terrain mesh updates to show the mound of loose material at the bottom of the cavity and possibly a slight rim.

6. **Next dig**: Only new particles at new location. Old deposits are undisturbed.

---

## Part XV: Files That Need Changes

| File | Change | Why |
|------|--------|-----|
| `src/lib/mpm/constants.ts` | gravity=-200, dt=5e-4, steps=12 | Match reference force balance |
| `src/lib/mpm/mpmSolver.ts` | vol=1.0 in addParticle | Fix catastrophic volume error |
| `src/lib/soil/materialBrain.ts` | Scale E values down | Compensate for vol=1.0 |

**Everything else is already correct or acceptable.**

---

## Appendix A: The 88-Line Reference (Annotated for 3D)

The canonical MLS-MPM in pseudocode, extended to 3D:

```
function step(dt):
    // 1. Clear grid
    grid[*].mass = 0
    grid[*].velocity = 0
    
    // 2. P2G
    for each particle p:
        base = floor(p.x * inv_dx - 0.5)
        fx = p.x * inv_dx - base
        
        // Quadratic B-spline weights (3 per dimension)
        w[0] = 0.5 * (1.5 - fx)²
        w[1] = 0.75 - (fx - 1)²
        w[2] = 0.5 * (fx - 0.5)²
        
        // Stress (Fixed Corotated)
        F = p.F
        U, sigma, V = SVD(F)
        J = sigma[0] * sigma[1] * sigma[2]
        R = U * V^T
        stress = -vol * 4 * inv_dx² * dt * (2*mu*(F-R)*F^T + lambda*J*(J-1)*I)
        affine = stress + mass * p.C
        
        for di,dj,dk in 0..2:
            weight = w[di].x * w[dj].y * w[dk].z
            dpos = ([di,dj,dk] - fx) * dx
            grid[base+di,dj,dk].momentum += weight * (mass*p.v + affine*dpos)
            grid[base+di,dj,dk].mass += weight * mass
    
    // 3. Grid update
    for each grid node g:
        if g.mass > 0:
            g.v = g.momentum / g.mass
            g.v.y += gravity * dt
            // Boundary / SDF collision
            enforce_boundaries(g)
    
    // 4. G2P
    for each particle p:
        // Same base, fx, w computation
        p.v = 0
        p.C = 0
        for di,dj,dk in 0..2:
            weight = w[di].x * w[dj].y * w[dk].z
            dpos = ([di,dj,dk] - fx) * dx
            g_v = grid[base+di,dj,dk].v
            p.v += weight * g_v
            p.C += 4 * inv_dx² * weight * outer(g_v, dpos)
        
        p.x += dt * p.v
        p.F = (I + dt * p.C) * p.F
        
        // Drucker-Prager plasticity (optional, for soil)
        U, sigma, V = SVD(p.F)
        // ... project singular values onto yield surface ...
        p.F = U * diag(projected_sigma) * V^T
```

---

## Appendix B: Numerical Verification Checklist

After applying fixes, verify:

1. **Particles fall**: Drop a cluster of particles from y=0.8. They should reach y=0.2 in ~15 frames.
2. **Particles pile**: Drop particles onto a flat surface. They should form a mound, not pass through each other.
3. **Angle of repose**: Sand (φ=33°) piles should be steeper than clay (φ=18°) piles.
4. **No explosion**: F singular values should stay in [0.1, 5.0] range.
5. **No freeze**: Particles should move for at least 30 frames (0.5s) before settling.
6. **Energy dissipation**: Total kinetic energy should decrease monotonically (no energy creation).
7. **Mass conservation**: Total particle mass should remain constant.

---

*Document version: 1.0*
*Based on: Hu et al. SIGGRAPH 2018, r03ert0/mls-mpm.js, PRINCIPIA MORPHICA*
*Written: 2026-03-08*
