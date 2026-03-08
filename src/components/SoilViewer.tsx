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
  particleDepthVertexShader,
  particleDepthFragmentShader,
  bilateralFilterVertexShader,
  bilateralFilterFragmentShader,
  normalReconstructionVertexShader,
  normalReconstructionFragmentShader,
  fluidShadingVertexShader,
  fluidShadingFragmentShader,
} from '@/lib/rendering/fluidShaders';

export interface SoilStats {
  vertices: number;
  triangles: number;
  simActive: boolean;
  activeParticles: number;
  totalParticles: number;
}

// ── Particle Spheres (InstancedMesh) ─────────────────────────────────
// Seeded RNG for consistent chunk shapes
function mulberry32(a: number) {
  return function() {
    var t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
}

function createDirtChunkGeometry(seed: number): THREE.BufferGeometry {
  const rng = mulberry32(seed);
  const baseRadius = 0.004;
  const geo = new THREE.IcosahedronGeometry(baseRadius, 1);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const freq = 300;
    const noise = Math.sin(v.x * freq + seed) * Math.sin(v.y * freq + seed) * Math.sin(v.z * freq + seed);
    const scale = 1.0 + noise * 0.4 + (rng() - 0.5) * 0.2;
    v.multiplyScalar(scale);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  
  geo.computeVertexNormals();
  return geo;
}

const CHUNK_TYPES = 4;

// ── Screen-Space Fluid Renderer ──────────────────────────────────────
function ScreenSpaceFluidRenderer({ 
  simRef 
}: { 
  simRef: React.MutableRefObject<SoilSimulator | null> 
}) {
  const { gl, scene, camera, size } = useThree();
  
  // Render targets
  const depthTarget = useMemo(() => new THREE.WebGLRenderTarget(size.width, size.height, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.FloatType,
  }), [size]);
  
  const smoothTarget = useMemo(() => new THREE.WebGLRenderTarget(size.width, size.height, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.FloatType,
  }), [size]);
  
  const normalTarget = useMemo(() => new THREE.WebGLRenderTarget(size.width, size.height, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
  }), [size]);
  
  // Fullscreen quad for post-processing
  const quadScene = useMemo(() => new THREE.Scene(), []);
  const quadCamera = useMemo(() => new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), []);
  const quadGeo = useMemo(() => new THREE.PlaneGeometry(2, 2), []);
  
  // Bilateral filter material
  const bilateralMat = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: bilateralFilterVertexShader,
    fragmentShader: bilateralFilterFragmentShader,
    uniforms: {
      depthTexture: { value: null },
      resolution: { value: new THREE.Vector2(size.width, size.height) },
      filterRadius: { value: 0.05 },
      blurScale: { value: 3.0 },
      blurDepthFalloff: { value: 100.0 },
    },
  }), [size]);
  
  // Normal reconstruction material
  const normalMat = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: normalReconstructionVertexShader,
    fragmentShader: normalReconstructionFragmentShader,
    uniforms: {
      smoothedDepthTexture: { value: null },
      resolution: { value: new THREE.Vector2(size.width, size.height) },
      near: { value: (camera as THREE.PerspectiveCamera).near },
      far: { value: (camera as THREE.PerspectiveCamera).far },
      projectionMatrix: { value: camera.projectionMatrix },
    },
  }), [size, camera]);
  
  // Fluid shading material
  const fluidMat = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: fluidShadingVertexShader,
    fragmentShader: fluidShadingFragmentShader,
    uniforms: {
      smoothedDepthTexture: { value: null },
      normalTexture: { value: null },
      lightDirection: { value: new THREE.Vector3(0.5, 0.8, 0.3).normalize() },
      fluidColor: { value: new THREE.Color(0.55, 0.45, 0.32) }, // Earthy soil color
      roughness: { value: 0.95 },
      metalness: { value: 0.0 },
    },
    transparent: true,
    depthWrite: false,
  }), []);
  
  const bilateralQuad = useMemo(() => new THREE.Mesh(quadGeo, bilateralMat), [quadGeo, bilateralMat]);
  const normalQuad = useMemo(() => new THREE.Mesh(quadGeo, normalMat), [quadGeo, normalMat]);
  const fluidQuad = useMemo(() => new THREE.Mesh(quadGeo, fluidMat), [quadGeo, fluidMat]);
  
  useEffect(() => {
    quadScene.add(bilateralQuad);
    return () => { quadScene.remove(bilateralQuad); };
  }, [quadScene, bilateralQuad]);
  
  // Update resolution on resize
  useEffect(() => {
    depthTarget.setSize(size.width, size.height);
    smoothTarget.setSize(size.width, size.height);
    normalTarget.setSize(size.width, size.height);
    bilateralMat.uniforms.resolution.value.set(size.width, size.height);
    normalMat.uniforms.resolution.value.set(size.width, size.height);
  }, [size, depthTarget, smoothTarget, normalTarget, bilateralMat, normalMat]);
  
  // This component doesn't render anything itself — it hijacks the render loop
  useFrame(() => {
    // 1. Render particle depths to depthTarget
    // (The main ParticleCloud component handles this with a depth material)
    
    // 2. Bilateral filter: depthTarget → smoothTarget
    bilateralMat.uniforms.depthTexture.value = depthTarget.texture;
    quadScene.remove(bilateralQuad);
    quadScene.add(bilateralQuad);
    
    const oldRenderTarget = gl.getRenderTarget();
    gl.setRenderTarget(smoothTarget);
    gl.render(quadScene, quadCamera);
    
    // 3. Normal reconstruction: smoothTarget → normalTarget
    normalMat.uniforms.smoothedDepthTexture.value = smoothTarget.texture;
    quadScene.remove(bilateralQuad);
    quadScene.add(normalQuad);
    
    gl.setRenderTarget(normalTarget);
    gl.render(quadScene, quadCamera);
    
    // 4. Fluid shading: blend fluid surface over scene
    fluidMat.uniforms.smoothedDepthTexture.value = smoothTarget.texture;
    fluidMat.uniforms.normalTexture.value = normalTarget.texture;
    quadScene.remove(normalQuad);
    quadScene.add(fluidQuad);
    
    gl.setRenderTarget(oldRenderTarget);
    // Render to screen happens naturally on next frame
    
  }, 2); // Priority 2: render AFTER main scene but BEFORE final output
  
  return null;
}

