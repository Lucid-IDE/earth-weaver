

## Diagnosis: Why the Soil Lab is Broken

The current `soil-lab.html` is the water simulation with cosmetic tweaks. It has **no real soil physics**. Specifically:

### 1. No Deformation Gradient (F)
The `Particle` struct stores only `position`, `velocity`, and `C` (APIC affine matrix). Real granular MLS-MPM requires a **per-particle deformation gradient `F` (mat3x3f)** that tracks how each particle has been stretched/sheared since the simulation started. Without `F`, there is no elastic memory and no meaningful yield criterion.

### 2. No SVD-Based Return Mapping
The Drucker-Prager model in the paper (Klár et al. 2016) works like this:
- Compute `F = (I + dt*C) * F_old` in G2P
- SVD decompose: `F = U * Σ * V^T`
- Compute log-strain: `ε = log(Σ)`
- Check yield: `‖ε_dev‖ + α * tr(ε) > k_c` → project singular values back onto yield surface
- Reconstruct: `F_new = U * Σ_projected * V^T`

The current code does none of this. It applies a viscosity cap to the strain rate from C, which is a fluid model with extra friction—not elastoplasticity. **This is why it still behaves like water.**

### 3. Stress Computation is Wrong
The real MLS-MPM sand stress is **Neo-Hookean Kirchhoff stress** computed from F:
```
stress = U * (2μ * Σ^{-1} * log(Σ) + λ * tr(log(Σ)) * Σ^{-1}) * V^T
stress_force = -p_vol * 4 * inv_dx² * stress * F^T
```
The current code uses an EOS pressure (`stiffness * (density/restDensity - 1)`) which is an SPH-style fluid pressure model.

---

## Plan: Proper Granular MLS-MPM in WGSL

### Phase 1: Add Deformation Gradient F to Particle Struct

Change the WGSL `Particle` struct from:
```wgsl
struct Particle {
    position: vec3f,
    v: vec3f,
    C: mat3x3f,
}
```
to:
```wgsl
struct Particle {
    position: vec3f,
    v: vec3f,
    C: mat3x3f,
    F: mat3x3f,    // deformation gradient
    logJp: f32,    // volume correction (log of plastic Jacobian)
}
```

This changes particle stride from 80 bytes to ~160 bytes. All buffer sizes, bind groups, and the `initDambreak` function must be updated.

### Phase 2: Implement 3x3 SVD in WGSL

Write a Jacobi-rotation SVD for 3x3 matrices directly in the WGSL shaders. This will be a helper function used in both P2G (stress computation) and G2P (return mapping). Based on the approach in the CPU solver (`svd3.ts`): iterate Jacobi rotations on `F^T * F` to get eigenvalues (Σ²) and V, then compute `U = F * V * Σ^{-1}`.

### Phase 3: Rewrite P2G Stress Computation

Replace the fluid EOS + viscosity model in `p2g_2` with:

1. Read particle's `F`
2. SVD: `F = U * Σ * V^T`
3. Compute Neo-Hookean Kirchhoff stress in log-strain space:
   ```
   stress = U * (2μ * Σ^{-1} * log(Σ) + λ * tr(log(Σ)) * Σ^{-1}) * V^T
   ```
4. Multiply by `-p_vol * 4 * inv_dx²` and scatter to grid as force contribution

### Phase 4: Rewrite G2P with F Update + Drucker-Prager Return Mapping

In the `g2p` shader, after gathering velocity and computing new C:

1. Update F: `F_new = (I + dt * C_new) * F_old`
2. SVD: `F_new = U * Σ * V^T`
3. Drucker-Prager projection on singular values:
   - `ε = log(Σ)`, compute `ε_dev` and `‖ε_dev‖`
   - If `tr(ε) > 0`: tension → clamp to identity
   - If `‖ε_dev‖ + α*tr(ε) > k_c`: yielding → project back
   - Else: elastic, keep Σ
4. Reconstruct: `F = U * Σ_projected * V^T`
5. Track `logJp` for volume correction

### Phase 5: Rendering — Hybrid Opaque/Fluid

Modify the final compositing shader to render soil as **opaque matte** instead of transparent fluid:
- Use the existing depth-smoothing pipeline (it creates a nice continuous surface)
- In the final fragment shader: replace Fresnel/refraction/transmission with Lambert diffuse + ambient occlusion
- Brown/earthy albedo based on material preset
- Keep the density-raymarch shadow pass (it works well for self-shadowing)

### Phase 6: Material Presets via Uniform Buffer

Add a uniform buffer with material parameters passed from JS:
- `frictionAngle`, `cohesion`, `E` (Young's modulus), `nu` (Poisson ratio), `gravity`
- lil-gui controls: Sand (φ=35°, low cohesion), Clay (φ=20°, high cohesion), Mud (φ=15°, medium cohesion, high damping), Gravel (φ=40°, zero cohesion)

### Files to Modify

1. **`public/soil-lab.html`** — Complete rewrite of the compute shaders (P2G, G2P), particle struct, initialization, SVD implementation, and final rendering shader. The rendering pipeline, camera, mouse interaction, and WebGPU infrastructure stay the same.

### Technical Details

**SVD in WGSL** (the trickiest part): Implement 8-12 Jacobi rotation sweeps on `F^T * F` (symmetric), each sweep zeroing the three off-diagonal pairs (0,1), (0,2), (1,2). This is ~120 lines of WGSL.

**Particle size**: Currently 80 bytes (3+3+9 floats = 15 floats × 4 bytes + padding). New struct needs 15 + 9 + 1 = 25 floats → 128 bytes with alignment.

**Performance**: SVD per particle in G2P and P2G adds ~200 FLOPs per particle per step. At 100k particles this is manageable on GPU.

**Reference**: The Taichi `sand.py` code from TempContainer/sand-MPM confirms the exact algorithm — SVD, log-strain, Drucker-Prager projection, volume correction — which is what we'll port to WGSL.

