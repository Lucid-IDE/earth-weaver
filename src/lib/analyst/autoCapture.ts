import { findCaptureTarget, captureCanvasScreenshot } from './captureCanvas';
import { saveScreenshot, type Screenshot } from './screenshotService';

type AutoCaptureEvent = 'dig' | 'sim-start' | 'sim-settle' | 'view-change';

interface AutoCaptureConfig {
  enabled: boolean;
  cooldownMs: number; // min time between auto-captures
  source: string;
}

const DEFAULT_CONFIG: AutoCaptureConfig = {
  enabled: true,
  cooldownMs: 5000,
  source: 'soil-terrain',
};

let lastCaptureTime = 0;
let listeners: ((s: Screenshot) => void)[] = [];

export function onAutoCapture(cb: (s: Screenshot) => void) {
  listeners.push(cb);
  return () => { listeners = listeners.filter(l => l !== cb); };
}

export async function triggerAutoCapture(
  event: AutoCaptureEvent,
  metadata: Record<string, any> = {},
  config: Partial<AutoCaptureConfig> = {}
): Promise<Screenshot | null> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  if (!cfg.enabled) return null;

  const now = Date.now();
  if (now - lastCaptureTime < cfg.cooldownMs) return null;

  const target = findCaptureTarget();
  if (!target) return null;

  const dataUrl = captureCanvasScreenshot(target);
  if (!dataUrl) return null;

  lastCaptureTime = now;
  const screenshot = await saveScreenshot(
    dataUrl,
    cfg.source,
    'auto',
    { ...metadata, event }
  );

  if (screenshot) {
    listeners.forEach(cb => cb(screenshot));
  }
  return screenshot;
}

/**
 * Create a settle detector that triggers auto-capture
 * when simulation goes from active → idle.
 */
export function createSettleDetector(source: string) {
  let wasActive = false;
  let settleTimeout: ReturnType<typeof setTimeout> | null = null;

  return (simActive: boolean, metadata: Record<string, any>) => {
    if (simActive) {
      wasActive = true;
      if (settleTimeout) {
        clearTimeout(settleTimeout);
        settleTimeout = null;
      }
    } else if (wasActive && !simActive) {
      // Sim just settled — wait a beat then capture
      wasActive = false;
      settleTimeout = setTimeout(() => {
        triggerAutoCapture('sim-settle', metadata, { source });
      }, 800);
    }
  };
}
