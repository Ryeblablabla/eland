import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  EmbodimentOptionCategory,
  EmbodimentOptionView,
  EmbodimentTargetView,
  EmbodimentView,
} from '@/game/embodimentContract';
import './LimitedEmbodimentHud.css';

export type EmbodimentFeedbackTone = 'progress' | 'success' | 'blocked' | 'error';

interface Props {
  view: EmbodimentView;
  target: EmbodimentTargetView | null;
  busy: boolean;
  pointerLocked?: boolean;
  feedback?: string;
  feedbackTone?: EmbodimentFeedbackTone;
  onChooseOption: (option: EmbodimentOptionView) => void;
  onRelease: () => void;
  onRequestPointerLock?: () => void;
  onPreviewOptionChange?: (option: EmbodimentOptionView | null) => void;
}

const OPTION_CATEGORY_ORDER: EmbodimentOptionCategory[] = [
  'build',
  'talk',
  'transfer',
  'attend',
  'survival',
  'project',
  'wait',
  'move',
];

const OPTION_CATEGORY_LABEL: Record<EmbodimentOptionCategory, string> = {
  build: '建造',
  talk: '交流',
  transfer: '交付',
  attend: '照料',
  survival: '生存',
  project: '事务',
  wait: '等待',
  move: '移动',
};

type MoveDirection = 'north' | 'west' | 'east' | 'south';
type StandingMoveOption = EmbodimentOptionView & {
  target: Extract<EmbodimentTargetView, { kind: 'standing-position' }>;
};

const MOVE_DIRECTIONS: Array<{
  direction: MoveDirection;
  glyph: string;
  label: string;
}> = [
  { direction: 'north', glyph: '↑', label: '北' },
  { direction: 'west', glyph: '←', label: '西' },
  { direction: 'east', glyph: '→', label: '东' },
  { direction: 'south', glyph: '↓', label: '南' },
];

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
  if (target.kind === 'animal') return `animal:${target.animalId}`;
  if (target.kind === 'remains') return `remains:${target.remainsId}`;
  return `container:${target.containerId}`;
}

function optionOrder(left: EmbodimentOptionView, right: EmbodimentOptionView): number {
  const categoryOrder = (category: EmbodimentOptionCategory) => OPTION_CATEGORY_ORDER.indexOf(category);
  return Number(right.primary) - Number(left.primary)
    || categoryOrder(left.category) - categoryOrder(right.category)
    || left.label.localeCompare(right.label);
}

function materialCostLabel(view: EmbodimentView, option: EmbodimentOptionView): string {
  if (!option.materialCost?.length) return '';
  return option.materialCost.map(({ materialId, quantity }) => {
    const material = view.society.world.palette.find((candidate) => candidate.id === materialId);
    return `${material?.name ?? `物质${materialId}`}×${quantity}`;
  }).join('、');
}

function riskLabel(option: EmbodimentOptionView): string {
  return option.risks?.filter(Boolean).join('；') ?? '';
}

function isStandingMoveOption(option: EmbodimentOptionView): option is StandingMoveOption {
  return option.category === 'move' && option.target?.kind === 'standing-position';
}

