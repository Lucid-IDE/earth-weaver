import { useState, useEffect, useCallback } from 'react';
import { X, Brain, Trash2, ChevronRight, Loader2, ImageIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import ReactMarkdown from 'react-markdown';
import {
  fetchScreenshots,
  analyzeScreenshot,
  deleteScreenshot,
  type Screenshot,
} from '@/lib/analyst/screenshotService';
import CaptureButton from './CaptureButton';

// Code context snippets to feed the AI
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

interface AnalystPanelProps {
  isOpen: boolean;
  onClose: () => void;
  source: string;
  metadata?: Record<string, any>;
}

export default function AnalystPanel({ isOpen, onClose, source, metadata = {} }: AnalystPanelProps) {
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]);
  const [selected, setSelected] = useState<Screenshot | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [model, setModel] = useState<string>('google/gemini-3.1-pro-preview');

  const loadScreenshots = useCallback(async () => {
    const data = await fetchScreenshots();
    setScreenshots(data);
  }, []);

  useEffect(() => {
    if (isOpen) loadScreenshots();
  }, [isOpen, loadScreenshots]);

  const handleAnalyze = async (screenshot: Screenshot) => {
    setAnalyzing(true);
    setSelected(screenshot);
    try {
      const analysis = await analyzeScreenshot(screenshot, CODE_CONTEXT, DOCS_CONTEXT, model);
      if (analysis) {
        setSelected((prev) => prev ? { ...prev, analysis } : null);
        await loadScreenshots();
      }
    } finally {
      setAnalyzing(false);
    }
  };

  const handleDelete = async (screenshot: Screenshot) => {
    await deleteScreenshot(screenshot);
    if (selected?.id === screenshot.id) setSelected(null);
    await loadScreenshots();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed right-0 top-0 h-full w-[420px] bg-card border-l border-border z-50 flex flex-col shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <Brain className="h-4 w-4 text-accent" />
          <span className="text-sm font-semibold text-foreground">AI Analyst</span>
        </div>
        <div className="flex items-center gap-2">
          <CaptureButton source={source} metadata={metadata} onCapture={(s) => {
            setScreenshots((prev) => [s, ...prev]);
            setSelected(s);
          }} />
          <Button variant="ghost" size="icon" onClick={onClose} className="h-7 w-7">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Model selector */}
      <div className="px-4 py-2 border-b border-border">
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="w-full text-xs bg-secondary text-secondary-foreground rounded px-2 py-1.5 border border-border"
        >
          <option value="google/gemini-3.1-pro-preview">Gemini 3.1 Pro (best analysis)</option>
          <option value="google/gemini-3-pro-image-preview">Gemini 3 Pro Image (image gen)</option>
          <option value="google/gemini-2.5-pro">Gemini 2.5 Pro (reasoning)</option>
          <option value="google/gemini-2.5-flash">Gemini 2.5 Flash (fast)</option>
        </select>
      </div>

      {/* Content */}
      <ScrollArea className="flex-1">
        {selected ? (
          <div className="p-4 space-y-4">
            {/* Back button */}
            <button
              onClick={() => setSelected(null)}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              ← All screenshots
            </button>

            {/* Selected image */}
            <div className="rounded-md overflow-hidden border border-border">
              <img
                src={selected.image_url}
                alt="Simulation screenshot"
                className="w-full"
              />
            </div>

            {/* Metadata */}
            <div className="text-[10px] text-muted-foreground font-mono space-y-0.5">
              <p>source: <span className="text-foreground">{selected.source}</span></p>
              <p>trigger: <span className="text-foreground">{selected.trigger_type}</span></p>
              <p>captured: <span className="text-foreground">{new Date(selected.created_at).toLocaleString()}</span></p>
              {selected.model_used && (
                <p>model: <span className="text-foreground">{selected.model_used}</span></p>
              )}
            </div>

            {/* Analyze button */}
            <Button
              variant="default"
              size="sm"
              onClick={() => handleAnalyze(selected)}
              disabled={analyzing}
              className="w-full gap-2"
            >
              {analyzing ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Analyzing…
                </>
              ) : (
                <>
                  <Brain className="h-3.5 w-3.5" />
                  {selected.analysis ? 'Re-analyze' : 'Analyze with AI'}
                </>
              )}
            </Button>

            {/* Analysis result */}
            {selected.analysis && (
              <div className="bg-secondary/50 rounded-md p-3 border border-border">
                <div className="prose prose-sm prose-invert max-w-none text-xs leading-relaxed">
                  <ReactMarkdown>{selected.analysis}</ReactMarkdown>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="p-4 space-y-3">
            {screenshots.length === 0 ? (
              <div className="text-center py-12 space-y-3">
                <ImageIcon className="h-8 w-8 text-muted-foreground mx-auto" />
                <p className="text-sm text-muted-foreground">No screenshots yet</p>
                <p className="text-xs text-muted-foreground">
                  Click "Capture" to take a screenshot of the current simulation view
                </p>
              </div>
            ) : (
              screenshots.map((s) => (
                <div
                  key={s.id}
                  className="group relative flex items-center gap-3 p-2 rounded-md border border-border hover:border-accent/50 cursor-pointer transition-colors"
                  onClick={() => setSelected(s)}
                >
                  <div className="w-16 h-12 rounded overflow-hidden bg-muted flex-shrink-0">
                    <img
                      src={s.image_url}
                      alt=""
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-foreground truncate">
                      {s.source} · {s.trigger_type}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      {new Date(s.created_at).toLocaleString()}
                    </p>
                    {s.analysis && (
                      <p className="text-[10px] text-accent mt-0.5">✓ Analyzed</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={(e) => { e.stopPropagation(); handleDelete(s); }}
                    >
                      <Trash2 className="h-3 w-3 text-destructive" />
                    </Button>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
