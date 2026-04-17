

## Plan: Push Simulation to Hyper-Realism Limits

After reviewing the codebase, research docs, and current architecture, here is a focused roadmap to advance from "very good" to "reference-grade" simulation realism. Grouped by impact tier.

---

### Tier 1 — Foundational Physics Upgrades (biggest realism gains)

**1. Two-Phase Soil (water + solid coupling)**
Current MPM treats moisture as a static parameter. Real wet soil derives behavior from pore-water pressure.
- Add per-particle `porePressure` and `saturation` fields
- Implement Terzaghi effective stress: `σ_effective = σ_total - p_water`
- Drainage diffusion between particles (Darcy flow approximation)
- Result: wet clay actually liquefies under load, mud forms under tracks, drainage tracks behind machines

**2. Track-Soil Bevameter Model (Bekker-Wong terramechanics)**
Replace ad-hoc sink/resistance with the industry-standard model used in actual vehicle engineering.
- Pressure-sinkage: `p = (k_c/b + k_φ) · z^n`
- Shear stress with Janosi-Hanamoto slip model
- Per-track-shoe contact patches (not single-point) computing normal + shear independently
- Result: machines exhibit real motion resistance, slip-sinkage cycle, drawbar pull curves

**3. Rigid-Body Dynamics for Vehicles**
Currently vehicles update position kinematically. Promote to full 6-DOF rigid bodies.
- Inertia tensor, angular momentum, proper torque integration
- Suspension model (track tension, road wheel travel)
- Weight transfer during acceleration/braking/digging
- Result: dozer pitches forward when blade hits resistance, excavator counter-rotates when swinging full bucket

---

### Tier 2 — Mechanical Authenticity

**4. Hydraulic Cylinder Physics (not just visual rods)**
Model cylinders as force-producing elements with realistic dynamics.
- Pressure × bore area = force (with rod-side vs bore-side asymmetry)
- Flow-limited extension rate, relief valve cracking
- Cylinder force feedback into chassis (digging reactions tip the machine)
- Pressure spikes when bucket hits buried gravel

**5. Engine Load Curve + Lugging**
- Engine stalls when load exceeds max torque at current RPM
- Audible "lugging" zone affects fuel/smoke
- Gear/range selection (Hi/Lo) on bulldozer

**6. Track Articulation**
- Individual track shoe simulation (sprocket teeth engagement)
- Track slap/slack visualization
- Idler tensioner travel

---

### Tier 3 — Visual & Material Fidelity

**7. Soil Aggregation & Clumping**
- Cohesion-driven particle bonding (clumps stay together when wet clay is scooped)
- Breakable bonds under shear
- Renderer treats bonded clusters as single metaball blobs

**8. Bucket-Material Conservation**
- Volumetric scoop calculation from actual swept volume
- Material spillage at angles exceeding repose
- Sticky residue on bucket interior for clay

**9. Compaction & Plastic Memory**
- SDF stores compaction state (density-modified)
- Track ruts persist with proper edge-piling
- Drive-overs progressively harden the path

**10. Atmospheric & Weathering**
- Moisture-driven dust suppression (wet ground → no dust)
- Splash/spray particles in wet conditions
- Heat shimmer above engine deck

---

### Tier 4 — Operator Realism

**11. Joystick Curve & Modulation**
- Logarithmic input response (fine control near center)
- Dead zones, pilot-pressure ramp simulating real pilot-operated valves

**12. Audio-Coupled Physics**
- Engine RPM drives audio pitch; load drives volume/timbre
- Hydraulic relief valve squeal at pressure ceiling
- Track squeak proportional to slip

---

### Recommended First Wave (single implementation pass)

To make a visible leap immediately, I recommend implementing in this order:

1. **Bekker-Wong terramechanics** (`vehiclePhysics.ts` + new `terramechanics.ts`) — replaces fake resistance with real model, single biggest realism delta for ground interaction
2. **Rigid-body chassis with weight transfer** (`vehiclePhysics.ts`) — pitch/roll reactions to digging, braking, slope
3. **Hydraulic force feedback to chassis** (`excavator.ts`, `bulldozer.ts`) — digging actually pushes the machine
4. **Two-phase pore pressure in MPM** (`mpmSolver.ts`) — wet soil truly behaves wet
5. **Volumetric bucket conservation + spillage** (`excavator.ts`)

### Files to Touch

- New: `src/lib/equipment/terramechanics.ts`, `src/lib/equipment/rigidBody.ts`, `src/lib/equipment/hydraulicCylinder.ts`
- Updated: `src/lib/equipment/vehiclePhysics.ts`, `excavator.ts`, `bulldozer.ts`, `terrainInteraction.ts`
- Updated: `src/lib/mpm/mpmSolver.ts` (pore pressure terms)
- Updated: `src/lib/soil/VoxelField.ts` (compaction state)
- Updated: `src/components/EquipmentRenderer.tsx` (per-track-shoe articulation)

### Key Question Before Proceeding

Want me to attack the **First Wave (5 items above) in one large pass**, or do you want to pick a narrower subset (e.g. just terramechanics + rigid body) for a deeper, more polished implementation per system?

