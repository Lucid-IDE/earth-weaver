import { useState, useCallback } from 'react';
import { Brain, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import ReactMarkdown from 'react-markdown';
import { supabase } from '@/integrations/supabase/client';
import type { Screenshot } from '@/lib/analyst/screenshotService';
import { toast } from '@/components/ui/sonner';

interface StreamingAnalysisProps {
  screenshot: Screenshot;
  model: string;
  codeContext: string;
  docsContext: string;
  onAnalysisComplete: (analysis: string) => void;
}

export default function StreamingAnalysis({
  screenshot,
  model,
  codeContext,
  docsContext,
  onAnalysisComplete,
}: StreamingAnalysisProps) {
  const [streaming, setStreaming] = useState(false);
  const [streamedText, setStreamedText] = useState(screenshot.analysis || '');

  const handleAnalyze = useCallback(async () => {
    setStreaming(true);
    setStreamedText('');

    try {
      // Fetch image as base64
      const imgResponse = await fetch(screenshot.image_url);
      const imgBlob = await imgResponse.blob();
      const reader = new FileReader();
      const imageBase64 = await new Promise<string>((resolve) => {
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(imgBlob);
      });

      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/analyze-screenshot`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
        },
        body: JSON.stringify({
          imageBase64,
          source: screenshot.source,
          metadata: screenshot.metadata,
          codeContext,
          docsContext,
          model,
          stream: true,
        }),
      });

      if (!resp.ok) {
        if (resp.status === 429) {
          toast.error('Rate limited — please try again in a moment.');
          return;
        }
        if (resp.status === 402) {
          toast.error('Credits exhausted — add funds in settings.');
          return;
        }
        throw new Error(`Analysis failed: ${resp.status}`);
      }

      // Check if streaming response
      const contentType = resp.headers.get('content-type') || '';
      if (contentType.includes('text/event-stream') && resp.body) {
        const bodyReader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullText = '';

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
            if (jsonStr === '[DONE]') break;
            try {
              const parsed = JSON.parse(jsonStr);
              const content = parsed.choices?.[0]?.delta?.content;
              if (content) {
                fullText += content;
                setStreamedText(fullText);
              }
            } catch { /* partial JSON */ }
          }
        }

        // Save to DB
        if (fullText) {
          await supabase
            .from('sim_screenshots')
            .update({ analysis: fullText, model_used: model })
            .eq('id', screenshot.id);
          onAnalysisComplete(fullText);
        }
      } else {
        // Non-streaming fallback
        const data = await resp.json();
        const analysis = data.analysis || 'No analysis generated.';
        setStreamedText(analysis);
        await supabase
          .from('sim_screenshots')
          .update({ analysis, model_used: model })
          .eq('id', screenshot.id);
        onAnalysisComplete(analysis);
      }
    } catch (e) {
      console.error('Analysis error:', e);
      toast.error('Analysis failed');
    } finally {
      setStreaming(false);
    }
  }, [screenshot, model, codeContext, docsContext, onAnalysisComplete]);

  return (
    <div className="space-y-3">
      <Button
        variant="default"
        size="sm"
        onClick={handleAnalyze}
        disabled={streaming}
        className="w-full gap-2"
      >
        {streaming ? (
          <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Analyzing…</>
        ) : (
          <><Brain className="h-3.5 w-3.5" /> {streamedText ? 'Re-analyze' : 'Analyze with AI'}</>
        )}
      </Button>

      {streamedText && (
        <div className="bg-secondary/50 rounded-md p-3 border border-border">
          <div className="prose prose-sm prose-invert max-w-none text-xs leading-relaxed">
            <ReactMarkdown>{streamedText}</ReactMarkdown>
          </div>
          {streaming && (
            <span className="inline-block w-2 h-4 bg-accent animate-pulse ml-1" />
          )}
        </div>
      )}
    </div>
  );
}
