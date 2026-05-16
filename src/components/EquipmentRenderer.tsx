// ── Equipment 3D Renderer ────────────────────────────────────────────
// High-fidelity procedural models of excavator and bulldozer
// Anatomically correct geometry matching real CAT/Komatsu proportions

import { useRef, useMemo } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { ExcavatorState, BulldozerState, DumpTruckState } from '@/lib/equipment/types';
import { computeExcavatorLocalFK } from '@/lib/equipment/excavator';

// ── Shared Materials (cached) ───────────────────────────────────────
const COLORS = {
  catYellow: '#d4a017',
  catYellowDark: '#b8880f',
  darkSteel: '#2a2a2a',
  medSteel: '#444',
  lightSteel: '#666',
  chrome: '#999',
  glass: '#3a7799',
  rubber: '#1a1a1a',
  hydraulicBody: '#555',
  hydraulicRod: '#aab',
  hydraulicHot: '#a33',
  counterweight: '#3a3a3a',
  cutting: '#888',
  exhaust: '#333',
  teeth: '#bbb',
};

// ── Helpers ─────────────────────────────────────────────────────────

function CylinderBetween({
  start, end, radius, color, metalness = 0.7, roughness = 0.4, segments = 8,
}: {
  start: [number, number, number];
  end: [number, number, number];
  radius: number;
  color: string;
  metalness?: number;
  roughness?: number;
  segments?: number;
}) {
  const s = new THREE.Vector3(...start);
  const e = new THREE.Vector3(...end);
  const len = s.distanceTo(e);
  if (len < 0.0005) return null;
  const mid = s.clone().add(e).multiplyScalar(0.5);
  const dir = e.clone().sub(s).normalize();
  const quat = new THREE.Quaternion();
  quat.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  const euler = new THREE.Euler().setFromQuaternion(quat);

  return (
    <mesh position={[mid.x, mid.y, mid.z]} rotation={euler}>
      <cylinderGeometry args={[radius, radius, len, segments]} />
      <meshStandardMaterial color={color} metalness={metalness} roughness={roughness} />
    </mesh>
  );
}

function BoxAt({
  pos, size, color, metalness = 0.5, roughness = 0.5, rotation,
}: {
  pos: [number, number, number];
  size: [number, number, number];
  color: string;
  metalness?: number;
  roughness?: number;
  rotation?: [number, number, number];
}) {
  return (
    <mesh position={pos} rotation={rotation}>
      <boxGeometry args={size} />
      <meshStandardMaterial color={color} metalness={metalness} roughness={roughness} />
    </mesh>
  );
}

// ── Hydraulic Cylinder (two-part: body + rod) ───────────────────────
function HydraulicCylinder({
  start, end, bodyRadius = 0.005, rodRadius = 0.003, pressure = 0,
}: {
  start: [number, number, number];
  end: [number, number, number];
  bodyRadius?: number;
  rodRadius?: number;
  pressure?: number;
}) {
  const s = new THREE.Vector3(...start);
  const e = new THREE.Vector3(...end);
  const len = s.distanceTo(e);
  if (len < 0.001) return null;
  const dir = e.clone().sub(s).normalize();

  // Body: first 55% from start
  const bodyEnd = s.clone().addScaledVector(dir, len * 0.55);
  const bodyMid = s.clone().add(bodyEnd).multiplyScalar(0.5);
  // Rod: from 50% to end
  const rodStart = s.clone().addScaledVector(dir, len * 0.5);
  const rodMid = rodStart.clone().add(e).multiplyScalar(0.5);

  const quat = new THREE.Quaternion();
  quat.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  const euler = new THREE.Euler().setFromQuaternion(quat);

  const bodyColor = pressure > 0.5 ? COLORS.hydraulicHot : COLORS.hydraulicBody;

  return (
    <group>
      {/* Cylinder body */}
      <mesh position={[bodyMid.x, bodyMid.y, bodyMid.z]} rotation={euler}>
        <cylinderGeometry args={[bodyRadius, bodyRadius, len * 0.55, 8]} />
        <meshStandardMaterial color={bodyColor} metalness={0.8} roughness={0.3} />
      </mesh>
      {/* Piston rod */}
      <mesh position={[rodMid.x, rodMid.y, rodMid.z]} rotation={euler}>
        <cylinderGeometry args={[rodRadius, rodRadius, len * 0.5, 8]} />
        <meshStandardMaterial color={COLORS.hydraulicRod} metalness={0.9} roughness={0.1} />
      </mesh>
      {/* Pin at start */}
      <mesh position={start}>
        <sphereGeometry args={[bodyRadius * 1.2, 6, 6]} />
        <meshStandardMaterial color={COLORS.medSteel} metalness={0.7} roughness={0.4} />
      </mesh>
      {/* Pin at end */}
      <mesh position={end}>
        <sphereGeometry args={[rodRadius * 1.5, 6, 6]} />
        <meshStandardMaterial color={COLORS.medSteel} metalness={0.7} roughness={0.4} />
      </mesh>
    </group>
  );
}

// ── Pin Joint Visual ────────────────────────────────────────────────
function PinJoint({ pos, radius = 0.006 }: { pos: [number, number, number]; radius?: number }) {
  return (
    <mesh position={pos} rotation={[0, 0, Math.PI / 2]}>
      <cylinderGeometry args={[radius, radius, 0.022, 8]} />
      <meshStandardMaterial color={COLORS.medSteel} metalness={0.7} roughness={0.4} />
    </mesh>
  );
}

