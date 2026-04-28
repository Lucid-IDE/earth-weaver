import { memo, useRef, useEffect, useCallback, useMemo, useState } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, ThreeEvent, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { VoxelField } from '@/lib/soil/VoxelField';
import { SoilSimulator } from '@/lib/soil/soilSim';
import { soilVertexShader, soilFragmentShader } from '@/lib/soil/soilShader';
import { DIG_RADIUS } from '@/lib/soil/constants';
import { getMaterialAt } from '@/lib/soil/materialBrain';
import { mpmToWorld, setSpawnSeed } from '@/lib/mpm/bridge';
import { mpmHealth } from '@/lib/mpm/mpmHealth';
import { triggerAutoCapture } from '@/lib/analyst/autoCapture';
import {
  dustVertexShader,
  dustFragmentShader,
} from '@/lib/rendering/dirtShaders';
import {
  fullscreenQuadVertexShader,
  bilateralFilterFragmentShader,
  fluidCompositingFragmentShader,
} from '@/lib/rendering/fluidShaders';

// Equipment
import { EquipmentType, ExcavatorState, BulldozerState } from '@/lib/equipment/types';
import { createExcavatorState, updateExcavator, computeExcavatorFK } from '@/lib/equipment/excavator';
import { createBulldozerState, updateBulldozer } from '@/lib/equipment/bulldozer';
import { initControls, pollControls, getExcavatorInputs, getBulldozerInputs } from '@/lib/equipment/controls';
import { excavatorDig, bulldozerPush, updateVehicleTerrainFollow, initVehicleOnTerrain } from '@/lib/equipment/terrainInteraction';
import { craterImpact, explosiveImpact } from '@/lib/equipment/impacts';
import {
  VehiclePhysicsState, createVehiclePhysics,
  createExcavatorMass, createBulldozerMass,
  updateVehiclePhysics,
} from '@/lib/equipment/vehiclePhysics';
import { getTerramechParams } from '@/lib/equipment/terramechanics';
import { applyChassisTorque } from '@/lib/equipment/rigidBody';
import { ExcavatorMesh, BulldozerMesh } from '@/components/EquipmentRenderer';
import MpmHeatmapOverlay from '@/components/MpmHeatmapOverlay';
import {
  createSpawnDrop, elevateForSpawn, stepSpawnDrop, SpawnDropState,
} from '@/lib/equipment/spawnDrop';
import {
  ensureAudioContext, updateVehicleAudio, playLandingThump,
} from '@/lib/equipment/audio';
import { telemetryBus, TelemetryFrame } from '@/lib/diagnostics/telemetryBus';

export interface SoilStats {
  vertices: number;
  triangles: number;
  simActive: boolean;
  activeParticles: number;
  totalParticles: number;
}

export interface EquipmentStats {
  activeEquipment: EquipmentType;
  excavator: ExcavatorState;
  bulldozer: BulldozerState;
  impactMode: string | null;
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
  [0.76, 0.70, 0.50],
  [0.52, 0.36, 0.24],
  [0.65, 0.55, 0.40],
  [0.28, 0.22, 0.14],
  [0.58, 0.56, 0.52],
  [0.48, 0.40, 0.30],
  [0.60, 0.50, 0.35],
];

