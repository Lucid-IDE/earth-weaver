# Realistic Dirt/Soil Particle Rendering: Research & Implementation Plan

## The Problem

Current rendering: **uniform smooth spheres** with flat material colors. This looks like a bag of marbles, not dirt. Real soil is irregular, clumpy, rough-textured, and forms a continuous mass rather than discrete perfect spheres.

---

## Part I: What Real Dirt Looks Like

### 1.1 Visual Properties of Granular Soil

1. **Irregular shape** — No two grains are identical. Sand grains are angular. Clay clumps are amorphous. Gravel is chunky.
2. **Size variation** — Natural soil has a wide particle size distribution (0.5x to 2x mean).
3. **Surface roughness** — Matte, rough surfaces with micro-occlusion in crevices.
4. **Color variation** — Not uniform. Each grain varies slightly in hue/saturation. Wet surfaces are darker.
5. **Cohesive clumping** — Moist soil sticks together in aggregates, not individual particles.
6. **Dust/debris trail** — Moving soil kicks up fine dust particles.
7. **Mass appearance** — At distance, individual particles merge into a continuous surface.

### 1.2 Why Spheres Fail

- Perfect geometric primitives look synthetic
- Uniform size screams "computer generated"
- No self-shadowing between particles
- No surface roughness or texture
- No visual cohesion between neighboring particles

---

## Part II: Rendering Techniques (Ranked by Impact/Feasibility)

### Tier 1: Immediate Improvements (InstancedMesh enhancements)

#### A. Noise-Displaced Icosahedron Geometry

Replace `SphereGeometry(0.004, 6, 4)` with a pre-computed irregular rock shape:

```typescript
function createDirtChunkGeometry(seed: number): BufferGeometry {
    const ico = new IcosahedronGeometry(0.004, 1); // low-poly base
    const pos = ico.attributes.position;
    for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const len = Math.sqrt(x*x + y*y + z*z);
        // Perlin-style noise displacement
        const noise = simplex3(x*50 + seed, y*50, z*50) * 0.3 + 
                      simplex3(x*100 + seed, y*100, z*100) * 0.15;
        const scale = 1 + noise;
        pos.setXYZ(i, x/len * 0.004 * scale, y/len * 0.004 * scale, z/len * 0.004 * scale);
    }
    ico.computeVertexNormals();
    return ico;
}
```

**Impact**: Massive. Irregular silhouettes immediately break the "marble" look.

#### B. Per-Instance Random Scale + Rotation

```typescript
// In the useFrame loop:
const scaleVar = 0.6 + srand() * 0.8;  // 0.6x to 1.4x
dummy.scale.set(scaleVar, scaleVar * (0.7 + srand()*0.6), scaleVar);
dummy.rotation.set(srand()*Math.PI, srand()*Math.PI, srand()*Math.PI);
```

**Impact**: High. Breaks uniformity.

#### C. Per-Instance Color Variation

```typescript
// Add per-grain hue/saturation jitter
const hueShift = (srand() - 0.5) * 0.08;
const satShift = (srand() - 0.5) * 0.15;
const valShift = (srand() - 0.5) * 0.2;
tmpColor.setRGB(
    base.r * darken + hueShift + valShift,
    base.g * darken + satShift * 0.5 + valShift,
    base.b * darken - hueShift * 0.3 + valShift
);
```

**Impact**: Medium. More natural look.

#### D. Multiple Geometry LODs (3-5 pre-generated shapes)

Create 3-5 different irregular geometries and batch them into separate InstancedMeshes. Each particle randomly picks one. This gives variety without per-vertex noise at runtime.

**Impact**: Medium. More visual diversity.

### Tier 2: Screen-Space Fluid Rendering (Post-Processing)

This is the industry-standard technique for making particles look like a continuous mass. Used in every major fluid simulator (NVIDIA FleX, Unreal Niagara, Unity VFX Graph).

#### The Pipeline (van der Laan et al. 2009):

```
1. DEPTH PASS    — Render particles as point sprites/spheres to a depth-only FBO
2. SMOOTH PASS   — Bilateral Gaussian filter on the depth buffer (preserves edges)
3. NORMAL PASS   — Reconstruct surface normals from smoothed depth (screen-space derivatives)
4. SHADE PASS    — Phong/PBR lighting using reconstructed normals + material color
5. COMPOSITE     — Blend fluid surface over the terrain scene
```

