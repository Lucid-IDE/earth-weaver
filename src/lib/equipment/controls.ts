// ── Equipment Input Controller ───────────────────────────────────────
// Dual joystick keyboard mapping for heavy equipment operation
//
// UNIVERSAL MOVEMENT:
//   Arrow Up/Down = both tracks forward/back (simple drive)
//   Arrow Left/Right = pivot turn (skid steer)
//   W/S = left track only, I/K = right track only (independent tracks)
//
// EXCAVATOR CONTROLS:
//   A/D = swing cab left/right
//   R/F = boom up/down
//   J/L = stick in/out
//   Q/E = curl/dump bucket
//
// BULLDOZER CONTROLS:
//   R/F = blade up/down
//   T/G = blade tilt left/right
//   Y/H = blade angle left/right
//   X = toggle rippers

export interface ControlInputs {
  // Left joystick (tracks)
  leftTrackForward: boolean;
  leftTrackBackward: boolean;
  rightTrackForward: boolean;
  rightTrackBackward: boolean;
  
  // Simple drive (arrow keys move both tracks)
  bothForward: boolean;
  bothBackward: boolean;
  pivotLeft: boolean;
  pivotRight: boolean;
  
  // Right joystick / arm controls
  swingLeft: boolean;
  swingRight: boolean;
  boomUp: boolean;
  boomDown: boolean;
  stickIn: boolean;
  stickOut: boolean;
  bucketCurl: boolean;
  bucketDump: boolean;
  
  // Blade controls
  bladeUp: boolean;
  bladeDown: boolean;
  bladeTiltLeft: boolean;
  bladeTiltRight: boolean;
  bladeAngleLeft: boolean;
  bladeAngleRight: boolean;
  toggleRippers: boolean;
  
  // Equipment switching
  switchToExcavator: boolean;
  switchToBulldozer: boolean;
  switchToDumpTruck: boolean;
  switchToFreeCamera: boolean;
  
  // Impact
  triggerImpact: boolean;
  triggerExplosion: boolean;
}

const keyState: Record<string, boolean> = {};
const justPressed: Record<string, boolean> = {};

export function initControls() {
  window.addEventListener('keydown', (e) => {
    const k = e.code || e.key.toLowerCase();
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(k)) {
      e.preventDefault();
    }
    if (!keyState[k]) {
      justPressed[k] = true;
    }
    keyState[k] = true;
  });
  
  window.addEventListener('keyup', (e) => {
    const k = e.code || e.key.toLowerCase();
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(k)) {
      e.preventDefault();
    }
    keyState[k] = false;
  });
}

function isDown(code: string): boolean {
  return keyState[code] || false;
}

function wasJustPressed(code: string): boolean {
  const pressed = justPressed[code] || false;
  justPressed[code] = false;
  return pressed;
}

export function pollControls(): ControlInputs {
  return {
    // Independent tracks: W/S = left, I/K = right
    leftTrackForward: isDown('KeyW'),
    leftTrackBackward: isDown('KeyS'),
    rightTrackForward: isDown('KeyI'),
    rightTrackBackward: isDown('KeyK'),
    
    // Arrow keys: both tracks together
    bothForward: isDown('ArrowUp'),
    bothBackward: isDown('ArrowDown'),
    pivotLeft: isDown('ArrowLeft'),
    pivotRight: isDown('ArrowRight'),
    
    // Arm controls
    swingLeft: isDown('KeyA'),
    swingRight: isDown('KeyD'),
    boomUp: isDown('KeyR'),
    boomDown: isDown('KeyF'),
    stickIn: isDown('KeyJ'),
    stickOut: isDown('KeyL'),
    bucketCurl: isDown('KeyQ'),
    bucketDump: isDown('KeyE'),
    
    // Blade
    bladeUp: isDown('KeyR'),
    bladeDown: isDown('KeyF'),
    bladeTiltLeft: isDown('KeyT'),
    bladeTiltRight: isDown('KeyG'),
    bladeAngleLeft: isDown('KeyY'),
    bladeAngleRight: isDown('KeyH'),
    toggleRippers: wasJustPressed('KeyX'),
    
    // Equipment switching
    switchToExcavator: wasJustPressed('Digit1'),
    switchToBulldozer: wasJustPressed('Digit2'),
    switchToDumpTruck: wasJustPressed('Digit3'),
    switchToFreeCamera: wasJustPressed('Digit4'),
    
    // Impact
    triggerImpact: wasJustPressed('KeyV'),
    triggerExplosion: wasJustPressed('KeyB'),
  };
}

