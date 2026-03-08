import { useState } from 'react';
import { Layers } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  SOIL_PRESET_NAMES,
  setGlobalSoilPreset,
  getGlobalSoilPreset,
  getSoilPreset,
} from '@/lib/soil/materialBrain';

const PRESET_COLORS = [
  'hsl(42, 30%, 60%)',   // Dry Sand
  'hsl(20, 40%, 35%)',   // Wet Clay
  'hsl(32, 25%, 50%)',   // Silt
  'hsl(28, 40%, 20%)',   // Organic/Peat
  'hsl(30, 5%, 52%)',    // Gravel
  'hsl(25, 25%, 38%)',   // Loam
  'hsl(36, 30%, 52%)',   // Sandy Silt
];

export default function SoilPresetSelector() {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<number | null>(getGlobalSoilPreset());

  const handleSelect = (id: number | null) => {
    setActive(id);
    setGlobalSoilPreset(id);
  };

  return (
    <div className="relative">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(!open)}
        className="gap-1.5"
      >
        <Layers className="h-3.5 w-3.5" />
        {active !== null ? SOIL_PRESET_NAMES[active] : 'Natural Layers'}
      </Button>

      {open && (
        <div className="absolute top-full mt-1 right-0 z-50 bg-card border border-border rounded-lg shadow-xl p-2 min-w-[200px]">
          <button
            onClick={() => { handleSelect(null); setOpen(false); }}
            className={`w-full text-left px-3 py-1.5 rounded text-xs transition-colors ${
              active === null ? 'bg-accent/20 text-accent' : 'text-foreground hover:bg-secondary'
            }`}
          >
            🌍 Natural Layers (mixed stratigraphy)
          </button>
          {SOIL_PRESET_NAMES.map((name, i) => {
            const preset = getSoilPreset(i);
            return (
              <button
                key={i}
                onClick={() => { handleSelect(i); setOpen(false); }}
                className={`w-full text-left px-3 py-1.5 rounded text-xs transition-colors flex items-center gap-2 ${
                  active === i ? 'bg-accent/20 text-accent' : 'text-foreground hover:bg-secondary'
                }`}
              >
                <span
                  className="w-3 h-3 rounded-full flex-shrink-0 border border-border"
                  style={{ background: PRESET_COLORS[i] }}
                />
                <span className="flex-1">{name}</span>
                <span className="text-[9px] text-muted-foreground font-mono">
                  φ={Math.round(preset.frictionAngle * 180 / Math.PI)}° c={preset.cohesion.toFixed(2)}
                </span>
              </button>
            );
          })}
          <div className="border-t border-border mt-1 pt-1 px-3 py-1">
            <p className="text-[9px] text-muted-foreground">
              Presets override material at spawn time. Existing particles keep their original material.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
