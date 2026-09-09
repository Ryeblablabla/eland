import './RecordedMemory.css';

export interface RecordedMemoryProps {
  /** Seconds from the beginning of the memory shot. */
  time: number;
}

/** Exact person-owned memory retained in the real month-397 snapshot. */
export const RECORDED_MEMORY = {
  agentId: 'born-16-cai-wenji-7',
  name: '孙疏影',
  civilizationId: 16,
  snapshotMonth: 397,
  createdAtMonth: 391,
  id: 'memory:intent-action-failed:intent-390-born-16-cai-wenji-7-9042:391',
  sourceEventIds: ['e-391-action-born-16-cai-wenji-7-23'],
  fullText: '尝试复现“石与木材可结合为石制工具”失败：背包中的结合材料已经不存在',
  excerpt: '尝试复现“石与木材可结合为石制工具”失败',
} as const;

export const RECORDED_MEMORY_SECONDS = 6;

function ease(time: number, start: number, duration: number): number {
  const p = Math.max(0, Math.min(1, (time - start) / duration));
  return p * p * (3 - 2 * p);
}

/** Filming-only card: no source reads, generated recollections, or live actions. */
export default function RecordedMemory({ time }: RecordedMemoryProps) {
  const t = Number.isFinite(time) ? Math.max(0, time) : 0;
  const reveal = ease(t, 0.08, 0.5);
  const close = ease(t, 5.6, 0.4);
  const opacity = reveal * (1 - close);
  const bodyReveal = ease(t, 0.24, 0.42);

  return (
    <aside
      className="recorded-memory"
      aria-label="孙疏影的真实存档记忆，原文节选"
      data-memory-id={RECORDED_MEMORY.id}
      data-source-event-id={RECORDED_MEMORY.sourceEventIds[0]}
      data-snapshot-month={RECORDED_MEMORY.snapshotMonth}
      style={{
        opacity,
        transform: `translateY(calc(-50% + ${(1 - reveal) * 18 + close * 8}px))`,
        clipPath: `inset(0 0 ${(1 - reveal) * 72}% 0 round 16px)`,
      }}
    >
      <p className="recorded-memory__eyebrow">真实存档 · 第16号文明</p>
      <h2 className="recorded-memory__title">孙疏影的记忆</h2>
      <div className="recorded-memory__body" style={{ opacity: bodyReveal }}>
        <div className="recorded-memory__meta">
          <span>一次制作尝试 · 失败</span>
          <time>第 33 年 · 7 月</time>
        </div>
        <p className="recorded-memory__quote">{RECORDED_MEMORY.excerpt}</p>
        <p className="recorded-memory__note">记忆原文节选</p>
      </div>
    </aside>
  );
}
