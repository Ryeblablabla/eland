import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { EraKey, SocietyState } from '@/game/societyContract';
import { statusColorOf } from '@/game/agentMarkers';
import { cellColor, cellCoordinates, cellLabel, interpolatePath } from '@/game/pixelworld';

/**
 * 立体沙盘：演化页的 2.5D/3D 视图。
 * - 地形：每格一根体素柱（InstancedMesh），高度 = world.elevation，颜色 = cellColor
 * - 水面：独立半透明体素层，缓慢闪烁
 * - 人物：3D 像素小人（体素拼装），步行摆动 + 状态环 + 头顶名牌
 * - 相机：OrbitControls 拖拽旋转 / 滚轮缩放 / 右键平移
 * - 点选：射线拾取人物与格柱，联动右侧检查器
 * 数据全部来自权威 SocietyState，只读不改。
 */

interface Props {
  society: SocietyState;
  era: EraKey;
  speaker: string | null;
  selectedAgentId: string | null;
  onSelectAgent: (id: string | null) => void;
  onZoomOutRequest?: () => void; // 滚轮持续缩小越过上限 → 请求升起返回宇宙
}

const CELL_H = 0.3; // 每层体素的视觉高度（世界单位）
const RULE_TICKS = 15;
const MONTH_PLAYBACK_MS = 3_000; // 与 2D 地图一致的月度播放时长

/** 纪元 → 沙盘点光源色温/强度（天象落到地表） */
const ERA_LIGHT: Record<EraKey, { sun: string; sunI: number; hemi: number }> = {
  stable: { sun: '#fff1d6', sunI: 1.15, hemi: 0.55 },
  chaotic: { sun: '#ffe9c9', sunI: 0.95, hemi: 0.5 },
  'chaotic-heat': { sun: '#ffc890', sunI: 1.5, hemi: 0.62 },
  'chaotic-cold': { sun: '#bcd4ff', sunI: 0.7, hemi: 0.42 },
  burned: { sun: '#ff9a5e', sunI: 1.8, hemi: 0.7 },
  frozen: { sun: '#9fb8e8', sunI: 0.45, hemi: 0.3 },
  extinct: { sun: '#a394d8', sunI: 0.5, hemi: 0.35 },
};

/** id → 稳定的衣色色相 */
function hueOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return (((h % 360) + 360) % 360) / 360;
}

// ---------------------------------------------------------------------------
// 名牌贴图（文本 sprite，模块级缓存共享）
// ---------------------------------------------------------------------------

const nameTextureCache = new Map<string, THREE.CanvasTexture>();

