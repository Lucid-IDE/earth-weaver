import { useState } from 'react';
import { Camera } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { findCaptureTarget, captureCanvasScreenshot } from '@/lib/analyst/captureCanvas';
import { saveScreenshot, type Screenshot } from '@/lib/analyst/screenshotService';
import { toast } from '@/components/ui/sonner';

interface CaptureButtonProps {
  source: string;
  metadata?: Record<string, any>;
  onCapture?: (screenshot: Screenshot) => void;
}

export default function CaptureButton({ source, metadata = {}, onCapture }: CaptureButtonProps) {
  const [capturing, setCapturing] = useState(false);

  const handleCapture = async () => {
    setCapturing(true);
    try {
      const target = findCaptureTarget();
      if (!target) {
        toast.error('No canvas found to capture');
        return;
      }

      const dataUrl = captureCanvasScreenshot(target);
      if (!dataUrl) {
        toast.error('Failed to capture screenshot');
        return;
      }

      const screenshot = await saveScreenshot(dataUrl, source, 'manual', metadata);
      if (screenshot) {
        toast.success('Screenshot captured');
        onCapture?.(screenshot);
      } else {
        toast.error('Failed to save screenshot');
      }
    } finally {
      setCapturing(false);
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleCapture}
      disabled={capturing}
      className="gap-1.5"
    >
      <Camera className="h-3.5 w-3.5" />
      {capturing ? 'Capturing…' : 'Capture'}
    </Button>
  );
}
