/**
 * 像素世界引擎 —— 人间地图的瓦片地形与精灵渲染。
 * 程序化生成（种子确定性），后续可整体替换为 AI 生成的 tilesheet 素材。
 * 参考：AI Town / Aivilization 的 2D 俯视像素小镇，但用夜色暗色系。
 */

export const TILE = 16;
export const MAP_W = 84;
export const MAP_H = 52;

// 地块类型
export const T = {
  GRASS: 0,
  GRASS_DARK: 1,
  SAND: 2,
  WATER: 3,
  TREE: 4,
  PATH: 5,
  CROP: 6,
  ROCKY: 7,
} as const;

export function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// 瓦片绘制（16×16 像素画）
// ---------------------------------------------------------------------------

type Pix = (g: CanvasRenderingContext2D, rng: () => number, frame: number) => void;

function speckle(g: CanvasRenderingContext2D, rng: () => number, colors: string[], n: number) {
  for (let i = 0; i < n; i++) {
    g.fillStyle = colors[Math.floor(rng() * colors.length)];
    g.fillRect(Math.floor(rng() * TILE), Math.floor(rng() * TILE), 1, 1);
  }
}

const PAINTERS: Record<number, Pix> = {
  [T.GRASS]: (g, rng) => {
    g.fillStyle = '#24402e'; g.fillRect(0, 0, TILE, TILE);
    speckle(g, rng, ['#2c4f38', '#1c3324', '#31583f'], 14);
    // 草叶细芒
    g.fillStyle = '#3a6547';
    for (let i = 0; i < 3; i++) g.fillRect(Math.floor(rng() * 14), Math.floor(rng() * 14), 1, 2);
    // 偶发小花
    if (rng() < 0.06) {
      g.fillStyle = rng() < 0.5 ? '#b8a4d8' : '#d8c98a';
      g.fillRect(Math.floor(rng() * 13) + 1, Math.floor(rng() * 13) + 1, 2, 2);
    }
  },
  [T.GRASS_DARK]: (g, rng) => {
    g.fillStyle = '#1d3527'; g.fillRect(0, 0, TILE, TILE);
    speckle(g, rng, ['#24402e', '#182b1f'], 12);
  },
  [T.SAND]: (g, rng) => {
    g.fillStyle = '#5c4d33'; g.fillRect(0, 0, TILE, TILE);
    speckle(g, rng, ['#6b5a3c', '#50422c', '#776648'], 12);
    // 风蚀弧纹
    if (rng() < 0.3) {
      g.strokeStyle = 'rgba(200,170,110,0.35)';
      g.lineWidth = 1;
      g.beginPath();
      g.arc(rng() * 10 + 3, rng() * 8 + 6, 3 + rng() * 4, Math.PI * 0.1, Math.PI * 0.8);
      g.stroke();
    }
  },
  [T.WATER]: (g, rng, frame) => {
    g.fillStyle = '#17334f'; g.fillRect(0, 0, TILE, TILE);
    g.fillStyle = '#265179';
    // 两帧水波：短横线错位
    for (let i = 0; i < 4; i++) {
      const y = 2 + i * 4;
      const x = ((i * 7 + frame * 6) % 12);
      g.fillRect(x, y, 4, 1);
    }
    speckle(g, rng, ['#1e4066'], 4);
  },
  [T.TREE]: (g, rng) => {
    g.fillStyle = '#1d3527'; g.fillRect(0, 0, TILE, TILE);
    speckle(g, rng, ['#24402e'], 6);
    const variant = rng();
    g.fillStyle = '#3d2f22'; g.fillRect(7, 10, 2, 5); // 树干
    if (variant < 0.55) {
      // 针叶松（双层）
      g.fillStyle = '#173f2c';
      g.beginPath(); g.moveTo(8, 1); g.lineTo(14, 11); g.lineTo(2, 11); g.closePath(); g.fill();
      g.fillStyle = '#1f5a3a';
      g.beginPath(); g.moveTo(8, 2); g.lineTo(12.5, 10); g.lineTo(3.5, 10); g.closePath(); g.fill();
    } else if (variant < 0.85) {
      // 圆冠树
      g.fillStyle = '#1a4a30';
      g.beginPath(); g.arc(8, 6, 6, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#256b42';
      g.beginPath(); g.arc(6.5, 5, 3.5, 0, Math.PI * 2); g.fill();
    } else {
      // 矮灌木
      g.fillStyle = '#1f5a3a';
      g.beginPath(); g.arc(5, 10, 3, 0, Math.PI * 2); g.arc(11, 10, 3.5, 0, Math.PI * 2); g.fill();
    }
  },
  [T.PATH]: (g, rng) => {
    g.fillStyle = '#4a3f30'; g.fillRect(0, 0, TILE, TILE);
    speckle(g, rng, ['#554936', '#3e3528'], 10);
  },
  [T.ROCKY]: (g, rng) => {
    g.fillStyle = '#3d4450'; g.fillRect(0, 0, TILE, TILE);
    speckle(g, rng, ['#4a5260', '#323a44', '#5a6474'], 12);
    g.fillStyle = '#525c6e';
    g.fillRect(3 + Math.floor(rng() * 6), 3 + Math.floor(rng() * 6), 5, 4);
    g.fillStyle = '#6a7488';
    g.fillRect(3 + Math.floor(rng() * 6), 3 + Math.floor(rng() * 4), 2, 1);
  },
  [T.CROP]: (g, rng) => {
    g.fillStyle = '#2a3c22'; g.fillRect(0, 0, TILE, TILE);
    g.fillStyle = '#577a35';
    for (let r = 0; r < 4; r++) g.fillRect(1, 2 + r * 4, 14, 1);
    speckle(g, rng, ['#7ba24f', '#8fb85e'], 8);
  },
};

/** 岸水交融：在邻水的陆地上画湿岸过渡带 */
function paintShores(g: CanvasRenderingContext2D, grid: Uint8Array) {
  const at = (x: number, y: number) => y * MAP_W + x;
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const id = grid[at(x, y)];
      if (id === T.WATER) continue;
      const near = [[0, -1], [0, 1], [-1, 0], [1, 0]];
      for (const [dx, dy] of near) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) continue;
        if (grid[at(nx, ny)] !== T.WATER) continue;
        g.fillStyle = 'rgba(23,51,79,0.55)';
        if (dy === -1) g.fillRect(x * TILE, y * TILE, TILE, 3);
        if (dy === 1) g.fillRect(x * TILE, y * TILE + TILE - 3, TILE, 3);
        if (dx === -1) g.fillRect(x * TILE, y * TILE, 3, TILE);
        if (dx === 1) g.fillRect(x * TILE + TILE - 3, y * TILE, 3, TILE);
      }
    }
  }
}

