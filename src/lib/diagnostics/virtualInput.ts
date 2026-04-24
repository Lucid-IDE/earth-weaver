// ── Virtual Input Injector ──────────────────────────────────────────
// Synthesizes keydown/keyup events on window so the existing controls
// pipeline registers them. Used by self-tests to simulate operator input.

export function pressKey(code: string) {
  window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true }));
}

export function releaseKey(code: string) {
  window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code, bubbles: true }));
}

export async function holdKey(code: string, ms: number) {
  pressKey(code);
  await new Promise((r) => setTimeout(r, ms));
  releaseKey(code);
}

export async function tapKey(code: string) {
  pressKey(code);
  await new Promise((r) => setTimeout(r, 30));
  releaseKey(code);
}

export function releaseAll(codes: string[]) {
  codes.forEach(releaseKey);
}