// ── Track Assembly ──────────────────────────────────────────────────
// Real articulated track. `gauge` is the center-to-center distance between
// the two tracks (chassis width). `shoeWidth` is the actual width of each
// individual track pad — much narrower than the gauge. Sprocket (rear) and
// idler (front) sit at the same bottom tangent so the bottom run is a
// perfectly horizontal flat line that the rollers ride along.
function TrackAssembly({
  side,
  gauge, trackLength, trackHeight, shoeWidth,
  numRollers = 6, numPads = 36,
  travel = 0,
  slack = 0,
}: {
  side: number;
  gauge: number;        // center-to-center spacing between left/right tracks
  trackLength: number;
  trackHeight: number;
  shoeWidth: number;    // actual pad shoe width (narrower than gauge)
  numRollers?: number;
  numPads?: number;
  travel?: number;
  slack?: number;
}) {
  const xOff = side * gauge / 2;

  const halfL = trackLength * 0.45;
  // Sprocket slightly larger than idler, but BOTH bottoms tangent to the
  // same ground line so pads form a flat bottom run with no protrusions.
  const sprocketRadius = trackHeight * 0.42;
  const idlerRadius = trackHeight * 0.40;
  // Place wheel CENTERS so their bottom tangents share `bottomY`.
  const bottomY = -trackHeight * 0.50;
  const sprocketCenter: [number, number] = [-halfL, bottomY + sprocketRadius];
  const idlerCenter: [number, number] = [halfL, bottomY + idlerRadius];
  const topY = trackHeight * 0.42;

  const padWidth = shoeWidth;
  const padThick = 0.0030;
  // Side frame much narrower than gauge — should match shoe + a little.
  const frameWidth = shoeWidth * 0.85;

  type Seg =
    | { type: 'line'; sz: number; sy: number; ez: number; ey: number; len: number }
    | { type: 'arc'; cz: number; cy: number; r: number; a0: number; a1: number; len: number };
  const segments: Seg[] = [];

  const idlerBottom: [number, number] = [idlerCenter[0], idlerCenter[1] - idlerRadius];
  const sprocketBottom: [number, number] = [sprocketCenter[0], sprocketCenter[1] - sprocketRadius];
  segments.push({
    type: 'line',
    sz: idlerBottom[0], sy: idlerBottom[1],
    ez: sprocketBottom[0], ey: sprocketBottom[1],
    len: Math.hypot(sprocketBottom[0] - idlerBottom[0], sprocketBottom[1] - idlerBottom[1]),
  });
  segments.push({
    type: 'arc',
    cz: sprocketCenter[0], cy: sprocketCenter[1], r: sprocketRadius,
    a0: -Math.PI / 2, a1: -Math.PI * 1.5,
    len: Math.PI * sprocketRadius,
  });
  const sprocketTop: [number, number] = [sprocketCenter[0], sprocketCenter[1] + sprocketRadius];
  const idlerTop: [number, number] = [idlerCenter[0], idlerCenter[1] + idlerRadius];
  segments.push({
    type: 'line',
    sz: sprocketTop[0], sy: sprocketTop[1],
    ez: idlerTop[0], ey: idlerTop[1],
    len: Math.hypot(idlerTop[0] - sprocketTop[0], idlerTop[1] - sprocketTop[1]),
  });
  segments.push({
    type: 'arc',
    cz: idlerCenter[0], cy: idlerCenter[1], r: idlerRadius,
    a0: Math.PI / 2, a1: -Math.PI / 2,
    len: Math.PI * idlerRadius,
  });

  const totalLen = segments.reduce((s, seg) => s + seg.len, 0);

  function sampleAt(s: number): { z: number; y: number; tangent: number } {
    let acc = 0;
    for (const seg of segments) {
      if (s <= acc + seg.len) {
        const t = (s - acc) / seg.len;
        if (seg.type === 'line') {
          const z = seg.sz + (seg.ez - seg.sz) * t;
          const y = seg.sy + (seg.ey - seg.sy) * t;
          const tangent = Math.atan2(seg.ey - seg.sy, seg.ez - seg.sz);
          return { z, y, tangent };
        }
        const a = seg.a0 + (seg.a1 - seg.a0) * t;
        const z = seg.cz + Math.cos(a) * seg.r;
        const y = seg.cy + Math.sin(a) * seg.r;
        const dir = Math.sign(seg.a1 - seg.a0);
        const tangent = a + dir * Math.PI / 2;
        return { z, y, tangent };
      }
      acc += seg.len;
    }
    return { z: 0, y: 0, tangent: 0 };
  }

  const phase = ((travel * (totalLen / (trackLength * 1.9))) % totalLen + totalLen) % totalLen;
  const padSpacing = totalLen / numPads;
  const sagAmp = slack * trackHeight * 0.25;
  const topRunStart = segments[0].len + segments[1].len;
  const topRunEnd = topRunStart + segments[2].len;

  const pads: React.ReactNode[] = [];
  for (let i = 0; i < numPads; i++) {
    const s = ((i * padSpacing - phase) % totalLen + totalLen) % totalLen;
    const sample = sampleAt(s);
    let y = sample.y;
    if (sagAmp > 0 && s >= topRunStart && s <= topRunEnd) {
      const t = (s - topRunStart) / (topRunEnd - topRunStart);
      y -= Math.sin(t * Math.PI) * sagAmp;
    }
    pads.push(
      <group
        key={`p${i}`}
        position={[xOff, y, sample.z]}
        rotation={[sample.tangent, 0, 0]}
      >
        <mesh>
          <boxGeometry args={[padWidth, padThick, padSpacing * 0.78]} />
          <meshStandardMaterial color={COLORS.darkSteel} metalness={0.55} roughness={0.7} />
        </mesh>
        <mesh position={[0, -padThick * 0.5 - 0.0015, 0]}>
          <boxGeometry args={[padWidth * 0.95, 0.0025, padSpacing * 0.18]} />
          <meshStandardMaterial color={COLORS.medSteel} metalness={0.6} roughness={0.6} />
        </mesh>
      </group>
    );
  }

  return (
    <group>
      <BoxAt
        pos={[xOff + side * frameWidth * 0.4, -trackHeight * 0.35, 0]}
        size={[0.005, trackHeight * 0.7, trackLength * 0.92]}
        color={COLORS.catYellowDark}
        metalness={0.5}
        roughness={0.6}
      />
      <BoxAt
        pos={[xOff - side * frameWidth * 0.4, -trackHeight * 0.35, 0]}
        size={[0.005, trackHeight * 0.7, trackLength * 0.92]}
        color={COLORS.catYellowDark}
        metalness={0.5}
        roughness={0.6}
      />

      <mesh position={[xOff, sprocketCenter[1], sprocketCenter[0]]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[sprocketRadius, sprocketRadius, frameWidth * 0.9, 14]} />
        <meshStandardMaterial color={COLORS.darkSteel} metalness={0.7} roughness={0.45} />
      </mesh>
      {Array.from({ length: 10 }).map((_, i) => {
        const a = (i / 10) * Math.PI * 2 + travel * 6;
        return (
          <mesh key={`st${i}`}
            position={[
              xOff,
              sprocketCenter[1] + Math.sin(a) * sprocketRadius * 0.95,
              sprocketCenter[0] + Math.cos(a) * sprocketRadius * 0.95,
            ]}
            rotation={[a, 0, 0]}
          >
            <boxGeometry args={[frameWidth * 0.85, 0.005, 0.005]} />
            <meshStandardMaterial color={COLORS.medSteel} metalness={0.7} roughness={0.45} />
          </mesh>
        );
      })}

      <mesh position={[xOff, idlerCenter[1], idlerCenter[0]]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[idlerRadius, idlerRadius, frameWidth * 0.85, 14]} />
        <meshStandardMaterial color={COLORS.darkSteel} metalness={0.7} roughness={0.45} />
      </mesh>

      {/* Bottom road wheels — sized to ride EXACTLY on the pad bottom line.
          Center placed so the wheel bottom tangent equals (bottomY + padThick),
          which is the top of the pads sitting on the ground.  */}
      {Array.from({ length: numRollers }).map((_, i) => {
        const z = sprocketCenter[0] + (idlerCenter[0] - sprocketCenter[0]) * ((i + 0.5) / numRollers);
        const rollerR = trackHeight * 0.18;
        const yC = bottomY + padThick + rollerR; // sits on top of pads
        return (
          <mesh key={`r${i}`} position={[xOff, yC, z]} rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[rollerR, rollerR, frameWidth * 0.95, 10]} />
            <meshStandardMaterial color={COLORS.medSteel} metalness={0.6} roughness={0.5} />
          </mesh>
        );
      })}

      {/* Top carrier rollers (smaller, support top run) */}
      {[-trackLength * 0.18, trackLength * 0.18].map((z, i) => {
        const rollerR = trackHeight * 0.13;
        return (
          <mesh key={`tr${i}`} position={[xOff, topY - rollerR, z]} rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[rollerR, rollerR, frameWidth * 0.85, 8]} />
            <meshStandardMaterial color={COLORS.medSteel} metalness={0.6} roughness={0.5} />
          </mesh>
        );
      })}

      {pads}
    </group>
  );
}

// ── I-Beam Arm Segment ──────────────────────────────────────────────
// Real excavator booms are I-beam or box-section, not round
function IBeamSegment({
  start, end, width, height, flangeThickness = 0.002, color,
}: {
  start: [number, number, number];
  end: [number, number, number];
  width: number;
  height: number;
  flangeThickness?: number;
  color: string;
}) {
  const s = new THREE.Vector3(...start);
  const e = new THREE.Vector3(...end);
  const len = s.distanceTo(e);
  if (len < 0.001) return null;
  const mid = s.clone().add(e).multiplyScalar(0.5);
  const dir = e.clone().sub(s).normalize();
  const quat = new THREE.Quaternion();
  quat.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  const euler = new THREE.Euler().setFromQuaternion(quat);

  const webThick = width * 0.25;

  return (
    <group position={[mid.x, mid.y, mid.z]} rotation={euler}>
      {/* Web (center vertical plate) */}
      <mesh>
        <boxGeometry args={[webThick, len, height * 0.7]} />
        <meshStandardMaterial color={color} metalness={0.5} roughness={0.5} />
      </mesh>
      {/* Top flange */}
      <mesh position={[0, 0, height * 0.35]}>
        <boxGeometry args={[width, len, flangeThickness]} />
        <meshStandardMaterial color={color} metalness={0.5} roughness={0.5} />
      </mesh>
      {/* Bottom flange */}
      <mesh position={[0, 0, -height * 0.35]}>
        <boxGeometry args={[width, len, flangeThickness]} />
        <meshStandardMaterial color={color} metalness={0.5} roughness={0.5} />
      </mesh>
    </group>
  );
}