/** 散落的岩石（直接画在静态地形上） */
function paintRocks(g: CanvasRenderingContext2D, rng: () => number, grid: Uint8Array) {
  for (let i = 0; i < 40; i++) {
    const x = Math.floor(rng() * MAP_W), y = Math.floor(rng() * MAP_H);
    if (grid[y * MAP_W + x] !== T.GRASS && grid[y * MAP_W + x] !== T.GRASS_DARK) continue;
    const px = x * TILE + 4 + rng() * 8, py = y * TILE + 6 + rng() * 6;
    g.fillStyle = '#4a5260';
    g.fillRect(px, py, 3 + rng() * 3, 2 + rng() * 2);
    g.fillStyle = '#67718a';
    g.fillRect(px, py, 2, 1);
  }
}

// ---------------------------------------------------------------------------
// 世界生成
// ---------------------------------------------------------------------------

export interface WorldMap {
  grid: Uint8Array;
  terrain: HTMLCanvasElement;  // 静态层（水用第 0 帧预渲染，动态水在渲染循环里补）
  waterCells: [number, number][];
  anchors: { tx: number; ty: number }[]; // 建筑锚点（瓦片坐标），与传入 locations 顺序一致
}

/** 百分比坐标 → 瓦片锚点（留出建筑绘制空间） */
function toAnchor(x: number, y: number): { tx: number; ty: number } {
  return {
    tx: Math.max(2, Math.min(MAP_W - 6, Math.round((x / 100) * MAP_W) - 2)),
    ty: Math.max(3, Math.min(MAP_H - 5, Math.round((y / 100) * MAP_H) - 2)),
  };
}