// ── Screen-Space Fluid Renderer ─────────────────────────────────────
function FluidRenderer({ simRef }: { simRef: React.MutableRefObject<SoilSimulator | null> }) {
  const MAX_PARTICLES_RENDER = 32768;
  const RENDER_SCALE = 0.5;
  const { gl, camera, size } = useThree();
  
  const resources = useMemo(() => {
    const w = Math.max(Math.floor(size.width * RENDER_SCALE), 1);
    const h = Math.max(Math.floor(size.height * RENDER_SCALE), 1);
    
    const depthTarget = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat, type: THREE.FloatType, depthBuffer: true,
    });
    const filterTargetH = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, type: THREE.FloatType,
    });
    const filterTargetV = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, type: THREE.FloatType,
    });
    
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
    
    const pointsDepthMat = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `
        attribute vec4 instanceColor;
        attribute float instanceRadius;
        varying vec3 vViewPosition;
        varying float vRadius;
        varying vec3 vColor;
        varying mat4 vProjMatrix;
        void main() {
            vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
            vViewPosition = mvPosition.xyz;
            vColor = instanceColor.rgb;
            vRadius = instanceRadius;
            vProjMatrix = projectionMatrix;
            float screenRadius = instanceRadius * (800.0 / length(mvPosition.xyz));
            gl_PointSize = max(screenRadius, 1.0);
            gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vViewPosition;
        varying float vRadius;
        varying vec3 vColor;
        varying mat4 vProjMatrix;
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
            vec4 clipPos = vProjMatrix * vec4(vViewPosition.xy, depth, 1.0);
            float ndc = clipPos.z / clipPos.w;
            gl_FragDepth = (ndc + 1.0) * 0.5;
        }
      `,
      uniforms: { near: { value: 0.005 }, far: { value: 10.0 } },
      depthTest: true, depthWrite: true,
    });
    
    const pointsMesh = new THREE.Points(pointsGeo, pointsDepthMat);
    pointsMesh.frustumCulled = false;
    
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
      depthTest: false, depthWrite: false,
    });
    
    const compositeMat = new THREE.ShaderMaterial({
      vertexShader: fullscreenQuadVertexShader,
      fragmentShader: fluidCompositingFragmentShader,
      uniforms: {
        smoothedDepthTexture: { value: null },
        resolution: { value: new THREE.Vector2(w, h) },
        near: { value: 0.005 }, far: { value: 10.0 },
        invProjectionMatrix: { value: new THREE.Matrix4() },
      },
      depthTest: false, depthWrite: false,
      transparent: true, blending: THREE.NormalBlending,
    });
    
    const filterScene = new THREE.Scene();
    filterScene.add(new THREE.Mesh(quadGeo, filterMat));
    const compositeScene = new THREE.Scene();
    compositeScene.add(new THREE.Mesh(quadGeo, compositeMat));
    const orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const depthScene = new THREE.Scene();
    depthScene.add(pointsMesh);
    
    return {
      depthTarget, filterTargetH, filterTargetV,
      pointsGeo, pointsMesh, pointsDepthMat,
      filterMat, compositeMat,
      filterScene, compositeScene, depthScene,
      orthoCamera, pPositions, pColors, pRadii,
    };
  }, []);
  
  useEffect(() => {
    const w = Math.max(Math.floor(size.width * RENDER_SCALE), 1);
    const h = Math.max(Math.floor(size.height * RENDER_SCALE), 1);
    resources.depthTarget.setSize(w, h);
    resources.filterTargetH.setSize(w, h);
    resources.filterTargetV.setSize(w, h);
    resources.filterMat.uniforms.resolution.value.set(w, h);
    resources.compositeMat.uniforms.resolution.value.set(w, h);
  }, [size.width, size.height, resources]);
  
  const particleRng = useMemo(() => {
    const rng = mulberry32(42);
    const data = new Float32Array(131072 * 2);
    for (let i = 0; i < 131072; i++) {
      data[i*2] = 0.003 + rng() * 0.005;
      data[i*2+1] = (rng() - 0.5) * 0.06;
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
      pPositions[count*3] = wx;
      pPositions[count*3+1] = wy;
      pPositions[count*3+2] = wz;
      const rOff = (i % 131072) * 2;
      pRadii[count] = particleRng[rOff];
      const matType = Math.min(mpm.materialType[i], 6);
      const base = MATERIAL_BASE_COLORS[matType];
      const moisture = mpm.moisture ? mpm.moisture[i] : 0;
      const depthFactor = Math.max(0, Math.min(1, (-wy - 0.05) * 3.0));
      const darken = (1.0 - depthFactor * 0.25) * (1 - moisture * 0.35);
      const jitter = particleRng[rOff + 1];
      const surfaceProximity = 1.0 - Math.min(1, Math.max(0, (-wy + 0.02) / 0.14));
      const organicMix = surfaceProximity * 0.45;
      pColors[count*4] = Math.max(0, Math.min(1, (base[0]*(1-organicMix) + 0.22*organicMix)*darken + jitter));
      pColors[count*4+1] = Math.max(0, Math.min(1, (base[1]*(1-organicMix) + 0.18*organicMix)*darken + jitter*0.8));
      pColors[count*4+2] = Math.max(0, Math.min(1, (base[2]*(1-organicMix) + 0.10*organicMix)*darken + jitter*0.6));
      pColors[count*4+3] = 1.0;
      count++;
    }
    
    pointsGeo.setDrawRange(0, count);
    (pointsGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (pointsGeo.attributes.instanceColor as THREE.BufferAttribute).needsUpdate = true;
    (pointsGeo.attributes.instanceRadius as THREE.BufferAttribute).needsUpdate = true;
    
    if (count === 0) return;
    
    const currentRT = gl.getRenderTarget();
    const currentAutoClear = gl.autoClear;
    gl.autoClear = false;
    
    gl.setRenderTarget(resources.depthTarget);
    gl.clearColor(); gl.clearDepth();
    gl.render(resources.depthScene, camera);
    
    resources.filterMat.uniforms.depthTexture.value = resources.depthTarget.texture;
    resources.filterMat.uniforms.filterDirection.value.set(1, 0);
    gl.setRenderTarget(resources.filterTargetH);
    gl.clearColor();
    gl.render(resources.filterScene, resources.orthoCamera);
    
    resources.filterMat.uniforms.depthTexture.value = resources.filterTargetH.texture;
    resources.filterMat.uniforms.filterDirection.value.set(0, 1);
    gl.setRenderTarget(resources.filterTargetV);
    gl.clearColor();
    gl.render(resources.filterScene, resources.orthoCamera);
    
    resources.compositeMat.uniforms.smoothedDepthTexture.value = resources.filterTargetV.texture;
    resources.compositeMat.uniforms.invProjectionMatrix.value.copy(camera.projectionMatrixInverse);
    
    gl.setRenderTarget(currentRT);
    gl.autoClear = currentAutoClear;
    gl.render(resources.compositeScene, resources.orthoCamera);
  });
  
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
  
  return null;
}