// ── Excavator Bucket (detailed) ─────────────────────────────────────
// Real excavator bucket: wider opening than depth, curl axis at the stick
// joint, opening faces forward (toward the bucket tip).
function DetailedBucket({
  stickEnd, bucketTip, fill = 0,
}: {
  stickEnd: [number, number, number];
  bucketTip: [number, number, number];
  fill?: number;
}) {
  const dir = new THREE.Vector3(
    bucketTip[0] - stickEnd[0],
    bucketTip[1] - stickEnd[1],
    bucketTip[2] - stickEnd[2],
  );
  const len = dir.length();
  if (len < 0.001) return null;
  dir.normalize();

  const mid: [number, number, number] = [
    (stickEnd[0] + bucketTip[0]) / 2,
    (stickEnd[1] + bucketTip[1]) / 2,
    (stickEnd[2] + bucketTip[2]) / 2,
  ];

  const quat = new THREE.Quaternion();
  quat.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  const euler = new THREE.Euler().setFromQuaternion(quat);

  // Realistic ~0.5m³ class bucket: opening width > depth.
  const bw = 0.060;       // bucket width (across opening)
  const bd = 0.052;       // bucket depth (front-to-back, opening size)
  const bh = len * 0.95;  // along stick→tip axis (cutting edge at -Y end)
  const wallT = 0.0025;

  return (
    <group position={mid} rotation={euler}>
      {/* Back plate */}
      <BoxAt pos={[0, 0, -bd * 0.45]} size={[bw, bh, wallT]} color={COLORS.lightSteel} metalness={0.6} roughness={0.4} />
      {/* Curved bottom (scoop floor) */}
      <BoxAt pos={[0, -bh * 0.30, -bd * 0.18]} size={[bw - wallT, wallT, bd * 0.55]} color={COLORS.lightSteel} metalness={0.6} roughness={0.4} rotation={[0.45, 0, 0]} />
      {/* Side plates */}
      <BoxAt pos={[-bw * 0.5 + wallT * 0.5, -bh * 0.05, -bd * 0.08]} size={[wallT, bh * 0.85, bd * 0.85]} color={COLORS.lightSteel} metalness={0.6} roughness={0.4} />
      <BoxAt pos={[ bw * 0.5 - wallT * 0.5, -bh * 0.05, -bd * 0.08]} size={[wallT, bh * 0.85, bd * 0.85]} color={COLORS.lightSteel} metalness={0.6} roughness={0.4} />

      {/* Cutting edge (forward = +Z) */}
      <BoxAt pos={[0, -bh * 0.48, bd * 0.18]} size={[bw * 0.96, 0.005, 0.010]} color={COLORS.cutting} metalness={0.85} roughness={0.2} />

      {/* GET teeth */}
      {[-0.022, -0.011, 0, 0.011, 0.022].map((offset, i) => (
        <group key={i}>
          <BoxAt
            pos={[offset, -bh * 0.49, bd * 0.21]}
            size={[0.0055, 0.0065, 0.007]}
            color={COLORS.medSteel}
            metalness={0.7}
            roughness={0.4}
          />
          <mesh position={[offset, -bh * 0.51, bd * 0.265]} rotation={[Math.PI / 2, 0, 0]}>
            <coneGeometry args={[0.0035, 0.014, 4]} />
            <meshStandardMaterial color={COLORS.teeth} metalness={0.85} roughness={0.3} />
          </mesh>
        </group>
      ))}

      {/* Hinge ear at stick joint */}
      <mesh position={[0, bh * 0.45, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.008, 0.008, bw * 0.7, 10]} />
        <meshStandardMaterial color={COLORS.medSteel} metalness={0.7} roughness={0.4} />
      </mesh>

      {/* Soil fill */}
      {fill > 0.05 && (
        <mesh position={[0, -bh * 0.18, -bd * 0.05]}>
          <boxGeometry args={[bw * 0.85, Math.max(0.005, bh * 0.45 * fill), bd * 0.65 * Math.max(0.4, fill)]} />
          <meshStandardMaterial color="#6b5a3d" metalness={0.05} roughness={0.95} />
        </mesh>
      )}
    </group>
  );
}

// ── Exhaust Smoke Puff ──────────────────────────────────────────────
// Fading dark puffs anchored to a local position. Intensity 0..1 controls
// puff spawn rate + size. Smoke rises buoyantly and dissipates.
function ExhaustSmoke({
  origin, intensity = 0,
}: {
  origin: [number, number, number];
  intensity?: number;
}) {
  const MAX = 10;
  const meshRef = useRef<THREE.InstancedMesh>(null!);
  const stateRef = useRef({
    px: new Float32Array(MAX), py: new Float32Array(MAX), pz: new Float32Array(MAX),
    vx: new Float32Array(MAX), vy: new Float32Array(MAX), vz: new Float32Array(MAX),
    life: new Float32Array(MAX), scale: new Float32Array(MAX),
    cursor: 0, accum: 0,
  });
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const mat = useMemo(() => new THREE.MeshBasicMaterial({
    color: '#1f1f1f', transparent: true, opacity: 0.5,
    depthWrite: false,
  }), []);
  const geo = useMemo(() => new THREE.SphereGeometry(0.012, 4, 4), []);

  useFrame((_, dt) => {
    const s = stateRef.current;
    const cdt = Math.min(dt, 0.05);
    const spawnRate = intensity * 8;
    s.accum += spawnRate * cdt;
    while (s.accum >= 1 && intensity > 0.02) {
      s.accum -= 1;
      const i = s.cursor;
      s.cursor = (s.cursor + 1) % MAX;
      s.px[i] = (Math.random() - 0.5) * 0.004;
      s.py[i] = 0;
      s.pz[i] = (Math.random() - 0.5) * 0.004;
      s.vx[i] = (Math.random() - 0.5) * 0.015;
      s.vy[i] = 0.04 + Math.random() * 0.05 + intensity * 0.04;
      s.vz[i] = (Math.random() - 0.5) * 0.015;
      s.life[i] = 1.0;
      s.scale[i] = 0.35 + Math.random() * 0.35 + intensity * 0.45;
    }
    if (!meshRef.current) return;
    let visible = 0;
    for (let i = 0; i < MAX; i++) {
      if (s.life[i] <= 0) continue;
      s.px[i] += s.vx[i] * cdt;
      s.py[i] += s.vy[i] * cdt;
      s.pz[i] += s.vz[i] * cdt;
      s.vx[i] *= 0.96; s.vz[i] *= 0.96;
      s.vy[i] += 0.06 * cdt;
      s.scale[i] += 0.7 * cdt;
      s.life[i] -= cdt * 0.55;
      if (s.life[i] <= 0) continue;
      dummy.position.set(s.px[i], s.py[i], s.pz[i]);
      const sc = s.scale[i] * (1.4 - s.life[i] * 0.4);
      dummy.scale.setScalar(sc);
      dummy.updateMatrix();
      meshRef.current.setMatrixAt(visible, dummy.matrix);
      visible++;
    }
    meshRef.current.count = visible;
    meshRef.current.instanceMatrix.needsUpdate = true;
    mat.opacity = 0.2 + intensity * 0.45;
  });

  return (
    <group position={origin}>
      <instancedMesh ref={meshRef} args={[geo, mat, MAX]} frustumCulled={false} />
    </group>
  );
}

