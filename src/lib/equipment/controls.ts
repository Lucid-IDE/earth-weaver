// ── Equipment Input Controller ───────────────────────────────────────
// Dual joystick keyboard mapping for heavy equipment operation
//
// EXCAVATOR CONTROLS:
//   Left Stick (tracks):  W/S = left track, ↑/↓ (or I/K) = right track
//   Right Stick (arm):    A/D = swing, I/K = boom, J/L = stick
//   Bucket:               Q/E = curl bucket in/out
//   
// BULLDOZER CONTROLS:
//   Left Stick (tracks):  W/S = left track, I/K = right track
//   Right Stick (blade):  R/F = blade up/down, T/G = tilt, Y/H = angle
//   Rippers:              X = toggle rippers

export interface ControlInputs {
  // Left joystick (tracks)
  leftTrackForward: boolean;
  leftTrackBackward: boolean;
  rightTrackForward: boolean;
  rightTrackBackward: boolean;
  
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
  switchToFreeCamera: boolean;
  
  // Impact
  triggerImpact: boolean;
  triggerExplosion: boolean;
}

const keyState: Record<string, boolean> = {};
const justPressed: Record<string, boolean> = {};

export function initControls() {
  window.addEventListener('keydown', (e) => {
    if (!keyState[e.key.toLowerCase()]) {
      justPressed[e.key.toLowerCase()] = true;
    }
    keyState[e.key.toLowerCase()] = true;
  });
  
  window.addEventListener('keyup', (e) => {
    keyState[e.key.toLowerCase()] = false;
  });
}

function isDown(key: string): boolean {
  return keyState[key] || false;
}

function wasJustPressed(key: string): boolean {
  const pressed = justPressed[key] || false;
  justPressed[key] = false;
  return pressed;
}

export function pollControls(): ControlInputs {
  return {
    // Left stick: W/S = left track, I/K = right track (or arrow keys)
    leftTrackForward: isDown('w'),
    leftTrackBackward: isDown('s'),
    rightTrackForward: isDown('i'),
    rightTrackBackward: isDown('k'),
    
    // Right stick: arm
    swingLeft: isDown('a'),
    swingRight: isDown('d'),
    boomUp: isDown('r'),
    boomDown: isDown('f'),
    stickIn: isDown('j'),
    stickOut: isDown('l'),
    bucketCurl: isDown('q'),
    bucketDump: isDown('e'),
    
    // Blade
    bladeUp: isDown('r'),
    bladeDown: isDown('f'),
    bladeTiltLeft: isDown('t'),
    bladeTiltRight: isDown('g'),
    bladeAngleLeft: isDown('y'),
    bladeAngleRight: isDown('h'),
    toggleRippers: wasJustPressed('x'),
    
    // Equipment switching
    switchToExcavator: wasJustPressed('1'),
    switchToBulldozer: wasJustPressed('2'),
    switchToFreeCamera: wasJustPressed('3'),
    
    // Impact
    triggerImpact: wasJustPressed('v'),
    triggerExplosion: wasJustPressed('b'),
  };
}

export function getExcavatorInputs(ctrl: ControlInputs) {
  return {
    leftTrack: (ctrl.leftTrackForward ? 1 : 0) + (ctrl.leftTrackBackward ? -1 : 0),
    rightTrack: (ctrl.rightTrackForward ? 1 : 0) + (ctrl.rightTrackBackward ? -1 : 0),
    swingInput: (ctrl.swingRight ? 1 : 0) + (ctrl.swingLeft ? -1 : 0),
    boomInput: (ctrl.boomUp ? 1 : 0) + (ctrl.boomDown ? -1 : 0),
    stickInput: (ctrl.stickIn ? 1 : 0) + (ctrl.stickOut ? -1 : 0),
    bucketInput: (ctrl.bucketCurl ? 1 : 0) + (ctrl.bucketDump ? -1 : 0),
  };
}

export function getBulldozerInputs(ctrl: ControlInputs) {
  return {
    leftTrack: (ctrl.leftTrackForward ? 1 : 0) + (ctrl.leftTrackBackward ? -1 : 0),
    rightTrack: (ctrl.rightTrackForward ? 1 : 0) + (ctrl.rightTrackBackward ? -1 : 0),
    bladeUp: (ctrl.bladeUp ? 1 : 0) + (ctrl.bladeDown ? -1 : 0),
    bladeTiltInput: (ctrl.bladeTiltRight ? 1 : 0) + (ctrl.bladeTiltLeft ? -1 : 0),
    bladeAngleInput: (ctrl.bladeAngleRight ? 1 : 0) + (ctrl.bladeAngleLeft ? -1 : 0),
    toggleRippers: ctrl.toggleRippers,
  };
}
