import * as THREE from 'three';

/**
 * 程序化表面纹理：周期化值噪声 + 分形叠加（fbm），零外部资源。
 * 供宇宙场景（ThreeBodyCanvas）与行星材质调试页（DebugPlanet）共用。
 */

export function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface NoiseGrid { g: Float64Array; w: number; h: number }

export function makeNoiseGrids(octaves: number[], rng: () => number): NoiseGrid[] {
  return octaves.map((n) => {
    const g = new Float64Array(n * n);
    for (let i = 0; i < n * n; i++) g[i] = rng();
    return { g, w: n, h: n };
  });
}

/** 双线性 + smoothstep 采样；x 方向周期（球面纹理横向无缝），y 方向钳制 */
export function sampleGrid({ g, w, h }: NoiseGrid, x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf);
  const x0 = ((xi % w) + w) % w, x1 = (x0 + 1) % w;
  const y0 = Math.min(Math.max(yi, 0), h - 1), y1 = Math.min(y0 + 1, h - 1);
  const a = g[y0 * w + x0], b = g[y0 * w + x1];
  const c2 = g[y1 * w + x0], d = g[y1 * w + x1];
  const top = a + (b - a) * sx, bot = c2 + (d - c2) * sx;
  return top + (bot - top) * sy;
}

/** 分形叠加：x,y ∈ [0,1) 归一化坐标，输出 [0,1] */
export function fbm(grids: NoiseGrid[], x: number, y: number): number {
  let v = 0, amp = 0.5, tot = 0;
  for (const grid of grids) {
    v += sampleGrid(grid, x * grid.w, y * grid.h) * amp;
    tot += amp;
    amp *= 0.5;
  }
  return v / tot;
}

/** 恒星表面：等离子颗粒（暗部 = 星光色压暗，亮斑 = 星芯色） */
export function makeStarSurfaceTexture(coreHex: string, glowHex: string, seed: number): THREE.CanvasTexture {
  const S = 256;
  const rng = mulberry32(seed);
  const grids = makeNoiseGrids([4, 8, 16, 32], rng);
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(S, S);
  const dark = new THREE.Color(glowHex).multiplyScalar(0.32);
  const mid = new THREE.Color(glowHex);
  const hot = new THREE.Color(coreHex);
  const tmp = new THREE.Color();
  const encoded = new THREE.Color();
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let n = fbm(grids, x / S, y / S);
      n = Math.min(Math.max((n - 0.32) * 2.1, 0), 1); // 对比度曲线，拉出颗粒感
      if (n < 0.55) tmp.copy(dark).lerp(mid, n / 0.55);
      else tmp.copy(mid).lerp(hot, (n - 0.55) / 0.45);
      // Three.Color 内部是线性色；Canvas 像素需要先编码回 sRGB，再交给 sRGB 纹理采样。
      encoded.copy(tmp).convertLinearToSRGB();
      const i = (y * S + x) * 4;
      img.data[i] = Math.round(encoded.r * 255);
      img.data[i + 1] = Math.round(encoded.g * 255);
      img.data[i + 2] = Math.round(encoded.b * 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 三体星表面组：日间海陆（无云）+ 高光掩码（海面反光）+ 独立云层 */
export function makePlanetTextureSet(seed: number): {
  day: THREE.CanvasTexture;
  spec: THREE.CanvasTexture;
  clouds: THREE.CanvasTexture;
} {
  const W = 512, H = 256; // 512 宽：聚焦近景时大陆边缘仍清晰
  const rng = mulberry32(seed);
  const grids = makeNoiseGrids([4, 8, 16, 32, 64], rng);
  const cloudGrids = makeNoiseGrids([3, 6, 12, 24], rng);
  const makeCanvas = () => {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    return c;
  };
  const dayC = makeCanvas(), specC = makeCanvas(), cloudC = makeCanvas();
  const dayCtx = dayC.getContext('2d')!;
  const specCtx = specC.getContext('2d')!;
  const cloudCtx = cloudC.getContext('2d')!;
  const dayImg = dayCtx.createImageData(W, H);
  const specImg = specCtx.createImageData(W, H);
  const cloudImg = cloudCtx.createImageData(W, H);
  // 提高对比度与饱和：近景下海洋不糊成黑团、陆地更暖
  const deep = new THREE.Color('#0e4258');
  const shallow = new THREE.Color('#1f7a8c');
  const landLow = new THREE.Color('#4a7a58');
  const landHigh = new THREE.Color('#a8946a');
  const ice = new THREE.Color('#ddf3ee');
  const tmp = new THREE.Color();
  const dayEncoded = new THREE.Color();
  for (let y = 0; y < H; y++) {
    const lat = Math.abs(y / H - 0.5) * 2; // 0 赤道 → 1 极
    for (let x = 0; x < W; x++) {
      const n = fbm(grids, x / W, y / H);
      const isIce = lat > 0.82 - n * 0.1;
      const isWater = !isIce && n < 0.53;
      if (isIce) tmp.copy(ice);
      else if (n < 0.47) tmp.copy(deep).lerp(shallow, Math.max(0, (n - 0.36) / 0.11));
      else if (n < 0.53) tmp.copy(shallow);
      else if (n < 0.62) tmp.copy(landLow).lerp(landHigh, (n - 0.53) / 0.09);
      else tmp.copy(landHigh);
      dayEncoded.copy(tmp).convertLinearToSRGB();
      const i = (y * W + x) * 4;
      dayImg.data[i] = Math.round(dayEncoded.r * 255);
      dayImg.data[i + 1] = Math.round(dayEncoded.g * 255);
      dayImg.data[i + 2] = Math.round(dayEncoded.b * 255);
      dayImg.data[i + 3] = 255;
      // 高光掩码：海面反光收窄（大白斑教训：控制在柔和范围）
      const sp = isWater ? 150 : isIce ? 56 : 14;
      specImg.data[i] = specImg.data[i + 1] = specImg.data[i + 2] = sp;
      specImg.data[i + 3] = 255;
      // 云层：更高阈值 + 更缓透明度，避免整面白纱
      const cl = fbm(cloudGrids, x / W, (y / H) * 0.35);
      const ca = cl > 0.63 ? Math.min((cl - 0.63) * 2.8, 0.75) : 0;
      cloudImg.data[i] = cloudImg.data[i + 1] = cloudImg.data[i + 2] = 255;
      cloudImg.data[i + 3] = Math.round(ca * 255);
    }
  }
  dayCtx.putImageData(dayImg, 0, 0);
  specCtx.putImageData(specImg, 0, 0);
  cloudCtx.putImageData(cloudImg, 0, 0);
  const toTex = (c: HTMLCanvasElement, srgb: boolean) => {
    const t = new THREE.CanvasTexture(c);
    t.wrapS = THREE.RepeatWrapping;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  return { day: toTex(dayC, true), spec: toTex(specC, false), clouds: toTex(cloudC, true) };
}