// ── EXCAVATOR ───────────────────────────────────────────────────────
export function ExcavatorMesh({
  state, exhaustIntensity = 0,
}: { state: ExcavatorState; exhaustIntensity?: number }) {
  const v = state.vehicle;
  const lk = computeExcavatorLocalFK(state);

  // Track dimensions — gauge is chassis-wide spacing between tracks,
  // shoeWidth is the much narrower individual pad width.
  const gauge = 0.082;     // center-to-center spacing (was 0.10, too wide)
  const shoeWidth = 0.032; // realistic ~600mm shoes scaled down
  const tl = 0.16;         // track length
  const th = 0.028;        // track height

  const rootRef = useRef<THREE.Group>(null!);
  const swingRef = useRef<THREE.Group>(null!);
  useFrame(() => {
    if (rootRef.current) {
      rootRef.current.position.set(v.posX, v.posY, v.posZ);
      rootRef.current.rotation.set(v.pitch, v.heading, 0);
    }
    if (swingRef.current) swingRef.current.rotation.y = state.swing.angle;
  });

  return (
    <group ref={rootRef}>
      {/* ── Undercarriage ── */}
      <TrackAssembly side={-1} gauge={gauge} shoeWidth={shoeWidth} trackLength={tl} trackHeight={th} numRollers={5} numPads={24}
        travel={v.tracks.leftTravel} slack={v.tracks.slack} />
      <TrackAssembly side={1} gauge={gauge} shoeWidth={shoeWidth} trackLength={tl} trackHeight={th} numRollers={5} numPads={24}
        travel={v.tracks.rightTravel} slack={v.tracks.slack} />

      {/* Track frame cross-members (span between the two tracks) */}
      <BoxAt pos={[0, -th * 0.05, -tl * 0.25]} size={[gauge * 0.7, 0.006, 0.008]} color={COLORS.darkSteel} metalness={0.6} roughness={0.5} />
      <BoxAt pos={[0, -th * 0.05, tl * 0.25]} size={[gauge * 0.7, 0.006, 0.008]} color={COLORS.darkSteel} metalness={0.6} roughness={0.5} />

      {/* Keep tw alias for downstream layout below */}
      {(() => { /* no-op */ return null; })()}
      {/* Center platform / turntable ring */}
      <mesh position={[0, 0.005, 0]}>
        <cylinderGeometry args={[0.035, 0.038, 0.008, 16]} />
        <meshStandardMaterial color={COLORS.darkSteel} metalness={0.7} roughness={0.4} />
      </mesh>

      {/* ── Superstructure (rotates with swing) ── */}
      <group ref={swingRef}>
        {/* Main deck plate */}
        <BoxAt pos={[0, 0.015, -0.005]} size={[0.07, 0.01, 0.08]} color={COLORS.catYellow} />

        {/* Engine housing (rear) */}
        <BoxAt pos={[0, 0.035, -0.04]} size={[0.065, 0.03, 0.035]} color={COLORS.catYellow} />
        {/* Engine vents */}
        {[-0.02, -0.01, 0, 0.01, 0.02].map((x, i) => (
          <BoxAt key={`ev${i}`} pos={[x, 0.042, -0.058]} size={[0.003, 0.015, 0.001]} color={COLORS.darkSteel} metalness={0.7} roughness={0.4} />
        ))}

        {/* Counterweight */}
        <mesh position={[0, 0.028, -0.058]}>
          <cylinderGeometry args={[0.036, 0.038, 0.025, 12, 1, false, 2.4, 3.9]} />
          <meshStandardMaterial color={COLORS.counterweight} metalness={0.7} roughness={0.5} />
        </mesh>

        {/* Exhaust stack */}
        <mesh position={[0.022, 0.06, -0.035]}>
          <cylinderGeometry args={[0.004, 0.003, 0.03, 8]} />
          <meshStandardMaterial color={COLORS.exhaust} metalness={0.6} roughness={0.5} />
        </mesh>
        {/* Exhaust cap */}
        <mesh position={[0.022, 0.076, -0.035]}>
          <cylinderGeometry args={[0.005, 0.005, 0.003, 8]} />
          <meshStandardMaterial color={COLORS.exhaust} metalness={0.6} roughness={0.5} />
        </mesh>
        {/* Exhaust smoke puffs (rises from cap) */}
        <ExhaustSmoke origin={[0.022, 0.082, -0.035]} intensity={exhaustIntensity} />

        {/* Cab structure */}
        {/* Cab floor */}
        <BoxAt pos={[-0.015, 0.025, 0.015]} size={[0.04, 0.005, 0.045]} color={COLORS.catYellow} />
        {/* Cab walls */}
        <BoxAt pos={[-0.034, 0.048, 0.015]} size={[0.003, 0.04, 0.045]} color={COLORS.catYellow} />
        <BoxAt pos={[0.003, 0.048, 0.015]} size={[0.003, 0.04, 0.045]} color={COLORS.catYellow} />
        {/* Cab rear */}
        <BoxAt pos={[-0.015, 0.048, -0.01]} size={[0.04, 0.04, 0.003]} color={COLORS.catYellow} />
        {/* Cab roof */}
        <BoxAt pos={[-0.015, 0.07, 0.015]} size={[0.042, 0.003, 0.048]} color={COLORS.catYellow} />

        {/* Front window */}
        <BoxAt
          pos={[-0.015, 0.052, 0.038]}
          size={[0.035, 0.032, 0.002]}
          color={COLORS.glass}
          metalness={0.1}
          roughness={0.05}
        />
        {/* Side window (left) */}
        <BoxAt
          pos={[-0.034, 0.052, 0.02]}
          size={[0.002, 0.028, 0.03]}
          color={COLORS.glass}
          metalness={0.1}
          roughness={0.05}
        />

        {/* ROPS pillars (4 corner posts) */}
        {[
          [-0.033, 0.048, -0.008],
          [-0.033, 0.048, 0.036],
          [0.002, 0.048, -0.008],
          [0.002, 0.048, 0.036],
        ].map((p, i) => (
          <BoxAt key={`rops${i}`}
            pos={p as [number, number, number]}
            size={[0.004, 0.04, 0.004]}
            color={COLORS.catYellowDark}
            metalness={0.5}
            roughness={0.5}
          />
        ))}

        {/* ── Boom ── */}
        <IBeamSegment
          start={lk.boomPivot}
          end={lk.boomEnd}
          width={0.018}
          height={0.022}
          color={COLORS.catYellow}
        />

        {/* ── Stick ── */}
        <IBeamSegment
          start={lk.boomEnd}
          end={lk.stickEnd}
          width={0.014}
          height={0.016}
          color={COLORS.catYellow}
        />

        {/* ── Bucket ── */}
        <DetailedBucket
          stickEnd={lk.stickEnd}
          bucketTip={lk.bucketTip}
          fill={state.bucketFill}
        />

        {/* ── Hydraulic Cylinders ── */}
        {/* Boom cylinders (pair, one each side) */}
        <HydraulicCylinder
          start={[lk.boomCylBase[0] - 0.008, lk.boomCylBase[1], lk.boomCylBase[2]]}
          end={[lk.boomCylEnd[0] - 0.008, lk.boomCylEnd[1], lk.boomCylEnd[2]]}
          bodyRadius={0.005}
          rodRadius={0.003}
          pressure={state.hydraulicPressure}
        />
        <HydraulicCylinder
          start={[lk.boomCylBase[0] + 0.008, lk.boomCylBase[1], lk.boomCylBase[2]]}
          end={[lk.boomCylEnd[0] + 0.008, lk.boomCylEnd[1], lk.boomCylEnd[2]]}
          bodyRadius={0.005}
          rodRadius={0.003}
          pressure={state.hydraulicPressure}
        />

        {/* Stick cylinder */}
        <HydraulicCylinder
          start={lk.stickCylBase}
          end={lk.stickCylEnd}
          bodyRadius={0.004}
          rodRadius={0.0025}
          pressure={state.hydraulicPressure}
        />

        {/* Bucket linkage */}
        <HydraulicCylinder
          start={lk.bucketLinkBase}
          end={lk.bucketLinkEnd}
          bodyRadius={0.003}
          rodRadius={0.002}
          pressure={state.hydraulicPressure * 0.6}
        />

        {/* ── Pin Joints ── */}
        <PinJoint pos={lk.boomPivot} radius={0.007} />
        <PinJoint pos={lk.boomEnd} radius={0.006} />
        <PinJoint pos={lk.stickEnd} radius={0.005} />

        {/* Boom foot pivot bracket */}
        <BoxAt
          pos={[0, lk.boomPivot[1] - 0.01, lk.boomPivot[2]]}
          size={[0.024, 0.015, 0.012]}
          color={COLORS.catYellow}
        />
      </group>
    </group>
  );
}

