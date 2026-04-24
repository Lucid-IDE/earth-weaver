// ── Automated Self-Test Runner ──────────────────────────────────────
// Synthesizes inputs, samples telemetry before/after, and verifies the
// expected state delta occurred. Reports pass/fail per subsystem.

import { telemetryBus, TelemetryFrame } from './telemetryBus';
import { holdKey, tapKey, releaseAll } from './virtualInput';

export type TestStatus = 'pending' | 'running' | 'pass' | 'fail' | 'skip';

export interface TestResult {
  id: string;
  name: string;
  status: TestStatus;
  expected: string;
  measured: string;
  detail?: string;
  durationMs?: number;
}

export interface TestSuiteState {
  results: TestResult[];
  running: boolean;
  current: string | null;
}

const ALL_KEYS = [
  'KeyW','KeyS','KeyA','KeyD','KeyI','KeyK','KeyJ','KeyL',
  'KeyR','KeyF','KeyQ','KeyE','KeyT','KeyG','KeyY','KeyH',
  'ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space','KeyV','KeyB',
];

function snap(): TelemetryFrame | null { return telemetryBus.getLatest(); }
async function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function makeResult(id: string, name: string, expected: string): TestResult {
  return { id, name, status: 'pending', expected, measured: '' };
}

export type ProgressCb = (state: TestSuiteState) => void;

export class DiagnosticTestRunner {
  private results: TestResult[] = [];
  private running = false;
  private current: string | null = null;
  private cb: ProgressCb | null = null;

  onProgress(cb: ProgressCb) { this.cb = cb; }

  private emit() {
    this.cb?.({ results: this.results.slice(), running: this.running, current: this.current });
  }

  private async runTest(
    r: TestResult,
    fn: () => Promise<{ pass: boolean; measured: string; detail?: string }>,
  ) {
    this.current = r.id;
    r.status = 'running';
    this.emit();
    const t0 = performance.now();
    try {
      const { pass, measured, detail } = await fn();
      r.status = pass ? 'pass' : 'fail';
      r.measured = measured;
      r.detail = detail;
    } catch (e) {
      r.status = 'fail';
      r.measured = 'exception';
      r.detail = String(e);
    }
    r.durationMs = Math.round(performance.now() - t0);
    this.emit();
  }

