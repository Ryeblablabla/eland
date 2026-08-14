/**
 * 离线复现 makePlanetTextureSet / makeStarSurfaceTexture 的像素生成逻辑，
 * 输出 PPM 图片与统计，用于排查行星纹理为何在 three.js 里显示为纯白。
 * 用法：node scripts/dump-planet-texture.mjs  （输出到 scripts/out/）
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), 'out');
mkdirSync(outDir, { recursive: true });

// --- 与 src/components/ThreeBodyCanvas.tsx 完全相同的生成逻辑 ----------------

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeNoiseGrids(octaves, rng) {
  return octaves.map((n) => {
    const g = new Float64Array(n * n);
    for (let i = 0; i < n * n; i++) g[i] = rng();
    return { g, w: n, h: n };
  });
}

function sampleGrid({ g, w, h }, x, y) {
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

function fbm(grids, x, y) {
  let v = 0, amp = 0.5, tot = 0;
  for (const grid of grids) {
    v += sampleGrid(grid, x * grid.w, y * grid.h) * amp;
    tot += amp;
    amp *= 0.5;
  }
  return v / tot;
}

// 颜色（THREE.Color 的 hex 等效 RGB）
const C = {
  deep: [10, 47, 60], shallow: [23, 96, 109],
  landLow: [61, 107, 76], landHigh: [151, 135, 90],
  ice: [221, 243, 238], white: [255, 255, 255],
};
const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// --- 行星 day / clouds ------------------------------------------------------

const W = 256, H = 128;
const rng = mulberry32(4242);
const grids = makeNoiseGrids([4, 8, 16, 32], rng);
const cloudGrids = makeNoiseGrids([3, 6, 12], rng);

const day = new Uint8Array(W * H * 3);
const cloud = new Uint8Array(W * H * 3);
let nMin = 1, nMax = 0, nSum = 0, clCover = 0, clSum = 0;

for (let y = 0; y < H; y++) {
  const lat = Math.abs(y / H - 0.5) * 2;
  for (let x = 0; x < W; x++) {
    const n = fbm(grids, x / W, y / H);
    nMin = Math.min(nMin, n); nMax = Math.max(nMax, n); nSum += n;
    const isIce = lat > 0.82 - n * 0.1;
    let rgb;
    if (isIce) rgb = C.ice;
    else if (n < 0.47) rgb = lerp(C.deep, C.shallow, Math.max(0, (n - 0.36) / 0.11));
    else if (n < 0.53) rgb = C.shallow;
    else if (n < 0.62) rgb = lerp(C.landLow, C.landHigh, (n - 0.53) / 0.09);
    else rgb = C.landHigh;
    const i = (y * W + x) * 3;
    day[i] = Math.round(rgb[0]); day[i + 1] = Math.round(rgb[1]); day[i + 2] = Math.round(rgb[2]);

    const cl = fbm(cloudGrids, x / W, (y / H) * 0.35);
    clSum += cl;
    const ca = cl > 0.56 ? Math.min((cl - 0.56) * 3.4, 0.92) : 0;
    if (ca > 0) clCover++;
    cloud[i] = cloud[i + 1] = cloud[i + 2] = Math.round(ca * 255);
  }
}

// --- 恒星表面（对照组，seed 与组件内一致） -----------------------------------

const S = 256;
const starRng = mulberry32(1000);
const starGrids = makeNoiseGrids([4, 8, 16, 32], starRng);
const glowA = [255, 179, 64], coreA = [255, 247, 224];
const star = new Uint8Array(S * S * 3);
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    let n = fbm(starGrids, x / S, y / S);
    n = Math.min(Math.max((n - 0.32) * 2.1, 0), 1);
    const dark = glowA.map((v) => v * 0.32);
    const rgb = n < 0.55 ? lerp(dark, glowA, n / 0.55) : lerp(glowA, coreA, (n - 0.55) / 0.45);
    const i = (y * S + x) * 3;
    star[i] = Math.round(rgb[0]); star[i + 1] = Math.round(rgb[1]); star[i + 2] = Math.round(rgb[2]);
  }
}

function writePpm(name, w, h, buf) {
  const header = Buffer.from(`P6\n${w} ${h}\n255\n`, 'ascii');
  writeFileSync(join(outDir, name), Buffer.concat([header, Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)]));
}

writePpm('planet-day.ppm', W, H, day);
writePpm('planet-cloud-alpha.ppm', W, H, cloud);
writePpm('star-surface.ppm', S, S, star);

const N = W * H;
console.log(JSON.stringify({
  fbmRange: [nMin.toFixed(3), nMax.toFixed(3)],
  fbmMean: (nSum / N).toFixed(3),
  cloudMean: (clSum / N).toFixed(3),
  cloudCoveragePct: ((clCover / N) * 100).toFixed(1),
}, null, 2));
