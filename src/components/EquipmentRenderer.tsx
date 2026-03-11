// ── Equipment 3D Renderer ────────────────────────────────────────────
// Renders excavator and bulldozer as procedural geometry in Three.js
// Uses local-space FK to avoid double-transform issues

import { useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { ExcavatorState, BulldozerState } from '@/lib/equipment/types';
import { computeExcavatorLocalFK } from '@/lib/equipment/excavator';
import { computeBladeGeometry } from '@/lib/equipment/bulldozer';

// ── Hydraulic Cylinder Visual ────────────────────────────────────────
function HydraulicCylinder({
  start, end, radius = 0.004, pressure = 0,
}: {
  start: [number, number, number];
  end: [number, number, number];
  radius?: number;
  pressure?: number;
}) {
  const cylRef = useRef<THREE.Group>(null!);
  
  const s = new THREE.Vector3(...start);
  const e = new THREE.Vector3(...end);
  const len = s.distanceTo(e);
  const mid = s.clone().add(e).multiplyScalar(0.5);
  const dir = e.clone().sub(s).normalize();
  
  const quat = new THREE.Quaternion();
  quat.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  const euler = new THREE.Euler().setFromQuaternion(quat);
  
  const cylColor = pressure > 0.5 ? '#c44' : '#666';
  
  // Body at 35% along, rod at 70% along
  const bodyPos = s.clone().lerp(e, 0.35);
  const rodPos = s.clone().lerp(e, 0.7);
  
  return (
    <group>
      <mesh position={[bodyPos.x, bodyPos.y, bodyPos.z]} rotation={euler}>
        <cylinderGeometry args={[radius * 1.5, radius * 1.5, len * 0.5, 6]} />
        <meshStandardMaterial color={cylColor} metalness={0.8} roughness={0.3} />
      </mesh>
      <mesh position={[rodPos.x, rodPos.y, rodPos.z]} rotation={euler}>
        <cylinderGeometry args={[radius * 0.7, radius * 0.7, len * 0.4, 6]} />
        <meshStandardMaterial color="#aaa" metalness={0.9} roughness={0.1} />
      </mesh>
    </group>
  );
}

// ── Track Visual ─────────────────────────────────────────────────────
function TrackPair({ width, length, height }: { width: number; length: number; height: number }) {
  return (
    <group>
      {/* Left track */}
      <mesh position={[-width / 2, -height / 2, 0]}>
        <boxGeometry args={[0.02, height, length]} />
        <meshStandardMaterial color="#333" metalness={0.6} roughness={0.7} />
      </mesh>
      {/* Right track */}
      <mesh position={[width / 2, -height / 2, 0]}>
        <boxGeometry args={[0.02, height, length]} />
        <meshStandardMaterial color="#333" metalness={0.6} roughness={0.7} />
      </mesh>
      {/* Track pads */}
      {Array.from({ length: 8 }).map((_, i) => (
        <group key={i}>
          <mesh position={[-width / 2, -height, -length / 2 + (i + 0.5) * length / 8]}>
            <boxGeometry args={[0.022, 0.003, length / 10]} />
            <meshStandardMaterial color="#222" metalness={0.5} roughness={0.8} />
          </mesh>
          <mesh position={[width / 2, -height, -length / 2 + (i + 0.5) * length / 8]}>
            <boxGeometry args={[0.022, 0.003, length / 10]} />
            <meshStandardMaterial color="#222" metalness={0.5} roughness={0.8} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

// ── Arm Segment (local space) ───────────────────────────────────────
function ArmSegment({
  start, end, width, color,
}: {
  start: [number, number, number];
  end: [number, number, number];
  width: number;
  color: string;
}) {
  const s = new THREE.Vector3(...start);
  const e = new THREE.Vector3(...end);
  const mid = s.clone().add(e).multiplyScalar(0.5);
  const len = s.distanceTo(e);
  
  if (len < 0.001) return null;
  
  const dir = e.clone().sub(s).normalize();
  const quat = new THREE.Quaternion();
  quat.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  const euler = new THREE.Euler().setFromQuaternion(quat);
  
  return (
    <mesh position={[mid.x, mid.y, mid.z]} rotation={euler}>
      <boxGeometry args={[width, len, width * 0.7]} />
      <meshStandardMaterial color={color} metalness={0.5} roughness={0.5} />
    </mesh>
  );
}

// ── Bucket Mesh (local space) ───────────────────────────────────────
function BucketMesh({
  stickEnd, bucketTip,
}: {
  stickEnd: [number, number, number];
  bucketTip: [number, number, number];
}) {
  const mid: [number, number, number] = [
    (stickEnd[0] + bucketTip[0]) / 2,
    (stickEnd[1] + bucketTip[1]) / 2,
    (stickEnd[2] + bucketTip[2]) / 2,
  ];
  
  // Orient bucket along the stick-to-tip direction
  const dir = new THREE.Vector3(
    bucketTip[0] - stickEnd[0],
    bucketTip[1] - stickEnd[1],
    bucketTip[2] - stickEnd[2],
  ).normalize();
  const quat = new THREE.Quaternion();
  quat.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  const euler = new THREE.Euler().setFromQuaternion(quat);
  
  return (
    <group position={[mid[0], mid[1], mid[2]]} rotation={euler}>
      {/* Bucket shell */}
      <mesh>
        <boxGeometry args={[0.045, 0.06, 0.035]} />
        <meshStandardMaterial color="#777" metalness={0.6} roughness={0.5} />
      </mesh>
      {/* Teeth along the bottom edge */}
      {[-0.015, -0.005, 0.005, 0.015].map((offset, i) => (
        <mesh key={i} position={[offset, -0.033, 0.015]}>
          <boxGeometry args={[0.004, 0.008, 0.004]} />
          <meshStandardMaterial color="#aaa" metalness={0.8} roughness={0.3} />
        </mesh>
      ))}
    </group>
  );
}

// ── Excavator Renderer ──────────────────────────────────────────────
export function ExcavatorMesh({ state }: { state: ExcavatorState }) {
  const v = state.vehicle;
  
  // Compute local-space FK (positions relative to swing group)
  const lk = computeExcavatorLocalFK(state);
  
  return (
    <group
      position={[v.posX, v.posY, v.posZ]}
      rotation={[v.pitch, v.heading, 0]}
    >
      {/* Chassis */}
      <TrackPair width={0.08} length={0.14} height={0.025} />
      
      {/* Undercarriage body */}
      <mesh position={[0, 0.02, 0]}>
        <boxGeometry args={[0.06, 0.03, 0.08]} />
        <meshStandardMaterial color="#d4a017" metalness={0.4} roughness={0.6} />
      </mesh>
      
      {/* Cab (rotates with swing) */}
      <group rotation={[0, state.swing.angle, 0]}>
        {/* Cab body */}
        <mesh position={[0, 0.055, 0]}>
          <boxGeometry args={[0.05, 0.04, 0.055]} />
          <meshStandardMaterial color="#d4a017" metalness={0.4} roughness={0.6} />
        </mesh>
        
        {/* Cab windows */}
        <mesh position={[0, 0.065, 0.028]}>
          <boxGeometry args={[0.044, 0.025, 0.002]} />
          <meshStandardMaterial color="#4488aa" metalness={0.1} roughness={0.1} transparent opacity={0.6} />
        </mesh>
        
        {/* Counterweight */}
        <mesh position={[0, 0.04, -0.045]}>
          <boxGeometry args={[0.055, 0.03, 0.02]} />
          <meshStandardMaterial color="#555" metalness={0.7} roughness={0.5} />
        </mesh>
        
        {/* Boom */}
        <ArmSegment
          start={lk.boomPivot}
          end={lk.boomEnd}
          width={0.014}
          color="#d4a017"
        />
        
        {/* Stick */}
        <ArmSegment
          start={lk.boomEnd}
          end={lk.stickEnd}
          width={0.010}
          color="#d4a017"
        />
        
        {/* Bucket */}
        <BucketMesh
          stickEnd={lk.stickEnd}
          bucketTip={lk.bucketTip}
        />
        
        {/* Boom hydraulic cylinder */}
        <HydraulicCylinder
          start={lk.boomCylBase}
          end={lk.boomCylEnd}
          radius={0.005}
          pressure={state.hydraulicPressure}
        />
        
        {/* Stick hydraulic cylinder */}
        <HydraulicCylinder
          start={lk.stickCylBase}
          end={lk.stickCylEnd}
          radius={0.004}
          pressure={state.hydraulicPressure}
        />
        
        {/* Bucket linkage */}
        <HydraulicCylinder
          start={lk.bucketLinkBase}
          end={lk.bucketLinkEnd}
          radius={0.003}
          pressure={state.hydraulicPressure * 0.5}
        />
        
        {/* Joint pins (visual detail) */}
        {[lk.boomPivot, lk.boomEnd, lk.stickEnd].map((pos, i) => (
          <mesh key={i} position={pos}>
            <cylinderGeometry args={[0.005, 0.005, 0.018, 8]} />
            <meshStandardMaterial color="#444" metalness={0.7} roughness={0.4} />
          </mesh>
        ))}
      </group>
    </group>
  );
}

// ── Bulldozer Renderer ──────────────────────────────────────────────
export function BulldozerMesh({ state }: { state: BulldozerState }) {
  const v = state.vehicle;
  
  return (
    <group
      position={[v.posX, v.posY, v.posZ]}
      rotation={[v.pitch, v.heading, 0]}
    >
      {/* Chassis */}
      <TrackPair width={0.1} length={0.18} height={0.03} />
      
      {/* Body */}
      <mesh position={[0, 0.03, -0.01]}>
        <boxGeometry args={[0.08, 0.04, 0.12]} />
        <meshStandardMaterial color="#d4a017" metalness={0.4} roughness={0.6} />
      </mesh>
      
      {/* Cab */}
      <mesh position={[0, 0.065, -0.02]}>
        <boxGeometry args={[0.05, 0.035, 0.05]} />
        <meshStandardMaterial color="#d4a017" metalness={0.4} roughness={0.6} />
      </mesh>
      
      {/* Cab window */}
      <mesh position={[0, 0.075, 0.005]}>
        <boxGeometry args={[0.044, 0.02, 0.002]} />
        <meshStandardMaterial color="#4488aa" metalness={0.1} roughness={0.1} transparent opacity={0.6} />
      </mesh>
      
      {/* Engine compartment */}
      <mesh position={[0, 0.04, -0.06]}>
        <boxGeometry args={[0.07, 0.035, 0.04]} />
        <meshStandardMaterial color="#555" metalness={0.6} roughness={0.6} />
      </mesh>
      
      {/* Exhaust stack */}
      <mesh position={[0.025, 0.08, -0.05]}>
        <cylinderGeometry args={[0.004, 0.004, 0.04, 6]} />
        <meshStandardMaterial color="#333" metalness={0.7} roughness={0.4} />
      </mesh>
      
      {/* Blade support arms (C-frame) */}
      <mesh position={[-0.04, 0.01, 0.07]}>
        <boxGeometry args={[0.008, 0.008, 0.06]} />
        <meshStandardMaterial color="#555" metalness={0.6} roughness={0.5} />
      </mesh>
      <mesh position={[0.04, 0.01, 0.07]}>
        <boxGeometry args={[0.008, 0.008, 0.06]} />
        <meshStandardMaterial color="#555" metalness={0.6} roughness={0.5} />
      </mesh>
      
      {/* Blade */}
      <group position={[0, state.bladeHeight, 0.09]} rotation={[state.bladeTilt, state.bladeAngle, 0]}>
        <mesh>
          <boxGeometry args={[state.bladeWidth, 0.06, 0.008]} />
          <meshStandardMaterial color="#222" metalness={0.7} roughness={0.4} />
        </mesh>
        {/* Cutting edge */}
        <mesh position={[0, -0.032, 0]}>
          <boxGeometry args={[state.bladeWidth + 0.005, 0.005, 0.01]} />
          <meshStandardMaterial color="#999" metalness={0.9} roughness={0.2} />
        </mesh>
      </group>
      
      {/* Blade hydraulic cylinders */}
      <HydraulicCylinder
        start={[-0.03, 0.03, 0.03]}
        end={[-0.03, state.bladeHeight + 0.02, 0.08]}
        radius={0.004}
        pressure={Math.abs(state.bladeHeight) > 0.01 ? 0.7 : 0.2}
      />
      <HydraulicCylinder
        start={[0.03, 0.03, 0.03]}
        end={[0.03, state.bladeHeight + 0.02, 0.08]}
        radius={0.004}
        pressure={Math.abs(state.bladeHeight) > 0.01 ? 0.7 : 0.2}
      />
      
      {/* Rippers (rear) */}
      {state.rippersDown && (
        <group position={[0, -0.02, -0.1]}>
          {[-0.02, 0, 0.02].map((offset, i) => (
            <mesh key={i} position={[offset, -0.02, 0]}>
              <boxGeometry args={[0.006, 0.04, 0.006]} />
              <meshStandardMaterial color="#888" metalness={0.7} roughness={0.4} />
            </mesh>
          ))}
          <mesh>
            <boxGeometry args={[0.06, 0.008, 0.01]} />
            <meshStandardMaterial color="#555" metalness={0.6} roughness={0.5} />
          </mesh>
        </group>
      )}
    </group>
  );
}
