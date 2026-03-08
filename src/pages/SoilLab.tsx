import { useState } from 'react';
import { useNavigate } from "react-router-dom";
import CaptureButton from '@/components/analyst/CaptureButton';
import AnalystPanel from '@/components/analyst/AnalystPanel';
import { Brain } from 'lucide-react';
import { Button } from '@/components/ui/button';

const SoilLab = () => {
  const navigate = useNavigate();
  const [analystOpen, setAnalystOpen] = useState(false);

  return (
    <div className="w-full h-screen flex flex-col bg-background">
      <div className="flex items-center gap-4 px-4 py-2 border-b border-border bg-card">
        <button
          onClick={() => navigate("/")}
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          ← Back to Soil
        </button>
        <button
          onClick={() => navigate("/fluid")}
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Fluid Lab
        </button>
        <h1 className="text-sm font-semibold text-foreground">
          🪨 Soil Lab — Drucker-Prager MLS-MPM
        </h1>
        <span className="text-xs text-muted-foreground">
          WebGPU • Drag to interact • P to pause
        </span>
        <div className="ml-auto flex items-center gap-2">
          <CaptureButton source="soil-lab" />
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
      </div>
      <iframe
        src="/soil-lab.html"
        className="flex-1 w-full border-none"
        title="Soil MLS-MPM Simulation"
      />
      <AnalystPanel
        isOpen={analystOpen}
        onClose={() => setAnalystOpen(false)}
        source="soil-lab"
      />
    </div>
  );
};

export default SoilLab;
