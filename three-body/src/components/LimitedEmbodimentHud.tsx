import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  EmbodimentOptionView,
  EmbodimentTargetView,
  EmbodimentView,
} from '@/game/embodimentContract';
import './LimitedEmbodimentHud.css';

interface Props {
  view: EmbodimentView;
  target: EmbodimentTargetView | null;
  busy: boolean;
  pointerLocked?: boolean;
  feedback?: string;
  onChooseOption: (option: EmbodimentOptionView) => void;
  onRelease: () => void;
  onRequestPointerLock?: () => void;
  onPreviewOptionChange?: (option: EmbodimentOptionView | null) => void;
}

function monthLabel(month: number): string {
  if (month <= 0) return '月初';
  return `第${Math.floor((month - 1) / 12) + 1}年 · ${((month - 1) % 12) + 1}月`;
}

function ageLabel(months: number): string {
  const years = Math.floor(months / 12);
  const remainder = months % 12;
  return remainder ? `${years}岁${remainder}个月` : `${years}岁`;
}

function targetKey(target: EmbodimentTargetView | undefined): string {
  if (!target) return 'none';
  if (target.kind === 'person') return `person:${target.personId}`;
  if (target.kind === 'structure') return `structure:${target.structureId}`;
  if (target.kind === 'standing-position') return `standing:${target.cellId}:${target.z}`;
  if (target.kind === 'voxel') return `voxel:${target.cellId}:${target.z}`;
  if (target.kind === 'drop') return `drop:${target.dropId}`;
  return `container:${target.containerId}`;
}

function optionOrder(left: EmbodimentOptionView, right: EmbodimentOptionView): number {
  const categoryOrder: Record<EmbodimentOptionView['category'], number> = {
    build: 0,
    communicate: 1,
    transfer: 2,
    attend: 3,
    survival: 4,
    project: 5,
    wait: 6,
    move: 7,
  };
  return Number(right.primary) - Number(left.primary)
    || categoryOrder[left.category] - categoryOrder[right.category]
    || left.label.localeCompare(right.label);
}

function observableConditions(view: EmbodimentView): string[] {
  const labels = view.actor.conditions.map((condition) => condition.label);
  if (view.actor.state === 'dehydrated' && !labels.includes('严重缺水')) labels.unshift('严重缺水');
  if (view.actor.state === 'hibernating' && !labels.includes('脱水休眠')) labels.unshift('脱水休眠');
  return [...new Set(labels)].slice(0, 3);
}

function targetLabel(view: EmbodimentView, target: EmbodimentTargetView | null): string {
  if (!target) return '';
  if (target.kind === 'person') {
    return view.society.agents.find((agent) => agent.id === target.personId)?.name ?? '附近人物';
  }
  if (target.kind === 'structure') {
    return view.society.structures.find((structure) => structure.id === target.structureId)?.name ?? '附近结构';
  }
  if (target.kind === 'drop') {
    return view.society.drops.find((drop) => drop.id === target.dropId)?.name ?? '地上物品';
  }
  if (target.kind === 'container') {
    return view.society.containers.find((container) => container.id === target.containerId)?.name ?? '容器';
  }
  if (target.kind === 'voxel') {
    return target.materialId === undefined
      ? '施工位置'
      : view.society.world.palette[target.materialId]?.name ?? '体素位置';
  }
  return '相邻位置';
}

function isEditingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