// ── Particle Cloud (renders to depth buffer) ────────────────────────
function ParticleCloud({ simRef }: { simRef: React.MutableRefObject<SoilSimulator | null> }) {
  const maxDisplay = 16384;
  const meshRefs = [
    useRef<THREE.InstancedMesh>(null!),
    useRef<THREE.InstancedMesh>(null!),
    useRef<THREE.InstancedMesh>(null!),
    useRef<THREE.InstancedMesh>(null!),
  ];
  
  const dummy = useMemo(() => new THREE.Object3D(), []);
  
  const geometries = useMemo(() => {
    const geos = [];
    for (let i = 0; i < CHUNK_TYPES; i++) {
      geos.push(createDirtChunkGeometry(12345 + i * 999));
    }
    return geos;
  }, []);

  const material = useMemo(() => new THREE.MeshStandardMaterial({
    roughness: 0.95,
    metalness: 0.0,
    flatShading: true,
  }), []);

  const MATERIAL_COLORS = useMemo(() => [
    new THREE.Color(0.76, 0.70, 0.50),  // Sand
    new THREE.Color(0.52, 0.36, 0.24),  // Clay
    new THREE.Color(0.65, 0.55, 0.40),  // Silt
    new THREE.Color(0.28, 0.22, 0.14),  // Organic
    new THREE.Color(0.58, 0.56, 0.52),  // Gravel
    new THREE.Color(0.48, 0.40, 0.30),  // Loam
    new THREE.Color(0.60, 0.50, 0.35),  // Sandy Silt
  ], []);

  const tmpColor = useMemo(() => new THREE.Color(), []);
  
  const particleProps = useMemo(() => {
    const props = new Float32Array(65536 * 8);
    const rng = mulberry32(42);
    for (let i = 0; i < 65536; i++) {
      props[i*8 + 0] = 0.6 + rng() * 0.9;
      props[i*8 + 1] = rng() * Math.PI * 2;
      props[i*8 + 2] = rng() * Math.PI * 2;
      props[i*8 + 3] = rng() * Math.PI * 2;
      props[i*8 + 4] = Math.floor(rng() * CHUNK_TYPES);
      props[i*8 + 5] = (rng() - 0.5) * 0.2;
      props[i*8 + 6] = (rng() - 0.5) * 0.2;
      props[i*8 + 7] = (rng() - 0.5) * 0.2;
    }
    return props;
  }, []);

  useFrame(() => {
    const sim = simRef.current;
    if (!sim) return;

    const mpm = sim.mpm;
    const counts = [0, 0, 0, 0];
    let totalDisplayed = 0;

    for (let i = 0; i < mpm.numParticles && totalDisplayed < maxDisplay; i++) {
      if (!mpm.active[i]) continue;

      const pOff = i * 8;
      const geoType = particleProps[pOff + 4];
      const inst = meshRefs[geoType].current;
      if (!inst) continue;

      const count = counts[geoType];
      
      const [wx, wy, wz] = mpmToWorld(mpm.px[i], mpm.py[i], mpm.pz[i]);
      const vx = mpm.vx[i], vy = mpm.vy[i], vz = mpm.vz[i];
      const speed = Math.sqrt(vx*vx + vy*vy + vz*vz);
      
      dummy.position.set(wx, wy, wz);
      dummy.rotation.set(
        particleProps[pOff + 1] + wy * 100, 
        particleProps[pOff + 2] + wx * 100, 
        particleProps[pOff + 3] + wz * 100
      );
      
      const baseScale = particleProps[pOff + 0];
      dummy.scale.set(baseScale, baseScale * (1 + speed*0.2), baseScale);
      
      dummy.updateMatrix();
      inst.setMatrixAt(count, dummy.matrix);

      const matType = Math.min(mpm.materialType[i], 6);
      const base = MATERIAL_COLORS[matType];
      const m = mpm.moisture ? mpm.moisture[i] : 0;
      const darken = 1 - m * 0.35;
      
      tmpColor.setRGB(
        Math.max(0, Math.min(1, base.r * darken + particleProps[pOff + 5])),
        Math.max(0, Math.min(1, base.g * darken + particleProps[pOff + 6])),
        Math.max(0, Math.min(1, base.b * darken + particleProps[pOff + 7]))
      );
      inst.setColorAt(count, tmpColor);

      counts[geoType]++;
      totalDisplayed++;
    }

    for (let g = 0; g < CHUNK_TYPES; g++) {
      const inst = meshRefs[g].current;
      if (inst) {
        inst.count = counts[g];
        inst.instanceMatrix.needsUpdate = true;
        if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      }
    }
  });

  return (
    <>
      <ambientLight intensity={0.4} />
      <directionalLight position={[2, 3, 1]} intensity={0.8} />
      {geometries.map((geo, i) => (
        <instancedMesh key={i} ref={meshRefs[i]} args={[geo, material, maxDisplay]} frustumCulled={false} />
      ))}
    </>
  );
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
      <ParticleCloud simRef={simRef} />
      {/* <ScreenSpaceFluidRenderer simRef={simRef} /> */}
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
