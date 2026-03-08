import { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, ThreeEvent, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { VoxelField } from '@/lib/soil/VoxelField';
import { SoilSimulator } from '@/lib/soil/soilSim';
import { soilVertexShader, soilFragmentShader } from '@/lib/soil/soilShader';
import { DIG_RADIUS } from '@/lib/soil/constants';
import { mpmToWorld } from '@/lib/mpm/bridge';
import { triggerAutoCapture, createSettleDetector } from '@/lib/analyst/autoCapture';
import {
  dustVertexShader,
  dustFragmentShader,
} from '@/lib/rendering/dirtShaders';
import {
  particleDepthVertexShader,
  particleDepthFragmentShader,
  fullscreenQuadVertexShader,
  bilateralFilterFragmentShader,
  fluidCompositingFragmentShader,
} from '@/lib/rendering/fluidShaders';

export interface SoilStats {
  vertices: number;
  triangles: number;
  simActive: boolean;
  activeParticles: number;
  totalParticles: number;
}

// ── Seeded RNG ──────────────────────────────────────────────────────
function mulberry32(a: number) {
  return function() {
    var t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
}

// ── Material color palette ──────────────────────────────────────────
const MATERIAL_BASE_COLORS = [
  [0.76, 0.70, 0.50],  // Sand
  [0.52, 0.36, 0.24],  // Clay
  [0.65, 0.55, 0.40],  // Silt
  [0.28, 0.22, 0.14],  // Organic
  [0.58, 0.56, 0.52],  // Gravel
  [0.48, 0.40, 0.30],  // Loam
  [0.60, 0.50, 0.35],  // Sandy Silt
];

// ── Screen-Space Fluid Renderer ─────────────────────────────────────
// Multi-pass pipeline that renders particles into a continuous surface:
// 1. Depth pass: particles as spherical impostors → depth + color texture
// 2. Bilateral filter (2-pass separable): smooths depth to merge particles
// 3. Compositing: reconstruct normals from smoothed depth, shade with SDF material
function FluidRenderer({ simRef }: { simRef: React.MutableRefObject<SoilSimulator | null> }) {
  const MAX_PARTICLES_RENDER = 131072;
  const { gl, camera, size } = useThree();
  
  const resources = useMemo(() => {
    const w = Math.max(size.width, 1);
    const h = Math.max(size.height, 1);
    
    // ── Render targets ──
    const depthTarget = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.FloatType,
      depthBuffer: true,
    });
    
    const filterTargetH = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.FloatType,
    });
    
    const filterTargetV = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.FloatType,
    });
    
    // ── Point sprite geometry for depth pass ──
    const pointGeo = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(new Float32Array(MAX_PARTICLES_RENDER * 3), 3);
    const radAttr = new THREE.BufferAttribute(new Float32Array(MAX_PARTICLES_RENDER), 1);
    const colAttr = new THREE.BufferAttribute(new Float32Array(MAX_PARTICLES_RENDER * 4), 4);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    radAttr.setUsage(THREE.DynamicDrawUsage);
    colAttr.setUsage(THREE.DynamicDrawUsage);
    pointGeo.setAttribute('position', posAttr); // needed but overridden by instancePosition
    
    // For points mode, we use position directly
    const depthMat = new THREE.ShaderMaterial({
      vertexShader: particleDepthVertexShader,
      fragmentShader: particleDepthFragmentShader,
      uniforms: {
        near: { value: 0.005 },
        far: { value: 10 },
      },
      depthTest: true,
      depthWrite: true,
    });
    
    // Use instanced points via custom attribute
    const instancedGeo = new THREE.InstancedBufferGeometry();
    // Single point vertex
    instancedGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0]), 3));
    const instancePosAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES_RENDER * 3), 3);
    const instanceRadiusAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES_RENDER), 1);
    const instanceColorAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES_RENDER * 4), 4);
    instancePosAttr.setUsage(THREE.DynamicDrawUsage);
    instanceRadiusAttr.setUsage(THREE.DynamicDrawUsage);
    instanceColorAttr.setUsage(THREE.DynamicDrawUsage);
    instancedGeo.setAttribute('instancePosition', instancePosAttr);
    instancedGeo.setAttribute('instanceRadius', instanceRadiusAttr);
    instancedGeo.setAttribute('instanceColor', instanceColorAttr);
    instancedGeo.instanceCount = 0;
    
    // Actually we need gl_PointSize — use Points with a custom ShaderMaterial
    // Let's use a simpler approach: regular Points geometry
    const pointsGeo = new THREE.BufferGeometry();
    const pPositions = new Float32Array(MAX_PARTICLES_RENDER * 3);
    const pColors = new Float32Array(MAX_PARTICLES_RENDER * 4);
    const pRadii = new Float32Array(MAX_PARTICLES_RENDER);
    pointsGeo.setAttribute('position', new THREE.BufferAttribute(pPositions, 3));
    pointsGeo.setAttribute('instanceColor', new THREE.BufferAttribute(pColors, 4));
    pointsGeo.setAttribute('instanceRadius', new THREE.BufferAttribute(pRadii, 1));
    (pointsGeo.attributes.position as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
    (pointsGeo.attributes.instanceColor as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
    (pointsGeo.attributes.instanceRadius as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
    
    // Depth material for Points
    const pointsDepthMat = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `
        attribute vec4 instanceColor;
        attribute float instanceRadius;
        
        varying vec3 vViewPosition;
        varying float vRadius;
        varying vec3 vColor;
        
        void main() {
            vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
            vViewPosition = mvPosition.xyz;
            vColor = instanceColor.rgb;
            vRadius = instanceRadius;
            
            float screenRadius = instanceRadius * (800.0 / length(mvPosition.xyz));
            gl_PointSize = max(screenRadius, 1.0);
            gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vViewPosition;
        varying float vRadius;
        varying vec3 vColor;
        
        uniform float near;
        uniform float far;
        
        void main() {
            vec2 coord = gl_PointCoord * 2.0 - 1.0;
            float r2 = dot(coord, coord);
            if (r2 > 1.0) discard;
            
            float z = sqrt(1.0 - r2);
            float depth = vViewPosition.z + z * vRadius;
            float linearDepth = (-depth - near) / (far - near);
            
            gl_FragColor = vec4(linearDepth, vColor);
            
            vec4 clipPos = projectionMatrix * vec4(vViewPosition.xy, depth, 1.0);
            float ndc = clipPos.z / clipPos.w;
            gl_FragDepth = (ndc + 1.0) * 0.5;
        }
      `,
      uniforms: {
        near: { value: 0.005 },
        far: { value: 10.0 },
      },
      depthTest: true,
      depthWrite: true,
    });
    
    const pointsMesh = new THREE.Points(pointsGeo, pointsDepthMat);
    pointsMesh.frustumCulled = false;
    
    // ── Fullscreen quad for filter/composite passes ──
    const quadGeo = new THREE.PlaneGeometry(2, 2);
    
    const filterMat = new THREE.ShaderMaterial({
      vertexShader: fullscreenQuadVertexShader,
      fragmentShader: bilateralFilterFragmentShader,
      uniforms: {
        depthTexture: { value: null },
        resolution: { value: new THREE.Vector2(w, h) },
        filterDirection: { value: new THREE.Vector2(1, 0) },
        blurScale: { value: 1.5 },
        blurDepthFalloff: { value: 100.0 },
      },
      depthTest: false,
      depthWrite: false,
    });
    
    const compositeMat = new THREE.ShaderMaterial({
      vertexShader: fullscreenQuadVertexShader,
      fragmentShader: fluidCompositingFragmentShader,
      uniforms: {
        smoothedDepthTexture: { value: null },
        resolution: { value: new THREE.Vector2(w, h) },
        near: { value: 0.005 },
        far: { value: 10.0 },
        invProjectionMatrix: { value: new THREE.Matrix4() },
      },
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: THREE.NormalBlending,
    });
    
    const filterQuad = new THREE.Mesh(quadGeo, filterMat);
    const compositeQuad = new THREE.Mesh(quadGeo, compositeMat);
    
    const filterScene = new THREE.Scene();
    filterScene.add(filterQuad);
    
    const compositeScene = new THREE.Scene();
    compositeScene.add(compositeQuad);
    
    const orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    
    const depthScene = new THREE.Scene();
    depthScene.add(pointsMesh);
    
    return {
      depthTarget, filterTargetH, filterTargetV,
      pointsGeo, pointsMesh, pointsDepthMat,
      filterMat, compositeMat,
      filterScene, compositeScene, depthScene,
      orthoCamera,
      pPositions, pColors, pRadii,
    };
  }, []);
  
  // Handle resize
  useEffect(() => {
    const w = Math.max(size.width, 1);
    const h = Math.max(size.height, 1);
    resources.depthTarget.setSize(w, h);
    resources.filterTargetH.setSize(w, h);
    resources.filterTargetV.setSize(w, h);
    resources.filterMat.uniforms.resolution.value.set(w, h);
    resources.compositeMat.uniforms.resolution.value.set(w, h);
  }, [size.width, size.height, resources]);
  
  // Pre-generate particle random data
  const particleRng = useMemo(() => {
    const rng = mulberry32(42);
    const data = new Float32Array(131072 * 2); // radius, colorJitter
    for (let i = 0; i < 131072; i++) {
      data[i*2 + 0] = 0.003 + rng() * 0.005; // radius 0.003-0.008
      data[i*2 + 1] = (rng() - 0.5) * 0.06;  // color jitter
    }
    return data;
  }, []);
  
  useFrame(() => {
    const sim = simRef.current;
    if (!sim) return;
    
    const mpm = sim.mpm;
    const { pPositions, pColors, pRadii, pointsGeo } = resources;
    
    let count = 0;
    
    for (let i = 0; i < mpm.numParticles && count < MAX_PARTICLES_RENDER; i++) {
      if (!mpm.active[i]) continue;
      
      const [wx, wy, wz] = mpmToWorld(mpm.px[i], mpm.py[i], mpm.pz[i]);
      
      pPositions[count * 3] = wx;
      pPositions[count * 3 + 1] = wy;
      pPositions[count * 3 + 2] = wz;
      
      const rOff = (i % 131072) * 2;
      pRadii[count] = particleRng[rOff];
      
      // Color from material type with depth/moisture adjustments
      const matType = Math.min(mpm.materialType[i], 6);
      const base = MATERIAL_BASE_COLORS[matType];
      const moisture = mpm.moisture ? mpm.moisture[i] : 0;
      
      const depthFactor = Math.max(0, Math.min(1, (-wy - 0.05) * 3.0));
      const depthDarken = 1.0 - depthFactor * 0.25;
      const moistureDarken = 1 - moisture * 0.35;
      const darken = depthDarken * moistureDarken;
      const jitter = particleRng[rOff + 1];
      
      // Surface proximity organic boost
      const surfaceProximity = 1.0 - Math.min(1, Math.max(0, (-wy + 0.02) / 0.14));
      const organicMix = surfaceProximity * 0.45;
      
      pColors[count * 4] = Math.max(0, Math.min(1, (base[0] * (1 - organicMix) + 0.22 * organicMix) * darken + jitter));
      pColors[count * 4 + 1] = Math.max(0, Math.min(1, (base[1] * (1 - organicMix) + 0.18 * organicMix) * darken + jitter * 0.8));
      pColors[count * 4 + 2] = Math.max(0, Math.min(1, (base[2] * (1 - organicMix) + 0.10 * organicMix) * darken + jitter * 0.6));
      pColors[count * 4 + 3] = 1.0;
      
      count++;
    }
    
    pointsGeo.setDrawRange(0, count);
    (pointsGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (pointsGeo.attributes.instanceColor as THREE.BufferAttribute).needsUpdate = true;
    (pointsGeo.attributes.instanceRadius as THREE.BufferAttribute).needsUpdate = true;
    
    // Skip rendering if no particles
    if (count === 0) return;
    
    // ── Pass 1: Render particle depths ──
    const currentRT = gl.getRenderTarget();
    const currentAutoClear = gl.autoClear;
    gl.autoClear = false;
    
    gl.setRenderTarget(resources.depthTarget);
    gl.clearColor();
    gl.clearDepth();
    gl.render(resources.depthScene, camera);
    
    // ── Pass 2a: Horizontal bilateral filter ──
    resources.filterMat.uniforms.depthTexture.value = resources.depthTarget.texture;
    resources.filterMat.uniforms.filterDirection.value.set(1, 0);
    gl.setRenderTarget(resources.filterTargetH);
    gl.clearColor();
    gl.render(resources.filterScene, resources.orthoCamera);
    
    // ── Pass 2b: Vertical bilateral filter ──
    resources.filterMat.uniforms.depthTexture.value = resources.filterTargetH.texture;
    resources.filterMat.uniforms.filterDirection.value.set(0, 1);
    gl.setRenderTarget(resources.filterTargetV);
    gl.clearColor();
    gl.render(resources.filterScene, resources.orthoCamera);
    
    // ── Pass 3: Composite — normal reconstruction + shading ──
    resources.compositeMat.uniforms.smoothedDepthTexture.value = resources.filterTargetV.texture;
    resources.compositeMat.uniforms.invProjectionMatrix.value.copy(camera.projectionMatrixInverse);
    
    gl.setRenderTarget(currentRT); // back to screen
    gl.autoClear = currentAutoClear;
    // Render composite as transparent overlay
    gl.render(resources.compositeScene, resources.orthoCamera);
  });
  
  // Cleanup
  useEffect(() => {
    return () => {
      resources.depthTarget.dispose();
      resources.filterTargetH.dispose();
      resources.filterTargetV.dispose();
      resources.pointsGeo.dispose();
      resources.pointsDepthMat.dispose();
      resources.filterMat.dispose();
      resources.compositeMat.dispose();
    };
  }, [resources]);
  
  return null; // All rendering is manual via gl.render
}

