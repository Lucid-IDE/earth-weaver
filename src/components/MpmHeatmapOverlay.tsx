// ── MPM NaN/Inf Heatmap Overlay ─────────────────────────────────────
// Renders red glowing markers at the world positions of the grid nodes
// and particles that the solver flagged as non-finite this frame.
// Uses InstancedMesh for performance; updates on the fly from mpmHealth.

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { mpmHealth } from '@/lib/mpm/mpmHealth';
import { MPM_GRID, MPM_DX,
  MPM_WORLD_MIN_X, MPM_WORLD_MAX_X,
  MPM_WORLD_MIN_Y, MPM_WORLD_MAX_Y,
  MPM_WORLD_MIN_Z, MPM_WORLD_MAX_Z,
} from '@/lib/mpm/constants';
import { mpmToWorld } from '@/lib/mpm/bridge';
import { SoilSimulator } from '@/lib/soil/soilSim';

const GS = MPM_GRID + 1;
const MAX_MARKERS = 512;

function gridIdxToWorld(idx: number): [number, number, number] {
  const i = idx % GS;
  const j = Math.floor(idx / GS) % GS;
  const k = Math.floor(idx / (GS * GS));
  const mx = i * MPM_DX, my = j * MPM_DX, mz = k * MPM_DX;
  return mpmToWorld(mx, my, mz);
}

interface Props {
  enabled: boolean;
  simRef: React.MutableRefObject<SoilSimulator | null>;
}

export default function MpmHeatmapOverlay({ enabled, simRef }: Props) {
  const gridMeshRef = useRef<THREE.InstancedMesh>(null);
  const partMeshRef = useRef<THREE.InstancedMesh>(null);
  const firstMeshRef = useRef<THREE.Mesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  useFrame(() => {
    if (!enabled) return;
    const hot = mpmHealth.hotspot;

    // Grid NaN nodes
    const gMesh = gridMeshRef.current;
    if (gMesh) {
      const n = Math.min(hot.gridIdxs.length, MAX_MARKERS);
      for (let i = 0; i < n; i++) {
        const [wx, wy, wz] = gridIdxToWorld(hot.gridIdxs[i]);
        dummy.position.set(wx, wy, wz);
        dummy.scale.setScalar(0.012);
        dummy.updateMatrix();
        gMesh.setMatrixAt(i, dummy.matrix);
      }
      // Hide remaining
      dummy.scale.setScalar(0);
      dummy.updateMatrix();
      for (let i = n; i < MAX_MARKERS; i++) gMesh.setMatrixAt(i, dummy.matrix);
      gMesh.count = MAX_MARKERS;
      gMesh.instanceMatrix.needsUpdate = true;
    }

    // Particle NaN
    const pMesh = partMeshRef.current;
    const sim = simRef.current;
    if (pMesh && sim) {
      const n = Math.min(hot.particleIdxs.length, MAX_MARKERS);
      for (let i = 0; i < n; i++) {
        const pi = hot.particleIdxs[i];
        const [wx, wy, wz] = mpmToWorld(sim.mpm.px[pi], sim.mpm.py[pi], sim.mpm.pz[pi]);
        if (!isFinite(wx) || !isFinite(wy) || !isFinite(wz)) {
          dummy.position.set(0, 0, 0);
          dummy.scale.setScalar(0);
        } else {
          dummy.position.set(wx, wy, wz);
          dummy.scale.setScalar(0.014);
        }
        dummy.updateMatrix();
        pMesh.setMatrixAt(i, dummy.matrix);
      }
      dummy.scale.setScalar(0);
      dummy.updateMatrix();
      for (let i = n; i < MAX_MARKERS; i++) pMesh.setMatrixAt(i, dummy.matrix);
      pMesh.count = MAX_MARKERS;
      pMesh.instanceMatrix.needsUpdate = true;
    }

    // First-failure beacon
    const beacon = firstMeshRef.current;
    if (beacon) {
      const idx = hot.firstGridIdx;
      if (idx >= 0) {
        const [wx, wy, wz] = gridIdxToWorld(idx);
        beacon.position.set(wx, wy, wz);
        beacon.visible = true;
        const s = 0.04 + 0.02 * Math.sin(performance.now() * 0.008);
        beacon.scale.setScalar(s);
      } else if (hot.firstParticleIdx >= 0 && sim) {
        const pi = hot.firstParticleIdx;
        const [wx, wy, wz] = mpmToWorld(sim.mpm.px[pi], sim.mpm.py[pi], sim.mpm.pz[pi]);
        if (isFinite(wx) && isFinite(wy) && isFinite(wz)) {
          beacon.position.set(wx, wy, wz);
          beacon.visible = true;
          const s = 0.04 + 0.02 * Math.sin(performance.now() * 0.008);
          beacon.scale.setScalar(s);
        } else {
          beacon.visible = false;
        }
      } else {
        beacon.visible = false;
      }
    }
  });

  if (!enabled) return null;

  return (
    <group>
      {/* Grid NaN markers — red */}
      <instancedMesh ref={gridMeshRef} args={[undefined, undefined, MAX_MARKERS]} frustumCulled={false}>
        <sphereGeometry args={[1, 6, 4]} />
        <meshBasicMaterial color="#ff2244" transparent opacity={0.85} depthTest={false} />
      </instancedMesh>
      {/* Particle NaN markers — orange */}
      <instancedMesh ref={partMeshRef} args={[undefined, undefined, MAX_MARKERS]} frustumCulled={false}>
        <sphereGeometry args={[1, 6, 4]} />
        <meshBasicMaterial color="#ffaa00" transparent opacity={0.9} depthTest={false} />
      </instancedMesh>
      {/* First-failure beacon — pulsing magenta sphere */}
      <mesh ref={firstMeshRef} visible={false} frustumCulled={false}>
        <sphereGeometry args={[1, 16, 12]} />
        <meshBasicMaterial color="#ff00ff" transparent opacity={0.5} depthTest={false} wireframe />
      </mesh>
    </group>
  );
}