export default function LimitedEmbodimentHud({
  view,
  target,
  busy,
  pointerLocked = false,
  feedback,
  onChooseOption,
  onRelease,
  onRequestPointerLock,
  onPreviewOptionChange,
}: Props) {
  const [moreOpen, setMoreOpen] = useState(false);
  const previewCallbackRef = useRef(onPreviewOptionChange);
  useEffect(() => { previewCallbackRef.current = onPreviewOptionChange; }, [onPreviewOptionChange]);
  const matchedOptions = useMemo(() => {
    if (!target) return [];
    const key = targetKey(target);
    return view.options
      .filter((option) => option.category !== 'move' && targetKey(option.target) === key)
      .sort(optionOrder);
  }, [target, view.options]);
  const mainOption = matchedOptions[0] ?? null;
  const moreOptions = useMemo(() => {
    const targetOptions = mainOption ? matchedOptions.slice(1) : matchedOptions;
    const wait = view.options.find((option) => option.category === 'wait');
    return wait ? [...targetOptions, wait] : targetOptions;
  }, [mainOption, matchedOptions, view.options]);
  const conditions = observableConditions(view);
  const currentTick = view.nextTick ?? Math.max(1, view.completedTick);
  const label = targetLabel(view, target);

  useEffect(() => {
    setMoreOpen(false);
  }, [target, view.revision]);

  useEffect(() => {
    previewCallbackRef.current?.(mainOption);
    return () => previewCallbackRef.current?.(null);
  }, [mainOption]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditingTarget(event.target)) return;
      if (event.code === 'Tab') {
        event.preventDefault();
        if (!event.repeat && !busy) onRelease();
        return;
      }
      if (event.code === 'KeyE') {
        if (!mainOption) return;
        event.preventDefault();
        if (!event.repeat && !busy) onChooseOption(mainOption);
        return;
      }
      if (event.code === 'KeyF') {
        if (!moreOptions.length) return;
        event.preventDefault();
        if (!event.repeat && !busy) setMoreOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, mainOption, moreOptions.length, onChooseOption, onRelease]);

  return (
    <section className="limited-embodiment-hud" aria-label={`${view.actor.name}的有限化身界面`}>
      <header className="limited-embodiment-hud__time" aria-label={`${monthLabel(view.atMonth)}，第${currentTick}刻，共15刻`}>
        <div>
          <span>{monthLabel(view.atMonth)}</span>
          <i aria-label="自动演化已暂停">Ⅱ</i>
          <strong>第{currentTick}/15刻</strong>
        </div>
        <ol aria-hidden="true" className="limited-embodiment-hud__ticks">
          {Array.from({ length: 15 }, (_, index) => {
            const tick = index + 1;
            const state = tick <= view.completedTick ? 'complete' : tick === view.nextTick ? 'active' : 'pending';
            return <li className={`is-${state}`} key={tick} />;
          })}
        </ol>
      </header>

      <aside className="limited-embodiment-hud__actor">
        <p>{view.actor.name} · {ageLabel(view.actor.body.ageMonths)}</p>
        <strong>意图：{view.actor.activeIntent?.summary ?? view.actor.doing ?? '观察眼前世界'}</strong>
        {conditions.length > 0 && (
          <ul aria-label="可感知的身体状态">
            {conditions.map((condition) => <li key={condition}>{condition}</li>)}
          </ul>
        )}
      </aside>

      <div className="limited-embodiment-hud__reticle" aria-hidden="true"><i /></div>

      {(label || mainOption) && (
        <div className="limited-embodiment-hud__target" aria-live="polite">
          {label && <strong>{label}</strong>}
          {mainOption?.reason && <span>{mainOption.reason}</span>}
        </div>
      )}

      {!pointerLocked && (onRequestPointerLock ? (
        <button
          className="limited-embodiment-hud__capture"
          onClick={onRequestPointerLock}
          type="button"
        >
          点击进入视角
          <small>Escape 仅释放鼠标</small>
        </button>
      ) : (
        <div className="limited-embodiment-hud__capture" aria-live="polite">
          点击场景进入视角
          <small>Escape 仅释放鼠标</small>
        </div>
      ))}

      {feedback && <p className="limited-embodiment-hud__feedback" aria-live="polite">{feedback}</p>}

      <div className="limited-embodiment-hud__actions">
        {mainOption && (
          <button disabled={busy} onClick={() => onChooseOption(mainOption)} type="button">
            <kbd>E</kbd>
            <span>{mainOption.label}</span>
            <small>· {mainOption.tickCost}刻</small>
          </button>
        )}
        {moreOptions.length > 0 && (
          <button
            aria-expanded={moreOpen}
            className="is-secondary"
            disabled={busy}
            onClick={() => setMoreOpen((open) => !open)}
            type="button"
          >
            <kbd>F</kbd><span>更多</span>
          </button>
        )}
        {moreOpen && (
          <div className="limited-embodiment-hud__more" role="menu">
            {moreOptions.map((option) => (
              <button
                disabled={busy}
                key={`${option.optionId}:${option.choiceKey}`}
                onClick={() => onChooseOption(option)}
                onPointerEnter={() => onPreviewOptionChange?.(option)}
                onPointerLeave={() => onPreviewOptionChange?.(mainOption)}
                role="menuitem"
                type="button"
              >
                <span>{option.label}</span>
                <small>{option.reason ?? `${option.tickCost}刻`}</small>
              </button>
            ))}
          </div>
        )}
      </div>

      <button
        className="limited-embodiment-hud__release"
        disabled={busy}
        onClick={onRelease}
        type="button"
      >
        <kbd>Tab</kbd><span>交还自主</span>
      </button>
    </section>
  );
}
