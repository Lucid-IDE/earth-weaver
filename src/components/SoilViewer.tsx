import { useRef, useEffect, useCallback, useMemo } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, ThreeEvent } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { VoxelField } from '@/lib/soil/VoxelField';
import { SoilSimulator } from '@/lib/soil/soilSim';
import { soilVertexShader, soilFragmentShader } from '@/lib/soil/soilShader';
import { DIG_RADIUS } from '@/lib/soil/constants';
import { mpmToWorld } from '@/lib/mpm/bridge';
import { triggerAutoCapture, createSettleDetector } from '@/lib/analyst/autoCapture';

export interface SoilStats {
  vertices: number;
  triangles: number;
  simActive: boolean;
  activeParticles: number;
  totalParticles: number;
}

// ── Particle Spheres (InstancedMesh) ─────────────────────────────────
function ParticleCloud({ simRef }: { simRef: React.MutableRefObject<SoilSimulator | null> }) {
  const meshRef = useRef<THREE.InstancedMesh>(null!);
  const maxDisplay = 16384;
  const dummy = useMemo(() => new THREE.Object3D(), []);

  const geometry = useMemo(() => new THREE.SphereGeometry(0.004, 6, 4), []);
  const material = useMemo(() => new THREE.MeshStandardMaterial({
    roughness: 0.85,
    metalness: 0.0,
    flatShading: true,
  }), []);

  // Material type → color (earthy tones)
  const MATERIAL_COLORS = useMemo(() => [
    new THREE.Color(0.76, 0.70, 0.50),  // Sand
    new THREE.Color(0.52, 0.36, 0.24),  // Clay
    new THREE.Color(0.65, 0.55, 0.40),  // Silt
    new THREE.Color(0.28, 0.22, 0.14),  // Organic
    new THREE.Color(0.58, 0.56, 0.52),  // Gravel
    new THREE.Color(0.48, 0.40, 0.30),  // Loam
  ], []);

  const tmpColor = useMemo(() => new THREE.Color(), []);

  useFrame(() => {
    const sim = simRef.current;
    const inst = meshRef.current;
    if (!sim || !inst) return;

    const mpm = sim.mpm;
    let count = 0;

    for (let i = 0; i < mpm.numParticles && count < maxDisplay; i++) {
      if (!mpm.active[i]) continue;

      const [wx, wy, wz] = mpmToWorld(mpm.px[i], mpm.py[i], mpm.pz[i]);
      dummy.position.set(wx, wy, wz);
      dummy.updateMatrix();
      inst.setMatrixAt(count, dummy.matrix);

      const matType = Math.min(mpm.materialType[i], 5);
      const base = MATERIAL_COLORS[matType];
      const m = mpm.moisture ? mpm.moisture[i] : 0;
      const darken = 1 - m * 0.35;
      tmpColor.setRGB(base.r * darken, base.g * darken, base.b * darken);
      inst.setColorAt(count, tmpColor);

      count++;
    }

    inst.count = count;
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  });

  return (
    <instancedMesh ref={meshRef} args={[geometry, material, maxDisplay]} frustumCulled={false}>
      <ambientLight intensity={0.4} />
      <directionalLight position={[2, 3, 1]} intensity={0.8} />
    </instancedMesh>
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

    // Compute per-vertex moisture from Y position (deeper = wetter)
    const vertCount = data.positions.length / 3;
    const moistureArr = new Float32Array(vertCount);
    for (let i = 0; i < vertCount; i++) {
      const wy = data.positions[i * 3 + 1];
      const depthFactor = Math.max(0, Math.min(1, (-wy - 0.05) * 3));
      const baseMoisture = 0.1 + depthFactor * 0.6;
      // Fresh cuts are wetter
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

    // Auto-capture on dig
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
      // Use real frame dt for the simple direct-integration solver
      // (the full MLS-MPM grid solver needs tiny dt, but direct integration is stable at ~1/120)
      const subDt = Math.min(dt, 1 / 30) / 4;
      let changed = false;
      for (let i = 0; i < 4; i++) {
        changed = sim.step(subDt) || changed;
      }
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
