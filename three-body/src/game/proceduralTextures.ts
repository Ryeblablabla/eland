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

export interface PlanetTextureSet {
  day: THREE.CanvasTexture;
  roughness: THREE.CanvasTexture;
  normal: THREE.CanvasTexture;
  water: THREE.CanvasTexture;
  clouds: THREE.CanvasTexture;
}

/**
 * 三体星表面组：按类地气候规则生成虚构地理，而不是复刻真实地球大陆。
 * 输出 PBR 所需的昼面、粗糙度、微法线、水体 clearcoat 掩码与独立云层。
 */
export function makePlanetTextureSet(seed: number): PlanetTextureSet {
  const W = 1024, H = 512;
  const rng = mulberry32(seed);
  const continentGrids = makeNoiseGrids([3, 6, 12, 24, 48, 96], rng);
  const reliefGrids = makeNoiseGrids([8, 16, 32, 64], rng);
  const moistureGrids = makeNoiseGrids([4, 8, 16, 32], rng);
  const cloudGrids = makeNoiseGrids([4, 8, 16, 32, 64], rng);
  const weatherGrids = makeNoiseGrids([3, 6, 12, 24], rng);
  const makeCanvas = () => {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    return c;
  };
  const dayC = makeCanvas();
  const roughnessC = makeCanvas();
  const normalC = makeCanvas();
  const waterC = makeCanvas();
  const cloudC = makeCanvas();
  const dayCtx = dayC.getContext('2d')!;
  const roughnessCtx = roughnessC.getContext('2d')!;
  const normalCtx = normalC.getContext('2d')!;
  const waterCtx = waterC.getContext('2d')!;
  const cloudCtx = cloudC.getContext('2d')!;
  const dayImg = dayCtx.createImageData(W, H);
  const roughnessImg = roughnessCtx.createImageData(W, H);
  const normalImg = normalCtx.createImageData(W, H);
  const waterImg = waterCtx.createImageData(W, H);
  const cloudImg = cloudCtx.createImageData(W, H);
  const elevation = new Float32Array(W * H);
  const deep = new THREE.Color('#061f38');
  const ocean = new THREE.Color('#0b4f73');
  const shallow = new THREE.Color('#2b8ca0');
  const beach = new THREE.Color('#b6a878');
  const dry = new THREE.Color('#a98b55');
  const grass = new THREE.Color('#4f7548');
  const forest = new THREE.Color('#244f3b');
  const rock = new THREE.Color('#756d61');
  const tundra = new THREE.Color('#8e9a82');
  const ice = new THREE.Color('#e8f5f3');
  const tmp = new THREE.Color();
  const coastTmp = new THREE.Color();
  const dayEncoded = new THREE.Color();
  const seaLevel = 0.525;

  // 先得到连续高度场，随后由高度梯度生成切线空间微法线。
  for (let y = 0; y < H; y++) {
    const v = y / H;
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const continent = fbm(continentGrids, u, v);
      const relief = fbm(reliefGrids, u + 0.035 * Math.sin(v * Math.PI * 2), v);
      elevation[y * W + x] = continent * 0.84 + relief * 0.16;
    }
  }

  for (let y = 0; y < H; y++) {
    const v = y / H;
    const latitude = Math.abs(v - 0.5) * 2; // 0 赤道 → 1 极
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const h = elevation[y * W + x];
      const landHeight = Math.max(0, (h - seaLevel) / (1 - seaLevel));
      const moisture = fbm(moistureGrids, u + 0.025 * Math.sin(v * Math.PI * 4), v);
      const surfaceDetail = fbm(reliefGrids, u + 0.173, v + 0.117);
      const temperature = THREE.MathUtils.clamp(1 - Math.pow(latitude, 1.35) - landHeight * 0.42, 0, 1);
      const polarIce = latitude > 0.86 - 0.07 * surfaceDetail;
      const isWater = h < seaLevel && !polarIce;
      const isIce = polarIce || (!isWater && temperature < 0.12);

      if (isIce) {
        tmp.copy(ice).lerp(tundra, THREE.MathUtils.clamp((0.18 - temperature) * 1.5, 0, 0.2));
      } else if (isWater) {
        const coast = THREE.MathUtils.smoothstep(h, seaLevel - 0.16, seaLevel);
        tmp.copy(deep).lerp(ocean, coast).lerp(shallow, coast * coast * 0.42);
      } else if (landHeight < 0.012) {
        tmp.copy(beach);
      } else if (landHeight > 0.33) {
        tmp.copy(rock).lerp(ice, THREE.MathUtils.smoothstep(landHeight, 0.55, 0.9));
      } else if (temperature < 0.28) {
        tmp.copy(tundra).lerp(grass, moisture * 0.28);
      } else if (moisture < 0.42 && latitude > 0.16 && latitude < 0.62) {
        tmp.copy(dry).lerp(grass, THREE.MathUtils.smoothstep(moisture, 0.28, 0.48) * 0.35);
      } else {
        tmp.copy(grass).lerp(forest, THREE.MathUtils.smoothstep(moisture, 0.46, 0.72));
      }

      if (!isWater && !isIce) tmp.multiplyScalar(0.84 + surfaceDetail * 0.3);
      // 在一个很窄的高度区间内抗锯齿，避免程序化大陆边缘出现像素阶梯。
      if (!isIce && Math.abs(h - seaLevel) < 0.012) {
        coastTmp.copy(tmp);
        tmp.copy(shallow).lerp(
          coastTmp,
          THREE.MathUtils.smoothstep(h, seaLevel - 0.006, seaLevel + 0.012),
        );
      }

      dayEncoded.copy(tmp).convertLinearToSRGB();
      const i = (y * W + x) * 4;
      dayImg.data[i] = Math.round(dayEncoded.r * 255);
      dayImg.data[i + 1] = Math.round(dayEncoded.g * 255);
      dayImg.data[i + 2] = Math.round(dayEncoded.b * 255);
      dayImg.data[i + 3] = 255;

      const roughness = isWater ? 82 : isIce ? 155 : Math.round(205 + landHeight * 38);
      roughnessImg.data[i] = roughnessImg.data[i + 1] = roughnessImg.data[i + 2] = roughness;
      roughnessImg.data[i + 3] = 255;
      const waterMask = isWater ? 255 : isIce ? 42 : 0;
      waterImg.data[i] = waterImg.data[i + 1] = waterImg.data[i + 2] = waterMask;
      waterImg.data[i + 3] = 255;

      // 两组不同尺度的天气噪声形成云带，纬度调制让副热带区域更稀疏。
      const windU = u + 0.045 * Math.sin(v * Math.PI * 4);
      const cloudNoise = fbm(cloudGrids, windU, v) * 0.72 + fbm(weatherGrids, u, v) * 0.28;
      const subtropicalDry = Math.exp(-Math.pow((latitude - 0.36) / 0.13, 2)) * 0.055;
      const cloudDensity = cloudNoise - subtropicalDry;
      const ca = THREE.MathUtils.smoothstep(cloudDensity, 0.49, 0.62) * 0.82;
      cloudImg.data[i] = 235;
      cloudImg.data[i + 1] = 246;
      cloudImg.data[i + 2] = 255;
      cloudImg.data[i + 3] = Math.round(ca * 255);
    }
  }

  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - 1);
    const y1 = Math.min(H - 1, y + 1);
    for (let x = 0; x < W; x++) {
      const x0 = (x - 1 + W) % W;
      const x1 = (x + 1) % W;
      const dx = (elevation[y * W + x1] - elevation[y * W + x0]) * 18;
      const dy = (elevation[y1 * W + x] - elevation[y0 * W + x]) * 9;
      const nx = -dx;
      const ny = dy;
      const nz = 1;
      const invLength = 1 / Math.hypot(nx, ny, nz);
      const i = (y * W + x) * 4;
      normalImg.data[i] = Math.round((nx * invLength * 0.5 + 0.5) * 255);
      normalImg.data[i + 1] = Math.round((ny * invLength * 0.5 + 0.5) * 255);
      normalImg.data[i + 2] = Math.round((nz * invLength * 0.5 + 0.5) * 255);
      normalImg.data[i + 3] = 255;
    }
  }

  dayCtx.putImageData(dayImg, 0, 0);
  roughnessCtx.putImageData(roughnessImg, 0, 0);
  normalCtx.putImageData(normalImg, 0, 0);
  waterCtx.putImageData(waterImg, 0, 0);
  cloudCtx.putImageData(cloudImg, 0, 0);
  const toTex = (c: HTMLCanvasElement, srgb: boolean) => {
    const t = new THREE.CanvasTexture(c);
    t.wrapS = THREE.RepeatWrapping;
    t.anisotropy = 4;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  return {
    day: toTex(dayC, true),
    roughness: toTex(roughnessC, false),
    normal: toTex(normalC, false),
    water: toTex(waterC, false),
    clouds: toTex(cloudC, true),
  };
}
