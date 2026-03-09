import type { EquipmentStats } from '@/components/SoilViewer';

interface DebugOverlayProps {
  stats: {
    vertices: number;
    triangles: number;
    simActive?: boolean;
    activeParticles?: number;
    totalParticles?: number;
  };
  equipment?: EquipmentStats | null;
}

export default function DebugOverlay({ stats, equipment }: DebugOverlayProps) {
  const hasParticles = (stats.totalParticles ?? 0) > 0;
  const activeEquip = equipment?.activeEquipment ?? 'none';

  return (
    <div className="absolute top-4 left-4 select-none pointer-events-none">
      <div className="bg-card/75 backdrop-blur-sm border border-border rounded-md px-4 py-3 space-y-2 max-w-xs">
        <h1 className="text-sm font-semibold text-foreground tracking-wide">
          Hybrid SDF–MPM Construction Sim
        </h1>
        <div className="text-[11px] text-muted-foreground space-y-0.5 leading-relaxed">
          <p className="text-primary">
            {activeEquip === 'none' 
              ? 'Click terrain to dig · Scroll to zoom'
              : activeEquip === 'excavator'
              ? '🏗️ Excavator — WASD+IJKL tracks, RF boom, JL stick, QE bucket'
              : '🚜 Bulldozer — WASD+IK tracks, RF blade, TG tilt'
            }
          </p>
          <p>Left-drag orbit · Right-drag pan · [1] Excavator [2] Dozer [3] Free</p>
          <p className="text-destructive/80">[V] Impact crater · [B] Explosion</p>
        </div>
        <div className="border-t border-border pt-2 text-[10px] text-muted-foreground font-mono space-y-0.5">
          <p>vertices: <span className="text-foreground">{stats.vertices.toLocaleString()}</span></p>
          <p>triangles: <span className="text-foreground">{stats.triangles.toLocaleString()}</span></p>
          <p>grid: <span className="text-foreground">64×32×64</span> · voxel: <span className="text-foreground">2.5cm</span></p>
          <p>extraction: <span className="text-foreground">Surface Nets</span></p>
          <p>physics: <span className={stats.simActive ? "text-accent" : "text-muted-foreground"}>
            {stats.simActive ? "● MLS-MPM active" : "○ idle"}
          </span></p>
          {hasParticles && (
            <>
              <p>particles: <span className="text-foreground">
                {(stats.activeParticles ?? 0).toLocaleString()}</span>
                <span className="text-muted-foreground"> / {(stats.totalParticles ?? 0).toLocaleString()}</span>
              </p>
              <p>model: <span className="text-foreground">Drucker-Prager + Neo-Hookean</span></p>
            </>
          )}
          <p>equipment: <span className={activeEquip !== 'none' ? "text-primary" : "text-muted-foreground"}>
            {activeEquip === 'excavator' ? '● Excavator' : activeEquip === 'bulldozer' ? '● Bulldozer' : '○ none'}
          </span></p>
        </div>
      </div>
    </div>
  );
}
