/**
 * 无头浏览器截图调试：headless Chrome + CDP（零依赖，Node>=21 全局 WebSocket）。
 * 用法：
 *   node scripts/debug-shots.mjs cosmos            # 只截宇宙视角
 *   node scripts/debug-shots.mjs click 1420 700    # 在指定坐标点击（行星聚焦）后截图
 * 输出到 scripts/out/。
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), 'out');
mkdirSync(outDir, { recursive: true });

const mode = process.argv[2] ?? 'cosmos';
const clickX = Number(process.argv[3] ?? 0);
const clickY = Number(process.argv[4] ?? 0);
const URL_GAME = 'http://localhost:3299/game?autoenter=1';
const PORT = 9333;

const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--window-size=1600,900',
  '--hide-scrollbars',
  '--use-angle=swiftshader', // 无 GPU 环境下的 WebGL 软件渲染
  URL_GAME,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTargetWs() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page' && t.url.includes('localhost:3299'));
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* chrome 未就绪 */ }
    await sleep(400);
  }
  throw new Error('找不到页面 target');
}

let seq = 0;
const pending = new Map();

function call(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function shot(ws, name) {
  const { data } = await call(ws, 'Page.captureScreenshot', { format: 'png' });
  const file = join(outDir, name);
  writeFileSync(file, Buffer.from(data, 'base64'));
  console.log('saved', file);
}

try {
  const wsUrl = await getTargetWs();
  const ws = new WebSocket(wsUrl);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id).resolve(msg.result ?? {});
      pending.delete(msg.id);
    }
  };
  await new Promise((r) => { ws.onopen = r; });
  await call(ws, 'Page.enable');
  await call(ws, 'Runtime.enable');

  // 等模拟跑起来（纹理生成 + 物理 + 首帧）
  await sleep(7000);
  await shot(ws, `debug-${mode}-before.png`);

  if (mode === 'click' || mode === 'focus' || mode === 'zoom' || mode === 'layers') {
    // 读取实时行星屏幕坐标（调试探针 window.__tbPlanet）再点击
    const { result } = await call(ws, 'Runtime.evaluate', {
      expression: 'JSON.stringify(window.__tbPlanet)',
      returnByValue: true,
    });
    const pos = JSON.parse(result.value ?? '{}');
    const tx = Math.round(pos.x ?? clickX);
    const ty = Math.round(pos.y ?? clickY);
    console.log('planet screen pos:', tx, ty);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await call(ws, 'Input.dispatchMouseEvent', { type, x: tx, y: ty, button: 'left', clickCount: 1 });
    }
    await sleep(2500); // 聚焦过渡动画
    await shot(ws, 'debug-click-after.png');

    if (mode === 'zoom' || mode === 'layers') {
      // 滚轮放大到近景（但不过俯冲阈值）
      for (let i = 0; i < 9; i++) {
        await call(ws, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: tx, y: ty, deltaX: 0, deltaY: -240 });
        await sleep(260);
      }
      await sleep(800);
      await shot(ws, 'debug-zoom-closeup.png');
    }

    if (mode === 'zoom') {
      // 继续放大 → 应触发俯冲进入人间
      for (let i = 0; i < 22; i++) {
        await call(ws, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: tx, y: ty, deltaX: 0, deltaY: -240 });
        await sleep(180);
      }
      await sleep(3000); // 幕布 + 沙盘入场动画
      await shot(ws, 'debug-dive-society.png');
    }

    if (mode === 'layers') {
      // 逐层隔离：云层 / 大气 / 只剩球芯
      const layerShots = [
        ['noclouds', 'window.__tbDebug.planetClouds.visible=false'],
        ['coreonly', 'window.__tbDebug.planetClouds.visible=false;window.__tbDebug.atmosphere.visible=false'],
        ['restored', 'window.__tbDebug.planetClouds.visible=true;window.__tbDebug.atmosphere.visible=true'],
      ];
      for (const [name, expr] of layerShots) {
        await call(ws, 'Runtime.evaluate', { expression: expr });
        await sleep(400);
        await shot(ws, `debug-layer-${name}.png`);
      }
    }

    if (mode === 'zoom') {
      // 继续放大 → 应触发俯冲进入人间
      for (let i = 0; i < 10; i++) {
        await call(ws, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: tx, y: ty, deltaX: 0, deltaY: -240 });
        await sleep(200);
      }
      await sleep(2500); // 幕布 + 沙盘入场动画
      await shot(ws, 'debug-dive-society.png');
    }
  }
  ws.close();
} finally {
  chrome.kill('SIGKILL');
}