export function genWorld(
  seed: number,
  locations: { name: string; x: number; y: number }[],
): WorldMap {
  const rng = mulberry32(seed);
  const anchors = locations.map((l) => toAnchor(l.x, l.y));
  const grid = new Uint8Array(MAP_W * MAP_H).fill(T.GRASS);
  const at = (x: number, y: number) => y * MAP_W + x;
  const inMap = (x: number, y: number) => x >= 0 && y >= 0 && x < MAP_W && y < MAP_H;

  // 草地明暗噪点
  for (let i = 0; i < MAP_W * MAP_H; i++) if (rng() < 0.35) grid[i] = T.GRASS_DARK;

  // 河流：西侧自北向南蜿蜒
  let rx = 8;
  for (let y = 0; y < MAP_H; y++) {
    rx += Math.floor(rng() * 3) - 1;
    rx = Math.max(4, Math.min(14, rx));
    for (let dx = 0; dx < 2; dx++) if (inMap(rx + dx, y)) grid[at(rx + dx, y)] = T.WATER;
  }

  // 森林：两片团块（西大东小）
  for (const [fCx, fCy, fR] of [[22, 26, 10], [62, 38, 7]] as const) {
    for (let y = fCy - fR; y <= fCy + fR; y++) {
      for (let x = fCx - fR; x <= fCx + fR * 2; x++) {
        if (!inMap(x, y)) continue;
        const d = Math.hypot((x - fCx) / 1.6, y - fCy);
        if (d < fR && rng() < 0.75 - d / fR * 0.5 && grid[at(x, y)] !== T.WATER) grid[at(x, y)] = T.TREE;
      }
    }
  }

  // 岩石山地：东北一隅
  const hCx = 70, hCy = 12, hR = 8;
  for (let y = hCy - hR; y <= hCy + hR; y++) {
    for (let x = hCx - hR; x <= hCx + hR; x++) {
      if (!inMap(x, y)) continue;
      const d = Math.hypot(x - hCx, y - hCy);
      if (d < hR && rng() < 0.8 - d / hR * 0.4 && grid[at(x, y)] === T.GRASS) grid[at(x, y)] = T.ROCKY;
    }
  }

  // 池塘：中部随机两三洼
  for (let p = 0; p < 3; p++) {
    const pCx = 30 + Math.floor(rng() * 30), pCy = 14 + Math.floor(rng() * 24), pR = 1.6 + rng() * 1.8;
    for (let y = Math.floor(pCy - pR); y <= pCy + pR; y++) {
      for (let x = Math.floor(pCx - pR * 1.6); x <= pCx + pR * 1.6; x++) {
        if (!inMap(x, y)) continue;
        const d = Math.hypot((x - pCx) / 1.6, y - pCy);
        if (d < pR && grid[at(x, y)] !== T.TREE && grid[at(x, y)] !== T.ROCKY) grid[at(x, y)] = T.WATER;
      }
    }
  }

  // 锚点周围清理出空地
  for (const a of anchors) {
    for (let dy = -1; dy <= 2; dy++) for (let dx = -2; dx <= 4; dx++) {
      const x = a.tx + dx, y = a.ty + dy;
      if (inMap(x, y) && (grid[at(x, y)] === T.TREE || grid[at(x, y)] === T.WATER)) grid[at(x, y)] = T.GRASS;
    }
  }

  // 预渲染静态地形（水用第 0 帧）
  const terrain = document.createElement('canvas');
  terrain.width = MAP_W * TILE; terrain.height = MAP_H * TILE;
  const g = terrain.getContext('2d')!;
  const tileCanvas = document.createElement('canvas');
  tileCanvas.width = TILE; tileCanvas.height = TILE;
  const tg = tileCanvas.getContext('2d')!;
  const waterCells: [number, number][] = [];
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const id = grid[at(x, y)];
      PAINTERS[id](tg, rng, 0);
      g.drawImage(tileCanvas, x * TILE, y * TILE);
      if (id === T.WATER) waterCells.push([x, y]);
    }
  }

  // 后处理：岸水交融 + 岩石散点
  paintShores(g, grid);
  paintRocks(g, rng, grid);

  return { grid, terrain, waterCells, anchors };
}

