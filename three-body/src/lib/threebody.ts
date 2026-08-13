/**
 * 三体问题物理引擎（含行星版）
 * 2D 平面、G=1 单位制，带软化因子的牛顿引力，RK4 定步长积分。
 * 天体 0~2 为恒星（质量按半人马座 α 原型），天体 3 为三体行星（无质量测试粒子）。
 * 状态向量布局: [x0..x3, y0..y3 交错, vx0..vx3, vy0..vy3 交错] = 16 维
 */

export const N_STARS = 3;
export const PLANET_IDX = 3;
export const N_BODIES = 4;
export const G = 1;
export const SOFTENING_SQ = 0.015 * 0.015; // 软化长度平方，避免近距离奇点爆炸

/** 故事原型：半人马座 α 三合星质量（单位 M☉，模拟中 G=1 直接用作质量） */
export const STORY_MASSES = [1.1, 0.907, 0.122];
export const STORY_MASS_LABELS = ['1.10 M☉', '0.91 M☉', '0.12 M☉'];

export interface SimSystem {
  state: Float64Array; // 16
  masses: Float64Array; // 4（行星质量为 0）
}

export interface StarStyle {
  name: string;
  core: string;
  glow: string;
  trail: string;
}

export const STAR_STYLES: StarStyle[] = [
  { name: 'α A · 曜金', core: '#fff7e0', glow: '#ffb340', trail: '#f5a623' },
  { name: 'α B · 苍蓝', core: '#e8f4ff', glow: '#4da6ff', trail: '#3b8cff' },
  { name: '比邻星 · 血日', core: '#ffe9e4', glow: '#ff5a4e', trail: '#ff4d6d' },
];

export const PLANET_STYLE = {
  name: '三体星',
  core: '#d9fff2',
  glow: '#34d399',
  trail: '#2dd4bf',
};

// ---------------------------------------------------------------------------
// 积分器
// ---------------------------------------------------------------------------

function accelerations(s: Float64Array, m: Float64Array, out: Float64Array): void {
  for (let i = 0; i < 8; i++) out[i] = 0;
  for (let i = 0; i < N_BODIES; i++) {
    for (let j = i + 1; j < N_BODIES; j++) {
      const dx = s[j * 2] - s[i * 2];
      const dy = s[j * 2 + 1] - s[i * 2 + 1];
      const r2 = dx * dx + dy * dy + SOFTENING_SQ;
      const inv = 1 / (r2 * Math.sqrt(r2));
      // i 受 j 的引力 ∝ m_j；j 受 i 的引力 ∝ m_i（行星 m=0，自然不反作用于恒星）
      out[i * 2] += m[j] * dx * inv;
      out[i * 2 + 1] += m[j] * dy * inv;
      out[j * 2] -= m[i] * dx * inv;
      out[j * 2 + 1] -= m[i] * dy * inv;
    }
  }
}

const k1 = new Float64Array(16);
const k2 = new Float64Array(16);
const k3 = new Float64Array(16);
const k4 = new Float64Array(16);
const tmp = new Float64Array(16);
const acc = new Float64Array(8);

function derivative(sys: SimSystem, out: Float64Array): void {
  const s = sys.state;
  for (let i = 0; i < 8; i++) out[i] = s[8 + i];
  accelerations(s, sys.masses, acc);
  for (let i = 0; i < 8; i++) out[8 + i] = acc[i];
}

export function rk4Step(sys: SimSystem, dt: number): void {
  const s = sys.state;
  derivative(sys, k1);
  for (let i = 0; i < 16; i++) tmp[i] = s[i] + (dt / 2) * k1[i];
  derivative({ state: tmp, masses: sys.masses }, k2);
  for (let i = 0; i < 16; i++) tmp[i] = s[i] + (dt / 2) * k2[i];
  derivative({ state: tmp, masses: sys.masses }, k3);
  for (let i = 0; i < 16; i++) tmp[i] = s[i] + dt * k3[i];
  derivative({ state: tmp, masses: sys.masses }, k4);
  for (let i = 0; i < 16; i++) {
    s[i] += (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
  }
}

/** 系统总能量（行星无质量，不影响能量） */
export function totalEnergy(sys: SimSystem): number {
  const s = sys.state, m = sys.masses;
  let ke = 0;
  for (let i = 0; i < N_BODIES; i++) {
    const vx = s[8 + i * 2], vy = s[8 + i * 2 + 1];
    ke += 0.5 * m[i] * (vx * vx + vy * vy);
  }
  let pe = 0;
  for (let i = 0; i < N_BODIES; i++) {
    for (let j = i + 1; j < N_BODIES; j++) {
      const dx = s[j * 2] - s[i * 2];
      const dy = s[j * 2 + 1] - s[i * 2 + 1];
      pe -= (G * m[i] * m[j]) / Math.sqrt(dx * dx + dy * dy + SOFTENING_SQ);
    }
  }
  return ke + pe;
}

/** 两套状态间恒星的最大间距（行星不参与，用于蝴蝶效应对照） */
export function maxSeparation(a: SimSystem, b: SimSystem): number {
  let m = 0;
  for (let i = 0; i < N_STARS; i++) {
    const dx = a.state[i * 2] - b.state[i * 2];
    const dy = a.state[i * 2 + 1] - b.state[i * 2 + 1];
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > m) m = d;
  }
  return m;
}