// ── Dust Particle System ────────────────────────────────────────────
function DustCloud({ simRef }: { simRef: React.MutableRefObject<SoilSimulator | null> }) {
  const MAX_DUST = 2048;
  const dustState = useMemo(() => ({
    px: new Float32Array(MAX_DUST), py: new Float32Array(MAX_DUST), pz: new Float32Array(MAX_DUST),
    vx: new Float32Array(MAX_DUST), vy: new Float32Array(MAX_DUST), vz: new Float32Array(MAX_DUST),
    life: new Float32Array(MAX_DUST), scale: new Float32Array(MAX_DUST),
    count: 0, lastParticleCount: 0,
  }), []);
  
  const { geometry, material } = useMemo(() => {
    const geo = new THREE.InstancedBufferGeometry();
    const vertices = new Float32Array([-1,-1,0,1,-1,0,1,1,0,-1,-1,0,1,1,0,-1,1,0]);
    const uvs = new Float32Array([0,0,1,0,1,1,0,0,1,1,0,1]);
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
      vertexShader: dustVertexShader, fragmentShader: dustFragmentShader,
      transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
    });
    return { geometry: geo, material: mat };
  }, []);
  
  const rng = useMemo(() => mulberry32(9999), []);
  
  useFrame((_, dt) => {
    const sim = simRef.current;
    if (!sim) return;
    const mpm = sim.mpm;
    const ds = dustState;
    
    const currentCount = mpm.numParticles;
    if (currentCount > ds.lastParticleCount + 10) {
      const newCount = currentCount - ds.lastParticleCount;
      const spawnCount = Math.min(newCount * 2, 200);
      for (let s = 0; s < spawnCount && ds.count < MAX_DUST; s++) {
        const srcIdx = ds.lastParticleCount + Math.floor(rng() * newCount);
        if (srcIdx >= currentCount) continue;
        const [wx, wy, wz] = mpmToWorld(mpm.px[srcIdx], mpm.py[srcIdx], mpm.pz[srcIdx]);
        const di = ds.count % MAX_DUST;
        ds.px[di] = wx + (rng()-0.5)*0.04;
        ds.py[di] = wy + (rng()-0.5)*0.04;
        ds.pz[di] = wz + (rng()-0.5)*0.04;
        ds.vx[di] = (rng()-0.5)*0.15;
        ds.vy[di] = rng()*0.2 + 0.05;
        ds.vz[di] = (rng()-0.5)*0.15;
        ds.life[di] = 1.0;
        ds.scale[di] = 0.005 + rng()*0.015;
        ds.count = Math.min(ds.count + 1, MAX_DUST);
      }
    }
    ds.lastParticleCount = currentCount;
    
    const sampleStride = Math.max(1, Math.floor(mpm.numParticles / 768));
    for (let i = 0; i < mpm.numParticles; i += sampleStride) {
      if (!mpm.active[i]) continue;
      const speed = Math.sqrt(mpm.vx[i]**2 + mpm.vy[i]**2 + mpm.vz[i]**2);
      if (speed > 0.3 && rng() < 0.05) {
        const [wx, wy, wz] = mpmToWorld(mpm.px[i], mpm.py[i], mpm.pz[i]);
        const di = ds.count % MAX_DUST;
        ds.px[di] = wx; ds.py[di] = wy; ds.pz[di] = wz;
        ds.vx[di] = (rng()-0.5)*0.08;
        ds.vy[di] = rng()*0.1 + 0.02;
        ds.vz[di] = (rng()-0.5)*0.08;
        ds.life[di] = 0.7 + rng()*0.3;
        ds.scale[di] = 0.003 + rng()*0.008;
        ds.count = Math.min(ds.count + 1, MAX_DUST);
      }
    }
    
    const posAttr = geometry.getAttribute('instancePosition') as THREE.InstancedBufferAttribute;
    const alphaAttr = geometry.getAttribute('instanceAlpha') as THREE.InstancedBufferAttribute;
    const scaleAttr = geometry.getAttribute('instanceScale') as THREE.InstancedBufferAttribute;
    const clampedDt = Math.min(dt, 0.033);
    let visibleCount = 0;
    
    for (let i = 0; i < ds.count; i++) {
      if (ds.life[i] <= 0) continue;
      ds.px[i] += ds.vx[i] * clampedDt;
      ds.py[i] += ds.vy[i] * clampedDt;
      ds.pz[i] += ds.vz[i] * clampedDt;
      ds.vy[i] -= 0.3 * clampedDt;
      ds.vx[i] *= 0.98; ds.vz[i] *= 0.98;
      ds.life[i] -= clampedDt * 0.8;
      if (ds.life[i] <= 0) continue;
      posAttr.setXYZ(visibleCount, ds.px[i], ds.py[i], ds.pz[i]);
      alphaAttr.setX(visibleCount, ds.life[i]);
      scaleAttr.setX(visibleCount, ds.scale[i] * (1.0 + (1.0 - ds.life[i]) * 2.0));
      visibleCount++;
    }
    
    geometry.instanceCount = visibleCount;
    posAttr.needsUpdate = true;
    alphaAttr.needsUpdate = true;
    scaleAttr.needsUpdate = true;
  });
  
  return <mesh geometry={geometry} material={material} frustumCulled={false} />;
}