  async runAll(): Promise<TestResult[]> {
    if (this.running) return this.results;
    this.running = true;
    this.results = [];
    this.emit();

    releaseAll(ALL_KEYS);

    // ── Bootstrap: telemetry alive ──
    const r0 = makeResult('telemetry', 'Telemetry bus alive', 'frame published within 500ms');
    this.results.push(r0);
    await this.runTest(r0, async () => {
      const start = performance.now();
      let f: TelemetryFrame | null = null;
      while (performance.now() - start < 500) {
        f = snap();
        if (f && f.render.fps > 0) break;
        await wait(20);
      }
      return f
        ? { pass: true, measured: `fps=${f.render.fps.toFixed(0)} t=${f.t.toFixed(2)}` }
        : { pass: false, measured: 'no frame' };
    });

    // Switch to excavator
    const rSwitch = makeResult('switch-exc', 'Switch to Excavator (Digit1)', 'active === excavator');
    this.results.push(rSwitch);
    await this.runTest(rSwitch, async () => {
      await tapKey('Digit1');
      await wait(120);
      const f = snap();
      return f && f.active === 'excavator'
        ? { pass: true, measured: `active=${f.active}` }
        : { pass: false, measured: `active=${f?.active}` };
    });

    // ── Excavator drive: forward ──
    await this.driveTest('exc-fwd', 'Excavator forward (ArrowUp)', 'ArrowUp', 800,
      (b, a) => a.exc.forwardVel - b.exc.forwardVel,
      (d) => d > 0.005, 'forwardVel Δ');

    await this.driveTest('exc-back', 'Excavator reverse (ArrowDown)', 'ArrowDown', 800,
      (b, a) => a.exc.forwardVel - b.exc.forwardVel,
      (d) => d < -0.005, 'forwardVel Δ');

    await this.driveTest('exc-pivL', 'Excavator pivot left (ArrowLeft)', 'ArrowLeft', 800,
      (b, a) => a.exc.angularVel - b.exc.angularVel,
      (d) => d < -0.02, 'angularVel Δ');

    await this.driveTest('exc-pivR', 'Excavator pivot right (ArrowRight)', 'ArrowRight', 800,
      (b, a) => a.exc.angularVel - b.exc.angularVel,
      (d) => d > 0.02, 'angularVel Δ');

    await this.driveTest('exc-leftTrack', 'Excavator left track only (W)', 'KeyW', 700,
      (b, a) => a.exc.leftTrackVel,
      (d) => d > 0.02, 'leftTrackVel');

    await this.driveTest('exc-rightTrack', 'Excavator right track only (I)', 'KeyI', 700,
      (b, a) => a.exc.rightTrackVel,
      (d) => d > 0.02, 'rightTrackVel');

    // ── Joints ──
    await this.jointTest('exc-boomUp', 'Boom up (R)', 'KeyR', 600,
      (b, a) => a.joints.boom - b.joints.boom, (d) => Math.abs(d) > 0.02, 'boom Δrad');
    await this.jointTest('exc-boomDown', 'Boom down (F)', 'KeyF', 600,
      (b, a) => a.joints.boom - b.joints.boom, (d) => Math.abs(d) > 0.02, 'boom Δrad');
    await this.jointTest('exc-stickIn', 'Stick in (J)', 'KeyJ', 600,
      (b, a) => a.joints.stick - b.joints.stick, (d) => Math.abs(d) > 0.02, 'stick Δrad');
    await this.jointTest('exc-stickOut', 'Stick out (L)', 'KeyL', 600,
      (b, a) => a.joints.stick - b.joints.stick, (d) => Math.abs(d) > 0.02, 'stick Δrad');
    await this.jointTest('exc-bucketCurl', 'Bucket curl (Q)', 'KeyQ', 600,
      (b, a) => a.joints.bucket - b.joints.bucket, (d) => Math.abs(d) > 0.02, 'bucket Δrad');
    await this.jointTest('exc-bucketDump', 'Bucket dump (E)', 'KeyE', 600,
      (b, a) => a.joints.bucket - b.joints.bucket, (d) => Math.abs(d) > 0.02, 'bucket Δrad');
    await this.jointTest('exc-swingL', 'Cab swing left (A)', 'KeyA', 600,
      (b, a) => a.joints.swing - b.joints.swing, (d) => Math.abs(d) > 0.02, 'swing Δrad');
    await this.jointTest('exc-swingR', 'Cab swing right (D)', 'KeyD', 600,
      (b, a) => a.joints.swing - b.joints.swing, (d) => Math.abs(d) > 0.02, 'swing Δrad');

    // ── Engine RPM responds to throttle ──
    const rRpm = makeResult('exc-rpm', 'Engine RPM rises with throttle', 'rpm Δ > 200');
    this.results.push(rRpm);
    await this.runTest(rRpm, async () => {
      const before = snap();
      await holdKey('ArrowUp', 700);
      await wait(60);
      const after = snap();
      const d = (after?.exc.rpm ?? 0) - (before?.exc.rpm ?? 0);
      return { pass: d > 200, measured: `Δrpm=${d.toFixed(0)}` };
    });

    // ── Hydraulic pressure rises on arm load ──
    const rHyd = makeResult('exc-hyd', 'Hydraulic pressure rises on boom command', 'hydPressure > 0.15');
    this.results.push(rHyd);
    await this.runTest(rHyd, async () => {
      await holdKey('KeyR', 500);
      await wait(60);
      const f = snap();
      const p = f?.exc.hydPressure ?? 0;
      return { pass: p > 0.15, measured: `hydPressure=${p.toFixed(3)}` };
    });

    // ── Switch to bulldozer ──
    const rSwitch2 = makeResult('switch-doz', 'Switch to Bulldozer (Digit2)', 'active === bulldozer');
    this.results.push(rSwitch2);
    await this.runTest(rSwitch2, async () => {
      await tapKey('Digit2');
      await wait(120);
      const f = snap();
      return f && f.active === 'bulldozer'
        ? { pass: true, measured: `active=${f.active}` }
        : { pass: false, measured: `active=${f?.active}` };
    });

    await this.driveTest('doz-fwd', 'Bulldozer forward (ArrowUp)', 'ArrowUp', 800,
      (b, a) => a.doz.forwardVel - b.doz.forwardVel,
      (d) => d > 0.005, 'forwardVel Δ', 'bulldozer');

    await this.driveTest('doz-pivR', 'Bulldozer pivot right (ArrowRight)', 'ArrowRight', 800,
      (b, a) => a.doz.angularVel - b.doz.angularVel,
      (d) => d > 0.02, 'angularVel Δ', 'bulldozer');

    await this.jointTest('doz-bladeUp', 'Blade up (R)', 'KeyR', 600,
      (b, a) => a.joints.bladeHeight - b.joints.bladeHeight,
      (d) => Math.abs(d) > 0.001, 'blade Δm');
    await this.jointTest('doz-bladeDown', 'Blade down (F)', 'KeyF', 600,
      (b, a) => a.joints.bladeHeight - b.joints.bladeHeight,
      (d) => Math.abs(d) > 0.001, 'blade Δm');

    // ── Render health ──
    const rRender = makeResult('render-fps', 'Render FPS reasonable', 'fps >= 20');
    this.results.push(rRender);
    await this.runTest(rRender, async () => {
      const f = snap();
      const fps = f?.render.fps ?? 0;
      return { pass: fps >= 20, measured: `fps=${fps.toFixed(1)}`,
        detail: fps < 20 ? 'GPU may be overloaded; reduce particle/render scale' : undefined };
    });

    // Cleanup
    releaseAll(ALL_KEYS);
    this.running = false;
    this.current = null;
    this.emit();
    return this.results;
  }

  private async driveTest(
    id: string, name: string, key: string, holdMs: number,
    metric: (b: TelemetryFrame, a: TelemetryFrame) => number,
    pred: (d: number) => boolean,
    label: string,
    machine: 'excavator' | 'bulldozer' = 'excavator',
  ) {
    const r = makeResult(id, name, `${label} satisfies predicate`);
    this.results.push(r);
    await this.runTest(r, async () => {
      // Ensure correct machine active
      const cur = snap();
      if (cur?.active !== machine) {
        await tapKey(machine === 'excavator' ? 'Digit1' : 'Digit2');
        await wait(120);
      }
      const before = snap()!;
      await holdKey(key, holdMs);
      await wait(60);
      const after = snap()!;
      const d = metric(before, after);
      return { pass: pred(d), measured: `${label}=${d.toFixed(4)}` };
    });
  }

  private async jointTest(
    id: string, name: string, key: string, holdMs: number,
    metric: (b: TelemetryFrame, a: TelemetryFrame) => number,
    pred: (d: number) => boolean,
    label: string,
  ) {
    const r = makeResult(id, name, `${label} satisfies predicate`);
    this.results.push(r);
    await this.runTest(r, async () => {
      const before = snap()!;
      await holdKey(key, holdMs);
      await wait(60);
      const after = snap()!;
      const d = metric(before, after);
      return { pass: pred(d), measured: `${label}=${d.toFixed(4)}` };
    });
  }
}