/** 质心（仅恒星） */
function starsCOM(sys: SimSystem): [number, number] {
  const s = sys.state, m = sys.masses;
  let cx = 0, cy = 0, mt = 0;
  for (let i = 0; i < N_STARS; i++) {
    cx += m[i] * s[i * 2]; cy += m[i] * s[i * 2 + 1]; mt += m[i];
  }
  return [cx / mt, cy / mt];
}

/** 距质心最远的恒星距离（行星被弹射时不影响取景） */
export function maxRadiusFromCOM(sys: SimSystem): number {
  const [cx, cy] = starsCOM(sys);
  const s = sys.state;
  let m = 0;
  for (let i = 0; i < N_STARS; i++) {
    const dx = s[i * 2] - cx, dy = s[i * 2 + 1] - cy;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > m) m = d;
  }
  return m;
}

// ---------------------------------------------------------------------------
// 行星
// ---------------------------------------------------------------------------

/** 把行星放到最大质量恒星的圆轨道上（三体文明的新一轮开局） */
export function placePlanet(sys: SimSystem, orbitR: number, rng: () => number = Math.random): void {
  const s = sys.state, m = sys.masses;
  // 找最大质量恒星
  let host = 0;
  for (let i = 1; i < N_STARS; i++) if (m[i] > m[host]) host = i;
  const ang = rng() * Math.PI * 2;
  const vc = Math.sqrt((G * m[host]) / orbitR); // 圆轨道速度
  const dir = rng() < 0.5 ? 1 : -1; // 顺逆时针随机
  s[PLANET_IDX * 2] = s[host * 2] + orbitR * Math.cos(ang);
  s[PLANET_IDX * 2 + 1] = s[host * 2 + 1] + orbitR * Math.sin(ang);
  s[8 + PLANET_IDX * 2] = s[8 + host * 2] - dir * vc * Math.sin(ang);
  s[8 + PLANET_IDX * 2 + 1] = s[8 + host * 2 + 1] + dir * vc * Math.cos(ang);
}

/** 行星接收的恒星光度通量 F = Σ Lᵢ/dᵢ²（主序星光度∝质量^3.5），用于区分酷暑/严寒 */
export function stellarFlux(sys: SimSystem): number {
  const s = sys.state, m = sys.masses;
  const px = s[PLANET_IDX * 2], py = s[PLANET_IDX * 2 + 1];
  let f = 0;
  for (let i = 0; i < N_STARS; i++) {
    const d2 = (s[i * 2] - px) ** 2 + (s[i * 2 + 1] - py) ** 2;
    f += Math.pow(m[i], 3.5) / Math.max(d2, 1e-6);
  }
  return f;
}

export type PlanetFate = 'stable' | 'chaotic' | 'burned' | 'frozen' | 'extinct';

export interface PlanetStatus {
  fate: PlanetFate;
  nearestDist: number; // 与最近恒星的距离
}

