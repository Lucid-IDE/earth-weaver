import { useEffect, useRef, useState } from 'react';
import { Activity, Play, Brain, X, ChevronDown, ChevronRight, RotateCcw, Flame } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { ScrollArea } from '@/components/ui/scroll-area';
import { telemetryBus, TelemetryFrame } from '@/lib/diagnostics/telemetryBus';
import { DiagnosticTestRunner, TestResult, TestSuiteState } from '@/lib/diagnostics/selfTest';
import { MPM_RUNTIME } from '@/lib/soil/soilSim';
import { mpmHealth, HealthMetrics } from '@/lib/mpm/mpmHealth';
import { supabase } from '@/integrations/supabase/client';
import { toast } from '@/hooks/use-toast';

export default function DiagnosticPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [frame, setFrame] = useState<TelemetryFrame | null>(null);
  const [suite, setSuite] = useState<TestSuiteState>({ results: [], running: false, current: null });
  const [aiBusy, setAiBusy] = useState(false);
  const [aiText, setAiText] = useState<string>('');
  const [mpmOn, setMpmOn] = useState(MPM_RUNTIME.enabled);
  const [health, setHealth] = useState<HealthMetrics>(mpmHealth.metrics);
  const [heatmap, setHeatmap] = useState(mpmHealth.heatmapEnabled);
  const [kRadius, setKRadius] = useState(mpmHealth.kernel.radius);
  const [kStrength, setKStrength] = useState(mpmHealth.kernel.strength);
  const [openSection, setOpenSection] = useState<Record<string, boolean>>({
    input: true, drive: true, joints: true, render: true, tests: true, ai: true,
    health: true, kernel: true, replay: true,
  });
  const runnerRef = useRef<DiagnosticTestRunner | null>(null);

  useEffect(() => {
    if (!open) return;
    const offT = telemetryBus.subscribe(setFrame);
    const offH = mpmHealth.subscribe(() => setHealth({ ...mpmHealth.metrics }));
    return () => { offT(); offH(); };
  }, [open]);

  useEffect(() => {
    if (!runnerRef.current) {
      runnerRef.current = new DiagnosticTestRunner();
      runnerRef.current.onProgress(setSuite);
    }
  }, []);

  if (!open) return null;

  const runTests = async () => {
    setAiText('');
    await runnerRef.current?.runAll();
  };

  const askAI = async () => {
    setAiBusy(true);
    setAiText('');
    try {
      const payload = {
        frame: telemetryBus.getLatest(),
        history: telemetryBus.getHistory().slice(-60), // ~3s
        tests: suite.results,
      };
      const { data, error } = await supabase.functions.invoke('diagnose', { body: payload });
      if (error) throw error;
      setAiText(data?.analysis ?? 'No analysis returned.');
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      setAiText(`AI error: ${msg}`);
      toast({ title: 'Diagnose failed', description: msg, variant: 'destructive' });
    } finally {
      setAiBusy(false);
    }
  };

  const passed = suite.results.filter((r) => r.status === 'pass').length;
  const failed = suite.results.filter((r) => r.status === 'fail').length;
  const total = suite.results.length;

  const Section = ({ id, title, children }: { id: string; title: string; children: React.ReactNode }) => (
    <div className="border-b border-border">
      <button
        onClick={() => setOpenSection((p) => ({ ...p, [id]: !p[id] }))}
        className="w-full flex items-center gap-1.5 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
      >
        {openSection[id] ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {title}
      </button>
      {openSection[id] && <div className="px-3 pb-3 space-y-1">{children}</div>}
    </div>
  );

  const Row = ({ k, v, hi }: { k: string; v: string | number; hi?: boolean }) => (
    <div className="flex justify-between text-[11px] font-mono leading-tight">
      <span className="text-muted-foreground">{k}</span>
      <span className={hi ? 'text-accent' : 'text-foreground'}>{typeof v === 'number' ? v.toFixed(3) : v}</span>
    </div>
  );

  return (
    <div className="fixed left-0 top-0 h-full w-[380px] bg-card border-r border-border z-50 flex flex-col shadow-2xl">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-accent" />
          <span className="text-sm font-semibold text-foreground">Live Diagnostics</span>
          {frame && <span className="text-[10px] text-muted-foreground font-mono">{frame.render.fps.toFixed(0)} fps</span>}
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} className="h-7 w-7">
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex flex-wrap gap-2 px-3 py-2 border-b border-border">
        <Button size="sm" onClick={runTests} disabled={suite.running} className="gap-1.5 flex-1 min-w-[140px]">
          <Play className="h-3 w-3" /> {suite.running ? `Running… ${suite.current ?? ''}` : 'Run All Tests'}
        </Button>
        <Button size="sm" variant="outline" onClick={askAI} disabled={aiBusy || !frame} className="gap-1.5">
          <Brain className="h-3 w-3" /> {aiBusy ? '…' : 'AI Diagnose'}
        </Button>
        <Button
          size="sm"
          variant={mpmOn ? 'default' : 'outline'}
          onClick={() => { MPM_RUNTIME.enabled = !MPM_RUNTIME.enabled; setMpmOn(MPM_RUNTIME.enabled); }}
          className="gap-1.5"
          title="Toggle MLS-MPM particle solver"
        >
          MPM: {mpmOn ? 'ON' : 'OFF'}
        </Button>
      </div>

      {total > 0 && (
        <div className="px-3 py-1.5 border-b border-border text-[11px] font-mono flex gap-3">
          <span className="text-emerald-400">✓ {passed}</span>
          <span className="text-destructive">✗ {failed}</span>
          <span className="text-muted-foreground">/ {total}</span>
        </div>
      )}

      <ScrollArea className="flex-1">
        <Section id="input" title="Input">
          {frame ? (
            <>
              <Row k="active" v={frame.active} hi />
              <Row k="exc.leftTrack" v={frame.input.exc.leftTrack} />
              <Row k="exc.rightTrack" v={frame.input.exc.rightTrack} />
              <Row k="exc.boom" v={frame.input.exc.boom} />
              <Row k="exc.stick" v={frame.input.exc.stick} />
              <Row k="exc.bucket" v={frame.input.exc.bucket} />
              <Row k="exc.swing" v={frame.input.exc.swing} />
              <Row k="doz.bladeUp" v={frame.input.doz.bladeUp} />
            </>
          ) : <div className="text-[11px] text-muted-foreground">no telemetry…</div>}
        </Section>

        <Section id="drive" title={`Drivetrain — ${frame?.active ?? '—'}`}>
          {frame && (() => {
            if (frame.active === 'dumpTruck' && frame.truck) {
              const t = frame.truck;
              return (
                <>
                  <Row k="rpm" v={t.rpm.toFixed(0)} hi={t.rpm > 900} />
                  <Row k="throttle" v={t.throttle} />
                  <Row k="forward v" v={t.forwardVel} hi={Math.abs(t.forwardVel) > 0.005} />
                  <Row k="steer°" v={(t.steeringAngle * 180 / Math.PI).toFixed(1)} />
                  <Row k="wheel rot" v={t.wheelRotation} />
                  <Row k="bed°" v={(t.bedAngle * 180 / Math.PI).toFixed(1)} hi={t.bedAngle > 0.05} />
                  <Row k="load" v={t.bedLoad} />
                  <Row k="tire psi" v={t.tirePressurePsi.toFixed(0)} />
                  <Row k="avg tire defl" v={`${(t.avgTireDeflection * 1000).toFixed(1)}mm`} hi={t.avgTireDeflection > 0.004} />
                  <Row k="max tire defl" v={`${(t.maxTireDeflection * 1000).toFixed(1)}mm`} hi={t.maxTireDeflection > 0.006} />
                  <Row k="pos" v={`${t.posX.toFixed(3)}, ${t.posZ.toFixed(3)}`} />
                  <Row k="heading°" v={(t.heading * 180 / Math.PI).toFixed(1)} />
                </>
              );
            }
            const p = frame.active === 'bulldozer' ? frame.doz : frame.exc;
            return (
              <>
                <Row k="rpm" v={p.rpm.toFixed(0)} hi={p.rpm > 100} />
                <Row k="throttle" v={p.throttle} />
                <Row k="engine torque" v={p.engineTorque} />
                <Row k="stalled" v={p.engineStalled ? 'YES' : 'no'} />
                <Row k="lugging" v={p.engineLugging ? 'YES' : 'no'} />
                <Row k="hyd.pressure" v={p.hydPressure} />
                <Row k="hyd.flow" v={p.hydFlow} />
                <Row k="L drive τ" v={p.leftDriveTorque} />
                <Row k="R drive τ" v={p.rightDriveTorque} />
                <Row k="L track v" v={p.leftTrackVel} hi={Math.abs(p.leftTrackVel) > 0.01} />
                <Row k="R track v" v={p.rightTrackVel} hi={Math.abs(p.rightTrackVel) > 0.01} />
                <Row k="forward v" v={p.forwardVel} hi={Math.abs(p.forwardVel) > 0.005} />
                <Row k="angular v" v={p.angularVel} hi={Math.abs(p.angularVel) > 0.02} />
                <Row k="slip" v={p.slip} />
                <Row k="L sinkage" v={p.leftSinkage} />
                <Row k="R sinkage" v={p.rightSinkage} />
                <Row k="ground res" v={p.groundResistance} />
                <Row k="pos" v={`${p.posX.toFixed(3)}, ${p.posZ.toFixed(3)}`} />
                <Row k="heading°" v={(p.heading * 180 / Math.PI).toFixed(1)} />
              </>
            );
          })()}
        </Section>

        <Section id="joints" title="Kinematics">
          {frame && (
            <>
              <Row k="swing rad" v={frame.joints.swing} />
              <Row k="boom rad" v={frame.joints.boom} />
              <Row k="stick rad" v={frame.joints.stick} />
              <Row k="bucket rad" v={frame.joints.bucket} />
              <Row k="bucket fill" v={frame.joints.bucketFill} />
              <Row k="blade height" v={frame.joints.bladeHeight} />
              <Row k="blade tilt°" v={frame.joints.bladeTilt} />
              <Row k="blade angle°" v={frame.joints.bladeAngle} />
            </>
          )}
        </Section>

        <Section id="render" title="Render">
          {frame && (
            <>
              <Row k="fps" v={frame.render.fps.toFixed(1)} hi={frame.render.fps >= 30} />
              <Row k="frame ms" v={frame.render.frameMs.toFixed(1)} />
              <Row k="vertices" v={frame.render.vertices} />
              <Row k="triangles" v={frame.render.triangles} />
              <Row k="active particles" v={frame.render.activeParticles} />
              <Row k="total particles" v={frame.render.totalParticles} />
              <Row k="sim active" v={frame.render.simActive ? 'YES' : 'no'} />
            </>
          )}
        </Section>

        <Section id="health" title="MPM Health">
          <Row k="tripped" v={health.tripped ? `YES — ${health.tripReason}` : 'no'} hi={health.tripped} />
          <Row k="grid mass min" v={health.gridMassMin.toExponential(2)} />
          <Row k="grid mass max" v={health.gridMassMax.toExponential(2)} />
          <Row k="grid active" v={health.gridMassActive} />
          <Row k="grid vel max" v={health.gridVelMax.toExponential(2)} />
          <Row k="grid NaN" v={health.gridNaNCount} hi={health.gridNaNCount > 0} />
          <Row k="part vel max" v={health.partVelMax.toExponential(2)} />
          <Row k="part NaN" v={health.partNaNCount} hi={health.partNaNCount > 0} />
          <Row k="σ min" v={health.sigmaMin.toExponential(2)} />
          <Row k="σ max" v={health.sigmaMax.toExponential(2)} hi={health.sigmaMax > 5} />
          <div className="flex gap-2 pt-1.5">
            <Button size="sm" variant={heatmap ? 'default' : 'outline'}
              onClick={() => { mpmHealth.heatmapEnabled = !mpmHealth.heatmapEnabled; setHeatmap(mpmHealth.heatmapEnabled); }}
              className="gap-1.5 flex-1 h-7 text-[11px]"><Flame className="h-3 w-3" /> NaN Heatmap</Button>
            <Button size="sm" variant="outline" onClick={() => mpmHealth.reset()} className="h-7 text-[11px]">Reset</Button>
          </div>
          {mpmHealth.postMortem && (
            <div className="mt-2 p-2 rounded bg-destructive/10 border border-destructive/30 text-[10px] font-mono">
              <div className="text-destructive font-semibold mb-1">POST-MORTEM</div>
              <div>grid NaN: {mpmHealth.postMortem.metrics.gridNaNCount}, part NaN: {mpmHealth.postMortem.metrics.partNaNCount}</div>
              <div>first grid idx: {mpmHealth.postMortem.hotspot.firstGridIdx}</div>
              <div>first part idx: {mpmHealth.postMortem.hotspot.firstParticleIdx}</div>
              {mpmHealth.postMortem.digEvent && (<div className="mt-1 text-amber-400">dig seed={mpmHealth.postMortem.digEvent.rngSeed} r={mpmHealth.postMortem.digEvent.radius.toFixed(3)}</div>)}
            </div>
          )}
        </Section>

        <Section id="kernel" title="Disturbance Kernel (Wendland)">
          <div><div className="flex justify-between text-[11px] font-mono"><span>radius ×</span><span className="text-accent">{kRadius.toFixed(2)}</span></div>
            <Slider min={0.2} max={3} step={0.05} value={[kRadius]} onValueChange={([v]) => { setKRadius(v); mpmHealth.kernel.radius = v; }} /></div>
          <div className="mt-2"><div className="flex justify-between text-[11px] font-mono"><span>strength</span><span className="text-accent">{kStrength.toFixed(3)}</span></div>
            <Slider min={0} max={1.5} step={0.01} value={[kStrength]} onValueChange={([v]) => { setKStrength(v); mpmHealth.kernel.strength = v; }} /></div>
          <Button size="sm" variant={mpmHealth.kernel.enabled ? 'default' : 'outline'} onClick={() => { mpmHealth.kernel.enabled = !mpmHealth.kernel.enabled; setHealth({ ...mpmHealth.metrics }); }} className="w-full mt-2 h-7 text-[11px]">Smoothed: {mpmHealth.kernel.enabled ? 'ON' : 'OFF (legacy)'}</Button>
        </Section>

        <Section id="replay" title="Deterministic Replay">
          {health.lastDig ? (<>
            <Row k="src" v={health.lastDig.source} />
            <Row k="seed" v={health.lastDig.rngSeed} />
            <Row k="x" v={health.lastDig.worldX} /><Row k="y" v={health.lastDig.worldY} /><Row k="z" v={health.lastDig.worldZ} />
            <Row k="radius" v={health.lastDig.radius} />
            <Button size="sm" variant="outline" className="gap-1.5 w-full mt-1.5 h-7 text-[11px]" onClick={() => { const d = mpmHealth.getLastDig(); if (!d) return; mpmHealth.rngSeedForNextDig = d.rngSeed; window.dispatchEvent(new CustomEvent('mpm:replay-dig', { detail: d })); toast({ title: 'Replay queued', description: `seed=${d.rngSeed}` }); }}><RotateCcw className="h-3 w-3" /> Replay last dig</Button>
          </>) : (<div className="text-[11px] text-muted-foreground">No dig recorded yet.</div>)}
        </Section>

        <Section id="tests" title="Self-Test Results">
          {suite.results.length === 0 && (
            <div className="text-[11px] text-muted-foreground">Click "Run All Tests" to verify every control end-to-end.</div>
          )}
          {suite.results.map((r) => (
            <div key={r.id} className="text-[11px] py-1 border-b border-border/50 last:border-0">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-foreground truncate">{r.name}</span>
                <span className={
                  r.status === 'pass' ? 'text-emerald-400' :
                  r.status === 'fail' ? 'text-destructive' :
                  r.status === 'running' ? 'text-accent animate-pulse' :
                  'text-muted-foreground'
                }>
                  {r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : r.status === 'running' ? '…' : '·'}
                </span>
              </div>
              <div className="font-mono text-[10px] text-muted-foreground">
                expect: {r.expected}
              </div>
              {r.measured && (
                <div className={`font-mono text-[10px] ${r.status === 'fail' ? 'text-destructive' : 'text-foreground/80'}`}>
                  got: {r.measured} {r.durationMs ? `(${r.durationMs}ms)` : ''}
                </div>
              )}
              {r.detail && <div className="text-[10px] text-amber-400 mt-0.5">{r.detail}</div>}
            </div>
          ))}
        </Section>

        <Section id="ai" title="AI Analysis">
          {aiText ? (
            <pre className="text-[11px] whitespace-pre-wrap text-foreground font-mono leading-relaxed">{aiText}</pre>
          ) : (
            <div className="text-[11px] text-muted-foreground">
              Run tests then click "AI Diagnose" — the model will inspect telemetry, history, and test results to identify the root cause of any failures.
            </div>
          )}
        </Section>
      </ScrollArea>
    </div>
  );
}