#### Depth Pass Shader (vertex):
```glsl
varying float vDepth;
void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = particleRadius * screenHeight / -mvPosition.z;
    vDepth = -mvPosition.z; // linear depth
}
```

#### Depth Pass Shader (fragment):
```glsl
varying float vDepth;
void main() {
    // Discard outside sphere
    vec2 coord = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(coord, coord);
    if (r2 > 1.0) discard;
    
    // Sphere depth correction
    float z = sqrt(1.0 - r2);
    float depth = vDepth - z * particleRadius;
    gl_FragDepth = depth / farPlane;
    gl_FragColor = vec4(depth, 0.0, 0.0, 1.0);
}
```

#### Bilateral Filter Shader:
```glsl
// Smooths depth while preserving edges (soil surface boundaries)
uniform sampler2D depthTex;
uniform float filterRadius;
uniform float blurDepthFalloff;

void main() {
    float depth = texture2D(depthTex, vUv).r;
    float sum = 0.0;
    float wsum = 0.0;
    
    for (int x = -KERNEL_RADIUS; x <= KERNEL_RADIUS; x++) {
        for (int y = -KERNEL_RADIUS; y <= KERNEL_RADIUS; y++) {
            vec2 offset = vec2(float(x), float(y)) / resolution;
            float sample = texture2D(depthTex, vUv + offset).r;
            
            float r = length(vec2(x, y)) * filterRadius;
            float w = exp(-r*r);                           // spatial weight
            float r2 = (sample - depth) * blurDepthFalloff;
            float g = exp(-r2*r2);                         // range weight (depth similarity)
            
            sum += sample * w * g;
            wsum += w * g;
        }
    }
    gl_FragColor = vec4(sum / wsum, 0.0, 0.0, 1.0);
}
```

#### Normal Reconstruction:
```glsl
uniform sampler2D smoothedDepth;
void main() {
    float d = texture2D(smoothedDepth, vUv).r;
    float dx = texture2D(smoothedDepth, vUv + vec2(1.0/width, 0.0)).r - d;
    float dy = texture2D(smoothedDepth, vUv + vec2(0.0, 1.0/height)).r - d;
    vec3 normal = normalize(vec3(-dx, -dy, 1.0));
    // Use normal for Phong/PBR shading with soil material
}
```

**Impact**: TRANSFORMATIVE. This is what makes particles look like a flowing mass instead of individual objects. The bilateral filter merges nearby particles into a smooth surface.

**Complexity**: High. Requires:
- Multiple render targets (FBOs)
- Custom shader passes
- In R3F: manual EffectComposer setup with custom ShaderPasses

### Tier 3: Advanced Techniques (Future)

#### A. Ellipsoid Splatting

Render each particle as an oriented ellipsoid (stretched along velocity direction). This gives motion blur for free and makes fast-moving soil look like streaks.

```typescript
// In useFrame:
const speed = Math.sqrt(vx*vx + vy*vy + vz*vz);
const stretch = 1 + speed * 5; // elongate along velocity
dummy.scale.set(baseScale, baseScale, baseScale * stretch);
dummy.lookAt(px + vx, py + vy, pz + vz); // orient along velocity
```

#### B. Dust Particle System

Secondary particle system with tiny, semi-transparent quads that spawn from fast-moving soil particles and fade out over 0.5-1 seconds. Uses additive blending for a hazy dust cloud effect.

#### C. Ambient Occlusion Between Particles

SSAO (Screen-Space Ambient Occlusion) on the particle depth buffer. Makes crevices between grains darker, adding depth perception to piles.

#### D. Gaussian Splatting (Research Frontier)

Each particle rendered as an oriented 3D Gaussian kernel (α-blended splat). Allows smooth surface reconstruction without explicit mesh generation. Very promising for soil — see recent papers on Gaussian Splatting Visual MPC for Granular Media (Tseng et al. 2024).

---

## Part III: Implementation Priority

### Phase 1: Irregular Chunks (IMMEDIATE — hours)

**Files**: `src/components/SoilViewer.tsx`

1. Replace SphereGeometry with noise-displaced IcosahedronGeometry
2. Pre-generate 4 different chunk shapes
3. Use 4 separate InstancedMeshes, randomly assign particles to each
4. Per-instance random scale (0.6x-1.4x) and rotation
5. Per-instance color jitter (±15% RGB)
6. Velocity-based elongation (stretch along movement direction)

**Expected result**: Particles look like irregular dirt chunks, not marbles.

