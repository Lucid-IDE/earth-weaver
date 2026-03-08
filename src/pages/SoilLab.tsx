import { useNavigate } from "react-router-dom";

const SoilLab = () => {
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
          WebGPU • Drag to interact • P to pause • Change color to brown for soil look
        </span>
      </div>
      <iframe
        src="/soil-lab.html"
        className="flex-1 w-full border-none"
        title="Soil MLS-MPM Simulation"
      />
    </div>
  );
};

export default SoilLab;