// ── Equipment Controller (inside Canvas) ────────────────────────────
function EquipmentController({
  fieldRef, simRef, rebuildMesh,
  equipmentState,
}: {
  fieldRef: React.MutableRefObject<VoxelField | null>;
  simRef: React.MutableRefObject<SoilSimulator | null>;
  rebuildMesh: () => void;
  equipmentState: React.MutableRefObject<{
    activeEquipment: EquipmentType;
    excavator: ExcavatorState;
    bulldozer: BulldozerState;
    impactMode: string | null;
    excPhysics: VehiclePhysicsState;
    dozPhysics: VehiclePhysicsState;
    excDrop: SpawnDropState;
    dozDrop: SpawnDropState;
  }>;
}) {
  useEffect(() => { initControls(); }, []);

  // Unlock audio on first user interaction (browsers require gesture).
  useEffect(() => {
    const unlock = () => { ensureAudioContext(); };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);
  
  useFrame((_, dt) => {
    const field = fieldRef.current;
    const sim = simRef.current;
    if (!field || !sim) return;
    
    const ctrl = pollControls();
    const es = equipmentState.current;
    
    // Equipment switching
    if (ctrl.switchToExcavator) es.activeEquipment = 'excavator';
    if (ctrl.switchToBulldozer) es.activeEquipment = 'bulldozer';
    if (ctrl.switchToFreeCamera) es.activeEquipment = 'none';
    
    const clampedDt = Math.min(dt, 0.033);

    let terrainChanged = false;

    // ── Spawn-drop: gravity-fall vehicles before any terrain-follow runs ──
    const excFalling = stepSpawnDrop(
      es.excDrop, es.excavator.vehicle, es.excPhysics.rigidBody,
      field, sim, 0.014, es.excPhysics.mass.mass, clampedDt,
    );
    const dozFalling = stepSpawnDrop(
      es.dozDrop, es.bulldozer.vehicle, es.dozPhysics.rigidBody,
      field, sim, 0.016, es.dozPhysics.mass.mass, clampedDt,
    );
    if (es.excDrop.landed && es.excDrop.landed) terrainChanged = true;

    // Soil terramechanics + softness at vehicle position
    const getSoilContext = (veh: { posX: number; posZ: number }) => {
      const mat = getMaterialAt(veh.posX, 0, veh.posZ);
      const softness = mat.moisture * 0.6 + (1 - mat.frictionAngle / (45 * 0.0174533)) * 0.4;
      const params = getTerramechParams(mat.frictionAngle, mat.cohesion, mat.moisture);
      return { softness, params };
    };
    
    if (es.activeEquipment === 'excavator') {
      const inputs = getExcavatorInputs(ctrl);

      const armDemand = Math.min(1,
        Math.abs(inputs.boomInput) * 0.4 +
        Math.abs(inputs.stickInput) * 0.3 +
        Math.abs(inputs.bucketInput) * 0.2 +
        Math.abs(inputs.swingInput) * 0.15
      );

      const excCtx = getSoilContext(es.excavator.vehicle);
      updateVehiclePhysics(
        es.excPhysics, es.excavator.vehicle,
        inputs.leftTrack, inputs.rightTrack,
        armDemand,
        excCtx.softness,
        clampedDt,
        excCtx.params,
      );

      updateExcavator(es.excavator, clampedDt, inputs, es.excPhysics.hydraulics);

      if (!excFalling) {
        updateVehicleTerrainFollow(es.excavator.vehicle, field, clampedDt, {
          trackWidth: 0.082, trackLength: 0.16, rideHeight: 0.014,
          loadFactor: 0.95 + es.excavator.bucketFill * 0.3,
          followSharpness: 0.55, maxDropSpeed: 0.6,
        });
      }

      if (!dozFalling) {
        updateVehicleTerrainFollow(es.bulldozer.vehicle, field, clampedDt, {
          trackWidth: 0.105, trackLength: 0.20, rideHeight: 0.016,
          loadFactor: 1.2, allowTrackMarks: false,
        });
      }

      // Dig/scoop/drop with chassis force feedback
      const armActive = Math.abs(inputs.boomInput) + Math.abs(inputs.stickInput) + Math.abs(inputs.bucketInput) > 0.01;
      if (armActive || es.excavator.bucketFill > 0.01) {
        const dig = excavatorDig(es.excavator, field, sim, {
          bucketInput: inputs.bucketInput, dt: clampedDt,
        });
        if (dig.changed) terrainChanged = true;
        if (dig.reactionForce > 0) {
          // Bucket pushes back on cab → forward pitch (nose dips)
          // Magnitude proportional to arm extension (longer lever = more torque)
          const fk = computeExcavatorFK(es.excavator);
          const lever = Math.hypot(fk.bucketTip[0] - es.excavator.vehicle.posX,
                                   fk.bucketTip[2] - es.excavator.vehicle.posZ);
          applyChassisTorque(es.excPhysics.rigidBody, dig.reactionForce * lever * 0.8);
        }
        // Heavy bucket lift: extra rear-down torque from boom up command
        if (inputs.boomInput > 0 && es.excavator.bucketFill > 0.05) {
          applyChassisTorque(es.excPhysics.rigidBody,
            -inputs.boomInput * es.excavator.bucketFill * 1.6);
        }
      }
    }

    if (es.activeEquipment === 'bulldozer') {
      const inputs = getBulldozerInputs(ctrl);

      const bladeDemand = Math.min(1,
        Math.abs(inputs.bladeUp) * 0.5 +
        Math.abs(inputs.bladeTiltInput) * 0.2 +
        Math.abs(inputs.bladeAngleInput) * 0.15
      );

      const dozCtx = getSoilContext(es.bulldozer.vehicle);
      updateVehiclePhysics(
        es.dozPhysics, es.bulldozer.vehicle,
        inputs.leftTrack, inputs.rightTrack,
        bladeDemand,
        dozCtx.softness,
        clampedDt,
        dozCtx.params,
      );

      updateBulldozer(es.bulldozer, clampedDt, inputs, es.dozPhysics.hydraulics);

      if (!dozFalling) {
        updateVehicleTerrainFollow(es.bulldozer.vehicle, field, clampedDt, {
          trackWidth: 0.105, trackLength: 0.20, rideHeight: 0.016,
          loadFactor: 1.2, followSharpness: 0.50, maxDropSpeed: 0.5,
        });
      }

      if (!excFalling) {
        updateVehicleTerrainFollow(es.excavator.vehicle, field, clampedDt, {
          trackWidth: 0.082, trackLength: 0.16, rideHeight: 0.014,
          loadFactor: 0.95, allowTrackMarks: false,
        });
      }

      const isMoving = Math.abs(es.dozPhysics.forwardVelocity) > 0.002;
      const bladeEngaged = es.bulldozer.bladeHeight < 0.03;
      if (isMoving && bladeEngaged) {
        const push = bulldozerPush(es.bulldozer, field, sim);
        if (push.changed) terrainChanged = true;
        if (push.reactionForce > 0) {
          // Blade pushes back → nose-up pitch (rear digs in)
          applyChassisTorque(es.dozPhysics.rigidBody, -push.reactionForce * 0.6);
        }
      }
    }

    // Overlay rigid-body dynamic pitch on top of terrain-following pitch
    es.excavator.vehicle.pitch += es.excPhysics.rigidBody.pitchAccum;
    es.bulldozer.vehicle.pitch += es.dozPhysics.rigidBody.pitchAccum;

    if (es.activeEquipment === 'none') {
      if (!excFalling) {
        updateVehicleTerrainFollow(es.excavator.vehicle, field, clampedDt, {
          trackWidth: 0.082, trackLength: 0.16, rideHeight: 0.014,
          loadFactor: 0.95, allowTrackMarks: false,
        });
      }
      if (!dozFalling) {
        updateVehicleTerrainFollow(es.bulldozer.vehicle, field, clampedDt, {
          trackWidth: 0.105, trackLength: 0.20, rideHeight: 0.016,
          loadFactor: 1.2, allowTrackMarks: false,
        });
      }
    }

    // ── Audio: drive synthesis from physics state every frame ──
    const excEng = es.excPhysics.engine;
    const excHyd = es.excPhysics.hydraulics;
    updateVehicleAudio('excavator', {
      rpm: excEng.rpm, maxRpm: excEng.maxRpm, throttle: excEng.throttle,
      lugging: excEng.lugging, stalled: excEng.stalled,
      hydPressure: excHyd.pressure, hydFlow: excHyd.flowRate, reliefOpen: excHyd.reliefOpen,
      trackSpeed: (Math.abs(es.excavator.vehicle.tracks.leftSpeed) + Math.abs(es.excavator.vehicle.tracks.rightSpeed)) * 0.5,
      slip: es.excPhysics.slipAmount,
      active: es.activeEquipment === 'excavator',
    });
    const dozEng = es.dozPhysics.engine;
    const dozHyd = es.dozPhysics.hydraulics;
    updateVehicleAudio('bulldozer', {
      rpm: dozEng.rpm, maxRpm: dozEng.maxRpm, throttle: dozEng.throttle,
      lugging: dozEng.lugging, stalled: dozEng.stalled,
      hydPressure: dozHyd.pressure, hydFlow: dozHyd.flowRate, reliefOpen: dozHyd.reliefOpen,
      trackSpeed: (Math.abs(es.bulldozer.vehicle.tracks.leftSpeed) + Math.abs(es.bulldozer.vehicle.tracks.rightSpeed)) * 0.5,
      slip: es.dozPhysics.slipAmount,
      active: es.activeEquipment === 'bulldozer',
    });

    if (terrainChanged) {
      rebuildMesh();
    }
    
    // Impact triggers
    if (ctrl.triggerImpact) {
      let pos: [number, number, number] = [0, 0, 0];
      if (es.activeEquipment === 'excavator') {
        const fk = computeExcavatorFK(es.excavator);
        pos = fk.bucketTip;
      }
      craterImpact(pos[0], pos[1], pos[2], 0.08, field, sim);
      rebuildMesh();
    }
    
    if (ctrl.triggerExplosion) {
      let pos: [number, number, number] = [0, 0, 0];
      if (es.activeEquipment === 'excavator') {
        const fk = computeExcavatorFK(es.excavator);
        pos = fk.bucketTip;
      }
      explosiveImpact(pos[0], pos[1], pos[2], 0.12, field, sim);
      rebuildMesh();
    }

    // ── Publish telemetry frame (every frame; bus throttles subscribers) ──
    const now = performance.now() / 1000;
    const fps = clampedDt > 0 ? Math.min(120, 1 / clampedDt) : 0;
    const sim2 = simRef.current;
    const exP = es.excPhysics, dzP = es.dozPhysics;
    const exV = es.excavator.vehicle, dzV = es.bulldozer.vehicle;
    const frame: TelemetryFrame = {
      t: now,
      active: es.activeEquipment,
      input: {
        keys: {},
        exc: {
          leftTrack: getExcavatorInputs(ctrl).leftTrack,
          rightTrack: getExcavatorInputs(ctrl).rightTrack,
          swing: (ctrl.swingRight ? 1 : 0) + (ctrl.swingLeft ? -1 : 0),
          boom: (ctrl.boomUp ? 1 : 0) + (ctrl.boomDown ? -1 : 0),
          stick: (ctrl.stickIn ? 1 : 0) + (ctrl.stickOut ? -1 : 0),
          bucket: (ctrl.bucketCurl ? 1 : 0) + (ctrl.bucketDump ? -1 : 0),
        },
        doz: {
          leftTrack: getBulldozerInputs(ctrl).leftTrack,
          rightTrack: getBulldozerInputs(ctrl).rightTrack,
          bladeUp: (ctrl.bladeUp ? 1 : 0) + (ctrl.bladeDown ? -1 : 0),
          bladeTilt: (ctrl.bladeTiltRight ? 1 : 0) + (ctrl.bladeTiltLeft ? -1 : 0),
          bladeAngle: (ctrl.bladeAngleRight ? 1 : 0) + (ctrl.bladeAngleLeft ? -1 : 0),
        },
        events: {
          switchExc: ctrl.switchToExcavator, switchDoz: ctrl.switchToBulldozer,
          switchFree: ctrl.switchToFreeCamera, impact: ctrl.triggerImpact, explosion: ctrl.triggerExplosion,
        },
      },
      exc: {
        rpm: exP.engine.rpm, throttle: exP.engine.throttle, engineTorque: exP.engine.torque,
        engineStalled: exP.engine.stalled, engineLugging: exP.engine.lugging,
        hydPressure: exP.hydraulics.pressure, hydFlow: exP.hydraulics.flowRate, reliefOpen: exP.hydraulics.reliefOpen,
        leftDriveTorque: exP.drivetrain.leftDriveTorque, rightDriveTorque: exP.drivetrain.rightDriveTorque,
        leftTrackVel: exP.drivetrain.leftTrackVelocity, rightTrackVel: exP.drivetrain.rightTrackVelocity,
        forwardVel: exP.forwardVelocity, angularVel: exP.angularVelocity,
        slip: exP.slipAmount, isSlipping: exP.isSlipping,
        leftSinkage: exP.leftSinkage, rightSinkage: exP.rightSinkage,
        groundResistance: exP.groundResistance,
        posX: exV.posX, posZ: exV.posZ, heading: exV.heading, pitch: exV.pitch,
      },
      doz: {
        rpm: dzP.engine.rpm, throttle: dzP.engine.throttle, engineTorque: dzP.engine.torque,
        engineStalled: dzP.engine.stalled, engineLugging: dzP.engine.lugging,
        hydPressure: dzP.hydraulics.pressure, hydFlow: dzP.hydraulics.flowRate, reliefOpen: dzP.hydraulics.reliefOpen,
        leftDriveTorque: dzP.drivetrain.leftDriveTorque, rightDriveTorque: dzP.drivetrain.rightDriveTorque,
        leftTrackVel: dzP.drivetrain.leftTrackVelocity, rightTrackVel: dzP.drivetrain.rightTrackVelocity,
        forwardVel: dzP.forwardVelocity, angularVel: dzP.angularVelocity,
        slip: dzP.slipAmount, isSlipping: dzP.isSlipping,
        leftSinkage: dzP.leftSinkage, rightSinkage: dzP.rightSinkage,
        groundResistance: dzP.groundResistance,
        posX: dzV.posX, posZ: dzV.posZ, heading: dzV.heading, pitch: dzV.pitch,
      },
      joints: {
        swing: es.excavator.swing.angle, boom: es.excavator.boom.angle,
        stick: es.excavator.stick.angle, bucket: es.excavator.bucket.angle,
        bucketFill: es.excavator.bucketFill,
        bladeHeight: es.bulldozer.bladeHeight,
        bladeTilt: es.bulldozer.bladeTilt, bladeAngle: es.bulldozer.bladeAngle,
      },
      render: {
        fps, frameMs: clampedDt * 1000,
        vertices: 0, triangles: 0,
        activeParticles: sim2?.getActiveParticles() ?? 0,
        totalParticles: sim2?.mpm.numParticles ?? 0,
        simActive: sim2?.simActive ?? false,
      },
    };
    telemetryBus.publish(frame);
  });
  
  const es = equipmentState.current;
  const excSmoke = Math.min(1,
    es.excPhysics.engine.smoke * 0.7 +
    es.excPhysics.engine.throttle * 0.25 + 0.05);
  const dozSmoke = Math.min(1,
    es.dozPhysics.engine.smoke * 0.7 +
    es.dozPhysics.engine.throttle * 0.25 + 0.05);

  return (
    <>
      <ExcavatorMesh state={es.excavator} exhaustIntensity={excSmoke} />
      <BulldozerMesh state={es.bulldozer} exhaustIntensity={dozSmoke} />
    </>
  );
}

// ── Soil Terrain Mesh ────────────────────────────────────────────────
function SoilTerrain({ 
  onStats, 
  onEquipmentUpdate,
}: { 
  onStats: (s: SoilStats) => void;
  onEquipmentUpdate: (e: EquipmentStats) => void;
}) {
  const meshRef = useRef<THREE.Mesh>(null!);
  const fieldRef = useRef<VoxelField | null>(null);
  const simRef = useRef<SoilSimulator | null>(null);
  const meshFrameRef = useRef(0);
  const hudTickRef = useRef(0);
  const statsTickRef = useRef(0);
  const [heatmapOn, setHeatmapOn] = useState(false);
  useEffect(() => mpmHealth.subscribe(() => setHeatmapOn(mpmHealth.heatmapEnabled)), []);
  useEffect(() => {
    const onReplay = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (!d || !fieldRef.current) return;
      setSpawnSeed(d.rngSeed);
      mpmHealth.recordDig({ ...d, source: 'replay', t: performance.now() / 1000 });
      mpmHealth.rngSeedForNextDig = null;
      fieldRef.current.applyStamp(d.worldX, d.worldY, d.worldZ, d.radius);
      rebuildMesh();
      simRef.current?.activate();
    };
    window.addEventListener('mpm:replay-dig', onReplay);
    return () => window.removeEventListener('mpm:replay-dig', onReplay);
  }, []);
  
  const equipmentState = useRef({
    activeEquipment: 'none' as EquipmentType,
    excavator: createExcavatorState(),
    bulldozer: createBulldozerState(),
    impactMode: null as string | null,
    excPhysics: createVehiclePhysics(createExcavatorMass(), 7.5, 2200),
    dozPhysics: createVehiclePhysics(createBulldozerMass(), 9.0, 2100),
    excDrop: createSpawnDrop(0.16),
    dozDrop: createSpawnDrop(0.18),
  });

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

    // Snap both vehicles onto terrain surface, then lift up for spawn drop
    const es = equipmentState.current;
    initVehicleOnTerrain(es.excavator.vehicle, field, {
      trackWidth: 0.082, trackLength: 0.16, rideHeight: 0.014,
    });
    initVehicleOnTerrain(es.bulldozer.vehicle, field, {
      trackWidth: 0.105, trackLength: 0.20, rideHeight: 0.016,
    });
    elevateForSpawn(es.excavator.vehicle, field, es.excDrop, 0.014);
    elevateForSpawn(es.bulldozer.vehicle, field, es.dozDrop, 0.016);
    es.excDrop.onLanding = (intensity) => playLandingThump(intensity);
    es.dozDrop.onLanding = (intensity) => playLandingThump(intensity);

    rebuildMesh();
  }, [rebuildMesh]);

  const handleClick = useCallback((e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    if (!e.face || !fieldRef.current) return;
    // Only allow click-dig in free camera mode
    if (equipmentState.current.activeEquipment !== 'none') return;

    const normal = e.face.normal.clone();
    const digPoint = e.point.clone().addScaledVector(normal, -DIG_RADIUS * 0.4);

    // Record dig event for replay + smoothed-kernel center
    const seed = mpmHealth.rngSeedForNextDig ?? Math.floor(Math.random() * 0x7fffffff);
    setSpawnSeed(seed);
    mpmHealth.recordDig({
      t: performance.now() / 1000,
      worldX: digPoint.x, worldY: digPoint.y, worldZ: digPoint.z,
      radius: DIG_RADIUS,
      kernelStrength: mpmHealth.kernel.strength,
      kernelRadius: mpmHealth.kernel.radius,
      rngSeed: seed,
      source: 'click',
    });
    mpmHealth.rngSeedForNextDig = null;

    fieldRef.current.applyStamp(digPoint.x, digPoint.y, digPoint.z, DIG_RADIUS);
    rebuildMesh();
    simRef.current?.activate();

    triggerAutoCapture('dig', {
      digPoint: { x: digPoint.x, y: digPoint.y, z: digPoint.z },
      activeParticles: simRef.current?.getActiveParticles() ?? 0,
    });
  }, [rebuildMesh]);

  useFrame((_, dt) => {
    material.uniforms.uTime.value += dt;

    const sim = simRef.current;
    statsTickRef.current += dt;
    hudTickRef.current += dt;

    if (sim && sim.simActive) {
      const changed = sim.step(dt);
      if (changed) {
        meshFrameRef.current++;
        if (meshFrameRef.current % 3 === 0) {
          rebuildMesh();
        }
      }
    }

    const statsInterval = sim?.simActive ? 0.12 : 0.35;
    if (statsTickRef.current >= statsInterval) {
      statsTickRef.current = 0;
      onStats({
        vertices: meshRef.current?.geometry?.attributes?.position?.count ?? 0,
        triangles: (meshRef.current?.geometry?.index?.count ?? 0) / 3,
        simActive: sim?.simActive ?? false,
        activeParticles: sim?.getActiveParticles() ?? 0,
        totalParticles: sim?.mpm.numParticles ?? 0,
      });
    }
    
    if (hudTickRef.current >= 1 / 12) {
      hudTickRef.current = 0;
      onEquipmentUpdate({
        activeEquipment: equipmentState.current.activeEquipment,
        excavator: equipmentState.current.excavator,
        bulldozer: equipmentState.current.bulldozer,
        impactMode: equipmentState.current.impactMode,
      });
    }
  });

  return (
    <>
      <mesh ref={meshRef} material={material} onClick={handleClick} />
      <FluidRenderer simRef={simRef} />
      <DustCloud simRef={simRef} />
      <MpmHeatmapOverlay enabled={heatmapOn} simRef={simRef} />
      <EquipmentController
        fieldRef={fieldRef}
        simRef={simRef}
        rebuildMesh={rebuildMesh}
        equipmentState={equipmentState}
      />
    </>
  );
}

