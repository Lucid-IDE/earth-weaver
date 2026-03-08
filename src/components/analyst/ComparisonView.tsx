import { useState } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { Screenshot } from '@/lib/analyst/screenshotService';

interface ComparisonViewProps {
  screenshots: Screenshot[];
  onClose: () => void;
}

export default function ComparisonView({ screenshots, onClose }: ComparisonViewProps) {
  const [left, setLeft] = useState<Screenshot | null>(null);
  const [right, setRight] = useState<Screenshot | null>(null);
  const [selectingFor, setSelectingFor] = useState<'left' | 'right' | null>(null);

  const renderSlot = (
    side: 'left' | 'right',
    shot: Screenshot | null,
  ) => (
    <div className="flex-1 flex flex-col border border-border rounded-lg overflow-hidden bg-card">
      {shot ? (
        <>
          <img src={shot.image_url} alt="" className="w-full aspect-video object-cover" />
          <div className="p-3 space-y-1 text-[10px] font-mono text-muted-foreground">
            <p>{shot.source} · {shot.trigger_type}</p>
            <p>{new Date(shot.created_at).toLocaleString()}</p>
            {shot.analysis && (
              <p className="text-accent truncate">✓ Has analysis</p>
            )}
          </div>
        </>
      ) : (
        <button
          onClick={() => setSelectingFor(side)}
          className="flex-1 flex items-center justify-center p-8 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Click to select {side} image
        </button>
      )}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setSelectingFor(side)}
        className="m-2 text-xs"
      >
        {shot ? 'Change' : 'Select'}
      </Button>
    </div>
  );

  if (selectingFor) {
    return (
      <div className="p-4 space-y-3">
        <button
          onClick={() => setSelectingFor(null)}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          ← Back to comparison
        </button>
        <p className="text-sm font-medium text-foreground">
          Select {selectingFor} screenshot
        </p>
        <ScrollArea className="max-h-[60vh]">
          <div className="space-y-2">
            {screenshots.map((s) => (
              <div
                key={s.id}
                className="flex gap-2 p-2 rounded-md border border-border hover:border-accent/50 cursor-pointer transition-colors"
                onClick={() => {
                  if (selectingFor === 'left') setLeft(s);
                  else setRight(s);
                  setSelectingFor(null);
                }}
              >
                <div className="w-16 h-12 rounded overflow-hidden bg-muted flex-shrink-0">
                  <img src={s.image_url} alt="" className="w-full h-full object-cover" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-foreground truncate">
                    {s.source} · {s.trigger_type}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {new Date(s.created_at).toLocaleString()}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ArrowLeftRight className="h-4 w-4 text-accent" />
          <span className="text-sm font-semibold text-foreground">Compare</span>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} className="text-xs">
          Close
        </Button>
      </div>
      <div className="flex gap-3">
        {renderSlot('left', left)}
        {renderSlot('right', right)}
      </div>
      {left?.analysis && right?.analysis && (
        <div className="bg-secondary/30 rounded-lg p-3 border border-border text-xs text-muted-foreground">
          <p className="font-medium text-foreground mb-2">Analysis Diff</p>
          <div className="space-y-2">
            <div>
              <p className="text-accent text-[10px]">Left ({new Date(left.created_at).toLocaleString()})</p>
              <p className="line-clamp-3">{left.analysis}</p>
            </div>
            <div>
              <p className="text-accent text-[10px]">Right ({new Date(right.created_at).toLocaleString()})</p>
              <p className="line-clamp-3">{right.analysis}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