function nameTexture(text: string, color: string): THREE.CanvasTexture {
  const key = `${text}|${color}`;
  const hit = nameTextureCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.font = '600 30px ui-sans-serif, system-ui, "PingFang SC", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = 'rgba(0,0,0,0.85)';
  g.shadowBlur = 8;
  g.fillStyle = color;
  g.fillText(text, 128, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  nameTextureCache.set(key, tex);
  return tex;
}

// ---------------------------------------------------------------------------
// 3D 像素小人
// ---------------------------------------------------------------------------

interface FigureParts {
  group: THREE.Group;
  legL: THREE.Mesh;
  legR: THREE.Mesh;
  armL: THREE.Mesh;
  armR: THREE.Mesh;
  ring: THREE.Mesh;
  sprite: THREE.Sprite;
  spriteKey: string;
}

function buildFigure(agent: { id: string; name: string }): FigureParts {
  const group = new THREE.Group();
  group.userData.agentId = agent.id;
  const hue = hueOf(agent.id);
  const cloth = new THREE.MeshLambertMaterial({ color: new THREE.Color().setHSL(hue, 0.42, 0.5) });
  const pants = new THREE.MeshLambertMaterial({ color: new THREE.Color().setHSL(hue, 0.4, 0.32) });
  const skin = new THREE.MeshLambertMaterial({ color: '#e8c39e' });
  const hair = new THREE.MeshLambertMaterial({ color: '#2c2420' });

  // 腿：pivot 在胯部（几何体先下移半高）
  const legGeo = new THREE.BoxGeometry(0.11, 0.3, 0.11);
  legGeo.translate(0, -0.15, 0);
  const legL = new THREE.Mesh(legGeo, pants);
  legL.position.set(-0.075, 0.3, 0);
  const legR = new THREE.Mesh(legGeo, pants);
  legR.position.set(0.075, 0.3, 0);
  // 躯干
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.34, 0.18), cloth);
  torso.position.y = 0.47;
  // 手臂：pivot 在肩
  const armGeo = new THREE.BoxGeometry(0.08, 0.3, 0.08);
  armGeo.translate(0, -0.14, 0);
  const armL = new THREE.Mesh(armGeo, cloth);
  armL.position.set(-0.21, 0.6, 0);
  const armR = new THREE.Mesh(armGeo, cloth);
  armR.position.set(0.21, 0.6, 0);
  // 头 + 发顶
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.24, 0.24), skin);
  head.position.y = 0.81;
  const cap = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.07, 0.26), hair);
  cap.position.y = 0.945;
  // 状态环（脚下）
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.27, 0.37, 24),
    new THREE.MeshBasicMaterial({ color: '#34d399', transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.015;
  // 名牌
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: nameTexture(agent.name, '#e2e8f0'), transparent: true, depthWrite: false }),
  );
  sprite.scale.set(1.5, 0.375, 1);
  sprite.position.y = 1.12;
  sprite.renderOrder = 5;

  group.add(legL, legR, torso, armL, armR, head, cap, ring, sprite);
  return { group, legL, legR, armL, armR, ring, sprite, spriteKey: '' };
}

/** 卸载一个人物（名牌贴图在模块缓存中共享，不随个体销毁） */
function disposeFigure(f: FigureParts): void {
  f.group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | undefined;
    if (mat) mat.dispose();
  });
}

