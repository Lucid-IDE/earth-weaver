import { useState } from 'react';
import SoilViewer from '@/components/SoilViewer';
import DebugOverlay from '@/components/DebugOverlay';

export default function Index() {
  const [stats, setStats] = useState({ vertices: 0, triangles: 0 });

  return (
    <div className="w-screen h-screen bg-background relative overflow-hidden">
      <SoilViewer onStats={setStats} />
      <DebugOverlay stats={stats} />
    </div>
  );
}
