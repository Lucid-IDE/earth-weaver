import { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, ThreeEvent } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { VoxelField } from '@/lib/soil/VoxelField';
import { SoilSimulator } from '@/lib/soil/soilSim';
import { soilVertexShader, soilFragmentShader } from '@/lib/soil/soilShader';
import { DIG_RADIUS, SIM_ITERATIONS_PER_FRAME } from '@/lib/soil/constants';

export interface SoilStats {
  vertices: number;
  triangles: number;
  simActive: boolean;
}

function SoilTerrain({ onStats }: { onStats: (s: SoilStats) => void }) {
  const meshRef = useRef<THREE.Mesh>(null!);
  const fieldRef = useRef<VoxelField | null>(null);
  const simRef = useRef<SoilSimulator | null>(null);
  const meshFrameRef = useRef(0);

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

    onStats({
      vertices: data.positions.length / 3,
      triangles: data.indices.length / 3,
      simActive: simRef.current?.simActive ?? false,
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
        if (meshFrameRef.current % 2 === 0) {
          rebuildMesh();
        }
      }
      // Update sim status in overlay
      onStats({
        vertices: meshRef.current?.geometry?.attributes?.position?.count ?? 0,
        triangles: (meshRef.current?.geometry?.index?.count ?? 0) / 3,
        simActive: sim.simActive,
      });
    }
  });

  return <mesh ref={meshRef} material={material} onClick={handleClick} />;
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