// ── BULLDOZER ───────────────────────────────────────────────────────
export function BulldozerMesh({
  state, exhaustIntensity = 0,
}: { state: BulldozerState; exhaustIntensity?: number }) {
  const v = state.vehicle;

  // Track dimensions — gauge narrower than before; shoe width represents
  // wide D6-style grouser shoes (~600mm scaled). `tw` kept as alias.
  const gauge = 0.105;       // center-to-center spacing (was 0.13)
  const shoeWidth = 0.040;
  const tw = gauge;          // alias for downstream layout (push arms etc.)
  const tl = 0.20;           // track length
  const th = 0.032;          // track height

  // Blade geometry in local space
  const bladeW = state.bladeWidth;
  const bladeH = 0.065;
  const bladeZ = 0.10; // forward from center

  const rootRef = useRef<THREE.Group>(null!);
  useFrame(() => {
    if (rootRef.current) {
      rootRef.current.position.set(v.posX, v.posY, v.posZ);
      rootRef.current.rotation.set(v.pitch, v.heading, 0);
    }
  });

  return (
    <group ref={rootRef}>
      {/* ── Undercarriage ── */}
      <TrackAssembly side={-1} gauge={gauge} shoeWidth={shoeWidth} trackLength={tl} trackHeight={th} numRollers={7} numPads={32}
        travel={v.tracks.leftTravel} slack={v.tracks.slack} />
      <TrackAssembly side={1} gauge={gauge} shoeWidth={shoeWidth} trackLength={tl} trackHeight={th} numRollers={7} numPads={32}
        travel={v.tracks.rightTravel} slack={v.tracks.slack} />

      {/* Track frame cross-members */}
      <BoxAt pos={[0, -th * 0.05, -tl * 0.3]} size={[gauge * 0.6, 0.008, 0.01]} color={COLORS.darkSteel} />
      <BoxAt pos={[0, -th * 0.05, 0]} size={[gauge * 0.6, 0.008, 0.01]} color={COLORS.darkSteel} />
      <BoxAt pos={[0, -th * 0.05, tl * 0.3]} size={[gauge * 0.6, 0.008, 0.01]} color={COLORS.darkSteel} />

      {/* ── Main body / engine deck ── */}
      <BoxAt pos={[0, 0.02, -0.02]} size={[0.09, 0.025, 0.14]} color={COLORS.catYellow} />

      {/* Engine hood (raised rear section) */}
      <BoxAt pos={[0, 0.045, -0.06]} size={[0.08, 0.025, 0.06]} color={COLORS.catYellow} />
      {/* Hood vents */}
      {[-0.025, -0.015, -0.005, 0.005, 0.015, 0.025].map((x, i) => (
        <BoxAt key={`hv${i}`} pos={[x, 0.059, -0.06]} size={[0.004, 0.001, 0.04]} color={COLORS.darkSteel} metalness={0.6} roughness={0.5} />
      ))}

      {/* Radiator grille (rear) */}
      <BoxAt pos={[0, 0.04, -0.091]} size={[0.07, 0.035, 0.003]} color={COLORS.darkSteel} metalness={0.6} roughness={0.5} />
      {/* Grille bars */}
      {Array.from({ length: 6 }).map((_, i) => (
        <BoxAt key={`gb${i}`}
          pos={[0, 0.025 + i * 0.006, -0.092]}
          size={[0.065, 0.002, 0.002]}
          color={COLORS.medSteel}
          metalness={0.7}
          roughness={0.4}
        />
      ))}

      {/* Exhaust stack (left side) */}
      <mesh position={[-0.035, 0.075, -0.05]}>
        <cylinderGeometry args={[0.005, 0.004, 0.04, 8]} />
        <meshStandardMaterial color={COLORS.exhaust} metalness={0.6} roughness={0.5} />
      </mesh>
      <mesh position={[-0.035, 0.096, -0.05]}>
        <cylinderGeometry args={[0.006, 0.006, 0.003, 8]} />
        <meshStandardMaterial color={COLORS.exhaust} metalness={0.6} roughness={0.5} />
      </mesh>
      {/* Exhaust smoke puffs */}
      <ExhaustSmoke origin={[-0.035, 0.102, -0.05]} intensity={exhaustIntensity} />

      {/* Air pre-cleaner (right side) */}
      <mesh position={[0.035, 0.075, -0.05]}>
        <cylinderGeometry args={[0.006, 0.006, 0.035, 8]} />
        <meshStandardMaterial color={COLORS.catYellow} metalness={0.4} roughness={0.6} />
      </mesh>

      {/* ── Cab ── */}
      {/* Cab floor */}
      <BoxAt pos={[0, 0.035, 0.02]} size={[0.05, 0.005, 0.05]} color={COLORS.catYellow} />
      {/* Cab walls */}
      <BoxAt pos={[-0.024, 0.06, 0.02]} size={[0.003, 0.045, 0.05]} color={COLORS.catYellow} />
      <BoxAt pos={[0.024, 0.06, 0.02]} size={[0.003, 0.045, 0.05]} color={COLORS.catYellow} />
      <BoxAt pos={[0, 0.06, -0.004]} size={[0.05, 0.045, 0.003]} color={COLORS.catYellow} />
      {/* Cab roof (ROPS) */}
      <BoxAt pos={[0, 0.085, 0.02]} size={[0.054, 0.004, 0.054]} color={COLORS.catYellow} />

      {/* Front window */}
      <BoxAt pos={[0, 0.065, 0.044]} size={[0.042, 0.035, 0.002]} color={COLORS.glass} metalness={0.1} roughness={0.05} />
      {/* Side windows */}
      <BoxAt pos={[-0.025, 0.065, 0.02]} size={[0.002, 0.03, 0.035]} color={COLORS.glass} metalness={0.1} roughness={0.05} />
      <BoxAt pos={[0.025, 0.065, 0.02]} size={[0.002, 0.03, 0.035]} color={COLORS.glass} metalness={0.1} roughness={0.05} />

      {/* ROPS corner posts */}
      {[
        [-0.024, 0.06, -0.003],
        [-0.024, 0.06, 0.044],
        [0.024, 0.06, -0.003],
        [0.024, 0.06, 0.044],
      ].map((p, i) => (
        <BoxAt key={`rops${i}`} pos={p as [number, number, number]} size={[0.005, 0.045, 0.005]} color={COLORS.catYellowDark} />
      ))}

      {/* ── C-Frame / Push Arms ── */}
      {/* Left push arm */}
      <CylinderBetween
        start={[-tw * 0.4, 0.005, 0.04]}
        end={[-bladeW * 0.45, state.bladeHeight + 0.015, bladeZ - 0.01]}
        radius={0.006}
        color={COLORS.medSteel}
      />
      {/* Right push arm */}
      <CylinderBetween
        start={[tw * 0.4, 0.005, 0.04]}
        end={[bladeW * 0.45, state.bladeHeight + 0.015, bladeZ - 0.01]}
        radius={0.006}
        color={COLORS.medSteel}
      />

      {/* ── Blade Assembly ── */}
      <group position={[0, state.bladeHeight, bladeZ]} rotation={[state.bladeTilt, state.bladeAngle, 0]}>
        {/* Main blade plate (curved approximation: 3 angled sections) */}
        <BoxAt pos={[0, 0, 0]} size={[bladeW * 0.5, bladeH, 0.008]} color={COLORS.darkSteel} metalness={0.7} roughness={0.4} />
        <BoxAt pos={[-bladeW * 0.32, 0, -0.008]} size={[bladeW * 0.2, bladeH, 0.008]} color={COLORS.darkSteel} metalness={0.7} roughness={0.4} rotation={[0, 0.3, 0]} />
        <BoxAt pos={[bladeW * 0.32, 0, -0.008]} size={[bladeW * 0.2, bladeH, 0.008]} color={COLORS.darkSteel} metalness={0.7} roughness={0.4} rotation={[0, -0.3, 0]} />

        {/* Blade stiffeners (horizontal ribs on back) */}
        <BoxAt pos={[0, bladeH * 0.2, -0.008]} size={[bladeW * 0.85, 0.005, 0.006]} color={COLORS.medSteel} />
        <BoxAt pos={[0, -bladeH * 0.15, -0.008]} size={[bladeW * 0.85, 0.005, 0.006]} color={COLORS.medSteel} />

        {/* Vertical stiffeners */}
        {[-bladeW * 0.3, -bladeW * 0.1, bladeW * 0.1, bladeW * 0.3].map((x, i) => (
          <BoxAt key={`vs${i}`} pos={[x, 0, -0.01]} size={[0.004, bladeH * 0.7, 0.008]} color={COLORS.medSteel} />
        ))}

        {/* Cutting edge */}
        <BoxAt
          pos={[0, -bladeH * 0.48, 0.003]}
          size={[bladeW * 0.95, 0.006, 0.012]}
          color={COLORS.cutting}
          metalness={0.8}
          roughness={0.2}
        />

        {/* End bits (blade corners) */}
        <BoxAt pos={[-bladeW * 0.47, -bladeH * 0.3, 0]} size={[0.006, bladeH * 0.5, 0.012]} color={COLORS.cutting} metalness={0.7} roughness={0.3} />
        <BoxAt pos={[bladeW * 0.47, -bladeH * 0.3, 0]} size={[0.006, bladeH * 0.5, 0.012]} color={COLORS.cutting} metalness={0.7} roughness={0.3} />

        {/* Blade lift eyes (attachment points) */}
        <mesh position={[-bladeW * 0.25, bladeH * 0.35, -0.01]}>
          <torusGeometry args={[0.005, 0.002, 6, 8]} />
          <meshStandardMaterial color={COLORS.medSteel} metalness={0.7} roughness={0.4} />
        </mesh>
        <mesh position={[bladeW * 0.25, bladeH * 0.35, -0.01]}>
          <torusGeometry args={[0.005, 0.002, 6, 8]} />
          <meshStandardMaterial color={COLORS.medSteel} metalness={0.7} roughness={0.4} />
        </mesh>
      </group>

      {/* ── Blade Lift Hydraulic Cylinders ── */}
      <HydraulicCylinder
        start={[-tw * 0.3, 0.025, 0.02]}
        end={[-bladeW * 0.25, state.bladeHeight + bladeH * 0.35, bladeZ - 0.01]}
        bodyRadius={0.005}
        rodRadius={0.003}
        pressure={Math.abs(state.bladeHeight) > 0.01 ? 0.7 : 0.2}
      />
      <HydraulicCylinder
        start={[tw * 0.3, 0.025, 0.02]}
        end={[bladeW * 0.25, state.bladeHeight + bladeH * 0.35, bladeZ - 0.01]}
        bodyRadius={0.005}
        rodRadius={0.003}
        pressure={Math.abs(state.bladeHeight) > 0.01 ? 0.7 : 0.2}
      />

      {/* Tilt cylinder (single, center-mounted) */}
      <HydraulicCylinder
        start={[0, 0.02, 0.05]}
        end={[0, state.bladeHeight + bladeH * 0.1, bladeZ - 0.01]}
        bodyRadius={0.004}
        rodRadius={0.0025}
        pressure={Math.abs(state.bladeTilt) > 0.02 ? 0.6 : 0.1}
      />

      {/* ── Ripper Assembly (rear) ── */}
      {state.rippersDown && (
        <group position={[0, -0.01, -tl * 0.48]}>
          {/* Ripper beam */}
          <BoxAt pos={[0, 0, 0]} size={[0.08, 0.01, 0.012]} color={COLORS.medSteel} metalness={0.6} roughness={0.5} />

          {/* Ripper shanks */}
          {[-0.025, 0, 0.025].map((x, i) => (
            <group key={`rip${i}`}>
              {/* Shank (angled back) */}
              <CylinderBetween
                start={[x, 0, 0]}
                end={[x, -0.04, 0.01]}
                radius={0.004}
                color={COLORS.medSteel}
              />
              {/* Ripper tip */}
              <mesh position={[x, -0.045, 0.012]} rotation={[0.3, 0, 0]}>
                <coneGeometry args={[0.004, 0.015, 4]} />
                <meshStandardMaterial color={COLORS.cutting} metalness={0.8} roughness={0.2} />
              </mesh>
            </group>
          ))}

          {/* Ripper lift cylinders */}
          <HydraulicCylinder
            start={[-0.03, 0.015, 0.01]}
            end={[-0.025, 0.003, 0]}
            bodyRadius={0.003}
            rodRadius={0.002}
            pressure={0.5}
          />
          <HydraulicCylinder
            start={[0.03, 0.015, 0.01]}
            end={[0.025, 0.003, 0]}
            bodyRadius={0.003}
            rodRadius={0.002}
            pressure={0.5}
          />
        </group>
      )}

      {/* Ripper frame (always visible, even when up) */}
      {!state.rippersDown && (
        <group position={[0, 0.01, -tl * 0.48]}>
          <BoxAt pos={[0, 0, 0]} size={[0.07, 0.008, 0.01]} color={COLORS.medSteel} metalness={0.6} roughness={0.5} />
          {[-0.025, 0, 0.025].map((x, i) => (
            <CylinderBetween
              key={`rs${i}`}
              start={[x, 0, 0]}
              end={[x, -0.015, 0.005]}
              radius={0.003}
              color={COLORS.medSteel}
            />
          ))}
        </group>
      )}

      {/* ── Tow hook / drawbar (rear) ── */}
      <mesh position={[0, -0.005, -tl * 0.44]}>
        <torusGeometry args={[0.008, 0.003, 6, 8, Math.PI]} />
        <meshStandardMaterial color={COLORS.medSteel} metalness={0.7} roughness={0.4} />
      </mesh>
    </group>
  );
}