/** 动态补画一帧水波 */
export function paintWaterFrame(g: CanvasRenderingContext2D, world: WorldMap, frame: number, rngSeed = 7) {
  const rng = mulberry32(rngSeed); // 固定种子，帧间不闪
  const tileCanvas = document.createElement('canvas');
  tileCanvas.width = TILE; tileCanvas.height = TILE;
  const tg = tileCanvas.getContext('2d')!;
  for (const [x, y] of world.waterCells) {
    PAINTERS[T.WATER](tg, rng, frame);
    g.drawImage(tileCanvas, x * TILE, y * TILE);
  }
}

// ---------------------------------------------------------------------------
// 建筑与人物精灵
// ---------------------------------------------------------------------------

/** 建筑绘制（世界像素坐标，ax/ay 为锚点左上角） */
export function drawBuilding(g: CanvasRenderingContext2D, name: string, ax: number, ay: number, progress: number, timeMs: number) {
  const flick = 0.75 + 0.25 * Math.sin(timeMs / 130 + ax);
  // 地影
  g.fillStyle = 'rgba(2,6,14,0.35)';
  g.beginPath();
  g.ellipse(ax + 20, ay + 20, 22, 5, 0, 0, Math.PI * 2);
  g.fill();
  switch (name) {
    case '营地': {
      for (const [dx, dy] of [[0, 6], [18, 2], [30, 9]] as const) {
        g.fillStyle = '#6b5b45';
        g.beginPath(); g.moveTo(ax + dx + 7, ay + dy); g.lineTo(ax + dx + 14, ay + dy + 10); g.lineTo(ax + dx, ay + dy + 10); g.closePath(); g.fill();
        g.fillStyle = '#544633';
        g.beginPath(); g.moveTo(ax + dx + 7, ay + dy + 3); g.lineTo(ax + dx + 11, ay + dy + 10); g.lineTo(ax + dx + 3, ay + dy + 10); g.closePath(); g.fill();
      }
      // 篝火
      g.fillStyle = `rgba(255,160,60,${flick})`;
      g.fillRect(ax + 19, ay + 17, 3, 3);
      g.fillStyle = `rgba(255,200,90,${flick})`;
      g.fillRect(ax + 20, ay + 16, 1, 1);
      g.fillStyle = 'rgba(80,60,40,0.9)';
      g.fillRect(ax + 18, ay + 20, 5, 1);
      break;
    }
    case '观星台': {
      g.fillStyle = '#4e5a6e'; g.fillRect(ax + 4, ay + 8, 18, 12);
      g.fillStyle = '#65738c';
      g.beginPath(); g.arc(ax + 13, ay + 8, 9, Math.PI, 0); g.fill();
      g.fillStyle = '#2e3746'; g.fillRect(ax + 10, ay + 14, 4, 6); // 门
      g.strokeStyle = '#8b99b3'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(ax + 16, ay + 4); g.lineTo(ax + 26, ay - 6); g.stroke(); // 望远镜
      break;
    }
    case '祭坛': {
      g.fillStyle = '#565060'; g.fillRect(ax, ay + 12, 26, 6);
      g.fillStyle = '#6a6378'; g.fillRect(ax + 4, ay + 7, 18, 5);
      g.fillStyle = `rgba(255,170,70,${flick})`;
      g.beginPath(); g.moveTo(ax + 13, ay - 3); g.lineTo(ax + 16, ay + 7); g.lineTo(ax + 10, ay + 7); g.closePath(); g.fill();
      g.fillStyle = `rgba(255,215,120,${flick})`;
      g.fillRect(ax + 12, ay + 3, 2, 3);
      break;
    }
    case '金字塔': {
      const h = 12 + (progress / 100) * 26;
      g.fillStyle = '#a68d5f';
      g.beginPath(); g.moveTo(ax + 20, ay + 34 - h); g.lineTo(ax + 40, ay + 34); g.lineTo(ax, ay + 34); g.closePath(); g.fill();
      g.fillStyle = '#8a7348';
      g.beginPath(); g.moveTo(ax + 20, ay + 34 - h); g.lineTo(ax + 40, ay + 34); g.lineTo(ax + 20, ay + 34); g.closePath(); g.fill();
      if (progress < 100) { // 脚手架
        g.strokeStyle = 'rgba(200,180,140,0.5)'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(ax + 36, ay + 34); g.lineTo(ax + 44, ay + 34 - h * 0.6); g.stroke();
      }
      break;
    }
    default: { // 田野：小屋
      g.fillStyle = '#5d4a35'; g.fillRect(ax + 8, ay + 4, 12, 9);
      g.fillStyle = '#463729';
      g.beginPath(); g.moveTo(ax + 6, ay + 5); g.lineTo(ax + 14, ay - 2); g.lineTo(ax + 22, ay + 5); g.closePath(); g.fill();
    }
  }
}

