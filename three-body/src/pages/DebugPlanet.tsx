import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { makePlanetTextureSet } from '@/game/proceduralTextures';

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
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    camera.position.set(0, 0.6, 2.6);
    camera.lookAt(0, 0, 0);

    // 与宇宙场景同源的光照配方：单颗恒星色 + 极暗环境光
    const sun = new THREE.DirectionalLight('#fff7e0', intensity);
    sun.position.set(2, 0.4, 2);
    scene.add(sun);
    scene.add(new THREE.AmbientLight('#16202e', 0.6));

    // 与 ThreeBodyCanvas 完全相同的行星组装
    const tex = makePlanetTextureSet(4242);
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(1, 28, 20),
      new THREE.MeshPhongMaterial({
        map: tex.day,
        specularMap: tex.spec,
        specular: new THREE.Color('#24333b'),
        shininess: 60,
      }),
    );
    core.rotation.x = 0.15;
    scene.add(core);
    const clouds = new THREE.Mesh(
      new THREE.SphereGeometry(1.035, 28, 20),
      new THREE.MeshPhongMaterial({ map: tex.clouds, transparent: true, opacity: 0.6, depthWrite: false }),
    );
    clouds.rotation.x = 0.15;
    scene.add(clouds);
    const atmosphereMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color('#34d399') },
        uPower: { value: 3.8 },
        uSunDir: { value: new THREE.Vector3(2, 0.4, 2).normalize() },
      },
      vertexShader: `
        varying vec3 vNormalW;
        varying vec3 vWorldPos;
        void main() {
          vNormalW = normalize(mat3(modelMatrix) * normal);
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uPower;
        uniform vec3 uSunDir;
        varying vec3 vNormalW;
        varying vec3 vWorldPos;
        void main() {
          vec3 viewDir = normalize(cameraPosition - vWorldPos);
          float rim = pow(1.0 - max(dot(viewDir, normalize(vNormalW)), 0.0), uPower);
          float day = max(dot(normalize(vNormalW), uSunDir), 0.0);
          rim *= 0.25 + 0.75 * day;
          gl_FragColor = vec4(uColor * rim, rim);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(1.14, 32, 24), atmosphereMat);
    scene.add(atmosphere);

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
      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material & { map?: THREE.Texture | null };
        if (mat) { mat.map?.dispose(); mat.dispose(); }
      });
      renderer.dispose();
    };
  }, []);

  return (
    <div className="relative h-screen w-screen bg-[#040610]">
      <canvas ref={canvasRef} className="block h-full w-full" />
      <div className="pointer-events-none absolute left-6 top-6 text-[10px] tracking-[0.3em] text-slate-500">
        DEBUG · 行星材质隔离台 · 光照强度 {new URLSearchParams(window.location.search).get('i') ?? '1.2'}
      </div>
    </div>
  );
}
