import { useCallback, useMemo, useState } from 'react';
import {
  Pause,
  Play,
  RotateCcw,
  Dices,
  Info,
  ChevronDown,
  ChevronUp,
  Sparkles,
  Globe,
} from 'lucide-react';
import ThreeBodyCanvas, { type SimStats } from '@/components/ThreeBodyCanvas';
import { PLANET_STYLE, PRESETS, STAR_STYLES, type PlanetFate } from '@/lib/threebody';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';

function fmtSci(x: number): string {
  if (x === 0) return '0';
  return x.toExponential(1).replace('e', '×10^');
}

function chaosStage(sep: number): { label: string; cls: string } {
  if (sep < 1e-3) return { label: '孪生同步 · 秩序', cls: 'text-emerald-300' };
  if (sep < 1e-1) return { label: '误差放大 · 开始分岔', cls: 'text-amber-300' };
  return { label: '彻底分道 · 混沌降临', cls: 'text-rose-400' };
}

function eraLabel(fate: PlanetFate): { label: string; cls: string } {
  switch (fate) {
    case 'stable':
      return { label: '恒纪元 · 文明发展', cls: 'text-emerald-300' };
    case 'chaotic':
      return { label: '乱纪元 · 脱水！', cls: 'text-amber-300' };
    case 'burned':
      return { label: '坠入恒星 · 文明毁灭', cls: 'text-rose-400' };
    case 'frozen':
      return { label: '流浪深空 · 长夜冻结', cls: 'text-sky-300' };
    case 'extinct':
      return { label: '星系崩解 · 文明终结', cls: 'text-purple-300' };
  }
}

const INITIAL_STATS: SimStats = {
  t: 0,
  energy: 0,
  separation: null,
  planetFate: 'stable',
  planetDist: 0,
  fluxRel: 1,
  collapsed: null,
  civilizations: 1,
};