### Phase 2: Screen-Space Smoothing (NEXT — days)

**Files**: New shader files + `SoilViewer.tsx`

1. Create depth-only render pass for particles
2. Implement bilateral filter shader
3. Reconstruct normals from smoothed depth
4. Shade with earthy PBR material
5. Composite over terrain

**Expected result**: Dense particle groups look like a continuous soil mass.

### Phase 3: Dust + Polish (LATER)

1. Secondary dust particle system (additive blending)
2. Velocity-based ellipsoid stretching
3. SSAO for inter-particle shadow
4. LOD system (reduce geometry complexity for distant particles)

---

## Part IV: Material-Specific Visual Targets

### Sand
- **Shape**: Angular, small, slightly translucent
- **Color**: Golden-tan with orange/white variation
- **Behavior**: Free-flowing, individual grains visible, sparkles in light
- **Size**: 0.003 base radius

### Clay
- **Shape**: Soft, rounded clumps, 2-3x larger than sand
- **Color**: Red-brown to grey, very uniform within clumps
- **Behavior**: Sticky, breaks into chunks rather than flowing
- **Size**: 0.006 base radius (clumps)

### Gravel
- **Shape**: Very angular, large, faceted
- **Color**: Grey with high variation (dark inclusions)
- **Behavior**: Bouncy, loud (future: sound), rolls
- **Size**: 0.008 base radius

### Organic/Peat
- **Shape**: Fibrous, elongated, amorphous
- **Color**: Very dark brown to black
- **Behavior**: Soft, spongy, compresses easily
- **Size**: 0.005 base radius, elongated 1.5x

### Loam
- **Shape**: Irregular medium clumps
- **Color**: Rich brown, moderate variation
- **Behavior**: Crumbly, moderate cohesion
- **Size**: 0.004 base radius

---

## Part V: Reference Implementations

1. **NVIDIA FleX** — Industry-standard granular sim with screen-space rendering
2. **Unreal Engine Niagara** — Particle fluid rendering with depth smoothing  
3. **xuxmin/pbf** (GitHub) — WebGL Position-Based Fluids with screen-space fluid rendering
4. **Dddatt/ss-fluid-rendering** (GitHub) — PIC/FLIP sim with screen-space rendering in WebGL
5. **Narrow-Band Screen-Space Fluid Rendering** (Neto et al. 2022) — Optimized bilateral filter
6. **EWA Splatting** (Zwicker et al.) — Elliptical Gaussian kernel splatting for point sets

---

## Part VI: Three.js/R3F Specific Implementation Notes

### InstancedMesh Approach (Phase 1)

```tsx
// Pre-generate geometries
const geos = useMemo(() => [
    createDirtChunk(0), createDirtChunk(1),
    createDirtChunk(2), createDirtChunk(3),
], []);

// 4 InstancedMeshes, cycle particles through them
return <>
    {geos.map((geo, i) => (
        <instancedMesh key={i} ref={meshRefs[i]} args={[geo, material, maxDisplay/4]} />
    ))}
</>
```

### Screen-Space Rendering (Phase 2)

In R3F, use `useFrame` with manual rendering:

```tsx
function FluidRenderer({ particles }) {
    const { gl, scene, camera } = useThree();
    const depthTarget = useMemo(() => new WebGLRenderTarget(w, h, { type: FloatType }), []);
    const smoothTarget = useMemo(() => new WebGLRenderTarget(w, h, { type: FloatType }), []);
    
    useFrame(() => {
        // 1. Render particle depths to depthTarget
        gl.setRenderTarget(depthTarget);
        gl.render(particleScene, camera);
        
        // 2. Bilateral filter → smoothTarget
        filterMaterial.uniforms.depthTex.value = depthTarget.texture;
        gl.setRenderTarget(smoothTarget);
        gl.render(fullscreenQuad, orthoCamera);
        
        // 3. Normal reconstruction + shading → screen
        shadeMaterial.uniforms.smoothedDepth.value = smoothTarget.texture;
        gl.setRenderTarget(null);
        gl.render(fullscreenQuad, orthoCamera);
    }, 1);
}
```

---

*Document version: 1.0*
*Research date: 2026-03-08*
*Sources: NVIDIA FleX docs, van der Laan 2009, Narrow-Band SSFR (Neto 2022), Perlin noise aggregate shapes (Michot-Roberto 2021), EWA Splatting (Zwicker et al.)*
