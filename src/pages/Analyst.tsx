import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Brain, Trash2, Loader2, ImageIcon, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import ReactMarkdown from 'react-markdown';
import {
  fetchScreenshots,
  analyzeScreenshot,
  deleteScreenshot,
  type Screenshot,
} from '@/lib/analyst/screenshotService';

const CODE_CONTEXT = `// Key solver files:
// - src/lib/mpm/mpmSolver.ts: MLS-MPM CPU solver with Drucker-Prager return mapping
// - src/lib/soil/soilSim.ts: Hybrid SDF-MPM soil simulator
// - src/lib/soil/VoxelField.ts: SDF voxel field with surface nets extraction
// - public/soil-lab.html: WebGPU MLS-MPM with WGSL compute shaders
// - src/lib/soil/soilShader.ts: GLSL soil terrain shader`;

const DOCS_CONTEXT = `Project MAELSTROM: WebGPU MLS-MPM soil/fluid simulation.
Uses Substrate-Aligned Computing (SAC) for GPU optimization.
Key physics: Drucker-Prager elastoplasticity, Neo-Hookean Kirchhoff stress,
SVD-based return mapping, deformation gradient F tracking.
Rendering: Billboard sphere splatting → bilateral depth smoothing → Lambert composite.`;

export default function Analyst() {
  const navigate = useNavigate();
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]);
  const [selected, setSelected] = useState<Screenshot | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [model, setModel] = useState('google/gemini-3.1-pro-preview');

  const load = useCallback(async () => {
    setScreenshots(await fetchScreenshots());
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleAnalyze = async (s: Screenshot) => {
    setAnalyzing(true);
    try {
      const analysis = await analyzeScreenshot(s, CODE_CONTEXT, DOCS_CONTEXT, model);
      if (analysis) {
        setSelected((prev) => prev ? { ...prev, analysis, model_used: model } : null);
        await load();
      }
    } finally {
      setAnalyzing(false);
    }
  };

  const handleDelete = async (s: Screenshot) => {
    await deleteScreenshot(s);
    if (selected?.id === s.id) setSelected(null);
    await load();
  };

  return (
    <div className="h-screen w-screen bg-background flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-4 px-4 py-2 border-b border-border bg-card">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="gap-1">
          <ArrowLeft className="h-3.5 w-3.5" /> Back
        </Button>
        <div className="flex items-center gap-2">
          <Brain className="h-4 w-4 text-accent" />
          <h1 className="text-sm font-semibold text-foreground">AI Simulation Analyst</h1>
        </div>
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="ml-auto text-xs bg-secondary text-secondary-foreground rounded px-2 py-1.5 border border-border"
        >
          <option value="google/gemini-3.1-pro-preview">Gemini 3.1 Pro</option>
          <option value="google/gemini-3-pro-image-preview">Gemini 3 Pro Image</option>
          <option value="google/gemini-2.5-pro">Gemini 2.5 Pro</option>
          <option value="google/gemini-2.5-flash">Gemini 2.5 Flash</option>
        </select>
      </div>

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Gallery sidebar */}
        <div className="w-80 border-r border-border flex flex-col">
          <div className="px-3 py-2 border-b border-border">
            <p className="text-xs text-muted-foreground font-medium">
              {screenshots.length} screenshot{screenshots.length !== 1 ? 's' : ''}
            </p>
          </div>
          <ScrollArea className="flex-1">
            <div className="p-3 space-y-2">
              {screenshots.length === 0 ? (
                <div className="text-center py-12 space-y-2">
                  <ImageIcon className="h-6 w-6 text-muted-foreground mx-auto" />
                  <p className="text-xs text-muted-foreground">
                    Capture screenshots from the simulation views
                  </p>
                </div>
              ) : (
                screenshots.map((s) => (
                  <div
                    key={s.id}
                    onClick={() => setSelected(s)}
                    className={`group flex gap-2 p-2 rounded-md border cursor-pointer transition-colors ${
                      selected?.id === s.id
                        ? 'border-accent bg-accent/10'
                        : 'border-border hover:border-accent/40'
                    }`}
                  >
                    <div className="w-14 h-10 rounded overflow-hidden bg-muted flex-shrink-0">
                      <img src={s.image_url} alt="" className="w-full h-full object-cover" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] font-medium text-foreground truncate">
                        {s.source} · {s.trigger_type}
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        {new Date(s.created_at).toLocaleString()}
                      </p>
                      {s.analysis && <p className="text-[10px] text-accent">✓ Analyzed</p>}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 opacity-0 group-hover:opacity-100"
                      onClick={(e) => { e.stopPropagation(); handleDelete(s); }}
                    >
                      <Trash2 className="h-3 w-3 text-destructive" />
                    </Button>
                  </div>
                ))
              )}
            </div>
          </ScrollArea>
        </div>

        {/* Detail view */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {selected ? (
            <ScrollArea className="flex-1">
              <div className="p-6 space-y-6 max-w-3xl">
                {/* Image */}
                <div className="rounded-lg overflow-hidden border border-border shadow-lg">
                  <img src={selected.image_url} alt="Simulation" className="w-full" />
                </div>

                {/* Metadata */}
                <div className="flex flex-wrap gap-3 text-[10px] font-mono text-muted-foreground">
                  <span>source: <span className="text-foreground">{selected.source}</span></span>
                  <span>trigger: <span className="text-foreground">{selected.trigger_type}</span></span>
                  <span>time: <span className="text-foreground">{new Date(selected.created_at).toLocaleString()}</span></span>
                  {selected.model_used && (
                    <span>model: <span className="text-foreground">{selected.model_used}</span></span>
                  )}
                </div>

                {/* Analyze */}
                <Button
                  onClick={() => handleAnalyze(selected)}
                  disabled={analyzing}
                  className="gap-2"
                >
                  {analyzing ? (
                    <><Loader2 className="h-4 w-4 animate-spin" /> Analyzing…</>
                  ) : (
                    <><Brain className="h-4 w-4" /> {selected.analysis ? 'Re-analyze' : 'Analyze with AI'}</>
                  )}
                </Button>

                {/* Analysis */}
                {selected.analysis && (
                  <div className="bg-secondary/30 rounded-lg p-5 border border-border">
                    <div className="prose prose-sm prose-invert max-w-none">
                      <ReactMarkdown>{selected.analysis}</ReactMarkdown>
                    </div>
                  </div>
                )}
              </div>
            </ScrollArea>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center space-y-3">
                <Brain className="h-10 w-10 text-muted-foreground mx-auto" />
                <p className="text-sm text-muted-foreground">Select a screenshot to analyze</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