/** 判定行星命运：恒纪元 / 乱纪元 / 焚毁 / 冻结 */
export function planetStatus(sys: SimSystem): PlanetStatus {
  const s = sys.state, m = sys.masses;
  const px = s[PLANET_IDX * 2], py = s[PLANET_IDX * 2 + 1];
  let d1 = Infinity, d2 = Infinity, host = 0;
  for (let i = 0; i < N_STARS; i++) {
    const d = Math.hypot(s[i * 2] - px, s[i * 2 + 1] - py);
    if (d < d1) { d2 = d1; d1 = d; host = i; }
    else if (d < d2) { d2 = d; }
  }
  if (d1 < 0.06) return { fate: 'burned', nearestDist: d1 };
  const [cx, cy] = starsCOM(sys);
  if (Math.hypot(px - cx, py - cy) > 25) return { fate: 'frozen', nearestDist: d1 };
  // 是否被单颗恒星束缚：相对比能量 < 0 且远离其他恒星
  const rvx = s[8 + PLANET_IDX * 2] - s[8 + host * 2];
  const rvy = s[8 + PLANET_IDX * 2 + 1] - s[8 + host * 2 + 1];
  const specEnergy = 0.5 * (rvx * rvx + rvy * rvy) - (G * m[host]) / d1;
  const bound = specEnergy < 0 && d1 < 0.4 * d2;
  return { fate: bound ? 'stable' : 'chaotic', nearestDist: d1 };
}

// ---------------------------------------------------------------------------
// 初始条件预设
// ---------------------------------------------------------------------------

export interface Preset {
  key: string;
  label: string;
  desc: string;
  masses: number[];   // 三颗恒星质量
  planetR: number;    // 行星初始轨道半径
  build: (rng?: () => number) => Float64Array; // 返回 16 维（行星槽位置零，由 placePlanet 填充）
}

/** 质量加权归零质心与总动量 */
function zeroCOM(s: Float64Array, masses: number[]): Float64Array {
  let cx = 0, cy = 0, cvx = 0, cvy = 0, mt = 0;
  for (let i = 0; i < N_STARS; i++) {
    cx += masses[i] * s[i * 2]; cy += masses[i] * s[i * 2 + 1];
    cvx += masses[i] * s[8 + i * 2]; cvy += masses[i] * s[8 + i * 2 + 1];
    mt += masses[i];
  }
  cx /= mt; cy /= mt; cvx /= mt; cvy /= mt;
  for (let i = 0; i < N_STARS; i++) {
    s[i * 2] -= cx; s[i * 2 + 1] -= cy;
    s[8 + i * 2] -= cvx; s[8 + i * 2 + 1] -= cvy;
  }
  return s;
}

function fromBodies(b: [number, number, number, number][], masses: number[]): Float64Array {
  const s = new Float64Array(16);
  for (let i = 0; i < N_STARS; i++) {
    s[i * 2] = b[i][0]; s[i * 2 + 1] = b[i][1];
    s[8 + i * 2] = b[i][2]; s[8 + i * 2 + 1] = b[i][3];
  }
  return zeroCOM(s, masses);
}

