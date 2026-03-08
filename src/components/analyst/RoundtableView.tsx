import { useState, useCallback } from 'react';
import { Users, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import ReactMarkdown from 'react-markdown';
import { toast } from '@/components/ui/sonner';
import type { Screenshot } from '@/lib/analyst/screenshotService';
import {
  runRoundtable,
  saveRoundtableResults,
  type AgentResult,
  type RoundtableEvent,
} from '@/lib/analyst/roundtableService';

interface RoundtableViewProps {
  screenshot: Screenshot;
  onComplete: (analysis: string) => void;
}

export default function RoundtableView({ screenshot, onComplete }: RoundtableViewProps) {
  const [running, setRunning] = useState(false);
  const [agents, setAgents] = useState<AgentResult[]>([]);

  const handleRun = useCallback(async () => {
    setRunning(true);
    setAgents([]);

    try {
      await runRoundtable(
        screenshot,
        (event: RoundtableEvent | { type: 'done' }) => {
          if (event.type === 'agent_start') {
            setAgents((prev) => [
              ...prev,
              {
                agentId: event.agentId,
                name: event.name,
                role: event.role,
                avatar: event.avatar,
                content: null,
                thinking: true,
              },
            ]);
          } else if (event.type === 'agent_result') {
            setAgents((prev) =>
              prev.map((a) =>
                a.agentId === event.agentId
                  ? {
                      ...a,
                      content: event.content,
                      model: event.model,
                      error: event.error,
                      status: event.status,
                      thinking: false,
                    }
                  : a
              )
            );
          } else if (event.type === 'done') {
            setRunning(false);
          }
        }
      );

      // Save combined results
      setAgents((prev) => {
        const completed = prev.filter((a) => a.content);
        if (completed.length > 0) {
          saveRoundtableResults(screenshot.id, completed);
          const combined = completed
            .map((r) => `## ${r.avatar} ${r.name} — ${r.role}\n\n${r.content}`)
            .join('\n\n---\n\n');
          onComplete(combined);
        }
        return prev;
      });
    } catch (e) {
      console.error('Roundtable error:', e);
      toast.error('Roundtable analysis failed');
      setRunning(false);
    }
  }, [screenshot, onComplete]);

  return (
    <div className="space-y-4">
      <Button
        onClick={handleRun}
        disabled={running}
        className="w-full gap-2"
        variant="default"
        size="sm"
      >
        {running ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Roundtable in session…
          </>
        ) : (
          <>
            <Users className="h-3.5 w-3.5" />
            {agents.length > 0 ? 'Re-run Roundtable' : 'Start Agent Roundtable'}
          </>
        )}
      </Button>

      {agents.length > 0 && (
        <div className="space-y-3">
          {agents.map((agent) => (
            <div
              key={agent.agentId}
              className="rounded-lg border border-border bg-secondary/30 overflow-hidden"
            >
              {/* Agent header */}
              <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-card/50">
                <span className="text-base">{agent.avatar}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-foreground">{agent.name}</p>
                  <p className="text-[10px] text-muted-foreground">{agent.role}</p>
                </div>
                {agent.model && (
                  <span className="text-[9px] text-muted-foreground font-mono bg-secondary px-1.5 py-0.5 rounded">
                    {agent.model.split('/')[1]}
                  </span>
                )}
                {agent.thinking && (
                  <Loader2 className="h-3 w-3 animate-spin text-accent" />
                )}
              </div>

              {/* Agent content */}
              <div className="px-3 py-2">
                {agent.thinking ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="inline-flex gap-1">
                      <span className="animate-pulse">●</span>
                      <span className="animate-pulse" style={{ animationDelay: '0.2s' }}>●</span>
                      <span className="animate-pulse" style={{ animationDelay: '0.4s' }}>●</span>
                    </span>
                    Analyzing…
                  </div>
                ) : agent.error ? (
                  <p className="text-xs text-destructive">{agent.error}</p>
                ) : agent.content ? (
                  <div className="prose prose-sm prose-invert max-w-none text-xs leading-relaxed">
                    <ReactMarkdown>{agent.content}</ReactMarkdown>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">No analysis generated.</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