/** 涌现建筑：人物真实建造的结构。未完工画脚手架工地，完工按 traits 画实体 */
export function drawStructure(
  g: CanvasRenderingContext2D,
  st: { name: string; progress: number; complete: boolean; traits: string[] },
  x: number, y: number, timeMs: number,
) {
  g.fillStyle = 'rgba(2,6,14,0.35)';
  g.beginPath(); g.ellipse(x + 8, y + 12, 12, 3, 0, 0, Math.PI * 2); g.fill();
  if (!st.complete) {
    // 工地：木架 + 进度条
    g.strokeStyle = '#7a6a4a'; g.lineWidth = 1;
    g.strokeRect(x, y, 16, 12);
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + 16, y + 12); g.moveTo(x + 16, y); g.lineTo(x, y + 12); g.stroke();
    g.fillStyle = '#3a3325'; g.fillRect(x, y + 14, 16, 2);
    g.fillStyle = '#c9a85a'; g.fillRect(x, y + 14, 16 * st.progress / 100, 2);
    return;
  }
  if (st.traits.includes('instrument')) {
    // 仪器/观测所：带晶球的小塔
    g.fillStyle = '#4e5a6e'; g.fillRect(x + 4, y - 4, 8, 16);
    g.fillStyle = '#65738c'; g.beginPath(); g.arc(x + 8, y - 4, 5, Math.PI, 0); g.fill();
    const glow = 0.6 + 0.4 * Math.sin(timeMs / 500 + x);
    g.fillStyle = `rgba(140,200,255,${glow})`;
    g.fillRect(x + 7, y - 9, 2, 2);
  } else if (st.traits.includes('shelter')) {
    // 庇护所：小屋
    g.fillStyle = '#5d4a35'; g.fillRect(x + 1, y, 14, 12);
    g.fillStyle = '#463729';
    g.beginPath(); g.moveTo(x - 1, y + 1); g.lineTo(x + 8, y - 7); g.lineTo(x + 17, y + 1); g.closePath(); g.fill();
    g.fillStyle = '#2e2519'; g.fillRect(x + 6, y + 6, 4, 6); // 门
    g.fillStyle = 'rgba(255,180,80,0.5)'; g.fillRect(x + 11, y + 3, 2, 2); // 窗火
  } else {
    // 平台/其他结构
    g.fillStyle = '#565060'; g.fillRect(x, y + 6, 16, 6);
    g.fillStyle = '#6a6378'; g.fillRect(x + 2, y + 2, 12, 4);
  }
}

const ROBES = ['#7d8aa0', '#a08a7d', '#8aa07d', '#9a7da0', '#7da09a', '#a09a7d'];

// ---------------------------------------------------------------------------
// 聚落装饰与野生动物
// ---------------------------------------------------------------------------