// ── John Deere 460 P-Tier — Articulated Dump Truck ─────────────────
// Real 460 P-Tier: 6×6 articulated, ~410 kW Cummins, 41-ton payload,
// articulation at center hinge (±45°), front 1× axle + rear 2× bogie.

const TRUCK_COLORS = {
  jdYellow: '#f2c200',        // John Deere construction yellow
  jdYellowDeep: '#d4a000',
  jdGreen: '#1a3a1f',         // dark green accents
  steelGrey: '#4a4a4a',
  darkGrey: '#2a2a2a',
  rubber: '#0e0e0e',
  treadFace: '#181818',
  rim: '#e6b400',             // yellow rim
  hub: '#1a1a1a',
  glass: '#3a7799',
  chrome: '#bcbcbc',
  hyd: '#5a5a5a',
  rod: '#c8c8d0',
  underframe: '#222',
};

function HeavyDutyTire({
  radius, width, deflection, rotation,
}: {
  radius: number; width: number; deflection: number; rotation: number;
}) {
  // Tire deforms vertically (squash) and bulges sideways under load.
  // Geometry note: the carcass is a torus with its axis along the wheel
  // spindle (group rotation places spindle on X). The tire spins on its
  // local Z axis -> we rotate the torus group by `rotation` on Z.
  const squash = Math.max(0.62, 1 - deflection * 11);
  const bulge = 1 + deflection * 5.0;
  const treadCount = 22;
  const lugLen = width * 0.42;
  return (
    <group rotation={[0, 0, Math.PI / 2]}>
      {/* Tire carcass — spindle is local X (post-rotation), spins on Z */}
      <group rotation={[0, 0, rotation]} scale={[bulge, squash, 1 + deflection * 2.0]}>
        {/* Inner sidewall + tread band */}
        <mesh>
          <torusGeometry args={[radius, width * 0.42, 16, 32]} />
          <meshStandardMaterial color={TRUCK_COLORS.rubber} metalness={0.05} roughness={0.95} />
        </mesh>
        {/* Outer tread face ring (slightly larger radius, darker) */}
        <mesh>
          <torusGeometry args={[radius * 1.005, width * 0.30, 8, 32]} />
          <meshStandardMaterial color={TRUCK_COLORS.treadFace} metalness={0.05} roughness={0.98} />
        </mesh>
        {/* Aggressive directional tread lugs (chevron-like) */}
        {Array.from({ length: treadCount }).map((_, i) => {
          const a = (i / treadCount) * Math.PI * 2;
          const ca = Math.cos(a), sa = Math.sin(a);
          const r = radius + width * 0.08;
          return (
            <group key={i} position={[ca * r, sa * r, 0]} rotation={[0, 0, a]}>
              {/* Left lug (angled out) */}
              <mesh position={[0, 0, lugLen * 0.45]} rotation={[0.42, 0, 0]}>
                <boxGeometry args={[width * 0.18, width * 0.12, lugLen]} />
                <meshStandardMaterial color={TRUCK_COLORS.darkGrey} metalness={0.05} roughness={0.92} />
              </mesh>
              {/* Right lug (mirror) */}
              <mesh position={[0, 0, -lugLen * 0.45]} rotation={[-0.42, 0, 0]}>
                <boxGeometry args={[width * 0.18, width * 0.12, lugLen]} />
                <meshStandardMaterial color={TRUCK_COLORS.darkGrey} metalness={0.05} roughness={0.92} />
              </mesh>
              {/* Center sipe */}
              <mesh position={[0, 0, 0]}>
                <boxGeometry args={[width * 0.10, width * 0.08, lugLen * 1.05]} />
                <meshStandardMaterial color={TRUCK_COLORS.darkGrey} metalness={0.05} roughness={0.92} />
              </mesh>
            </group>
          );
        })}
        {/* Sidewall ribs (subtle) */}
        {Array.from({ length: 8 }).map((_, i) => {
          const a = (i / 8) * Math.PI * 2;
          return (
            <mesh key={`sw${i}`} position={[Math.cos(a) * radius * 0.85, Math.sin(a) * radius * 0.85, width * 0.35]} rotation={[0, 0, a]}>
              <boxGeometry args={[radius * 0.05, 0.0008, 0.0015]} />
              <meshStandardMaterial color={TRUCK_COLORS.darkGrey} roughness={0.9} />
            </mesh>
          );
        })}
      </group>
      {/* Yellow rim + hub (do NOT spin visually — keep static for clarity) */}
      <mesh>
        <cylinderGeometry args={[radius * 0.55, radius * 0.55, width * 0.55, 18]} />
        <meshStandardMaterial color={TRUCK_COLORS.rim} metalness={0.35} roughness={0.55} />
      </mesh>
      <mesh>
        <cylinderGeometry args={[radius * 0.18, radius * 0.18, width * 0.62, 12]} />
        <meshStandardMaterial color={TRUCK_COLORS.hub} metalness={0.7} roughness={0.4} />
      </mesh>
      {/* Lug nuts */}
      {Array.from({ length: 10 }).map((_, i) => {
        const a = (i / 10) * Math.PI * 2;
        return (
          <mesh key={`ln${i}`} position={[0, Math.cos(a) * radius * 0.36, Math.sin(a) * radius * 0.36]} rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[radius * 0.04, radius * 0.04, width * 0.62, 6]} />
            <meshStandardMaterial color={TRUCK_COLORS.darkGrey} metalness={0.6} roughness={0.4} />
          </mesh>
        );
      })}
    </group>
  );
}