// ── Dust Particle System ────────────────────────────────────────────
// Small translucent particles that float up from impacts
function DustCloud({ simRef }: { simRef: React.MutableRefObject<SoilSimulator | null> }) {
  const MAX_DUST = 2048;
  
  const dustState = useMemo(() => ({
    px: new Float32Array(MAX_DUST),
    py: new Float32Array(MAX_DUST),
    pz: new Float32Array(MAX_DUST),
    vx: new Float32Array(MAX_DUST),
    vy: new Float32Array(MAX_DUST),
    vz: new Float32Array(MAX_DUST),
    life: new Float32Array(MAX_DUST), // 0 = dead, 1 = just born
    scale: new Float32Array(MAX_DUST),
    count: 0,
    lastParticleCount: 0,
  }), []);
  
  const { geometry, material } = useMemo(() => {
    const geo = new THREE.InstancedBufferGeometry();
    const vertices = new Float32Array([
      -1, -1, 0,  1, -1, 0,  1, 1, 0,
      -1, -1, 0,  1, 1, 0,  -1, 1, 0,
    ]);
    const uvs = new Float32Array([
      0, 0,  1, 0,  1, 1,
      0, 0,  1, 1,  0, 1,
    ]);
    geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    
    const posAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DUST * 3), 3);
    const alphaAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DUST), 1);
    const scaleAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DUST), 1);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    alphaAttr.setUsage(THREE.DynamicDrawUsage);
    scaleAttr.setUsage(THREE.DynamicDrawUsage);
    
    geo.setAttribute('instancePosition', posAttr);
    geo.setAttribute('instanceAlpha', alphaAttr);
    geo.setAttribute('instanceScale', scaleAttr);
    geo.instanceCount = 0;
    
    const mat = new THREE.ShaderMaterial({
      vertexShader: dustVertexShader,
      fragmentShader: dustFragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });
    
    return { geometry: geo, material: mat };
  }, []);
  
  const rng = useMemo(() => mulberry32(9999), []);
  
  useFrame((_, dt) => {
    const sim = simRef.current;
    if (!sim) return;
    
    const mpm = sim.mpm;
    const ds = dustState;
    
    // Spawn dust from fast-moving particles
    const currentCount = mpm.numParticles;
    // Spawn burst when new particles appear (dig event)
    if (currentCount > ds.lastParticleCount + 10) {
      const newCount = currentCount - ds.lastParticleCount;
      const spawnCount = Math.min(newCount * 2, 200);
      for (let s = 0; s < spawnCount && ds.count < MAX_DUST; s++) {
        const srcIdx = ds.lastParticleCount + Math.floor(rng() * newCount);
        if (srcIdx >= currentCount) continue;
        const [wx, wy, wz] = mpmToWorld(mpm.px[srcIdx], mpm.py[srcIdx], mpm.pz[srcIdx]);
        const di = ds.count % MAX_DUST;
        ds.px[di] = wx + (rng() - 0.5) * 0.04;
        ds.py[di] = wy + (rng() - 0.5) * 0.04;
        ds.pz[di] = wz + (rng() - 0.5) * 0.04;
        ds.vx[di] = (rng() - 0.5) * 0.15;
        ds.vy[di] = rng() * 0.2 + 0.05;
        ds.vz[di] = (rng() - 0.5) * 0.15;
        ds.life[di] = 1.0;
        ds.scale[di] = 0.005 + rng() * 0.015;
        ds.count = Math.min(ds.count + 1, MAX_DUST);
      }
    }
    ds.lastParticleCount = currentCount;
    
    // Also spawn from fast-moving particles (continuous dust trail)
    for (let i = 0; i < mpm.numParticles; i++) {
      if (!mpm.active[i]) continue;
      const speed = Math.sqrt(mpm.vx[i]**2 + mpm.vy[i]**2 + mpm.vz[i]**2);
      if (speed > 0.3 && rng() < 0.05) {
        const [wx, wy, wz] = mpmToWorld(mpm.px[i], mpm.py[i], mpm.pz[i]);
        const di = ds.count % MAX_DUST;
        ds.px[di] = wx;
        ds.py[di] = wy;
        ds.pz[di] = wz;
        ds.vx[di] = (rng() - 0.5) * 0.08;
        ds.vy[di] = rng() * 0.1 + 0.02;
        ds.vz[di] = (rng() - 0.5) * 0.08;
        ds.life[di] = 0.7 + rng() * 0.3;
        ds.scale[di] = 0.003 + rng() * 0.008;
        ds.count = Math.min(ds.count + 1, MAX_DUST);
      }
    }
    
    // Update dust particles
    const posAttr = geometry.getAttribute('instancePosition') as THREE.InstancedBufferAttribute;
    const alphaAttr = geometry.getAttribute('instanceAlpha') as THREE.InstancedBufferAttribute;
    const scaleAttr = geometry.getAttribute('instanceScale') as THREE.InstancedBufferAttribute;
    
    const clampedDt = Math.min(dt, 0.033);
    let visibleCount = 0;
    
    for (let i = 0; i < ds.count; i++) {
      if (ds.life[i] <= 0) continue;
      
      // Physics
      ds.px[i] += ds.vx[i] * clampedDt;
      ds.py[i] += ds.vy[i] * clampedDt;
      ds.pz[i] += ds.vz[i] * clampedDt;
      ds.vy[i] -= 0.3 * clampedDt; // slight gravity
      ds.vx[i] *= 0.98; // air drag
      ds.vz[i] *= 0.98;
      ds.life[i] -= clampedDt * 0.8; // fade out over ~1.25s
      
      if (ds.life[i] <= 0) continue;
      
      posAttr.setXYZ(visibleCount, ds.px[i], ds.py[i], ds.pz[i]);
      alphaAttr.setX(visibleCount, ds.life[i]);
      scaleAttr.setX(visibleCount, ds.scale[i] * (1.0 + (1.0 - ds.life[i]) * 2.0)); // expand as fading
      visibleCount++;
    }
    
    geometry.instanceCount = visibleCount;
    posAttr.needsUpdate = true;
    alphaAttr.needsUpdate = true;
    scaleAttr.needsUpdate = true;
  });
  
  return <mesh geometry={geometry} material={material} frustumCulled={false} />;
}

