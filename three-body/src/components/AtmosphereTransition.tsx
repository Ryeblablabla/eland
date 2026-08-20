import { useEffect, useRef } from 'react';
import * as THREE from 'three';

export type AtmosphereTransitionDirection = 'dive' | 'rise';

interface Props {
  direction: AtmosphereTransitionDirection;
  onComplete: (direction: AtmosphereTransitionDirection) => void;
  onOpaque: (direction: AtmosphereTransitionDirection) => void;
}

const TRANSITION_MS = 2000;

/**
 * 两个独立 WebGL 场景之间的短时大气桥接层。
 * 云层完全遮屏时切换底层场景，因此不要求宇宙球体与人间体素地形连续。
 */
export default function AtmosphereTransition({ direction, onComplete, onOpaque }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const callbacksRef = useRef({ onComplete, onOpaque });
  callbacksRef.current = { onComplete, onOpaque };

  useEffect(() => {
    const canvas = canvasRef.current!;
    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: false,
      powerPreference: 'high-performance',
    });
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uDirection: { value: direction === 'dive' ? 1 : -1 },
        uProgress: { value: 0 },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uTime: { value: 0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        precision highp float;
        uniform float uDirection;
        uniform float uProgress;
        uniform vec2 uResolution;
        uniform float uTime;
        varying vec2 vUv;

        float hash33(vec3 p) {
          p = fract(p * 0.1031);
          p += dot(p, p.yzx + 33.33);
          return fract((p.x + p.y) * p.z);
        }

        float noise3(vec3 p) {
          vec3 cell = floor(p);
          vec3 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(
              mix(hash33(cell), hash33(cell + vec3(1.0, 0.0, 0.0)), f.x),
              mix(hash33(cell + vec3(0.0, 1.0, 0.0)), hash33(cell + vec3(1.0, 1.0, 0.0)), f.x),
              f.y
            ),
            mix(
              mix(hash33(cell + vec3(0.0, 0.0, 1.0)), hash33(cell + vec3(1.0, 0.0, 1.0)), f.x),
              mix(hash33(cell + vec3(0.0, 1.0, 1.0)), hash33(cell + vec3(1.0, 1.0, 1.0)), f.x),
              f.y
            ),
            f.z
          );
        }

        float fbm(vec3 p) {
          float value = 0.0;
          float amplitude = 0.52;
          for (int octave = 0; octave < 4; octave++) {
            value += noise3(p) * amplitude;
            p = p * 2.03 + vec3(7.1, 3.7, 5.9);
            amplitude *= 0.5;
          }
          return value / 0.975;
        }

        void main() {
          vec2 point = (vUv - 0.5) * 2.0;
          point.x *= uResolution.x / max(uResolution.y, 1.0);
          float travel = uDirection > 0.0 ? uProgress : 1.0 - uProgress;
          float zoom = mix(0.68, 1.72, smoothstep(0.0, 1.0, travel));
          vec3 origin = vec3(point / zoom, -1.35 + travel * 1.15);
          vec3 ray = normalize(vec3(point * 0.42, 1.25));
          float jitter = hash33(vec3(gl_FragCoord.xy, floor(uTime * 24.0))) * 0.13;
          float density = 0.0;
          float scatteredLight = 0.0;

          for (int stepIndex = 0; stepIndex < 24; stepIndex++) {
            float t = (float(stepIndex) + jitter) / 23.0 * 3.6;
            vec3 samplePoint = origin + ray * t;
            samplePoint.x += uTime * 0.045 * uDirection;
            samplePoint.z += uTime * 0.018;
            float layer = exp(-pow(samplePoint.y * 0.72, 2.0));
            float shape = smoothstep(0.5, 0.72, fbm(samplePoint * 1.18)) * layer;
            float sampleAlpha = shape * 0.15;
            float visibleSample = (1.0 - density) * sampleAlpha;
            density += visibleSample;
            scatteredLight += visibleSample * (0.52 + 0.48 * (1.0 - t / 3.6));
          }

          float enter = smoothstep(0.0, 0.43, uProgress);
          float leave = 1.0 - smoothstep(0.68, 1.0, uProgress);
          float cloudEnvelope = enter * leave;
          float whiteout = smoothstep(0.34, 0.48, uProgress)
            * (1.0 - smoothstep(0.68, 0.84, uProgress));
          float atmosphere = sin(clamp(uProgress, 0.0, 1.0) * 3.14159265);
          float sunGlow = exp(-length(point - vec2(-0.72, 0.34)) * 2.8) * atmosphere;
          vec3 skyColor = mix(vec3(0.035, 0.11, 0.2), vec3(0.22, 0.53, 0.73), atmosphere);
          vec3 cloudColor = mix(
            vec3(0.47, 0.63, 0.72),
            vec3(0.94, 0.97, 1.0),
            clamp(scatteredLight * 1.65 + whiteout * 0.7, 0.0, 1.0)
          );
          vec3 color = mix(skyColor, cloudColor, clamp(density * 1.45 + whiteout * 0.72, 0.0, 1.0));
          color += vec3(1.0, 0.55, 0.28) * sunGlow * 0.16;
          float alpha = max(cloudEnvelope * (0.18 + density * 1.5), whiteout);
          alpha = max(alpha, atmosphere * 0.12);
          gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
        }
      `,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const geometry = new THREE.PlaneGeometry(2, 2);
    const quad = new THREE.Mesh(geometry, material);
    scene.add(quad);

    const resize = () => {
      const rect = canvas.parentElement!.getBoundingClientRect();
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.25);
      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(rect.width, rect.height, false);
      material.uniforms.uResolution.value.set(rect.width * pixelRatio, rect.height * pixelRatio);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas.parentElement!);
    resize();

    const startedAt = performance.now();
    let midpointSent = false;
    let raf = 0;
    const tick = (now: number) => {
      const progress = THREE.MathUtils.clamp((now - startedAt) / TRANSITION_MS, 0, 1);
      material.uniforms.uProgress.value = progress;
      material.uniforms.uTime.value = (now - startedAt) / 1000;
      renderer.render(scene, camera);
      if (!midpointSent && progress >= 0.5) {
        midpointSent = true;
        callbacksRef.current.onOpaque(direction);
      }
      if (progress >= 1) {
        callbacksRef.current.onComplete(direction);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      geometry.dispose();
      material.dispose();
      renderer.dispose();
    };
  }, [direction]);

  return (
    <div aria-hidden="true" className="pointer-events-auto absolute inset-0 z-[90] touch-none">
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}