/** 每个聚落地标周围的一簇生活道具（种子确定） */
export function drawProps(g: CanvasRenderingContext2D, kind: string, ax: number, ay: number, timeMs: number) {
  const flick = 0.7 + 0.3 * Math.sin(timeMs / 150 + ax * 3);
  switch (kind) {
    case '营地': {
      // 柴堆
      g.fillStyle = '#4a3a28';
      for (let i = 0; i < 4; i++) g.fillRect(ax - 8 + i * 3, ay + 16 - (i % 2), 2, 5);
      // 晾架
      g.strokeStyle = '#5d4c38'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(ax + 40, ay + 4); g.lineTo(ax + 40, ay + 16); g.moveTo(ax + 48, ay + 4); g.lineTo(ax + 48, ay + 16); g.moveTo(ax + 39, ay + 6); g.lineTo(ax + 49, ay + 6); g.stroke();
      g.fillStyle = '#8a6d4a'; g.fillRect(ax + 41, ay + 6, 2, 4); g.fillRect(ax + 45, ay + 6, 2, 5);
      break;
    }
    case '田野': {
      // 稻草人
      g.strokeStyle = '#6d5a3d'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(ax + 34, ay + 2); g.lineTo(ax + 34, ay + 14); g.moveTo(ax + 30, ay + 7); g.lineTo(ax + 38, ay + 7); g.stroke();
      g.fillStyle = '#c9b083'; g.fillRect(ax + 32, ay - 1, 4, 4);
      g.fillStyle = '#8a7348'; g.fillRect(ax + 31, ay - 2, 6, 1);
      // 草垛
      g.fillStyle = '#9a8148';
      g.beginPath(); g.arc(ax - 4, ay + 12, 5, Math.PI, 0); g.fill();
      g.fillStyle = '#b89a5a'; g.fillRect(ax - 8, ay + 10, 8, 1);
      break;
    }
    case '祭坛': {
      // 石阵
      g.fillStyle = '#5a6373';
      for (let i = 0; i < 6; i++) {
        const ang = (i / 6) * Math.PI * 2;
        g.fillRect(ax + 13 + Math.cos(ang) * 22 - 1, ay + 12 + Math.sin(ang) * 12 - 2, 3, 4);
      }
      break;
    }
    case '观星台': {
      // 星表杆与旗
      g.strokeStyle = '#5d6a80'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(ax - 6, ay - 4); g.lineTo(ax - 6, ay + 14); g.stroke();
      g.fillStyle = `rgba(150,170,210,${flick})`;
      g.beginPath(); g.moveTo(ax - 6, ay - 4); g.lineTo(ax + 2, ay - 1); g.lineTo(ax - 6, ay + 2); g.closePath(); g.fill();
      break;
    }
    case '小屋': {
      // 板条箱与工具堆
      g.fillStyle = '#544632';
      g.fillRect(ax + 26, ay + 10, 5, 5);
      g.fillStyle = '#655540';
      g.fillRect(ax + 26, ay + 10, 5, 1);
      g.fillRect(ax + 32, ay + 12, 4, 4);
      break;
    }
    default:
      break;
  }
}

/** 鹿（森林与河岸的访客） */
export function drawDeer(g: CanvasRenderingContext2D, x: number, y: number, frame: number, flip: boolean) {
  g.save();
  if (flip) { g.translate(x * 2, 0); g.scale(-1, 1); }
  const legOff = frame % 2 === 0 ? 1 : 0;
  g.fillStyle = 'rgba(2,6,14,0.3)';
  g.fillRect(x - 6, y + 3, 12, 2);
  g.fillStyle = '#7a6248'; // 身
  g.fillRect(x - 5, y - 4, 10, 5);
  g.fillRect(x - 5, y - 6, 3, 3); // 颈
  g.fillRect(x - 6, y - 9, 4, 3); // 头
  g.fillStyle = '#5d4a36'; // 腿
  g.fillRect(x - 4, y + 1, 1, 3 + legOff);
  g.fillRect(x + 3, y + 1, 1, 3 - legOff);
  g.fillRect(x - 1, y + 1, 1, 3);
  g.strokeStyle = '#c9b083'; g.lineWidth = 1; // 角
  g.beginPath(); g.moveTo(x - 6, y - 9); g.lineTo(x - 8, y - 12); g.moveTo(x - 5, y - 9); g.lineTo(x - 4, y - 12); g.stroke();
  g.restore();
}