// ── Soil Terrain Mesh ────────────────────────────────────────────────

function SoilTerrain({ onStats }: { onStats: (s: SoilStats) => void }) {
  const meshRef = useRef<THREE.Mesh>(null!);
  const fieldRef = useRef<VoxelField | null>(null);
  const simRef = useRef<SoilSimulator | null>(null);
  const meshFrameRef = useRef(0);
  const settleDetector = useRef(createSettleDetector('soil-terrain'));

  const material = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: soilVertexShader,
    fragmentShader: soilFragmentShader,
    uniforms: {
      uLightDir: { value: new THREE.Vector3(0.5, 0.8, 0.3).normalize() },
      uLightDir2: { value: new THREE.Vector3(-0.3, 0.5, -0.6).normalize() },
      uTime: { value: 0 },
    },
    side: THREE.DoubleSide,
  }), []);

  const rebuildMesh = useCallback(() => {
    const mesh = meshRef.current;
    const field = fieldRef.current;
    if (!mesh || !field) return;

    const data = field.extractMesh();
    if (mesh.geometry) mesh.geometry.dispose();

    const vertCount = data.positions.length / 3;
    const moistureArr = new Float32Array(vertCount);
    for (let i = 0; i < vertCount; i++) {
      const wy = data.positions[i * 3 + 1];
      const depthFactor = Math.max(0, Math.min(1, (-wy - 0.05) * 3));
      const baseMoisture = 0.1 + depthFactor * 0.6;
      const freshness = 1 - data.disturbanceAges[i];
      moistureArr[i] = Math.min(1, baseMoisture + freshness * 0.3);
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geom.setAttribute('aDisturbanceAge', new THREE.BufferAttribute(data.disturbanceAges, 1));
    geom.setAttribute('aMoisture', new THREE.BufferAttribute(moistureArr, 1));
    geom.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geom.computeBoundingSphere();
    mesh.geometry = geom;

    const sim = simRef.current;
    onStats({
      vertices: data.positions.length / 3,
      triangles: data.indices.length / 3,
      simActive: sim?.simActive ?? false,
      activeParticles: sim?.getActiveParticles() ?? 0,
      totalParticles: sim?.mpm.numParticles ?? 0,
    });
  }, [onStats]);

  useEffect(() => {
    const field = new VoxelField();
    field.initTerrain();
    fieldRef.current = field;
    simRef.current = new SoilSimulator(field);
    rebuildMesh();
  }, [rebuildMesh]);

  const handleClick = useCallback((e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    if (!e.face || !fieldRef.current) return;

    const normal = e.face.normal.clone();
    const digPoint = e.point.clone().addScaledVector(normal, -DIG_RADIUS * 0.4);
    fieldRef.current.applyStamp(digPoint.x, digPoint.y, digPoint.z, DIG_RADIUS);
    rebuildMesh();
    simRef.current?.activate();

    const sim = simRef.current;
    triggerAutoCapture('dig', {
      digPoint: { x: digPoint.x, y: digPoint.y, z: digPoint.z },
      activeParticles: sim?.getActiveParticles() ?? 0,
    });
  }, [rebuildMesh]);

  useFrame((_, dt) => {
    material.uniforms.uTime.value += dt;

    const sim = simRef.current;
    if (sim && sim.simActive) {
      const changed = sim.step(dt);
      if (changed) {
        meshFrameRef.current++;
        if (meshFrameRef.current % 3 === 0) {
          rebuildMesh();
        }
      }
      onStats({
        vertices: meshRef.current?.geometry?.attributes?.position?.count ?? 0,
        triangles: (meshRef.current?.geometry?.index?.count ?? 0) / 3,
        simActive: sim.simActive,
        activeParticles: sim.getActiveParticles(),
        totalParticles: sim.mpm.numParticles,
      });
    }
  });

  return (
    <>
      <mesh ref={meshRef} material={material} onClick={handleClick} />
      <DirtSplatCloud simRef={simRef} />
      <DustCloud simRef={simRef} />
    </>
  );
}

export default function SoilViewer({ onStats }: { onStats: (s: SoilStats) => void }) {
  return (
    <Canvas
      camera={{ position: [0.9, 0.5, 0.9], fov: 42, near: 0.005, far: 10 }}
      gl={{ antialias: true }}
      style={{ width: '100%', height: '100%' }}
    >
      <color attach="background" args={['#080c12']} />
      <ambientLight intensity={0.35} />
      <directionalLight position={[2, 3, 1]} intensity={0.7} />
      <directionalLight position={[-1, 2, -2]} intensity={0.3} />
      <SoilTerrain onStats={onStats} />
      <gridHelper args={[2, 24, '#141e2b', '#141e2b']} position={[0, 0.001, 0]} />
      <OrbitControls
        target={[0, -0.1, 0]}
        maxPolarAngle={Math.PI * 0.88}
        enableDamping
        dampingFactor={0.08}
      />
    </Canvas>
  );
}
