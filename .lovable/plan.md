

## Plan: Screen-Space Fluid Surface Rendering

### Problem
Individual particles (splats, spheres, chunks) always look like discrete objects — confetti, not dirt. The SDF terrain looks like a solid mass; the particles need to look like the **same material** breaking off and flowing.

### Solution
Implement the **screen-space fluid rendering pipeline** that's already been partially written in `fluidShaders.ts` but never wired up. This composites particles into a **continuous surface** by:

1. Rendering particle depths to an offscreen texture
2. Bilateral-filtering those depths to merge nearby particles into one smooth surface
3. Reconstructing normals from the smoothed depth
4. Shading the result using the **same lighting/material model as the SDF terrain shader**

### Implementation Steps

**1. Create `FluidRenderer` component** (replaces `DirtSplatCloud`)
- Render particles as point sprites into a depth-only `WebGLRenderTarget`
- Each particle writes sphere-corrected depth (not flat discs)
- Use `particleDepthVertexShader` / `particleDepthFragmentShader` from `fluidShaders.ts`

**2. Bilateral filter pass**
- Full-screen quad pass that smooths the depth texture
- Edge-preserving: only merges particles at similar depths (so front/back layers stay separate)
- This is what turns 1000 individual dots into one continuous flowing shape

**3. Normal reconstruction pass**
- Derives surface normals from the smoothed depth gradient
- These normals drive realistic lighting on the merged surface

**4. Final shading pass — match the SDF shader**
- Port the SDF terrain's stratigraphy, moisture darkening, lighting (warm key + cool fill), SSS, and fog into the fluid shading fragment shader
- Particles carry their material type + depth → shader reconstructs the same layered color
- Result: the fluid surface is visually indistinguishable from the SDF terrain, just moving

**5. Composite over scene**
- Render the fluid surface as a screen-aligned quad with proper depth testing
- Blends seamlessly with the SDF terrain at contact edges

**6. Tune parameters**
- Increase particle count (spawn density) for better coverage
- Adjust bilateral filter radius to control how "blobby" vs "granular" the surface looks
- Smaller filter = grainy sand feel; larger = wet mud flow

### Files Changed
- `src/lib/rendering/fluidShaders.ts` — update final shading shader to match SDF terrain material
- `src/components/SoilViewer.tsx` — replace `DirtSplatCloud` with multi-pass `FluidRenderer`; keep `DustCloud` for atmosphere
- `src/lib/mpm/constants.ts` — increase `MAX_PARTICLES` to 131072 for denser coverage

### Key Insight
The splats stay as the **simulation representation** but are never directly visible. The screen-space pipeline turns them into a smooth surface that looks like the same dirt as the terrain — just detached and falling.