export default memo(function SoilViewer({ 
  onStats, 
  onEquipmentUpdate,
}: { 
  onStats: (s: SoilStats) => void;
  onEquipmentUpdate?: (e: EquipmentStats) => void;
}) {
  const handleEquipmentUpdate = useCallback((e: EquipmentStats) => {
    onEquipmentUpdate?.(e);
  }, [onEquipmentUpdate]);
  
  return (
    <Canvas
      dpr={[1, 1]}
      camera={{ position: [0.9, 0.5, 0.9], fov: 42, near: 0.005, far: 10 }}
      gl={{ antialias: false, alpha: false, powerPreference: 'high-performance', stencil: false }}
      style={{ width: '100%', height: '100%' }}
    >
      <color attach="background" args={['#080c12']} />
      <ambientLight intensity={0.35} />
      <directionalLight position={[2, 3, 1]} intensity={0.7} />
      <directionalLight position={[-1, 2, -2]} intensity={0.3} />
      <SoilTerrain onStats={onStats} onEquipmentUpdate={handleEquipmentUpdate} />
      <gridHelper args={[2, 24, '#141e2b', '#141e2b']} position={[0, 0.001, 0]} />
      <OrbitControls
        target={[0, -0.1, 0]}
        maxPolarAngle={Math.PI * 0.88}
        enableDamping
        dampingFactor={0.08}
      />
    </Canvas>
  );
})