export function DumpTruckMesh({ state, exhaustIntensity = 0 }: { state: DumpTruckState; exhaustIntensity?: number }) {
  const v = state.vehicle;

  // ── Live per-frame transforms ──
  const rootRef = useRef<THREE.Group>(null!);
  const frontRef = useRef<THREE.Group>(null!);     // articulated front tractor
  const bedRef = useRef<THREE.Group>(null!);       // dump body tilt
  const tailgateRef = useRef<THREE.Group>(null!);
  const wheelRefs = useRef<(THREE.Group | null)[]>([null, null, null, null, null, null]);
  const hingeRamLeftRef = useRef<THREE.Group>(null!);
  const hingeRamRightRef = useRef<THREE.Group>(null!);

  useFrame(() => {
    if (rootRef.current) {
      rootRef.current.position.set(v.posX, v.posY, v.posZ);
      rootRef.current.rotation.set(v.pitch, v.heading, 0);
    }
    // Articulation: front tractor pivots around hinge (at z = +0.0)
    // The whole front section yaws by state.steeringAngle around the hinge.
    if (frontRef.current) {
      frontRef.current.rotation.y = state.steeringAngle;
    }
    if (bedRef.current) bedRef.current.rotation.x = state.bedAngle;
    if (tailgateRef.current) {
      tailgateRef.current.rotation.x = state.tailgateOpen ? -1.05 : 0;
    }
    // Wheel rotation (spin)
    for (let i = 0; i < 6; i++) {
      const w = wheelRefs.current[i];
      if (w) w.rotation.x = state.wheelRotation;
    }
  });

  // Geometry constants — proportions match 460 P-Tier reference photo.
  const tireR = 0.038;
  const tireW = 0.028;
  const hingeZ = 0.0;           // articulation hinge at world-local origin
  const frontAxleZ = 0.14;      // front axle distance ahead of hinge
  const rearAxle1Z = -0.12;     // first rear axle behind hinge
  const rearAxle2Z = -0.20;     // second rear axle (rear bogie)
  const halfTrack = 0.075;      // wheel half-spacing

  // Suspension Y (negative = compressed). Indices: 0 FL, 1 FR, 2 M-L, 3 M-R, 4 R-L, 5 R-R
  // Use first 2 entries of state.suspensionCompression for front, blend for rear bogie.
  const sFL = -state.suspensionCompression[0];
  const sFR = -state.suspensionCompression[1];
  const sRL = -state.suspensionCompression[2];
  const sRR = -state.suspensionCompression[3];

  const dFront = (state.tireDeflection[0] + state.tireDeflection[1]) * 0.5;
  const dRear = (state.tireDeflection[2] + state.tireDeflection[3]) * 0.5;

  // Hinge ram length: extends/retracts based on articulation angle
  const ramExtend = state.steeringAngle * 0.025;

  return (
    <group ref={rootRef}>
      {/* ═══════════ REAR SECTION (dump body chassis) ═══════════ */}
      <group position={[0, 0, 0]}>
        {/* Rear chassis longerons */}
        <mesh position={[0, tireR + 0.005, -0.16]}>
          <boxGeometry args={[0.135, 0.020, 0.22]} />
          <meshStandardMaterial color={TRUCK_COLORS.underframe} metalness={0.6} roughness={0.55} />
        </mesh>
        {/* Subframe yellow strip */}
        <mesh position={[0, tireR + 0.018, -0.16]}>
          <boxGeometry args={[0.14, 0.008, 0.215]} />
          <meshStandardMaterial color={TRUCK_COLORS.jdYellow} metalness={0.35} roughness={0.55} />
        </mesh>

        {/* Dump body (pivots at rear pivot point near tailgate) */}
        <group position={[0, tireR + 0.03, -0.18]}>
          <group ref={bedRef} position={[0, 0, 0.10]}>
            <group position={[0, 0, -0.10]}>
              {/* Floor */}
              <mesh position={[0, 0.005, 0]}>
                <boxGeometry args={[0.155, 0.010, 0.26]} />
                <meshStandardMaterial color={TRUCK_COLORS.jdYellowDeep} metalness={0.4} roughness={0.5} />
              </mesh>
              {/* Side walls (sloped outward at top — classic ADT) */}
              <mesh position={[-0.080, 0.045, 0]} rotation={[0, 0, -0.18]}>
                <boxGeometry args={[0.008, 0.085, 0.26]} />
                <meshStandardMaterial color={TRUCK_COLORS.jdYellow} metalness={0.35} roughness={0.55} />
              </mesh>
              <mesh position={[0.080, 0.045, 0]} rotation={[0, 0, 0.18]}>
                <boxGeometry args={[0.008, 0.085, 0.26]} />
                <meshStandardMaterial color={TRUCK_COLORS.jdYellow} metalness={0.35} roughness={0.55} />
              </mesh>
              {/* Front headboard (high cab guard) */}
              <mesh position={[0, 0.065, 0.130]}>
                <boxGeometry args={[0.165, 0.13, 0.010]} />
                <meshStandardMaterial color={TRUCK_COLORS.jdYellow} metalness={0.35} roughness={0.55} />
              </mesh>
              {/* John Deere logo plate on headboard back */}
              <mesh position={[0, 0.08, 0.136]}>
                <boxGeometry args={[0.045, 0.022, 0.001]} />
                <meshStandardMaterial color={TRUCK_COLORS.jdGreen} metalness={0.3} roughness={0.6} />
              </mesh>
              {/* Tailgate (hinged at top of rear) */}
              <group position={[0, 0.085, -0.13]} ref={tailgateRef}>
                <mesh position={[0, -0.045, 0]}>
                  <boxGeometry args={[0.155, 0.09, 0.008]} />
                  <meshStandardMaterial color={TRUCK_COLORS.jdYellow} metalness={0.35} roughness={0.55} />
                </mesh>
              </group>
              {/* Payload */}
              {state.bedLoad > 0.02 && (
                <mesh position={[0, 0.025 + state.bedLoad * 0.025, 0]}>
                  <boxGeometry args={[0.135, 0.012 + state.bedLoad * 0.050, 0.22]} />
                  <meshStandardMaterial color="#6b5a3d" roughness={0.96} />
                </mesh>
              )}
            </group>
          </group>
        </group>

        {/* Hoist hydraulics (two big rams under bed front) */}
        <HydraulicCylinder
          start={[-0.030, tireR + 0.025, -0.05]}
          end={[-0.030, tireR + 0.045 + Math.sin(state.bedAngle) * 0.04, -0.18]}
          bodyRadius={0.006} rodRadius={0.004}
          pressure={state.bedAngle > 0.02 ? 0.9 : 0.15}
        />
        <HydraulicCylinder
          start={[0.030, tireR + 0.025, -0.05]}
          end={[0.030, tireR + 0.045 + Math.sin(state.bedAngle) * 0.04, -0.18]}
          bodyRadius={0.006} rodRadius={0.004}
          pressure={state.bedAngle > 0.02 ? 0.9 : 0.15}
        />

        {/* Rear bogie axles (twin) */}
        <mesh position={[0, tireR * 0.55, rearAxle1Z]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.012, 0.012, halfTrack * 2.15, 12]} />
          <meshStandardMaterial color={TRUCK_COLORS.steelGrey} metalness={0.7} roughness={0.45} />
        </mesh>
        <mesh position={[0, tireR * 0.55, rearAxle2Z]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.012, 0.012, halfTrack * 2.15, 12]} />
          <meshStandardMaterial color={TRUCK_COLORS.steelGrey} metalness={0.7} roughness={0.45} />
        </mesh>

        {/* Rear wheels: 4 (two on each side, twin bogie) */}
        {([
          [-halfTrack, sRL, rearAxle1Z, 2],
          [ halfTrack, sRR, rearAxle1Z, 3],
          [-halfTrack, sRL, rearAxle2Z, 4],
          [ halfTrack, sRR, rearAxle2Z, 5],
        ] as const).map(([x, dy, z, idx]) => (
          <group key={`rw${idx}`}
            ref={(g) => { wheelRefs.current[idx] = g; }}
            position={[x, tireR * 0.55 + dy, z]}
          >
            <HeavyDutyTire radius={tireR} width={tireW} deflection={dRear} rotation={state.wheelRotation} />
          </group>
        ))}
      </group>

      {/* ═══════════ HINGE — Articulation joint ═══════════ */}
      {/* Vertical pivot pin between rear chassis and front tractor */}
      <mesh position={[0, tireR + 0.025, hingeZ]}>
        <cylinderGeometry args={[0.014, 0.014, 0.07, 12]} />
        <meshStandardMaterial color={TRUCK_COLORS.darkGrey} metalness={0.75} roughness={0.35} />
      </mesh>
      {/* Hinge plate */}
      <mesh position={[0, tireR + 0.012, hingeZ]}>
        <boxGeometry args={[0.085, 0.012, 0.045]} />
        <meshStandardMaterial color={TRUCK_COLORS.steelGrey} metalness={0.7} roughness={0.45} />
      </mesh>

      {/* Steering hydraulic rams (cross from rear to front, one each side).
          These visibly extend/retract as articulation changes. */}
      <group>
        {/* Left ram: rear-left to front-right via crossover */}
        <HydraulicCylinder
          start={[-0.045, tireR + 0.015, -0.035]}
          end={[
            -0.025 + Math.sin(state.steeringAngle) * 0.06 + ramExtend,
            tireR + 0.015,
            0.05 + Math.cos(state.steeringAngle) * 0.005,
          ]}
          bodyRadius={0.006} rodRadius={0.004}
          pressure={Math.abs(state.steeringAngle) > 0.03 ? 0.85 : 0.25}
        />
        <HydraulicCylinder
          start={[0.045, tireR + 0.015, -0.035]}
          end={[
            0.025 + Math.sin(state.steeringAngle) * 0.06 - ramExtend,
            tireR + 0.015,
            0.05 + Math.cos(state.steeringAngle) * 0.005,
          ]}
          bodyRadius={0.006} rodRadius={0.004}
          pressure={Math.abs(state.steeringAngle) > 0.03 ? 0.85 : 0.25}
        />
      </group>

      {/* ═══════════ FRONT SECTION (tractor / cab) — articulates ═══════════ */}
      <group ref={frontRef} position={[0, 0, hingeZ]}>
        {/* Front chassis main beam */}
        <mesh position={[0, tireR + 0.005, 0.10]}>
          <boxGeometry args={[0.105, 0.022, 0.20]} />
          <meshStandardMaterial color={TRUCK_COLORS.underframe} metalness={0.6} roughness={0.55} />
        </mesh>
        {/* Yellow side fender skirt */}
        <mesh position={[0, tireR + 0.028, 0.10]}>
          <boxGeometry args={[0.155, 0.015, 0.21]} />
          <meshStandardMaterial color={TRUCK_COLORS.jdYellow} metalness={0.35} roughness={0.55} />
        </mesh>

        {/* Engine hood (sloped — flat top, sloped front) */}
        <mesh position={[0, tireR + 0.060, 0.180]}>
          <boxGeometry args={[0.12, 0.060, 0.085]} />
          <meshStandardMaterial color={TRUCK_COLORS.jdYellow} metalness={0.35} roughness={0.55} />
        </mesh>
        {/* Hood front grille area (dark plastic) */}
        <mesh position={[0, tireR + 0.040, 0.225]}>
          <boxGeometry args={[0.10, 0.038, 0.005]} />
          <meshStandardMaterial color={TRUCK_COLORS.darkGrey} metalness={0.5} roughness={0.55} />
        </mesh>
        {/* Radiator grille bars */}
        {Array.from({ length: 5 }).map((_, i) => (
          <mesh key={`gb${i}`} position={[0, tireR + 0.025 + i * 0.008, 0.228]}>
            <boxGeometry args={[0.092, 0.0025, 0.003]} />
            <meshStandardMaterial color={TRUCK_COLORS.chrome} metalness={0.75} roughness={0.3} />
          </mesh>
        ))}
        {/* Headlights */}
        <mesh position={[-0.045, tireR + 0.058, 0.227]}>
          <boxGeometry args={[0.018, 0.014, 0.004]} />
          <meshStandardMaterial color="#ffefb0" emissive="#ffd770" emissiveIntensity={0.4} metalness={0.4} roughness={0.2} />
        </mesh>
        <mesh position={[0.045, tireR + 0.058, 0.227]}>
          <boxGeometry args={[0.018, 0.014, 0.004]} />
          <meshStandardMaterial color="#ffefb0" emissive="#ffd770" emissiveIntensity={0.4} metalness={0.4} roughness={0.2} />
        </mesh>
        {/* "DEERE 460" plate */}
        <mesh position={[0, tireR + 0.080, 0.225]}>
          <boxGeometry args={[0.06, 0.012, 0.002]} />
          <meshStandardMaterial color={TRUCK_COLORS.jdGreen} roughness={0.55} />
        </mesh>

        {/* Cab body */}
        <mesh position={[0, tireR + 0.085, 0.075]}>
          <boxGeometry args={[0.115, 0.080, 0.090]} />
          <meshStandardMaterial color={TRUCK_COLORS.jdYellow} metalness={0.35} roughness={0.55} />
        </mesh>
        {/* Cab roof */}
        <mesh position={[0, tireR + 0.130, 0.080]}>
          <boxGeometry args={[0.122, 0.008, 0.095]} />
          <meshStandardMaterial color={TRUCK_COLORS.jdYellowDeep} metalness={0.35} roughness={0.55} />
        </mesh>
        {/* Windshield */}
        <mesh position={[0, tireR + 0.105, 0.122]} rotation={[0.18, 0, 0]}>
          <boxGeometry args={[0.095, 0.045, 0.003]} />
          <meshStandardMaterial color={TRUCK_COLORS.glass} metalness={0.2} roughness={0.05} transparent opacity={0.78} />
        </mesh>
        {/* Side windows */}
        <mesh position={[-0.060, 0.10 + tireR, 0.078]}>
          <boxGeometry args={[0.003, 0.044, 0.062]} />
          <meshStandardMaterial color={TRUCK_COLORS.glass} metalness={0.2} roughness={0.05} transparent opacity={0.72} />
        </mesh>
        <mesh position={[0.060, 0.10 + tireR, 0.078]}>
          <boxGeometry args={[0.003, 0.044, 0.062]} />
          <meshStandardMaterial color={TRUCK_COLORS.glass} metalness={0.2} roughness={0.05} transparent opacity={0.72} />
        </mesh>
        {/* Rear window of cab */}
        <mesh position={[0, tireR + 0.105, 0.030]}>
          <boxGeometry args={[0.090, 0.045, 0.003]} />
          <meshStandardMaterial color={TRUCK_COLORS.glass} metalness={0.2} roughness={0.05} transparent opacity={0.72} />
        </mesh>
        {/* Mirrors */}
        {[-0.072, 0.072].map((x, i) => (
          <group key={`mir${i}`}>
            <mesh position={[x, tireR + 0.110, 0.118]}>
              <boxGeometry args={[0.004, 0.002, 0.040]} />
              <meshStandardMaterial color={TRUCK_COLORS.darkGrey} />
            </mesh>
            <mesh position={[x * 1.25, tireR + 0.105, 0.135]}>
              <boxGeometry args={[0.016, 0.022, 0.004]} />
              <meshStandardMaterial color={TRUCK_COLORS.darkGrey} metalness={0.4} roughness={0.5} />
            </mesh>
          </group>
        ))}

        {/* Exhaust stack (right rear of cab) */}
        <mesh position={[0.052, tireR + 0.155, 0.045]}>
          <cylinderGeometry args={[0.0048, 0.0048, 0.075, 10]} />
          <meshStandardMaterial color={TRUCK_COLORS.darkGrey} metalness={0.65} roughness={0.45} />
        </mesh>
        <mesh position={[0.052, tireR + 0.196, 0.045]}>
          <cylinderGeometry args={[0.0065, 0.0065, 0.004, 10]} />
          <meshStandardMaterial color={TRUCK_COLORS.darkGrey} metalness={0.65} roughness={0.45} />
        </mesh>
        <ExhaustSmoke origin={[0.052, tireR + 0.210, 0.045]} intensity={exhaustIntensity} />

        {/* Front axle */}
        <mesh position={[0, tireR * 0.55, frontAxleZ]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.013, 0.013, halfTrack * 2.20, 12]} />
          <meshStandardMaterial color={TRUCK_COLORS.steelGrey} metalness={0.7} roughness={0.45} />
        </mesh>

        {/* Front mudflaps */}
        <mesh position={[-halfTrack, tireR + 0.005, frontAxleZ - 0.05]}>
          <boxGeometry args={[0.005, 0.040, 0.025]} />
          <meshStandardMaterial color={TRUCK_COLORS.darkGrey} roughness={0.9} />
        </mesh>
        <mesh position={[halfTrack, tireR + 0.005, frontAxleZ - 0.05]}>
          <boxGeometry args={[0.005, 0.040, 0.025]} />
          <meshStandardMaterial color={TRUCK_COLORS.darkGrey} roughness={0.9} />
        </mesh>

        {/* Front wheels (2) */}
        {([
          [-halfTrack, sFL, frontAxleZ, 0],
          [ halfTrack, sFR, frontAxleZ, 1],
        ] as const).map(([x, dy, z, idx]) => (
          <group key={`fw${idx}`}
            ref={(g) => { wheelRefs.current[idx] = g; }}
            position={[x, tireR * 0.55 + dy, z]}
          >
            <HeavyDutyTire radius={tireR} width={tireW} deflection={dFront} rotation={state.wheelRotation} />
          </group>
        ))}
      </group>
    </group>
  );
}
