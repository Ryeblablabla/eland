import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { createEarthlikePlanet, disposeEarthlikePlanet } from '@/game/earthlikePlanet';

/**
 * 行星材质隔离渲染页（/debug-planet）：脱离宇宙场景的确定性测试台——
 * 固定机位、固定光照（强度可用 ?i= 调）、行星放大居中慢转。
 * 供无头截图排查材质/纹理问题，不进导航。
 */
export default function DebugPlanet() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const params = new URLSearchParams(window.location.search);
    const intensity = Number(params.get('i') ?? 1.2);

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setClearColor('#040610');
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.02;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    camera.position.set(0, 0.55, 3.35);
    camera.lookAt(0, 0, 0);

    // 主恒星决定大气散射；另外两颗只给 PBR 地表和云层提供次级方向光。
    const sun = new THREE.DirectionalLight('#fff7e0', intensity);
    sun.position.set(2.6, 0.45, 2);
    scene.add(sun);
    const secondarySun = new THREE.DirectionalLight('#ffd08c', 0.1);
    secondarySun.position.set(-2.5, 0.8, 0.2);
    scene.add(secondarySun);
    const redSun = new THREE.DirectionalLight('#ff6d61', 0.05);
    redSun.position.set(0.4, -2, -2);
    scene.add(redSun);
    scene.add(new THREE.AmbientLight('#7890aa', 0.18));

    // 与 ThreeBodyCanvas 完全相同的行星组装。
    const planet = createEarthlikePlanet(4242);
    const { core, cloudShadow, clouds, atmosphere, atmosphereMaterial } = planet;
    atmosphereMaterial.uniforms.uSunDir.value.copy(sun.position).normalize();
    atmosphereMaterial.uniforms.uSunColor.value.set('#fff7e0');
    scene.add(core, cloudShadow, clouds, atmosphere);

    const resize = () => {
      const w = canvas.parentElement!.clientWidth;
      const h = canvas.parentElement!.clientHeight;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement!);
    resize();

    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      core.rotation.y += 0.004;
      clouds.rotation.y += 0.0052;
      cloudShadow.rotation.y = clouds.rotation.y + 0.018;
      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      disposeEarthlikePlanet(planet);
      renderer.dispose();
    };
  }, []);

  return (
    <div className="relative h-screen w-screen bg-[#040610]">
      <canvas ref={canvasRef} className="block h-full w-full" />
      <div className="pointer-events-none absolute left-6 top-6 text-[10px] tracking-[0.3em] text-slate-500">
        DEBUG · PBR 类地行星 · 三恒星光照 · 主光强度 {new URLSearchParams(window.location.search).get('i') ?? '1.2'}
      </div>
    </div>
  );
}
