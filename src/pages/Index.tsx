import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import SoilViewer from '@/components/SoilViewer';
import type { SoilStats } from '@/components/SoilViewer';
import DebugOverlay from '@/components/DebugOverlay';
import CaptureButton from '@/components/analyst/CaptureButton';
import AnalystPanel from '@/components/analyst/AnalystPanel';
import { Brain } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function Index() {
  const navigate = useNavigate();
  const [stats, setStats] = useState<SoilStats>({
    vertices: 0, triangles: 0, simActive: false,
    activeParticles: 0, totalParticles: 0,
  });
  const [analystOpen, setAnalystOpen] = useState(false);

  return (
    <div className="w-screen h-screen bg-background relative overflow-hidden">
      <SoilViewer onStats={setStats} />
      <DebugOverlay stats={stats} />

      {/* Top-right controls */}
      <div className="absolute top-4 right-4 flex items-center gap-2 z-40">
        <CaptureButton source="soil-terrain" metadata={stats} />
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

      <AnalystPanel
        isOpen={analystOpen}
        onClose={() => setAnalystOpen(false)}
        source="soil-terrain"
        metadata={stats}
      />
    </div>
  );
}
