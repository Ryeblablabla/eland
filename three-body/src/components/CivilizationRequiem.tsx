import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type {
  CivilizationEndingKind,
  CivilizationRequiem as CivilizationRequiemView,
} from '@/game/civilizationRequiem';
import './CivilizationRequiem.css';

export interface CivilizationEndingView {
  civilizationId: number;
  branchId: string;
  elapsedMonths: number;
  kind: CivilizationEndingKind;
  cause: string;
  summary: string;
}

interface Props {
  ending: CivilizationEndingView;
  loadRequiem: () => Promise<CivilizationRequiemView>;
  onContinue: () => void;
  onOpenHistory: () => void;
}

type PlaybackState = 'loading' | 'playing' | 'paused' | 'complete' | 'error';

const LINE_INTERVAL_MS = 3_100;
const LAST_LINE_HOLD_MS = 3_800;
const EXIT_MS = 180;

function durationLabel(months: number): string {
  const years = Math.floor(months / 12);
  const remainder = months % 12;
  if (years === 0) return `${remainder} 个月`;
  if (remainder === 0) return `${years} 年`;
  return `${years} 年 ${remainder} 个月`;
}

function endingTitle(ending: CivilizationEndingView): string {
  if (ending.kind === 'destroyed') return `毁灭于${ending.cause}`;
  if (ending.kind === 'concluded') return '文明在此落幕';
  if (ending.kind === 'milestones') return '文明抵达观察目标';
  return '观察在此结束';
}

function styleDecisionLabel(requiem: CivilizationRequiemView): string {
  return requiem.source === 'model' ? '由 AI 选择' : '模型不可用 · 本地规则代选';
}

function verseClass(offset: number): string {
  if (offset === 0) return 'civilization-requiem__verse--current';
  if (offset === -1) return 'civilization-requiem__verse--recent';
  if (offset === -2) return 'civilization-requiem__verse--distant';
  return 'civilization-requiem__verse--hidden';
}

function verseY(offset: number): string {
  if (offset === 0) return '0vh';
  if (offset === -1) return '-27vh';
  if (offset === -2) return '-45vh';
  return offset < 0 ? '-58vh' : '24vh';
}

export default function CivilizationRequiem({
  ending,
  loadRequiem,
  onContinue,
  onOpenHistory,
}: Props) {
  const skipRef = useRef<HTMLButtonElement | null>(null);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationRef = useRef(0);
  const [requiem, setRequiem] = useState<CivilizationRequiemView | null>(null);
  const [playback, setPlayback] = useState<PlaybackState>('loading');
  const [visibleLines, setVisibleLines] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const reduceMotion = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);
  const currentLine = Math.max(-1, visibleLines - 1);

  useEffect(() => {
    const generation = ++generationRef.current;
    setRequiem(null);
    setVisibleLines(0);
    setPlayback('loading');
    void loadRequiem().then((result) => {
      if (generation !== generationRef.current) return;
      setRequiem(result);
      if (reduceMotion) {
        setVisibleLines(result.lines.length);
        setPlayback('complete');
      } else {
        setPlayback('playing');
      }
    }).catch(() => {
      if (generation === generationRef.current) setPlayback('error');
    });
  }, [loadRequiem, reduceMotion, retryToken]);

  useEffect(() => {
    if (!requiem || playback !== 'playing') return;
    const complete = visibleLines >= requiem.lines.length;
    const timer = setTimeout(() => {
      if (complete) setPlayback('complete');
      else setVisibleLines((current) => Math.min(requiem.lines.length, current + 1));
    }, complete ? LAST_LINE_HOLD_MS : visibleLines === 0 ? 2_400 : LINE_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [playback, requiem, visibleLines]);

  useEffect(() => {
    skipRef.current?.focus({ preventScroll: true });
    return () => {
      generationRef.current += 1;
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
    };
  }, []);

  const skip = () => {
    if (!requiem) return;
    setVisibleLines(requiem.lines.length);
    setPlayback('complete');
  };

  const togglePlayback = () => {
    if (playback === 'paused') setPlayback('playing');
    else if (playback === 'playing') setPlayback('paused');
  };

  const replay = () => {
    setVisibleLines(0);
    setPlayback(reduceMotion ? 'complete' : 'playing');
  };

  const leave = () => {
    if (leaving) return;
    setLeaving(true);
    exitTimerRef.current = setTimeout(onContinue, reduceMotion ? 0 : EXIT_MS);
  };

  return (
    <section
      aria-labelledby="civilization-requiem-title"
      aria-modal="true"
      className={`civilization-requiem${leaving ? ' civilization-requiem--leaving' : ''}`}
      role="dialog"
    >
      <div aria-hidden="true" className="civilization-requiem__veil" />
      <header className="civilization-requiem__topbar">
        <p>第 {ending.civilizationId} 号文明 · 延续 {durationLabel(ending.elapsedMonths)}</p>
        {requiem && playback !== 'complete' && (
          <button ref={skipRef} onClick={skip} type="button">跳至落款</button>
        )}
      </header>

      <div className="civilization-requiem__stage">
        {(playback === 'loading' || requiem && visibleLines === 0 && playback !== 'complete') && (
          <div className="civilization-requiem__intro">
            <p>{playback === 'loading' ? '正在从真实历史中写下终章' : `${requiem?.styleName} · ${requiem ? styleDecisionLabel(requiem) : ''}`}</p>
            <h1 id="civilization-requiem-title">{requiem?.title ?? endingTitle(ending)}</h1>
            <span>{requiem?.summary ?? ending.summary}</span>
            {playback === 'loading' && <i aria-hidden="true" />}
          </div>
        )}

        {playback === 'error' && (
          <div className="civilization-requiem__error" role="alert">
            <p>终章暂时没有写成，文明结局已经安全保存。</p>
            <button onClick={() => setRetryToken((token) => token + 1)} type="button">重新生成</button>
          </div>
        )}

        {requiem && visibleLines > 0 && playback !== 'complete' && (
          <article aria-live="polite" className="civilization-requiem__stream">
            <p className="civilization-requiem__style">{requiem.styleName} · {styleDecisionLabel(requiem)}</p>
            {requiem.lines.map((line, index) => {
              const offset = index - currentLine;
              return (
                <p
                  className={`civilization-requiem__verse ${verseClass(offset)}`}
                  key={`${requiem.id}:${index}`}
                  style={{ '--verse-y': verseY(offset) } as CSSProperties}
                >
                  {line.text}
                </p>
              );
            })}
          </article>
        )}

        {requiem && playback === 'complete' && (
          <footer className="civilization-requiem__finale">
            <p>{requiem.styleName} · {styleDecisionLabel(requiem)}</p>
            <h2>{requiem.title}</h2>
            <span>第 {ending.civilizationId} 号文明的终章已经写入本次文明档案。</span>
            <div>
              <button onClick={replay} type="button">重新播放</button>
              <button onClick={onOpenHistory} type="button">查看历史</button>
              <button className="civilization-requiem__primary" onClick={leave} type="button">
                {leaving ? '正在远离' : '观察下一文明'}
              </button>
            </div>
          </footer>
        )}
      </div>

      {requiem && (playback === 'playing' || playback === 'paused') && (
        <div className="civilization-requiem__controls">
          <button onClick={togglePlayback} type="button">{playback === 'paused' ? '继续' : '暂停'}</button>
          <span>{Math.min(visibleLines, requiem.lines.length)} / {requiem.lines.length}</span>
        </div>
      )}
    </section>
  );
}
