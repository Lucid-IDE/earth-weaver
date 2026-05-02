import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import SoilViewer from '@/components/SoilViewer';
import type { SoilStats, EquipmentStats } from '@/components/SoilViewer';
import DebugOverlay from '@/components/DebugOverlay';
import ControlsHUD from '@/components/ControlsHUD';
import CaptureButton from '@/components/analyst/CaptureButton';
import AnalystPanel from '@/components/analyst/AnalystPanel';
import SoilPresetSelector from '@/components/SoilPresetSelector';
import DiagnosticPanel from '@/components/DiagnosticPanel';
import { Brain, Activity } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function Index() {
  const navigate = useNavigate();
  const [stats, setStats] = useState<SoilStats>({
    vertices: 0, triangles: 0, simActive: false,
    activeParticles: 0, totalParticles: 0,
  });
  const [equipmentStats, setEquipmentStats] = useState<EquipmentStats | null>(null);
  const [analystOpen, setAnalystOpen] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);

  return (
    <div className="w-screen h-screen bg-background relative overflow-hidden">
      <SoilViewer onStats={setStats} onEquipmentUpdate={setEquipmentStats} />
      <DebugOverlay stats={stats} equipment={equipmentStats} />

      {/* Top-right controls */}
      <div className="absolute top-4 right-4 flex items-center gap-2 z-40">
        <SoilPresetSelector />
        <CaptureButton source="soil-terrain" metadata={stats} />
        <Button
          variant={diagOpen ? 'default' : 'outline'}
          size="sm"
          onClick={() => setDiagOpen((v) => !v)}
          className="gap-1.5"
        >
          <Activity className="h-3.5 w-3.5" />
          Diagnostics
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setAnalystOpen(true)}
          className="gap-1.5"
        >
          <Brain className="h-3.5 w-3.5" />
          Analyst
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate('/analyst')}
          className="text-xs text-muted-foreground"
        >
          Full View →
        </Button>
      </div>

      <DiagnosticPanel open={diagOpen} onClose={() => setDiagOpen(false)} />

      {/* Controls HUD */}
      {equipmentStats && (
        <ControlsHUD
          activeEquipment={equipmentStats.activeEquipment}
          excavator={equipmentStats.excavator}
          bulldozer={equipmentStats.bulldozer}
            dumpTruck={equipmentStats.dumpTruck}
          impactMode={equipmentStats.impactMode}
        />
      )}

      <AnalystPanel
        isOpen={analystOpen}
        onClose={() => setAnalystOpen(false)}
        source="soil-terrain"
        metadata={stats}
      />
    </div>
  );
}