export const PRESETS: Preset[] = [
  {
    key: 'figure8',
    label: '8 字轮回',
    desc: '著名的周期解：三颗星沿同一个 8 字互相追逐。数学上要求严格等质量（1:1:1），是混沌海洋中罕见的秩序孤岛。',
    masses: [1, 1, 1],
    planetR: 0.5,
    build: () =>
      fromBodies(
        [
          [0.97000436, -0.24308753, 0.466203685, 0.43236573],
          [-0.97000436, 0.24308753, 0.466203685, 0.43236573],
          [0, 0, -0.93240737, -0.86473146],
        ],
        [1, 1, 1],
      ),
  },
  {
    key: 'lagrange',
    label: '拉格朗日三角',
    desc: '三颗星构成旋转的等边三角形——拉格朗日的解析解对任意质量成立，三星绕质心刚体式旋转。',
    masses: STORY_MASSES,
    planetR: 0.45,
    build: () => {
      const m = STORY_MASSES;
      const R = 1;
      const s = Math.sqrt(3) * R; // 三角形边长
      const omega = Math.sqrt((G * (m[0] + m[1] + m[2])) / (s * s * s));
      const b: [number, number, number, number][] = [];
      // 先放在圆上，再求质心，绕质心的切向刚体旋转 v = ω × r
      for (let i = 0; i < 3; i++) {
        const a = (i * 2 * Math.PI) / 3;
        b.push([R * Math.cos(a), R * Math.sin(a), 0, 0]);
      }
      let cx = 0, cy = 0, mt = 0;
      for (let i = 0; i < 3; i++) { cx += m[i] * b[i][0]; cy += m[i] * b[i][1]; mt += m[i]; }
      cx /= mt; cy /= mt;
      for (let i = 0; i < 3; i++) {
        const rx = b[i][0] - cx, ry = b[i][1] - cy;
        b[i][2] = -omega * ry;
        b[i][3] = omega * rx;
      }
      return fromBodies(b, m);
    },
  },
  {
    key: 'chaos',
    label: '乱纪元 · 随机',
    desc: '层级结构：α A 与 α B 组成双星，比邻星沿反向偏心外轨道环绕——约 9 成系统能安渡 1~10 分钟的恒纪元，但反向共振几乎注定最终走向混沌。',
    masses: STORY_MASSES,
    planetR: 0.15, // 紧贴 α A 内侧公转，避开双星扰动（且在焚毁半径 0.06 之外）
    build: (rng = Math.random) => {
      const [mA, mB, mC] = STORY_MASSES;
      // 内双星 A-B：近圆轨道
      const dIn = 0.5 + rng() * 0.2; // 内间距 0.5~0.7
      const eIn = rng() * 0.1;
      // 外轨道：比邻星，间距比 1.8~2.2（失稳侧），偏心率 0.25~0.5
      const dOut = dIn * (1.8 + rng() * 0.4);
      const eOut = 0.25 + rng() * 0.25;
      const MIn = mA + mB;
      const MTot = MIn + mC;
      const b: [number, number, number, number][] = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
      // 内双星（从近心点出发，切向速度 v = sqrt(G·M·(1+e)/d)）
      const thI = rng() * Math.PI * 2;
      const dirI = rng() < 0.5 ? 1 : -1;
      const uxI = Math.cos(thI), uyI = Math.sin(thI);
      const vRelI = Math.sqrt((G * MIn * (1 + eIn)) / dIn);
      b[0] = [-uxI * dIn * mB / MIn, -uyI * dIn * mB / MIn, dirI * uyI * vRelI * mB / MIn, -dirI * uxI * vRelI * mB / MIn];
      b[1] = [uxI * dIn * mA / MIn, uyI * dIn * mA / MIn, -dirI * uyI * vRelI * mA / MIn, dirI * uxI * vRelI * mA / MIn];
      // 外轨道：双星质心 vs 比邻星，反向环绕（实测该参数区反向轨道约 9 成最终失稳）
      const thO = rng() * Math.PI * 2;
      const dirO = -dirI;
      const uxO = Math.cos(thO), uyO = Math.sin(thO);
      const vRelO = Math.sqrt((G * MTot * (1 + eOut)) / dOut);
      const vxO = -dirO * uyO * vRelO, vyO = dirO * uxO * vRelO;
      for (const i of [0, 1]) {
        b[i][0] += -uxO * dOut * mC / MTot;
        b[i][1] += -uyO * dOut * mC / MTot;
        b[i][2] += vxO * mC / MTot;
        b[i][3] += vyO * mC / MTot;
      }
      b[2] = [uxO * dOut * MIn / MTot, uyO * dOut * MIn / MTot, -vxO * MIn / MTot, -vyO * MIn / MTot];
      return fromBodies(b, STORY_MASSES);
    },
  },
  {
    key: 'intruder',
    label: '双星与闯入者',
    desc: 'α A 与 α B 相拥成双星，渺小的比邻星从远方闯入——最常见的结局是有一颗被永远弹射出去。',
    masses: STORY_MASSES,
    planetR: 0.16,
    build: () => {
      const m = STORY_MASSES;
      const d = 0.56; // 双星间距
      const M = m[0] + m[1];
      const omega = Math.sqrt((G * M) / (d * d * d));
      // 质心在原点：r_i = d * m_j / M，v = ω * r_i
      const r1 = (d * m[1]) / M, r2 = (d * m[0]) / M;
      return fromBodies(
        [
          [-r1, 0, 0, -omega * r1],
          [r2, 0, 0, omega * r2],
          [2.3, 0.55, -0.62, -0.02],
        ],
        m,
      );
    },
  },
];

export const DEFAULT_PRESET = PRESETS[2];

/** 创建完整系统（恒星 + 行星 + 质量表） */
export function createSystem(preset: Preset, rng: () => number = Math.random): SimSystem {
  const sys: SimSystem = {
    state: preset.build(rng),
    masses: new Float64Array([...preset.masses, 0]),
  };
  placePlanet(sys, preset.planetR, rng);
  return sys;
}

/** 生成扰动孪生系统：仅给 0 号星速度的 x 分量一个 1e-6 的扰动 */
export function makeTwin(sys: SimSystem): SimSystem {
  const twin: SimSystem = {
    state: new Float64Array(sys.state),
    masses: new Float64Array(sys.masses),
  };
  twin.state[8] += 1e-6;
  return twin;
}
