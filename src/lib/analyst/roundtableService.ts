import { supabase } from '@/integrations/supabase/client';
import type { Screenshot } from './screenshotService';

export interface AgentResult {
  agentId: string;
  name: string;
  role: string;
  avatar: string;
  model?: string;
  content: string | null;
  error?: string | null;
  status?: number;
  thinking?: boolean;
}

export type RoundtableEvent =
  | { type: 'agent_start'; agentId: string; name: string; role: string; avatar: string }
  | { type: 'agent_result'; agentId: string; name: string; role: string; avatar: string; model: string; content: string | null; error: string | null; status: number };

/**
 * Run the AI roundtable analysis on a screenshot.
 * Streams SSE events as each agent completes.
 */
export async function runRoundtable(
  screenshot: Screenshot,
  onEvent: (event: RoundtableEvent | { type: 'done' }) => void,
  agents?: string[]
): Promise<void> {
  // Fetch image as base64
  const imgResponse = await fetch(screenshot.image_url);
  const imgBlob = await imgResponse.blob();
  const reader = new FileReader();
  const imageBase64 = await new Promise<string>((resolve) => {
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(imgBlob);
  });

  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/roundtable`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
    },
    body: JSON.stringify({
      imageBase64,
      metadata: screenshot.metadata,
      agents,
    }),
  });

  if (!resp.ok || !resp.body) {
    throw new Error(`Roundtable failed: ${resp.status}`);
  }

  const bodyReader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await bodyReader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line.startsWith('data: ')) continue;
      const jsonStr = line.slice(6).trim();
      if (jsonStr === '[DONE]') {
        onEvent({ type: 'done' });
        return;
      }
      try {
        const parsed = JSON.parse(jsonStr);
        onEvent(parsed);
      } catch { /* partial */ }
    }
  }

  onEvent({ type: 'done' });
}

/**
 * Save roundtable results back to the screenshot record.
 */
export async function saveRoundtableResults(
  screenshotId: string,
  results: AgentResult[]
): Promise<void> {
  const combinedAnalysis = results
    .filter(r => r.content)
    .map(r => `## ${r.avatar} ${r.name} — ${r.role}\n\n${r.content}`)
    .join('\n\n---\n\n');

  if (combinedAnalysis) {
    await supabase
      .from('sim_screenshots')
      .update({
        analysis: combinedAnalysis,
        model_used: 'roundtable',
      })
      .eq('id', screenshotId);
  }
}
