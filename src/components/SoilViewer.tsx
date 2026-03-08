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
  dirtSplatVertexShader,
  dirtSplatFragmentShader,
  dustVertexShader,
  dustFragmentShader,
} from '@/lib/rendering/dirtShaders';

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
  [0.76, 0.70, 0.50],  // Sand - warm tan
  [0.52, 0.36, 0.24],  // Clay - reddish brown
  [0.65, 0.55, 0.40],  // Silt - grey-brown
  [0.28, 0.22, 0.14],  // Organic - dark earth
  [0.58, 0.56, 0.52],  // Gravel - grey
  [0.48, 0.40, 0.30],  // Loam - medium brown
  [0.60, 0.50, 0.35],  // Sandy Silt
];

// ── Dirt Splat Cloud ────────────────────────────────────────────────
// Renders particles as large overlapping camera-facing quads with soft
// edges and procedural noise, creating a cohesive dirt mass appearance.
function DirtSplatCloud({ simRef }: { simRef: React.MutableRefObject<SoilSimulator | null> }) {
  const MAX_SPLATS = 32768;
  const meshRef = useRef<THREE.Mesh>(null!);
  
  // Pre-generate per-particle random properties
  const particleRng = useMemo(() => {
    const rng = mulberry32(42);
    const data = new Float32Array(65536 * 4); // scale, rotation, noisePhase, colorJitter
    for (let i = 0; i < 65536; i++) {
      data[i*4 + 0] = 0.004 + rng() * 0.006; // scale: much smaller splats (0.004 - 0.010) for denser coverage
      data[i*4 + 1] = rng() * Math.PI * 2;    // rotation
      data[i*4 + 2] = rng() * 10.0;           // noise phase
      data[i*4 + 3] = (rng() - 0.5) * 0.08;  // subtler color jitter
    }
    return data;
  }, []);
  
  // Create instanced buffer geometry with a quad
  const { geometry, material } = useMemo(() => {
    // Quad geometry (two triangles)
    const geo = new THREE.InstancedBufferGeometry();
    const vertices = new Float32Array([
      -1, -1, 0,  1, -1, 0,  1, 1, 0,
      -1, -1, 0,  1, 1, 0,   -1, 1, 0,
    ]);
    const uvs = new Float32Array([
      0, 0,  1, 0,  1, 1,
      0, 0,  1, 1,  0, 1,
    ]);
    geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    
    // Instance attributes
    const posAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SPLATS * 3), 3);
    const colorAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SPLATS * 4), 4);
    const scaleAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SPLATS), 1);
    const rotAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SPLATS), 1);
    const noiseAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SPLATS), 1);
    
    posAttr.setUsage(THREE.DynamicDrawUsage);
    colorAttr.setUsage(THREE.DynamicDrawUsage);
    scaleAttr.setUsage(THREE.DynamicDrawUsage);
    rotAttr.setUsage(THREE.DynamicDrawUsage);
    noiseAttr.setUsage(THREE.DynamicDrawUsage);
    
    geo.setAttribute('instancePosition', posAttr);
    geo.setAttribute('instanceColor', colorAttr);
    geo.setAttribute('instanceScale', scaleAttr);
    geo.setAttribute('instanceRotation', rotAttr);
    geo.setAttribute('instanceNoisePhase', noiseAttr);
    
    geo.instanceCount = 0;
    
    const mat = new THREE.ShaderMaterial({
      vertexShader: dirtSplatVertexShader,
      fragmentShader: dirtSplatFragmentShader,
      transparent: true,
      depthWrite: true,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
    });
    
    return { geometry: geo, material: mat };
  }, []);
  
  useFrame(() => {
    const sim = simRef.current;
    if (!sim) return;
    
    const mpm = sim.mpm;
    const posArr = geometry.getAttribute('instancePosition') as THREE.InstancedBufferAttribute;
    const colorArr = geometry.getAttribute('instanceColor') as THREE.InstancedBufferAttribute;
    const scaleArr = geometry.getAttribute('instanceScale') as THREE.InstancedBufferAttribute;
    const rotArr = geometry.getAttribute('instanceRotation') as THREE.InstancedBufferAttribute;
    const noiseArr = geometry.getAttribute('instanceNoisePhase') as THREE.InstancedBufferAttribute;
    
    let count = 0;
    
    for (let i = 0; i < mpm.numParticles && count < MAX_SPLATS; i++) {
      if (!mpm.active[i]) continue;
      
      const [wx, wy, wz] = mpmToWorld(mpm.px[i], mpm.py[i], mpm.pz[i]);
      
      // Particle velocity for motion effects
      const vx = mpm.vx[i], vy = mpm.vy[i], vz = mpm.vz[i];
      const speed = Math.sqrt(vx*vx + vy*vy + vz*vz);
      
      // Position
      posArr.setXYZ(count, wx, wy, wz);
      
      // Scale: larger when moving fast (stretchy splats)
      const rOff = i * 4;
      const baseScale = particleRng[rOff + 0];
      const motionScale = 1.0 + Math.min(speed * 0.5, 0.8);
      scaleArr.setX(count, baseScale * motionScale);
      
      // Rotation: base + slight velocity-based twist
      rotArr.setX(count, particleRng[rOff + 1] + speed * 2.0);
      
      // Noise phase
      noiseArr.setX(count, particleRng[rOff + 2]);
      
      // Color from material type with moisture and jitter
      const matType = Math.min(mpm.materialType[i], 6);
      const base = MATERIAL_BASE_COLORS[matType];
      const moisture = mpm.moisture ? mpm.moisture[i] : 0;
      const darken = 1 - moisture * 0.4;
      const jitter = particleRng[rOff + 3];
      
      colorArr.setXYZW(
        count,
        Math.max(0, Math.min(1, base[0] * darken + jitter)),
        Math.max(0, Math.min(1, base[1] * darken + jitter * 0.8)),
        Math.max(0, Math.min(1, base[2] * darken + jitter * 0.6)),
        1.0
      );
      
      count++;
    }
    
    geometry.instanceCount = count;
    posArr.needsUpdate = true;
    colorArr.needsUpdate = true;
    scaleArr.needsUpdate = true;
    rotArr.needsUpdate = true;
    noiseArr.needsUpdate = true;
  });
  
  return <mesh ref={meshRef} geometry={geometry} material={material} frustumCulled={false} />;
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
