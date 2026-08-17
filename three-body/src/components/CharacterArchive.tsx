import { useMemo, useState } from 'react';
import { CHARACTERS, CHARACTER_CATEGORIES, type CharacterCategory } from '@/data/characters';

/**
 * 人物档案 · 文明原型库
 *  - 浏览人物档案（画像 / 时代 / 气质）
 *  - 点选组成开局阵容（最多 8 人），阵容对之后每个文明生效
 *  - 不选任何人物时，引擎按种子随机抽取 5~10 人入局
 */

const MAX_ROSTER = 8;

type TabKey = '全部' | CharacterCategory;

interface Props {
  roster: string[];
  inGameIds: Set<string>;
  onToggle: (id: string) => void;
  onClear: () => void;
  onRestart: () => void;
  onClose: () => void;
}

export default function CharacterArchive({ roster, inGameIds, onToggle, onClear, onRestart, onClose }: Props) {
  const [tab, setTab] = useState<TabKey>('全部');
  const tabs: TabKey[] = useMemo(() => ['全部', ...CHARACTER_CATEGORIES], []);
  const shown = useMemo(() => (tab === '全部' ? CHARACTERS : CHARACTERS.filter((c) => c.category === tab)), [tab]);

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-[#02030a]/80 backdrop-blur-sm" onClick={onClose}>
      <div
        className="flex h-[82vh] w-[min(920px,94vw)] flex-col rounded-2xl border border-white/10 bg-slate-950/90 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between border-b border-white/5 px-6 py-4">
          <div className="flex items-baseline gap-4">
            <span className="text-sm tracking-[0.5em] text-slate-300">人物档案 · 文明原型库</span>
            <span className="text-[10px] tracking-[0.3em] text-slate-600">共 {CHARACTERS.length} 位</span>
          </div>
          <button onClick={onClose} className="text-xs tracking-[0.3em] text-slate-500 transition-colors hover:text-slate-300">合上 ✕</button>
        </div>

        {/* 分类页签 */}
        <div className="flex items-center gap-6 px-6 pt-4 text-[11px] tracking-[0.3em]">
          {tabs.map((key) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`border-b pb-1.5 transition-colors ${
                tab === key ? 'border-amber-200 text-amber-200' : 'border-transparent text-slate-500 hover:text-slate-300'
              }`}
            >
              {key}
            </button>
          ))}
          <span className="ml-auto text-[10px] tracking-[0.2em] text-slate-600">点选人物组成开局阵容</span>
        </div>

        {/* 人物卡片墙 */}
        <div className="grid flex-1 grid-cols-3 gap-4 overflow-y-auto px-6 py-5 sm:grid-cols-4 md:grid-cols-5">
          {shown.map((c) => {
            const picked = roster.includes(c.id);
            const inGame = inGameIds.has(c.id);
            return (
              <button
                key={c.id}
                onClick={() => onToggle(c.id)}
                className={`group relative flex flex-col rounded-xl border p-2 text-left transition-all duration-300 ${
                  picked
                    ? 'border-amber-200/70 bg-amber-200/5 shadow-[0_0_24px_rgba(251,191,36,0.12)]'
                    : 'border-white/8 bg-white/[0.02] hover:border-white/25'
                }`}
              >
                <div className="relative overflow-hidden rounded-lg">
                  {c.portrait ? (
                    <img
                      src={c.portrait}
                      alt={c.name}
                      loading="lazy"
                      className={`aspect-[3/4] w-full object-cover transition-transform duration-500 group-hover:scale-105 ${picked ? '' : 'opacity-85'}`}
                    />
                  ) : (
                    <div className="flex aspect-[3/4] w-full items-center justify-center bg-white/5 text-3xl text-slate-600">{c.name[0]}</div>
                  )}
                  {picked && (
                    <span className="absolute right-1.5 top-1.5 rounded-full bg-amber-300 px-1.5 py-0.5 text-[9px] font-medium tracking-wider text-slate-950">
                      ✓ 已选
                    </span>
                  )}
                  {inGame && (
                    <span className="absolute left-1.5 top-1.5 rounded-full bg-emerald-300/90 px-1.5 py-0.5 text-[9px] tracking-wider text-slate-950">
                      入局
                    </span>
                  )}
                </div>
                <div className="mt-2 flex items-baseline justify-between gap-2">
                  <span className={`text-[13px] tracking-wider ${picked ? 'text-amber-100' : 'text-slate-200'}`}>{c.name}</span>
                  <span className="shrink-0 text-[9px] tracking-widest text-slate-600">{c.era}</span>
                </div>
                <div className="mt-1 line-clamp-2 text-[10px] leading-relaxed text-slate-500">{c.traits}</div>
              </button>
            );
          })}
        </div>

        {/* 底部：阵容说明与操作 */}
        <div className="flex items-center justify-between border-t border-white/5 px-6 py-4">
          <div className="text-[10px] leading-relaxed tracking-[0.2em] text-slate-500">
            {roster.length > 0 ? (
              <>
                已选 <span className="text-amber-200">{roster.length}</span> / {MAX_ROSTER} 人 · 阵容对之后每个文明生效
              </>
            ) : (
              <>未指定阵容 · 开局将按种子随机抽取 5~10 人入局</>
            )}
          </div>
          <div className="flex items-center gap-6 text-[11px] tracking-[0.3em]">
            <button
              onClick={onClear}
              disabled={roster.length === 0}
              className={`transition-colors ${roster.length === 0 ? 'text-slate-700' : 'text-slate-500 hover:text-slate-300'}`}
            >
              清空
            </button>
            <button
              onClick={onRestart}
              disabled={roster.length === 0}
              title="以当前阵容从第一号文明重新开始"
              className={`transition-colors ${roster.length === 0 ? 'text-slate-700' : 'text-rose-200/80 hover:text-rose-100'}`}
            >
              以阵容重开宇宙 ↺
            </button>
            <button onClick={onClose} className="text-amber-200 transition-colors hover:text-amber-100">
              完 成
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
