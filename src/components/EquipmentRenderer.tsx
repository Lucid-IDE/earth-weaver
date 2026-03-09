// ── Equipment 3D Renderer ────────────────────────────────────────────
// Renders excavator and bulldozer as procedural geometry in Three.js

import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { ExcavatorState } from '@/lib/equipment/types';
import { BulldozerState } from '@/lib/equipment/types';
import { computeExcavatorFK } from '@/lib/equipment/excavator';
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
  const meshRef = useRef<THREE.Mesh>(null!);
  const rodRef = useRef<THREE.Mesh>(null!);
  
  useFrame(() => {
    if (!meshRef.current || !rodRef.current) return;
    const s = new THREE.Vector3(...start);
    const e = new THREE.Vector3(...end);
    const mid = s.clone().add(e).multiplyScalar(0.5);
    const len = s.distanceTo(e);
    const dir = e.clone().sub(s).normalize();
    
    // Cylinder body (shorter, thicker)
    meshRef.current.position.copy(s.clone().lerp(e, 0.35));
    meshRef.current.scale.set(1, len * 0.5, 1);
    meshRef.current.lookAt(e);
    meshRef.current.rotateX(Math.PI / 2);
    
    // Rod (thinner, extends)
    rodRef.current.position.copy(s.clone().lerp(e, 0.7));
    rodRef.current.scale.set(1, len * 0.4, 1);
    rodRef.current.lookAt(e);
    rodRef.current.rotateX(Math.PI / 2);
  });
  
  const cylColor = pressure > 0.5 ? '#c44' : '#666';
  
  return (
    <>
      <mesh ref={meshRef}>
        <cylinderGeometry args={[radius * 1.5, radius * 1.5, 1, 6]} />
        <meshStandardMaterial color={cylColor} metalness={0.8} roughness={0.3} />
      </mesh>
      <mesh ref={rodRef}>
        <cylinderGeometry args={[radius * 0.7, radius * 0.7, 1, 6]} />
        <meshStandardMaterial color="#aaa" metalness={0.9} roughness={0.1} />
      </mesh>
    </>
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
      {/* Track pads (visual detail) */}
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

// ── Excavator Renderer ──────────────────────────────────────────────
export function ExcavatorMesh({ state }: { state: ExcavatorState }) {
  const groupRef = useRef<THREE.Group>(null!);
  const boomRef = useRef<THREE.Mesh>(null!);
  const stickRef = useRef<THREE.Mesh>(null!);
  const bucketRef = useRef<THREE.Mesh>(null!);
  
  const fk = computeExcavatorFK(state);
  const v = state.vehicle;
  
  return (
    <group
      position={[v.posX, v.posY, v.posZ]}
      rotation={[0, v.heading, 0]}
    >
      {/* Chassis */}
      <TrackPair width={0.08} length={0.14} height={0.025} />
      
      {/* Body */}
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
          start={fk.boomPivot}
          end={fk.boomEnd}
          width={0.012}
          color="#d4a017"
          vehiclePos={[v.posX, v.posY, v.posZ]}
          vehicleHeading={v.heading}
          swingAngle={state.swing.angle}
        />
        
        {/* Boom hydraulic */}
        <HydraulicCylinder
          start={[0, 0.06, 0.02]}
          end={localizePoint(fk.boomEnd, v, state.swing.angle, [0, 0.01, 0])}
          radius={0.005}
          pressure={state.hydraulicPressure}
        />
        
        {/* Stick */}
        <ArmSegment
          start={fk.boomEnd}
          end={fk.stickEnd}
          width={0.009}
          color="#d4a017"
          vehiclePos={[v.posX, v.posY, v.posZ]}
          vehicleHeading={v.heading}
          swingAngle={state.swing.angle}
        />
        
        {/* Bucket */}
        <BucketMesh
          tipPos={fk.bucketTip}
          stickEnd={fk.stickEnd}
          vehiclePos={[v.posX, v.posY, v.posZ]}
          vehicleHeading={v.heading}
          swingAngle={state.swing.angle}
        />
      </group>
    </group>
  );
}

// Helper: convert world point to local space for hydraulic positioning
function localizePoint(
  worldPt: [number, number, number],
  vehicle: { posX: number; posY: number; posZ: number; heading: number },
  swingAngle: number,
  offset: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  const dx = worldPt[0] - vehicle.posX;
  const dy = worldPt[1] - vehicle.posY;
  const dz = worldPt[2] - vehicle.posZ;
  const ch = Math.cos(-vehicle.heading - swingAngle);
  const sh = Math.sin(-vehicle.heading - swingAngle);
  return [
    dx * ch - dz * sh + offset[0],
    dy + offset[1],
    dx * sh + dz * ch + offset[2],
  ];
}

// Arm segment rendered between two world points
function ArmSegment({
  start, end, width, color, vehiclePos, vehicleHeading, swingAngle,
}: {
  start: [number, number, number];
  end: [number, number, number];
  width: number;
  color: string;
  vehiclePos: [number, number, number];
  vehicleHeading: number;
  swingAngle: number;
}) {
  const meshRef = useRef<THREE.Mesh>(null!);
  
  // Convert to local space
  const ls = localizePoint(start, 
    { posX: vehiclePos[0], posY: vehiclePos[1], posZ: vehiclePos[2], heading: vehicleHeading },
    swingAngle);
  const le = localizePoint(end,
    { posX: vehiclePos[0], posY: vehiclePos[1], posZ: vehiclePos[2], heading: vehicleHeading },
    swingAngle);
  
  const s = new THREE.Vector3(...ls);
  const e = new THREE.Vector3(...le);
  const mid = s.clone().add(e).multiplyScalar(0.5);
  const len = s.distanceTo(e);
  const dir = e.clone().sub(s).normalize();
  
  // Calculate rotation
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

// Bucket mesh
function BucketMesh({
  tipPos, stickEnd, vehiclePos, vehicleHeading, swingAngle,
}: {
  tipPos: [number, number, number];
  stickEnd: [number, number, number];
  vehiclePos: [number, number, number];
  vehicleHeading: number;
  swingAngle: number;
}) {
  const veh = { posX: vehiclePos[0], posY: vehiclePos[1], posZ: vehiclePos[2], heading: vehicleHeading };
  const lt = localizePoint(tipPos, veh, swingAngle);
  const ls = localizePoint(stickEnd, veh, swingAngle);
  
  const mid = [(lt[0] + ls[0]) / 2, (lt[1] + ls[1]) / 2, (lt[2] + ls[2]) / 2];
  
  return (
    <group position={[mid[0], mid[1], mid[2]]}>
      {/* Bucket shell */}
      <mesh>
        <boxGeometry args={[0.05, 0.03, 0.04]} />
        <meshStandardMaterial color="#888" metalness={0.6} roughness={0.5} />
      </mesh>
      {/* Teeth */}
      {[-0.02, 0, 0.02].map((offset, i) => (
        <mesh key={i} position={[offset, -0.018, 0.02]}>
          <boxGeometry args={[0.005, 0.008, 0.005]} />
          <meshStandardMaterial color="#aaa" metalness={0.8} roughness={0.3} />
        </mesh>
      ))}
    </group>
  );
}

// ── Bulldozer Renderer ──────────────────────────────────────────────
export function BulldozerMesh({ state }: { state: BulldozerState }) {
  const blade = computeBladeGeometry(state);
  const v = state.vehicle;
  
  return (
    <group
      position={[v.posX, v.posY, v.posZ]}
      rotation={[0, v.heading, 0]}
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
      
      {/* Blade support arms */}
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
        {/* Blade cutting edge */}
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
        pressure={Math.abs(state.bladeHeight - 0) > 0.01 ? 0.7 : 0.2}
      />
      <HydraulicCylinder
        start={[0.03, 0.03, 0.03]}
        end={[0.03, state.bladeHeight + 0.02, 0.08]}
        radius={0.004}
        pressure={Math.abs(state.bladeHeight - 0) > 0.01 ? 0.7 : 0.2}
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
          <mesh position={[0, 0, 0]}>
            <boxGeometry args={[0.06, 0.008, 0.01]} />
            <meshStandardMaterial color="#555" metalness={0.6} roughness={0.5} />
          </mesh>
        </group>
      )}
    </group>
  );
}