export function getExcavatorInputs(ctrl: ControlInputs) {
  // Combine independent tracks + arrow keys
  let leftTrack = (ctrl.leftTrackForward ? 1 : 0) + (ctrl.leftTrackBackward ? -1 : 0);
  let rightTrack = (ctrl.rightTrackForward ? 1 : 0) + (ctrl.rightTrackBackward ? -1 : 0);
  
  // Arrow keys: forward/back = both tracks, left/right = pivot
  if (ctrl.bothForward) { leftTrack += 1; rightTrack += 1; }
  if (ctrl.bothBackward) { leftTrack -= 1; rightTrack -= 1; }
  if (ctrl.pivotLeft) { leftTrack -= 1; rightTrack += 1; }
  if (ctrl.pivotRight) { leftTrack += 1; rightTrack -= 1; }
  
  leftTrack = Math.max(-1, Math.min(1, leftTrack));
  rightTrack = Math.max(-1, Math.min(1, rightTrack));
  
  return {
    leftTrack,
    rightTrack,
    swingInput: (ctrl.swingRight ? 1 : 0) + (ctrl.swingLeft ? -1 : 0),
    boomInput: (ctrl.boomUp ? 1 : 0) + (ctrl.boomDown ? -1 : 0),
    stickInput: (ctrl.stickIn ? 1 : 0) + (ctrl.stickOut ? -1 : 0),
    bucketInput: (ctrl.bucketCurl ? 1 : 0) + (ctrl.bucketDump ? -1 : 0),
  };
}

export function getBulldozerInputs(ctrl: ControlInputs) {
  let leftTrack = (ctrl.leftTrackForward ? 1 : 0) + (ctrl.leftTrackBackward ? -1 : 0);
  let rightTrack = (ctrl.rightTrackForward ? 1 : 0) + (ctrl.rightTrackBackward ? -1 : 0);
  
  if (ctrl.bothForward) { leftTrack += 1; rightTrack += 1; }
  if (ctrl.bothBackward) { leftTrack -= 1; rightTrack -= 1; }
  if (ctrl.pivotLeft) { leftTrack -= 1; rightTrack += 1; }
  if (ctrl.pivotRight) { leftTrack += 1; rightTrack -= 1; }
  
  leftTrack = Math.max(-1, Math.min(1, leftTrack));
  rightTrack = Math.max(-1, Math.min(1, rightTrack));
  
  return {
    leftTrack,
    rightTrack,
    bladeUp: (ctrl.bladeUp ? 1 : 0) + (ctrl.bladeDown ? -1 : 0),
    bladeTiltInput: (ctrl.bladeTiltRight ? 1 : 0) + (ctrl.bladeTiltLeft ? -1 : 0),
    bladeAngleInput: (ctrl.bladeAngleRight ? 1 : 0) + (ctrl.bladeAngleLeft ? -1 : 0),
    toggleRippers: ctrl.toggleRippers,
  };
}

export function getDumpTruckInputs(ctrl: ControlInputs) {
  const drive = (ctrl.bothForward ? 1 : 0) + (ctrl.bothBackward ? -1 : 0);
  const steer = (ctrl.pivotLeft ? 1 : 0) + (ctrl.pivotRight ? -1 : 0);
  return {
    throttle: Math.max(-1, Math.min(1, drive)),
    steer: Math.max(-1, Math.min(1, steer)),
    dumpBed: (ctrl.boomUp ? 1 : 0) + (ctrl.boomDown ? -1 : 0),
    toggleTailgate: ctrl.toggleRippers,
    pressureDown: ctrl.bladeTiltLeft,
    pressureUp: ctrl.bladeTiltRight,
    loadAdd: ctrl.bladeAngleRight,
    loadDump: ctrl.bladeAngleLeft,
  };
}