export default function Home() {
  const [running, setRunning] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [trailLength, setTrailLength] = useState(1200);
  const [showTwin, setShowTwin] = useState(true);
  const [presetKey, setPresetKey] = useState(PRESETS[2].key);
  const [resetToken, setResetToken] = useState(0);
  const [stats, setStats] = useState<SimStats>(INITIAL_STATS);
  const [showAbout, setShowAbout] = useState(true);

  const onStats = useCallback((s: SimStats) => setStats(s), []);
  const preset = useMemo(() => PRESETS.find((p) => p.key === presetKey)!, [presetKey]);
  const era = eraLabel(stats.planetFate);

  const pickPreset = (key: string) => {
    setPresetKey(key);
    setResetToken((n) => n + 1);
  };

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#05070f] font-sans text-slate-200">
      {/* 模拟画布 */}
      <div className="absolute inset-0">
        <ThreeBodyCanvas
          running={running}
          speed={speed}
          trailLength={trailLength}
          showTwin={showTwin}
          presetKey={presetKey}
          resetToken={resetToken}
          onStats={onStats}
        />
      </div>

      {/* 标题 */}
      <header className="pointer-events-none absolute left-6 top-6 select-none">
        <div className="flex items-center gap-3">
          <Sparkles className="h-6 w-6 text-amber-300/80" />
          <h1 className="bg-gradient-to-r from-amber-200 via-rose-200 to-sky-300 bg-clip-text text-3xl font-bold tracking-[0.35em] text-transparent">
            三 体
          </h1>
        </div>
        <p className="mt-2 text-xs tracking-[0.3em] text-slate-400">
          THREE-BODY PROBLEM · 三颗恒星的混沌之舞
        </p>
        {/* 天体图例 */}
        <div className="pointer-events-auto mt-3 space-y-1 text-[11px] text-slate-400">
          {STAR_STYLES.map((s, i) => (
            <div key={s.name} className="flex items-center gap-2">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: s.glow, boxShadow: `0 0 6px ${s.glow}` }}
              />
              <span>{s.name}</span>
              <span className="font-mono tabular-nums text-slate-500">
                {preset.masses[i].toFixed(2)} M☉
              </span>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={{ background: PLANET_STYLE.glow, boxShadow: `0 0 6px ${PLANET_STYLE.glow}` }}
            />
            <span>{PLANET_STYLE.name} · 三体人的家园</span>
          </div>
        </div>
      </header>

      {/* 控制面板 */}
      <aside className="absolute right-5 top-5 w-[300px] rounded-2xl border border-white/10 bg-slate-950/60 p-4 shadow-2xl backdrop-blur-md">
        {/* 预设 */}
        <div className="grid grid-cols-2 gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              onClick={() => pickPreset(p.key)}
              className={`rounded-lg border px-2 py-2 text-left text-xs transition-all ${
                p.key === presetKey
                  ? 'border-amber-300/60 bg-amber-300/10 text-amber-200'
                  : 'border-white/10 bg-white/5 text-slate-300 hover:border-white/25 hover:bg-white/10'
              }`}
            >
              <span className="flex items-center gap-1 font-medium">
                {p.key === 'chaos' && <Dices className="h-3 w-3" />}
                {p.label}
              </span>
            </button>
          ))}
        </div>
        <p className="mt-2 min-h-8 text-[11px] leading-4 text-slate-400">{preset.desc}</p>

        <Separator className="my-3 bg-white/10" />

        {/* 播放控制 */}
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => setRunning((r) => !r)}
            className="flex-1 bg-amber-400/90 text-slate-950 hover:bg-amber-300"
          >
            {running ? <Pause className="mr-1 h-4 w-4" /> : <Play className="mr-1 h-4 w-4" />}
            {running ? '暂停' : '继续'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setResetToken((n) => n + 1)}
            className="border-white/15 bg-white/5 text-slate-200 hover:bg-white/10"
          >
            <RotateCcw className="mr-1 h-4 w-4" />
            重置
          </Button>
        </div>

        {/* 滑杆 */}
        <div className="mt-4 space-y-4">
          <div>
            <div className="mb-1.5 flex justify-between text-[11px] text-slate-400">
              <span>时间流速</span>
              <span className="tabular-nums text-slate-300">{speed.toFixed(1)}×</span>
            </div>
            <Slider
              value={[speed]}
              min={0.1}
              max={5}
              step={0.1}
              onValueChange={([v]) => setSpeed(v)}
            />
          </div>
          <div>
            <div className="mb-1.5 flex justify-between text-[11px] text-slate-400">
              <span>轨迹长度</span>
              <span className="tabular-nums text-slate-300">{trailLength}</span>
            </div>
            <Slider
              value={[trailLength]}
              min={100}
              max={3000}
              step={100}
              onValueChange={([v]) => setTrailLength(v)}
            />
          </div>
          <label className="flex cursor-pointer items-center justify-between text-[11px] text-slate-300">
            <span>
              蝴蝶效应对照
              <span className="block text-[10px] text-slate-500">
                叠加一个初速度仅差 10⁻⁶ 的孪生宇宙
              </span>
            </span>
            <Switch checked={showTwin} onCheckedChange={setShowTwin} />
          </label>
        </div>

        <Separator className="my-3 bg-white/10" />

        {/* 状态读数 */}
        <div className="space-y-1.5 font-mono text-[11px] tabular-nums">
          <div className="flex justify-between">
            <span className="text-slate-500">模拟时间 t</span>
            <span>{stats.t.toFixed(2)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">系统能量 E</span>
            <span>{stats.energy.toFixed(4)}</span>
          </div>
          {stats.separation !== null && (
            <>
              <div className="flex justify-between">
                <span className="text-slate-500">孪生宇宙偏差</span>
                <span>{fmtSci(stats.separation)}</span>
              </div>
              <div className={`text-right text-[10px] ${chaosStage(stats.separation).cls}`}>
                {chaosStage(stats.separation).label}
              </div>
            </>
          )}
        </div>

        {/* 三体行星状态 */}
        <div className="mt-3 rounded-lg border border-emerald-300/20 bg-emerald-400/5 p-2.5">
          <div className="flex items-center justify-between font-mono text-[11px]">
            <span className="flex items-center gap-1.5 text-slate-400">
              <Globe className="h-3 w-3 text-emerald-300" />
              第 {stats.civilizations} 号文明
            </span>
            <span className="tabular-nums text-slate-500">
              距最近恒星 {stats.planetDist.toFixed(2)}
            </span>
          </div>
          <div className={`mt-1 text-xs font-medium ${era.cls}`}>{era.label}</div>
        </div>
      </aside>

      {/* 科普说明 */}
      <div className="absolute bottom-5 left-5 w-[340px] rounded-2xl border border-white/10 bg-slate-950/60 shadow-2xl backdrop-blur-md">
        <button
          onClick={() => setShowAbout((v) => !v)}
          className="flex w-full items-center justify-between px-4 py-3 text-left text-xs font-medium text-slate-300"
        >
          <span className="flex items-center gap-2">
            <Info className="h-3.5 w-3.5 text-sky-300" />
            为什么三体无法预测？
          </span>
          {showAbout ? (
            <ChevronDown className="h-4 w-4 text-slate-500" />
          ) : (
            <ChevronUp className="h-4 w-4 text-slate-500" />
          )}
        </button>
        {showAbout && (
          <div className="space-y-2 px-4 pb-4 text-[11px] leading-5 text-slate-400">
            <p>
              两颗恒星的轨道可以精确求解（开普勒定律）；但再加一颗，万有引力的相互牵扯
              就让方程组<span className="text-slate-200">不再有解析解</span>——
              1887 年庞加莱证明了这一点，混沌理论由此诞生。
            </p>
            <p>
              画面中的<span className="text-emerald-300">青色小点</span>是三体人的行星，
              质量按半人马座 α 原型分配（1.10 / 0.91 / 0.12 M☉）。
              行星被单颗恒星束缚时是<span className="text-emerald-300">恒纪元</span>；
              被三颗飞星轮番撕扯时是<span className="text-amber-300">乱纪元</span>；
              坠入恒星或流浪深空，则文明毁灭——新的文明会在废墟上重新计数，
              正如小说中两百轮文明的轮回；而当某颗恒星被彻底弹射出星系，
              三体世界将迎来<span className="text-purple-300">终局</span>——文明不再复活。
            </p>
            <p className="text-slate-500">
              引擎：RK4 定步长积分 · G=1 · 引力软化 ε=0.015 · 行星为无质量测试粒子
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
