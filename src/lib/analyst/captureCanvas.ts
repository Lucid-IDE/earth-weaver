/**
 * Captures a screenshot from a canvas element (WebGL/WebGPU or iframe).
 * Returns a base64 data URL.
 */
export function captureCanvasScreenshot(
  canvasOrIframe: HTMLCanvasElement | HTMLIFrameElement
): string | null {
  try {
    if (canvasOrIframe instanceof HTMLIFrameElement) {
      // Try to grab canvas from inside iframe
      const iframeDoc = canvasOrIframe.contentDocument || canvasOrIframe.contentWindow?.document;
      if (!iframeDoc) return null;
      const canvas = iframeDoc.querySelector('canvas');
      if (!canvas) return null;
      return canvas.toDataURL('image/png');
    }
    return canvasOrIframe.toDataURL('image/png');
  } catch (e) {
    console.warn('Failed to capture canvas screenshot:', e);
    return null;
  }
}

/**
 * Finds the first canvas in the document (for R3F scenes) or in an iframe.
 */
export function findCaptureTarget(): HTMLCanvasElement | HTMLIFrameElement | null {
  // Check for iframe first (soil-lab.html)
  const iframe = document.querySelector('iframe[title*="Soil"]') as HTMLIFrameElement | null;
  if (iframe) return iframe;

  // Check for R3F canvas
  const canvas = document.querySelector('canvas') as HTMLCanvasElement | null;
  return canvas;
}
