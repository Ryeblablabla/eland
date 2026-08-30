/**
 * 环境音景：程序化 Web Audio，不使用任何音频资产。
 * 风、雨、火焰噼啪全部由噪声与滤波器实时合成，音量跟随权威天气、纪元与近处火光。
 * 必须在用户手势后 resume（浏览器自动播放策略）；纯表现层，不写回任何状态。
 */

export interface AmbientAudioState {
  weatherKind: 'clear' | 'rain' | 'storm' | 'drought' | 'snow' | 'fog';
  weatherIntensity: number; // 0-10
  eraChaotic: boolean;
  /** 0-1，近处火焰装饰的归一化光照强度（decorLayer 火光池） */
  fireLevel: number;
}

export interface AmbientAudio {
  resume(): void;
  update(state: AmbientAudioState): void;
  dispose(): void;
}

export function createAmbientAudio(): AmbientAudio {
  let context: AudioContext | null = null;
  let sharedNoise: AudioBuffer | null = null;
  let master: GainNode | null = null;
  let windGain: GainNode | null = null;
  let rainGain: GainNode | null = null;
  let crackleGain: GainNode | null = null;
  let nextPopAt = 0;
  let disposed = false;

  const makeNoiseBuffer = (ctx: AudioContext, seconds: number): AudioBuffer => {
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  };

  const ensureStarted = () => {
    if (context || disposed) return;
    try {
      context = new AudioContext();
    } catch {
      return;
    }
    const ctx = context;
    sharedNoise = makeNoiseBuffer(ctx, 2.5);
    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);

    const loop = (filterType: BiquadFilterType, frequency: number, q = 0.7) => {
      const source = ctx.createBufferSource();
      source.buffer = sharedNoise;
      source.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = filterType;
      filter.frequency.value = frequency;
      filter.Q.value = q;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      source.connect(filter).connect(gain).connect(master!);
      source.start();
      return gain;
    };

    windGain = loop('lowpass', 320);          // 风：低通噪声的起伏
    rainGain = loop('highpass', 1500);        // 雨：高通噪声的细密沙沙
    crackleGain = loop('bandpass', 820, 1.6); // 火焰：带通噪声的持续噼啪底床
  };

  const resume = () => {
    if (disposed) return;
    ensureStarted();
    if (context && context.state === 'suspended') void context.resume();
  };

  const update = (state: AmbientAudioState) => {
    if (!context || !master || !sharedNoise || context.state !== 'running') return;
    const now = context.currentTime;
    const strength = Math.min(1, Math.max(0, state.weatherIntensity / 10));
    const isRainy = state.weatherKind === 'rain' || state.weatherKind === 'storm';
    const windTarget = 0.022 + strength * 0.02 + (state.eraChaotic ? 0.028 : 0)
      + (state.weatherKind === 'storm' ? 0.03 : 0);
    const rainTarget = isRainy ? 0.035 + strength * 0.055 : 0;
    const crackleTarget = Math.min(0.16, state.fireLevel * 0.14);
    windGain?.gain.setTargetAtTime(windTarget, now, 0.6);
    rainGain?.gain.setTargetAtTime(rainTarget, now, 0.4);
    crackleGain?.gain.setTargetAtTime(crackleTarget, now, 0.25);

    // 火星爆裂：近处有火时随机触发 30-70ms 的短促脉冲；复用共享噪声缓冲，不分配新内存。
    if (state.fireLevel > 0.04 && now >= nextPopAt) {
      nextPopAt = now + 0.05 + Math.random() * Math.max(0.06, 0.42 - state.fireLevel * 0.3);
      const popDuration = 0.03 + Math.random() * 0.04;
      const popSource = context.createBufferSource();
      popSource.buffer = sharedNoise;
      const popFilter = context.createBiquadFilter();
      popFilter.type = 'bandpass';
      popFilter.frequency.value = 900 + Math.random() * 2200;
      popFilter.Q.value = 6;
      const popGain = context.createGain();
      popGain.gain.setValueAtTime(0, now);
      popGain.gain.linearRampToValueAtTime(0.10 * state.fireLevel + 0.015, now + 0.006);
      popGain.gain.exponentialRampToValueAtTime(0.0001, now + popDuration);
      popSource.connect(popFilter).connect(popGain).connect(master);
      popSource.start(now, Math.random() * 2, popDuration + 0.02);
      popSource.onended = () => {
        popSource.disconnect();
        popFilter.disconnect();
        popGain.disconnect();
      };
    }
  };

  const dispose = () => {
    disposed = true;
    if (context) void context.close();
    context = null;
    sharedNoise = null;
    master = null;
    windGain = null;
    rainGain = null;
    crackleGain = null;
  };

  return { resume, update, dispose };
}
