import { useRef, useEffect, useCallback, useMemo } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, ThreeEvent } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { VoxelField } from '@/lib/soil/VoxelField';
import { SoilSimulator } from '@/lib/soil/soilSim';
import { soilVertexShader, soilFragmentShader } from '@/lib/soil/soilShader';
import { DIG_RADIUS, SIM_ITERATIONS_PER_FRAME } from '@/lib/soil/constants';
import { mpmToWorld } from '@/lib/mpm/bridge';
import { triggerAutoCapture, createSettleDetector } from '@/lib/analyst/autoCapture';

export interface SoilStats {
  vertices: number;
  triangles: number;
  simActive: boolean;
  activeParticles: number;
  totalParticles: number;
}

// ── Particle Cloud ───────────────────────────────────────────────────
// Renders active MPM particles as a Three.js Points cloud

function ParticleCloud({ simRef }: { simRef: React.MutableRefObject<SoilSimulator | null> }) {
  const pointsRef = useRef<THREE.Points>(null!);
  const maxDisplay = 65536;

  const geometry = useMemo(() => {
    const geom = new THREE.BufferGeometry();
    const positions = new Float32Array(maxDisplay * 3);
    const colors = new Float32Array(maxDisplay * 3);
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geom.setDrawRange(0, 0);
    return geom;
  }, []);

  const material = useMemo(() => new THREE.PointsMaterial({
    size: 0.008,
    vertexColors: true,
    transparent: true,
    opacity: 0.85,
    sizeAttenuation: true,
    depthWrite: false,
  }), []);

  // Material type → color (matching soil shader palette)
  const MATERIAL_COLORS: [number,number,number][] = [
    [0.76, 0.70, 0.50],  // Sand
    [0.52, 0.36, 0.24],  // Clay
    [0.65, 0.55, 0.40],  // Silt
    [0.28, 0.22, 0.14],  // Organic
    [0.58, 0.56, 0.52],  // Gravel
    [0.48, 0.40, 0.30],  // Loam
  ];

  useFrame(() => {
    const sim = simRef.current;
    if (!sim || !pointsRef.current) return;

    const mpm = sim.mpm;
    const posAttr = geometry.attributes.position as THREE.BufferAttribute;
    const colAttr = geometry.attributes.color as THREE.BufferAttribute;
    const pos = posAttr.array as Float32Array;
    const col = colAttr.array as Float32Array;

    let count = 0;
    for (let i = 0; i < mpm.numParticles && count < maxDisplay; i++) {
      if (!mpm.active[i]) continue;

      const [wx, wy, wz] = mpmToWorld(mpm.px[i], mpm.py[i], mpm.pz[i]);
      const wi = count * 3;
      pos[wi]     = wx;
      pos[wi + 1] = wy;
      pos[wi + 2] = wz;

      const matType = Math.min(mpm.materialType[i], 5);
      const c = MATERIAL_COLORS[matType];
      col[wi]     = c[0];
      col[wi + 1] = c[1];
      col[wi + 2] = c[2];

      count++;
    }

    geometry.setDrawRange(0, count);
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
  });

  return <points ref={pointsRef} geometry={geometry} material={material} />;
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

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geom.setAttribute('aDisturbanceAge', new THREE.BufferAttribute(data.disturbanceAges, 1));
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
  }, [rebuildMesh]);

  useFrame((_, dt) => {
    material.uniforms.uTime.value += dt;

    const sim = simRef.current;
    if (sim && sim.simActive) {
      const clampedDt = Math.min(dt, 1 / 30);
      let changed = false;
      for (let i = 0; i < SIM_ITERATIONS_PER_FRAME; i++) {
        changed = sim.step(clampedDt / SIM_ITERATIONS_PER_FRAME) || changed;
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
