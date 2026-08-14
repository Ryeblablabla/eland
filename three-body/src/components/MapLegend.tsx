import { useMemo } from 'react';
import type { PixelWorldView } from '@/game/societyContract';

interface Props {
  world: PixelWorldView;
}

/**
 * 地图图例：表面材质（按覆盖率取前四）、高度明暗、活动痕迹、人物状态环。
 * 纯展示，pointer-events 关闭，不挡地图交互。
 */
export default function MapLegend({ world }: Props) {
  // 表面材质覆盖率 Top4
  const surfaceEntries = useMemo(() => {
    const counts = new Map<number, number>();
    for (const materialId of world.surface) {
      counts.set(materialId, (counts.get(materialId) ?? 0) + 1);
    }
    const total = world.surface.length || 1;
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([materialId, count]) => {
        const material = world.palette[materialId];
        const [r, g, b] = material?.color ?? [13, 20, 24];
        return {
          materialId,
          name: material?.name ?? '未知',
          color: `rgb(${r},${g},${b})`,
          share: Math.round((count / total) * 100),
        };
      });
  }, [world.palette, world.surface]);

  return (
    <div className="pointer-events-none absolute bottom-9 left-3 space-y-2 border border-white/10 bg-slate-950/70 px-3 py-2.5 text-[9px] tracking-[0.12em] text-slate-400 backdrop-blur-md">
      <div className="flex items-center gap-3">
        {surfaceEntries.map((entry) => (
          <span key={entry.materialId} className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 border border-white/15" style={{ background: entry.color }} />
            {entry.name} {entry.share}%
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-8 border border-white/15"
            style={{ background: 'linear-gradient(90deg, rgba(3,8,16,0.55), transparent 45%, rgba(255,244,214,0.5))' }}
          />
          低 → 高
        </span>
      </div>
      <div className="flex items-center gap-3 border-t border-white/5 pt-2">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-1 w-3.5" style={{ background: 'rgba(194,166,118,0.62)' }} />
          通行痕迹
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2" style={{ background: 'rgba(214,225,166,0.6)' }} />
          转移痕迹
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full border-2" style={{ borderColor: '#34d399' }} />
          康健
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full border-2" style={{ borderColor: '#f87171' }} />
          濒危
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full border-2" style={{ borderColor: '#60a5fa' }} />
          脱水
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full border-2" style={{ borderColor: '#fbbf24' }} />
          说话中
        </span>
      </div>
    </div>
  );
}
