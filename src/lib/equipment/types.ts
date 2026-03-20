// ── Equipment Type Definitions ───────────────────────────────────────

export interface JointState {
  angle: number;       // current angle in radians
  minAngle: number;    // joint limits
  maxAngle: number;
  speed: number;       // radians per second
  length: number;      // segment length
  label: string;
}

export interface TrackState {
  leftSpeed: number;   // -1 to 1
  rightSpeed: number;  // -1 to 1
}

export interface VehicleState {
  posX: number;
  posY: number;
  posZ: number;
  heading: number;     // yaw in radians
  pitch: number;       // for slope following
  contactSink: number; // dynamic sink depth based on soil softness
  groundClearance: number; // estimated chassis-to-surface clearance
  tracks: TrackState;
  speed: number;       // derived forward speed
  turnRate: number;    // derived turn rate
}

export interface ExcavatorState {
  vehicle: VehicleState;
  swing: JointState;      // cab rotation (turntable)
  boom: JointState;       // main arm
  stick: JointState;      // secondary arm
  bucket: JointState;     // bucket curl
  bucketFill: number;     // 0-1 captured soil load for scoop/drop behavior
  hydraulicPressure: number; // 0-1 visual feedback
}

export interface BulldozerState {
  vehicle: VehicleState;
  bladeHeight: number;    // -0.15 to 0.05 (world units)
  bladeTilt: number;      // -15 to 15 degrees
  bladeAngle: number;     // side angle -20 to 20 degrees
  bladeWidth: number;     // fixed width
  bladeMinHeight: number;
  bladeMaxHeight: number;
  rippersDown: boolean;
}

export type EquipmentType = 'excavator' | 'bulldozer' | 'none';

export interface EquipmentControlState {
  activeEquipment: EquipmentType;
  excavator: ExcavatorState;
  bulldozer: BulldozerState;
}

export const DEG = Math.PI / 180;
