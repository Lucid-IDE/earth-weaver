// ── MPM Grid & Simulation Constants ──────────────────────────────────

// MPM grid resolution (separate from SDF grid)
export const MPM_GRID = 64;
export const MPM_DX = 1.0 / MPM_GRID;        // cell size in normalized coords
export const MPM_INV_DX = MPM_GRID;

// Physics — tuned per stability constraints from roundtable analysis
export const MPM_DT = 2e-4;                   // simulation timestep (small for CFL stability)
export const MPM_GRAVITY = -9.81;
export const MPM_STEPS_PER_FRAME = 16;        // substeps per render frame

// Velocity damping — prevents energy buildup and helps settling
export const MPM_VELOCITY_DAMPING = 0.998;    // per-substep multiplier (1.0 = no damping)

// Particle limits
export const MAX_PARTICLES = 65536;

// Default material constants (Lamé parameters for Neo-Hookean)
// These are now overridden per-material via materialBrain
export const E_YOUNG = 1.2e4;                 // Young's modulus (reduced from 1.4e4 for stability)
export const NU_POISSON = 0.25;               // Poisson's ratio
export const MU_0 = E_YOUNG / (2 * (1 + NU_POISSON));
export const LAMBDA_0 = E_YOUNG * NU_POISSON / ((1 + NU_POISSON) * (1 - 2 * NU_POISSON));

// Drucker-Prager yield surface defaults
export const DP_FRICTION_ANGLE = 30 * Math.PI / 180;
export const DP_COHESION = 0.0;               // kPa, overridden per-material

// Particle spawn/deposit thresholds
export const SPAWN_SHELL_DEPTH = 3;           // voxels deep from surface to spawn
export const SETTLE_VELOCITY = 0.015;         // speed below which particle settles (was 0.02)
export const SETTLE_FRAMES = 25;              // frames below threshold before deposit (was 30)

// World mapping: MPM domain [0,1]^3 maps to SDF world
export const MPM_WORLD_MIN_X = -0.8;
export const MPM_WORLD_MAX_X = 0.8;
export const MPM_WORLD_MIN_Y = -0.6;
export const MPM_WORLD_MAX_Y = 0.2;
export const MPM_WORLD_MIN_Z = -0.8;
export const MPM_WORLD_MAX_Z = 0.8;