export default function SocietyScene3D({ society, era, speaker, selectedAgentId, onSelectAgent, onZoomOutRequest }: Props) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const [selectedCell, setSelectedCell] = useState<number | null>(null);
  const propsRef = useRef({ society, era, speaker, selectedAgentId, onSelectAgent, onZoomOutRequest });
  useEffect(() => {
    propsRef.current = { society, era, speaker, selectedAgentId, onSelectAgent, onZoomOutRequest };
  });
  const world = society.world;

  const animStart = useRef(0); // 挂载后由 effect 置为当前时间（渲染期不调非纯函数）
  useEffect(() => { animStart.current = performance.now(); }, [society]);
  const selectedCellRef = useRef<number | null>(null);
  useEffect(() => { selectedCellRef.current = selectedCell; }, [selectedCell]);

  // 供主循环外调用的场景 API
  const terrainApiRef = useRef<((s: SocietyState) => void) | null>(null);
  const lightApiRef = useRef<((e: EraKey) => void) | null>(null);

  // ---- 主场景（挂载一次）----
  useEffect(() => {
    const mount = mountRef.current!;
    const canvas = canvasRef.current!;
    const world0 = propsRef.current.society.world;
    const COUNT = world0.width * world0.height;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setClearColor('#040610'); // 深空底色：星球浮在宇宙中
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog('#040610', 150, 420);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 600);
    camera.position.set(0, 150, 70); // 从太空高位入场（丝滑下降）
    const mountedAt = performance.now();

    const controls = new OrbitControls(camera, canvas);
    controls.enabled = false; // 入场动画期间锁定，结束后开放
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI * 0.49; // 不钻到地底
    controls.minDistance = 6;
    controls.maxDistance = 170;
    controls.target.set(0, 0, 0);
    controlsRef.current = controls;

    // ---- 星野背景（星球悬浮其中）----
    {
      const N = 700;
      const pos = new Float32Array(N * 3);
      const col3 = new Float32Array(N * 3);
      const cCool = new THREE.Color('#cdd8ff');
      const cWarm = new THREE.Color('#ffe9c9');
      for (let i = 0; i < N; i++) {
        const u = Math.random() * 2 - 1;
        const th = Math.random() * Math.PI * 2;
        const r = 140 + Math.random() * 150;
        const s = Math.sqrt(1 - u * u);
        pos[i * 3] = r * s * Math.cos(th);
        pos[i * 3 + 1] = r * u * 0.6 - 24;
        pos[i * 3 + 2] = r * s * Math.sin(th);
        const base = Math.random() < 0.85 ? cCool : cWarm;
        const a = 0.2 + Math.random() * 0.55;
        col3[i * 3] = base.r * a;
        col3[i * 3 + 1] = base.g * a;
        col3[i * 3 + 2] = base.b * a;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col3, 3));
      const stars = new THREE.Points(
        g,
        new THREE.PointsMaterial({ size: 1.1, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false }),
      );
      scene.add(stars);
    }

    // ---- 光照：半球环境 + 方向光（色温随纪元）----
    const hemi = new THREE.HemisphereLight('#cdd8ff', '#1d241c', 0.55);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight('#fff1d6', 1.15);
    sun.position.set(38, 60, 24);
    scene.add(sun);
    lightApiRef.current = (eraKey) => {
      const L = ERA_LIGHT[eraKey];
      sun.color.set(L.sun);
      sun.intensity = L.sunI;
      hemi.intensity = L.hemi;
    };
    lightApiRef.current(propsRef.current.era);

    // ---- 地形体素柱（InstancedMesh，逐实例颜色）----
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const land = new THREE.InstancedMesh(boxGeo, new THREE.MeshLambertMaterial({ color: '#ffffff' }), COUNT);
    land.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(land);
    const waterMat = new THREE.MeshLambertMaterial({ color: '#ffffff', transparent: true, opacity: 0.78 });
    const water = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), waterMat, COUNT);
    water.count = 0;
    water.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(water);
    // 掉落物 / 建筑构件
    const dropMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.22, 0.22, 0.22), new THREE.MeshLambertMaterial({ color: '#ffffff' }), 1024);
    dropMesh.count = 0;
    dropMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(dropMesh);
    const structMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.86, 0.5, 0.86), new THREE.MeshLambertMaterial({ color: '#c9a06a' }), 1024);
    structMesh.count = 0;
    structMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(structMesh);

    // ---- 立方体星球化 ----
    // 边界柱的地层剖面：逐层堆叠真实物质色（columns 数据），替代单一色柱
    const perimeter = 2 * (world0.width + world0.height);
    const STRATA_CAP = perimeter * 12; // levels 上限 12
    const strata = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshLambertMaterial({ color: '#ffffff' }),
      STRATA_CAP,
    );
    strata.count = 0;
    strata.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(strata);
    // 星球底壳：暗色岩座
    const underside = new THREE.Mesh(
      new THREE.BoxGeometry(world0.width, 1.4, world0.height),
      new THREE.MeshLambertMaterial({ color: '#221d1a' }),
    );
    underside.position.set(0, -0.76, 0);
    scene.add(underside);

    // 选中格线框
    const cellMarker = new THREE.Mesh(
      new THREE.BoxGeometry(1.04, 1, 1.04),
      new THREE.MeshBasicMaterial({ color: '#fde68a', wireframe: true, transparent: true, opacity: 0.9 }),
    );
    cellMarker.visible = false;
    scene.add(cellMarker);

    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const sc = new THREE.Vector3();
    const col = new THREE.Color();

    terrainApiRef.current = (s) => {
      const w = s.world;
      let wi = 0;
      let sti = 0;
      for (let cellId = 0; cellId < COUNT; cellId++) {
        const { x, y } = cellCoordinates(cellId, w.width);
        const wx = x - w.width / 2 + 0.5;
        const wz = y - w.height / 2 + 0.5;
        const h = (w.elevation[cellId] + 1) * CELL_H;
        const isBoundary = x === 0 || x === w.width - 1 || y === 0 || y === w.height - 1;
        if (isBoundary) {
          // 边界柱收进地层网格：逐层堆叠（columns[0] 是表面/顶层）
          m4.compose(v.set(wx, 0, wz), q.identity(), sc.set(0.0001, 0.0001, 0.0001));
          land.setMatrixAt(cellId, m4);
          land.setColorAt(cellId, col.setRGB(0, 0, 0));
          const stack = w.columns[cellId];
          for (let k = 0; k < stack.length && sti < STRATA_CAP; k++) {
            const yc = (stack.length - k - 0.5) * CELL_H;
            m4.compose(v.set(wx, yc, wz), q, sc.set(1, CELL_H, 1));
            strata.setMatrixAt(sti, m4);
            if (k === 0) {
              const cc = cellColor(w, cellId); // 顶层与内部格同色
              col.setRGB(cc.r / 255, cc.g / 255, cc.b / 255, THREE.SRGBColorSpace);
            } else {
              const mat = w.palette[stack[k]];
              const mc = mat?.color ?? [90, 80, 70];
              col.setRGB(mc[0] / 255, mc[1] / 255, mc[2] / 255, THREE.SRGBColorSpace);
            }
            strata.setColorAt(sti, col);
            sti++;
          }
        } else {
          m4.compose(v.set(wx, h / 2, wz), q.identity(), sc.set(1, h, 1));
          land.setMatrixAt(cellId, m4);
          const c = cellColor(w, cellId);
          land.setColorAt(cellId, col.setRGB(c.r / 255, c.g / 255, c.b / 255, THREE.SRGBColorSpace));
        }
        const material = w.palette[w.surface[cellId]];
        if (material?.tags.includes('liquid')) {
          m4.compose(v.set(wx, h + 0.08, wz), q, sc.set(1, 0.16, 1));
          water.setMatrixAt(wi, m4);
          water.setColorAt(wi, col.setRGB(material.color[0] / 255, material.color[1] / 255, material.color[2] / 255, THREE.SRGBColorSpace));
          wi++;
        }
      }
      water.count = wi;
      strata.count = sti;
      land.instanceMatrix.needsUpdate = true;
      if (land.instanceColor) land.instanceColor.needsUpdate = true;
      water.instanceMatrix.needsUpdate = true;
      if (water.instanceColor) water.instanceColor.needsUpdate = true;
      strata.instanceMatrix.needsUpdate = true;
      if (strata.instanceColor) strata.instanceColor.needsUpdate = true;

      // 掉落物：柱顶小方块
      let di = 0;
      for (const drop of s.drops) {
        if (drop.quantity <= 0 || di >= 1024) continue;
        const { x, y } = cellCoordinates(drop.cellId, w.width);
        const material = w.palette[drop.materialId];
        m4.compose(v.set(x - w.width / 2 + 0.5, drop.z * CELL_H + 0.11, y - w.height / 2 + 0.5), q, sc.set(1, 1, 1));
        dropMesh.setMatrixAt(di, m4);
        const dc = material?.color ?? [156, 105, 72];
        dropMesh.setColorAt(di, col.setRGB(dc[0] / 255, dc[1] / 255, dc[2] / 255, THREE.SRGBColorSpace));
        di++;
      }
      dropMesh.count = di;
      dropMesh.instanceMatrix.needsUpdate = true;
      if (dropMesh.instanceColor) dropMesh.instanceColor.needsUpdate = true;

      // 建筑构件：柱顶矮盒
      let si = 0;
      for (const structure of s.structures) {
        for (const cellId of structure.occupiedCells) {
          if (si >= 1024) break;
          const { x, y } = cellCoordinates(cellId, w.width);
          const h = (w.elevation[cellId] + 1) * CELL_H;
          m4.compose(v.set(x - w.width / 2 + 0.5, h + 0.25, y - w.height / 2 + 0.5), q, sc.set(1, 1, 1));
          structMesh.setMatrixAt(si, m4);
          si++;
        }
      }
      structMesh.count = si;
      structMesh.instanceMatrix.needsUpdate = true;
    };

    // ---- 人物：按需创建 / 更新 / 回收 ----
    const figures = new Map<string, FigureParts>();
    const syncAgents = (now: number) => {
      const p = propsRef.current;
      const w = p.society.world;
      const agents = p.society.agents;
      const motion = Math.min(1, (now - animStart.current) / MONTH_PLAYBACK_MS);
      for (const agent of agents) {
        let f = figures.get(agent.id);
        if (!f) {
          f = buildFigure(agent);
          scene.add(f.group);
          figures.set(agent.id, f);
        }
        const path = agent.tickPath.length === RULE_TICKS + 1 ? agent.tickPath : agent.lastPath.length ? agent.lastPath : [agent.cellId];
        const point = interpolatePath(path, w.width, motion);
        const prev = interpolatePath(path, w.width, Math.max(0, motion - 0.08));
        const dx = point.x - prev.x;
        const dz = point.y - prev.y;
        const moving = Math.hypot(dx, dz) > 1e-4;
        const dead = agent.state === 'dead';
        const bob = moving && !dead ? Math.abs(Math.sin(now * 0.012)) * 0.05 : 0;
        f.group.position.set(
          point.x - w.width / 2 + 0.5,
          agent.z * CELL_H + (dead ? 0.1 : bob),
          point.y - w.height / 2 + 0.5,
        );
        if (moving && !dead) f.group.rotation.y = Math.atan2(dx, dz);
        f.group.rotation.x = dead ? -Math.PI * 0.45 : 0; // 死亡倒地
        const swing = moving && !dead ? Math.sin(now * 0.012) * 0.55 : 0;
        f.legL.rotation.x = swing;
        f.legR.rotation.x = -swing;
        f.armL.rotation.x = -swing * 0.7;
        f.armR.rotation.x = swing * 0.7;
        const highlighted = agent.id === p.selectedAgentId || agent.name === p.speaker;
        const color = statusColorOf(agent, agent.id === p.selectedAgentId, agent.name === p.speaker);
        (f.ring.material as THREE.MeshBasicMaterial).color.set(color);
        f.ring.scale.setScalar(highlighted ? 1 + 0.16 * Math.sin(now * 0.006) : 1);
        const key = `${agent.name}|${highlighted}`;
        if (key !== f.spriteKey) {
          f.sprite.material.map = nameTexture(agent.name, highlighted ? '#fde68a' : '#e2e8f0');
          f.spriteKey = key;
        }
      }
      for (const [id, f] of figures) {
        if (!agents.some((a) => a.id === id)) {
          scene.remove(f.group);
          disposeFigure(f);
          figures.delete(id);
        }
      }
    };

    // ---- 点选：射线拾取 ----
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let downPos: { x: number; y: number } | null = null;
    const onPointerDown = (ev: PointerEvent) => {
      downPos = { x: ev.clientX, y: ev.clientY };
    };
    const onPointerUp = (ev: PointerEvent) => {
      if (!downPos || Math.hypot(ev.clientX - downPos.x, ev.clientY - downPos.y) >= 5) {
        downPos = null;
        return;
      }
      downPos = null;
      const rect = canvas.getBoundingClientRect();
      ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const agentHits = ray.intersectObjects([...figures.values()].map((f) => f.group), true);
      if (agentHits.length) {
        let o: THREE.Object3D | null = agentHits[0].object;
        while (o && !o.userData.agentId) o = o.parent;
        const id = o?.userData.agentId as string | undefined;
        if (id) {
          const agent = propsRef.current.society.agents.find((a) => a.id === id);
          setSelectedCell(agent?.cellId ?? null);
          propsRef.current.onSelectAgent(id);
          return;
        }
      }
      const landHits = ray.intersectObject(land);
      if (landHits.length && landHits[0].instanceId !== undefined) {
        const cellId = landHits[0].instanceId;
        setSelectedCell(cellId);
        const agent = propsRef.current.society.agents.find((a) => a.cellId === cellId);
        propsRef.current.onSelectAgent(agent?.id ?? null);
      }
    };
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointerup', onPointerUp);

    // ---- 滚轮持续缩小越过上限 → 请求升起返回宇宙 ----
    let zoomOutAcc = 0;
    let zoomOutAsked = false;
    const onWheelOut = (ev: WheelEvent) => {
      if (zoomOutAsked || !propsRef.current.onZoomOutRequest) return;
      if (ev.deltaY > 0 && camera.position.distanceTo(controls.target) >= controls.maxDistance - 0.6) {
        zoomOutAcc += ev.deltaY;
        if (zoomOutAcc > 300) {
          zoomOutAsked = true;
          controls.maxDistance = 600; // 过场期间允许继续升高，配合幕布淡出
          propsRef.current.onZoomOutRequest();
        }
      } else {
        zoomOutAcc = 0;
      }
    };
    canvas.addEventListener('wheel', onWheelOut, { passive: true });

    // ---- 尺寸自适应 ----
    const resize = () => {
      const wpx = mount.clientWidth;
      const hpx = mount.clientHeight;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(wpx, hpx, false);
      camera.aspect = wpx / hpx;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);
    resize();

    // ---- 主循环 ----
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      syncAgents(now);
      waterMat.opacity = 0.72 + 0.08 * Math.sin(now * 0.0016); // 水面微闪
      // 选中格线框跟随
      const sel = selectedCellRef.current;
      if (sel !== null) {
        const w = propsRef.current.society.world;
        const { x, y } = cellCoordinates(sel, w.width);
        const h = (w.elevation[sel] + 1) * CELL_H;
        cellMarker.visible = true;
        cellMarker.position.set(x - w.width / 2 + 0.5, h / 2, y - w.height / 2 + 0.5);
        cellMarker.scale.set(1, h, 1);
      } else {
        cellMarker.visible = false;
      }
      // 入场：从太空高位丝滑下降（easeOutCubic），结束后开放相机控制
      const entryT = Math.min(1, (now - mountedAt) / 1100);
      if (entryT < 1) {
        const e = 1 - Math.pow(1 - entryT, 3);
        camera.position.set(0, 150 - 104 * e, 70 - 8 * e);
        camera.lookAt(0, 0, 0);
      } else if (!controls.enabled) {
        controls.enabled = true;
        controls.saveState(); // “复位视角”落到入场后的机位
      }
      controls.update();
      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('wheel', onWheelOut);
      controls.dispose();
      controlsRef.current = null;
      terrainApiRef.current = null;
      lightApiRef.current = null;
      for (const f of figures.values()) disposeFigure(f);
      figures.clear();
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | undefined;
        if (mat) mat.dispose(); // 贴图在模块缓存中共享，不在此处销毁
      });
      renderer.dispose();
    };
  }, []);

  // ---- 地形/实体随月度状态重建；光照随纪元 ----
  useEffect(() => { terrainApiRef.current?.(society); }, [society]);
  useEffect(() => { lightApiRef.current?.(era); }, [era]);

  // ---- 检查器数据 ----
  const cellDrops = useMemo(() => selectedCell === null ? [] : society.drops.filter((d) => d.cellId === selectedCell), [selectedCell, society.drops]);
  const cellStructures = useMemo(() => selectedCell === null ? [] : society.structures.filter((s) => s.occupiedCells.includes(selectedCell)), [selectedCell, society.structures]);
  const cellAgents = useMemo(() => selectedCell === null ? [] : society.agents.filter((a) => a.cellId === selectedCell), [selectedCell, society.agents]);

  return (
    <div className="absolute inset-0 z-[5] bg-[#0b1016]">
      <div
        ref={mountRef}
        className="absolute bottom-20 left-10 right-[340px] top-16 overflow-hidden border border-white/10 bg-[#0b1016] shadow-[0_0_80px_rgba(4,10,12,0.9)]"
      >
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full cursor-grab active:cursor-grabbing" style={{ touchAction: 'none' }} />
        <div className="pointer-events-none absolute bottom-3 left-3 text-[9px] tracking-[0.2em] text-slate-300/50">
          拖拽旋转 · 右键平移 · 滚轮缩放 · 点击选格
        </div>
        <button
          onClick={() => controlsRef.current?.reset()}
          className="absolute right-3 top-3 border border-white/10 bg-slate-950/75 px-3 py-2 text-[10px] tracking-[0.2em] text-slate-300 backdrop-blur-md hover:bg-white/10"
        >
          复位视角
        </button>
      </div>

      <div className="absolute left-10 top-8 text-[10px] tracking-[0.45em] text-slate-300/70">
        立体沙盘 · {world.width} × {world.height} · {era === 'stable' ? '恒纪元' : '乱纪元'}
      </div>

      <aside className="absolute bottom-6 right-6 top-6 w-[300px] overflow-y-auto border border-white/10 bg-slate-950/80 p-5 backdrop-blur-md">
        <div className="text-[10px] tracking-[0.4em] text-amber-100/70">CELL INSPECTOR</div>
        {selectedCell === null ? <p className="mt-6 text-xs text-slate-500">点击体素柱或人物查看真实格状态。</p> : (
          <>
            <div className="mt-4 text-lg tracking-[0.2em] text-slate-100">{cellLabel(selectedCell, world.width)}</div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-slate-400">
              <span>最高层 {world.elevation[selectedCell]}</span>
              <span>层数 {world.columns[selectedCell].length}</span>
            </div>
            <div className="mt-4 border-y border-white/10 py-3">
              <div className="mb-2 text-[9px] tracking-[0.22em] text-slate-600">物质柱 · 自上而下</div>
              <div className="space-y-1 text-xs text-slate-300">{world.columns[selectedCell].map((materialId, index) => {
                const material = world.palette[materialId];
                return <div key={`${materialId}-${index}`} className="flex items-center justify-between"><span>{index === 0 ? '表面' : `下层 ${index}`} · {material?.name ?? '未知物质'}</span><span className="text-slate-700">#{materialId}</span></div>;
              })}</div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] text-slate-600">
              <span>近 史通行 {world.activity.traffic[selectedCell]}</span>
              <span>转移 {world.activity.transfer[selectedCell]}</span>
              <span>作用 {world.activity.action[selectedCell]}</span>
              <span>观察 {world.activity.attention[selectedCell]}</span>
            </div>
            <div className="mt-5 space-y-2">
              {cellAgents.map((agent) => (
                <button key={agent.id} onClick={() => onSelectAgent(agent.id)} className="block w-full border-l border-white/10 pl-3 text-left text-xs text-slate-300">
                  {agent.name} · 高度 {agent.z} · {agent.doing}
                </button>
              ))}
              {cellDrops.map((drop) => (
                <button key={drop.id} className="block w-full border-l border-white/10 pl-3 text-left text-xs text-slate-300">
                  高度 {drop.z} 的物品 · {drop.name} × {drop.quantity}
                </button>
              ))}
              {cellStructures.map((structure) => <div key={structure.id} className="border-l border-amber-200/30 pl-3 text-xs text-amber-100/80">{structure.name} · 内部高度 {structure.interiorPositions.filter((position) => position.cellId === selectedCell).map((position) => position.z).join('、') || '无'} · 防护 {Math.round(structure.effects.weatherProtection)}</div>)}
              {!cellAgents.length && !cellDrops.length && !cellStructures.length && <div className="text-xs text-slate-600">这格只有物质柱，没有地面实体。</div>}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
