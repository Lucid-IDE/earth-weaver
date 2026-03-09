// ── Dual Joystick Controls HUD ───────────────────────────────────────
// Shows active equipment controls, current state, and keyboard mappings

import { EquipmentType, ExcavatorState, BulldozerState } from '@/lib/equipment/types';

interface ControlsHUDProps {
  activeEquipment: EquipmentType;
  excavator: ExcavatorState;
  bulldozer: BulldozerState;
  impactMode: string | null;
}

const DEG = 180 / Math.PI;

export default function ControlsHUD({ activeEquipment, excavator, bulldozer, impactMode }: ControlsHUDProps) {
  return (
    <div className="absolute bottom-4 left-4 right-4 pointer-events-none z-40">
      <div className="flex items-end justify-between gap-4">
        {/* Left: Equipment selector */}
        <div className="bg-card/85 backdrop-blur-sm border border-border rounded-md px-3 py-2 pointer-events-auto">
          <div className="text-[10px] text-muted-foreground font-mono mb-1">EQUIPMENT</div>
          <div className="flex gap-1.5">
            <EquipBtn label="1" name="Excavator" active={activeEquipment === 'excavator'} />
            <EquipBtn label="2" name="Bulldozer" active={activeEquipment === 'bulldozer'} />
            <EquipBtn label="3" name="Free Cam" active={activeEquipment === 'none'} />
          </div>
          <div className="flex gap-1.5 mt-1.5">
            <ImpactBtn label="V" name="Impact" active={impactMode === 'impact'} />
            <ImpactBtn label="B" name="Explosive" active={impactMode === 'explosive'} />
          </div>
        </div>
        
        {/* Center: Active equipment controls */}
        {activeEquipment === 'excavator' && <ExcavatorHUD state={excavator} />}
        {activeEquipment === 'bulldozer' && <BulldozerHUD state={bulldozer} />}
        {activeEquipment === 'none' && (
          <div className="bg-card/85 backdrop-blur-sm border border-border rounded-md px-4 py-2">
            <div className="text-[10px] text-muted-foreground font-mono">FREE CAMERA</div>
            <div className="text-[10px] text-muted-foreground">Click terrain to dig · Scroll to zoom</div>
          </div>
        )}
        
        {/* Right: Status gauges */}
        <div className="bg-card/85 backdrop-blur-sm border border-border rounded-md px-3 py-2">
          <div className="text-[10px] text-muted-foreground font-mono mb-1">STATUS</div>
          {activeEquipment === 'excavator' && (
            <div className="space-y-0.5 text-[10px] font-mono">
              <Gauge label="Hydraulic" value={excavator.hydraulicPressure} color="text-accent" />
              <Gauge label="Boom" value={(excavator.boom.angle - excavator.boom.minAngle) / (excavator.boom.maxAngle - excavator.boom.minAngle)} />
              <Gauge label="Stick" value={(excavator.stick.angle - excavator.stick.minAngle) / (excavator.stick.maxAngle - excavator.stick.minAngle)} />
              <Gauge label="Bucket" value={(excavator.bucket.angle - excavator.bucket.minAngle) / (excavator.bucket.maxAngle - excavator.bucket.minAngle)} />
            </div>
          )}
          {activeEquipment === 'bulldozer' && (
            <div className="space-y-0.5 text-[10px] font-mono">
              <Gauge label="Blade Ht" value={(bulldozer.bladeHeight - bulldozer.bladeMinHeight) / (bulldozer.bladeMaxHeight - bulldozer.bladeMinHeight)} />
              <div className="text-muted-foreground">
                Tilt: <span className="text-foreground">{(bulldozer.bladeTilt * DEG).toFixed(1)}°</span>
              </div>
              <div className="text-muted-foreground">
                Angle: <span className="text-foreground">{(bulldozer.bladeAngle * DEG).toFixed(1)}°</span>
              </div>
              <div className="text-muted-foreground">
                Rippers: <span className={bulldozer.rippersDown ? "text-accent" : "text-muted-foreground"}>
                  {bulldozer.rippersDown ? '● DOWN' : '○ UP'}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function EquipBtn({ label, name, active }: { label: string; name: string; active: boolean }) {
  return (
    <div className={`px-2 py-0.5 rounded text-[10px] font-mono border ${
      active ? 'border-primary bg-primary/20 text-primary' : 'border-border text-muted-foreground'
    }`}>
      <span className="text-muted-foreground">[{label}]</span> {name}
    </div>
  );
}

function ImpactBtn({ label, name, active }: { label: string; name: string; active: boolean }) {
  return (
    <div className={`px-2 py-0.5 rounded text-[10px] font-mono border ${
      active ? 'border-destructive bg-destructive/20 text-destructive' : 'border-border text-muted-foreground'
    }`}>
      <span className="text-muted-foreground">[{label}]</span> {name}
    </div>
  );
}

function ExcavatorHUD({ state }: { state: ExcavatorState }) {
  return (
    <div className="bg-card/85 backdrop-blur-sm border border-border rounded-md px-4 py-2 flex gap-6">
      {/* Left Joystick */}
      <div>
        <div className="text-[10px] text-muted-foreground font-mono mb-1">LEFT STICK — TRACKS</div>
        <div className="grid grid-cols-3 gap-0.5 text-[9px] font-mono text-center w-[90px]">
          <div />
          <Key k="W" label="L↑" active={state.vehicle.tracks.leftSpeed > 0} />
          <div />
          <div />
          <Key k="S" label="L↓" active={state.vehicle.tracks.leftSpeed < 0} />
          <div />
        </div>
      </div>
      
      {/* Right Joystick */}
      <div>
        <div className="text-[10px] text-muted-foreground font-mono mb-1">RIGHT STICK — ARM</div>
        <div className="grid grid-cols-5 gap-0.5 text-[9px] font-mono text-center">
          <div /> <Key k="I" label="R↑" /> <div /> <Key k="R" label="Boom↑" /> <div />
          <Key k="J" label="Stk←" /> <div /> <Key k="L" label="Stk→" /> <Key k="F" label="Boom↓" /> <div />
          <div /> <Key k="K" label="R↓" /> <div /> <div /> <div />
        </div>
      </div>
      
      {/* Extras */}
      <div>
        <div className="text-[10px] text-muted-foreground font-mono mb-1">EXTRAS</div>
        <div className="flex gap-1">
          <Key k="A" label="Swing←" />
          <Key k="D" label="Swing→" />
          <Key k="Q" label="Curl" />
          <Key k="E" label="Dump" />
        </div>
      </div>
    </div>
  );
}

function BulldozerHUD({ state }: { state: BulldozerState }) {
  return (
    <div className="bg-card/85 backdrop-blur-sm border border-border rounded-md px-4 py-2 flex gap-6">
      {/* Left Joystick */}
      <div>
        <div className="text-[10px] text-muted-foreground font-mono mb-1">LEFT STICK — TRACKS</div>
        <div className="grid grid-cols-2 gap-0.5 text-[9px] font-mono text-center">
          <Key k="W" label="L↑" active={state.vehicle.tracks.leftSpeed > 0} />
          <Key k="I" label="R↑" active={state.vehicle.tracks.rightSpeed > 0} />
          <Key k="S" label="L↓" active={state.vehicle.tracks.leftSpeed < 0} />
          <Key k="K" label="R↓" active={state.vehicle.tracks.rightSpeed < 0} />
        </div>
      </div>
      
      {/* Right Joystick */}
      <div>
        <div className="text-[10px] text-muted-foreground font-mono mb-1">RIGHT STICK — BLADE</div>
        <div className="flex gap-1 text-[9px] font-mono">
          <Key k="R" label="Up" />
          <Key k="F" label="Down" />
          <Key k="T" label="Tilt←" />
          <Key k="G" label="Tilt→" />
          <Key k="Y" label="Ang←" />
          <Key k="H" label="Ang→" />
        </div>
      </div>
      
      {/* Extras */}
      <div>
        <div className="text-[10px] text-muted-foreground font-mono mb-1">EXTRAS</div>
        <Key k="X" label="Rippers" />
      </div>
    </div>
  );
}

function Key({ k, label, active }: { k: string; label: string; active?: boolean }) {
  return (
    <div className={`px-1.5 py-0.5 rounded border text-[9px] font-mono ${
      active ? 'border-primary bg-primary/20 text-primary' : 'border-border text-muted-foreground'
    }`}>
      <span className="text-foreground">{k}</span>
      <span className="text-muted-foreground ml-0.5">{label}</span>
    </div>
  );
}

function Gauge({ label, value, color }: { label: string; value: number; color?: string }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  const bars = Math.round(pct / 10);
  const barStr = '█'.repeat(bars) + '░'.repeat(10 - bars);
  return (
    <div className="text-muted-foreground">
      {label}: <span className={color || "text-foreground"}>{barStr}</span> <span className="text-foreground">{pct.toFixed(0)}%</span>
    </div>
  );
}
