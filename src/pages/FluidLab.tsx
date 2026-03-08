import { useNavigate } from "react-router-dom";

const FluidLab = () => {
  const navigate = useNavigate();

  return (
    <div className="w-full h-screen flex flex-col bg-background">
      <div className="flex items-center gap-4 px-4 py-2 border-b border-border bg-card">
        <button
          onClick={() => navigate("/")}
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          ← Back to Soil
        </button>
        <h1 className="text-sm font-semibold text-foreground">
          MLS-MPM Fluid Lab
        </h1>
        <span className="text-xs text-muted-foreground">
          WebGPU • Drag to interact • P to pause
        </span>
      </div>
      <iframe
        src="/splash-mls-mpm.html"
        className="flex-1 w-full border-none"
        title="MLS-MPM Fluid Simulation"
      />
    </div>
  );
};

export default FluidLab;