function moveDirection(view: EmbodimentView, option: EmbodimentOptionView): MoveDirection | null {
  if (!isStandingMoveOption(option)) return null;
  const width = view.society.world.width;
  const actorX = view.actor.cellId % width;
  const actorY = Math.floor(view.actor.cellId / width);
  const targetX = option.target.cellId % width;
  const targetY = Math.floor(option.target.cellId / width);
  if (targetX === actorX && targetY === actorY - 1) return 'north';
  if (targetX === actorX - 1 && targetY === actorY) return 'west';
  if (targetX === actorX + 1 && targetY === actorY) return 'east';
  if (targetX === actorX && targetY === actorY + 1) return 'south';
  return null;
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
  if (target.kind === 'animal') {
    return view.society.animals.find((animal) => animal.id === target.animalId)?.name ?? '附近动物';
  }
  if (target.kind === 'remains') {
    const grave = view.society.graves?.find((candidate) => candidate.remainsId === target.remainsId);
    return grave ? `${grave.personName}的遗体` : '附近遗体';
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
  feedbackTone = 'error',
  onChooseOption,
  onRelease,
  onRequestPointerLock,
  onPreviewOptionChange,
}: Props) {
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null);
  const menuKey = `${targetKey(target ?? undefined)}:${view.revision}`;
  const moreOpen = openMenuKey === menuKey;
  const previewCallbackRef = useRef(onPreviewOptionChange);
  useEffect(() => { previewCallbackRef.current = onPreviewOptionChange; }, [onPreviewOptionChange]);
  const matchedOptions = useMemo(() => {
    if (!target) return [];
    const key = targetKey(target);
    return view.options
      .filter((option) => !isStandingMoveOption(option) && targetKey(option.target) === key)
      .sort(optionOrder);
  }, [target, view.options]);
  const globalActionOptions = useMemo(() => view.options
    .filter((option) => option.category !== 'wait'
      && (option.source === 'continue-intent' || (!option.target && !isStandingMoveOption(option))))
    .sort(optionOrder), [view.options]);
  const mainOption = matchedOptions[0] ?? globalActionOptions[0] ?? null;
  const moreOptions = useMemo(() => {
    const targetOptions = matchedOptions.filter((option) => option !== mainOption);
    const alreadyVisible = new Set([mainOption, ...targetOptions]);
    const globalOptions = globalActionOptions.filter((option) => !alreadyVisible.has(option));
    const wait = view.options.find((option) => option.category === 'wait');
    return wait ? [...targetOptions, ...globalOptions, wait] : [...targetOptions, ...globalOptions];
  }, [globalActionOptions, mainOption, matchedOptions, view.options]);
  const moreOptionGroups = useMemo(() => OPTION_CATEGORY_ORDER.flatMap((category) => {
    const options = moreOptions.filter((option) => option.category === category).sort(optionOrder);
    return options.length ? [{ category, options }] : [];
  }), [moreOptions]);
  const keyboardOptions = useMemo(() => [
    ...(mainOption ? [mainOption] : []),
    ...moreOptionGroups.flatMap((group) => group.options),
  ].slice(0, 9), [mainOption, moreOptionGroups]);
  const targetCategories = useMemo(() => {
    const options = matchedOptions.length ? matchedOptions : target ? [] : globalActionOptions;
    return [...new Set(options.map((option) => option.category))]
      .sort((left, right) => OPTION_CATEGORY_ORDER.indexOf(left) - OPTION_CATEGORY_ORDER.indexOf(right));
  }, [globalActionOptions, matchedOptions, target]);
  const recentTickEvents = useMemo(() => {
    const ordered = [...view.tickEvents]
      .sort((left, right) => left.planningTick - right.planningTick || left.orderInTick - right.orderInTick);
    const controlled = [...ordered].reverse().find((event) => event.actorId === view.actorId);
    const world = [...ordered].reverse().find((event) => event.id !== controlled?.id);
    return [controlled, world]
      .filter((event): event is NonNullable<typeof event> => Boolean(event))
      .sort((left, right) => left.planningTick - right.planningTick || left.orderInTick - right.orderInTick);
  }, [view.actorId, view.tickEvents]);
  const moveOptions = useMemo(() => {
    const options: Partial<Record<MoveDirection, EmbodimentOptionView>> = {};
    for (const option of view.options) {
      const direction = moveDirection(view, option);
      if (direction && !options[direction]) options[direction] = option;
    }
    return options;
  }, [view]);
  const conditions = observableConditions(view);
  const currentTick = view.nextTick ?? Math.max(1, view.completedTick);
  const label = targetLabel(view, target);
  const mainOptionDescribesTarget = !target || (mainOption ? matchedOptions.includes(mainOption) : false);
  const mainMaterialCost = mainOption ? materialCostLabel(view, mainOption) : '';
  const mainRisks = mainOption ? riskLabel(mainOption) : '';

  useEffect(() => {
    previewCallbackRef.current?.(mainOption);
    return () => previewCallbackRef.current?.(null);
  }, [mainOption]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.code === 'Tab') {
        if (!pointerLocked) return;
        event.preventDefault();
        if (!event.repeat) onRelease();
        return;
      }
      if (isEditingTarget(event.target)) return;
      if (pointerLocked && event.code === 'Enter') {
        if (!mainOption) return;
        event.preventDefault();
        if (!event.repeat && !busy) onChooseOption(mainOption);
        return;
      }
      if (pointerLocked && /^(?:Digit|Numpad)[1-9]$/.test(event.code)) {
        const index = Number(event.code.slice(-1)) - 1;
        const option = keyboardOptions[index];
        if (!option) return;
        event.preventDefault();
        if (!event.repeat && !busy) onChooseOption(option);
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
        if (!event.repeat && !busy) {
          setOpenMenuKey((openKey) => openKey === menuKey ? null : menuKey);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, keyboardOptions, mainOption, menuKey, moreOptions.length, onChooseOption, onRelease, pointerLocked]);

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

      {recentTickEvents.length > 0 && (
        <aside className="limited-embodiment-hud__events" aria-label="本刻真实结果" aria-live="polite">
          <strong>本刻真实结果</strong>
          <ol>
            {recentTickEvents.map((event) => (
              <li key={event.id}>
                <small>第{event.planningTick}刻</small>
                <span>{event.summary}</span>
              </li>
            ))}
          </ol>
        </aside>
      )}

      <div className="limited-embodiment-hud__reticle" aria-hidden="true"><i /></div>

      {(label || mainOption) && (
        <div className="limited-embodiment-hud__target" aria-live="polite">
          {label && <strong>{label}</strong>}
          {targetCategories.length > 0 && (
            <div className="limited-embodiment-hud__target-categories" aria-label="当前目标可做的动作类别">
              {targetCategories.map((category) => (
                <span key={category}>{OPTION_CATEGORY_LABEL[category]}</span>
              ))}
            </div>
          )}
          {mainOptionDescribesTarget && mainOption?.reason && <p>{mainOption.reason}</p>}
          {mainOptionDescribesTarget && mainMaterialCost && <small className="is-cost">耗材 · {mainMaterialCost}</small>}
          {mainOptionDescribesTarget && mainRisks && <small className="is-risk">风险 · {mainRisks}</small>}
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

      {feedback && (
        <p
          className={`limited-embodiment-hud__feedback is-${feedbackTone}`}
          data-tone={feedbackTone}
          aria-live={feedbackTone === 'error' || feedbackTone === 'blocked' ? 'assertive' : 'polite'}
        >
          {feedback}
        </p>
      )}

      <div className="limited-embodiment-hud__dpad" aria-label="合法移动方向">
        {MOVE_DIRECTIONS.map(({ direction, glyph, label: directionLabel }) => {
          const option = moveOptions[direction];
          return (
            <button
              aria-label={option?.label ?? `${directionLabel}方没有服务端提供的移动动作`}
              className={`is-${direction}`}
              disabled={busy || !option}
              key={direction}
              onClick={() => { if (option) onChooseOption(option); }}
              type="button"
            >
              <span aria-hidden="true">{glyph}</span>
            </button>
          );
        })}
      </div>

      <div className="limited-embodiment-hud__actions">
        {mainOption && (
          <button
            aria-keyshortcuts={pointerLocked ? '1 Enter E' : 'E'}
            disabled={busy}
            onClick={() => onChooseOption(mainOption)}
            type="button"
          >
            <span className="limited-embodiment-hud__key-pair" aria-label="快捷键 1、Enter 或 E">
              <kbd>1</kbd><kbd>↵</kbd>
            </span>
            <span>{mainOption.label}</span>
            <small>{OPTION_CATEGORY_LABEL[mainOption.category]} · {mainOption.tickCost}刻</small>
          </button>
        )}
        {moreOptions.length > 0 && (
          <button
            aria-expanded={moreOpen}
            aria-keyshortcuts="F"
            className="is-secondary"
            disabled={busy}
            onClick={() => setOpenMenuKey((openKey) => openKey === menuKey ? null : menuKey)}
            type="button"
          >
            <kbd>F</kbd><span>更多</span>
          </button>
        )}
        {moreOpen && (
          <div className="limited-embodiment-hud__more" role="menu" aria-label="更多合法动作">
            {moreOptionGroups.map(({ category, options }) => (
              <div
                className="limited-embodiment-hud__more-group"
                key={category}
                role="group"
                aria-label={`${OPTION_CATEGORY_LABEL[category]}动作`}
              >
                <div className="limited-embodiment-hud__more-heading" aria-hidden="true">
                  <span>{OPTION_CATEGORY_LABEL[category]}</span>
                  <small>{options.length}项</small>
                </div>
                {options.map((option) => {
                  const materialCost = materialCostLabel(view, option);
                  const risks = riskLabel(option);
                  const shortcut = keyboardOptions.indexOf(option) + 1;
                  return (
                    <button
                      aria-keyshortcuts={pointerLocked && shortcut > 1 && shortcut <= 9 ? `${shortcut}` : undefined}
                      disabled={busy}
                      key={`${option.optionId}:${option.choiceKey}`}
                      onClick={() => onChooseOption(option)}
                      onPointerEnter={() => onPreviewOptionChange?.(option)}
                      onPointerLeave={() => onPreviewOptionChange?.(mainOption)}
                      role="menuitem"
                      type="button"
                    >
                      <span className="limited-embodiment-hud__more-copy">
                        <strong>{option.label}</strong>
                        {option.reason && <small>{option.reason}</small>}
                        {materialCost && <small className="is-cost">耗材 · {materialCost}</small>}
                        {risks && <small className="is-risk">风险 · {risks}</small>}
                      </span>
                      <span className="limited-embodiment-hud__more-tags" aria-hidden="true">
                        {shortcut > 1 && shortcut <= 9 && <kbd>{shortcut}</kbd>}
                        {option.primary && <em>优先</em>}
                        <small>{option.tickCost}刻</small>
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>

      <button
        aria-keyshortcuts={pointerLocked ? 'Tab' : undefined}
        className="limited-embodiment-hud__release"
        onClick={onRelease}
        type="button"
      >
        <kbd>Tab</kbd><span>交还自主</span>
      </button>
    </section>
  );
}