/** 飞鸟（定期掠过天际） */
export function drawBird(g: CanvasRenderingContext2D, x: number, y: number, frame: number) {
  g.strokeStyle = 'rgba(200,215,235,0.75)';
  g.lineWidth = 1.5;
  const wing = frame % 2 === 0 ? 3 : 1;
  g.beginPath();
  g.moveTo(x - 4, y);
  g.quadraticCurveTo(x - 1, y - wing, x, y);
  g.quadraticCurveTo(x + 1, y - wing, x + 4, y);
  g.stroke();
}

/** 人烟标记：有人活动痕迹（火种/刻痕/工地）但还没有完工建筑的地点 */
export function drawMarker(g: CanvasRenderingContext2D, ax: number, ay: number, timeMs: number) {
  const flick = 0.7 + 0.3 * Math.sin(timeMs / 140 + ay);
  // 石圈营火
  g.fillStyle = '#4a5260';
  g.fillRect(ax + 5, ay + 14, 2, 2); g.fillRect(ax + 13, ay + 14, 2, 2); g.fillRect(ax + 9, ay + 16, 2, 2);
  g.fillStyle = `rgba(255,160,60,${flick})`;
  g.fillRect(ax + 8, ay + 10, 3, 4);
  g.fillStyle = `rgba(255,210,110,${flick})`;
  g.fillRect(ax + 9, ay + 9, 1, 2);
  // 木标桩
  g.fillStyle = '#5d4c38';
  g.fillRect(ax + 18, ay + 6, 1, 10);
  g.fillRect(ax + 16, ay + 8, 5, 1);
}

/** 像素小人（行走两帧 / 脱水纤维捆），带地面投影 */
export function drawPerson(
  g: CanvasRenderingContext2D,
  x: number, y: number,
  opt: { moving: boolean; frame: number; dehydrated: boolean; highlight: 'none' | 'speaker' | 'selected'; robeIdx: number },
) {
  if (opt.dehydrated) {
    // 纤维捆：横躺的束状物
    g.fillStyle = 'rgba(2,6,14,0.4)';
    g.fillRect(x - 6, y + 1, 12, 2);
    g.fillStyle = '#8a6d4a';
    g.fillRect(x - 5, y - 2, 10, 3);
    g.fillStyle = '#6d5639';
    g.fillRect(x - 5, y - 1, 10, 1);
    g.fillRect(x - 3, y - 3, 1, 5);
    g.fillRect(x + 2, y - 3, 1, 5);
    return;
  }
  // 地面投影
  g.fillStyle = 'rgba(2,6,14,0.35)';
  g.beginPath();
  g.ellipse(x, y + 1, 5, 2, 0, 0, Math.PI * 2);
  g.fill();
  const robe = ROBES[opt.robeIdx % ROBES.length];
  const legOff = opt.moving ? (opt.frame % 2 === 0 ? 1 : -1) : 0;
  // 腿
  g.fillStyle = '#3a3f4a';
  g.fillRect(x - 2, y - 3, 2, 3 + legOff);
  g.fillRect(x + 1, y - 3, 2, 3 - legOff);
  // 袍（带深色下摆）
  g.fillStyle = robe;
  g.fillRect(x - 3, y - 8, 6, 5);
  g.fillStyle = 'rgba(0,0,0,0.25)';
  g.fillRect(x - 3, y - 4, 6, 1);
  // 头
  g.fillStyle = '#d9c4a5';
  g.fillRect(x - 2, y - 12, 4, 4);
  g.fillStyle = 'rgba(30,34,44,0.85)'; // 发
  g.fillRect(x - 2, y - 13, 4, 1);
  // 高亮
  if (opt.highlight !== 'none') {
    g.strokeStyle = opt.highlight === 'speaker' ? 'rgba(252,211,77,0.9)' : 'rgba(240,171,252,0.9)';
    g.lineWidth = 1;
    g.strokeRect(x - 6, y - 15, 12, 16);
  }
}
