import { useEffect, useRef } from 'react';
import type { EraKey } from '@/game/societyContract';

type MusicView = 'cosmos' | 'society';
type TrackRole = 'cosmos' | 'society' | 'chaos';

interface Props {
  view: MusicView;
  era: EraKey;
  audible: boolean;
}

interface MusicTrack {
  role: TrackRole;
  audio: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  gain: GainNode;
}

interface MusicRuntime {
  context: AudioContext;
  tracks: MusicTrack[];
  master: GainNode;
  activeTrack: number;
  started: boolean;
  starting: boolean;
  destroyed: boolean;
  syncTimer: ReturnType<typeof setInterval> | null;
}

const TRACKS: ReadonlyArray<{ role: TrackRole; file: string }> = [
  { role: 'cosmos', file: 'triple-dusk-cosmic-loop.mp3' },
  { role: 'society', file: 'triple-dusk-human-world-loop.mp3' },
  { role: 'chaos', file: 'triple-dusk-chaotic-era-loop.mp3' },
];

const NORMAL_MASTER_GAIN = 0.56;
const CHAOS_BOOST_GAIN = 0.88;
const CROSSFADE_SECONDS = 2.6;
const CHAOS_BOOST_ATTACK_SECONDS = 0.22;
const CHAOS_BOOST_RELEASE_SECONDS = 4.2;
const TRACK_SYNC_TOLERANCE_SECONDS = 0.045;

function isChaoticEra(era: EraKey): boolean {
  return era === 'chaotic'
    || era === 'chaotic-heat'
    || era === 'chaotic-cold'
    || era === 'burned'
    || era === 'frozen';
}

function targetTrack(view: MusicView, era: EraKey): number {
  if (isChaoticEra(era)) return 2;
  return view === 'cosmos' ? 0 : 1;
}

function holdParameter(parameter: AudioParam, at: number): void {
  if (typeof parameter.cancelAndHoldAtTime === 'function') {
    parameter.cancelAndHoldAtTime(at);
    return;
  }
  const value = parameter.value;
  parameter.cancelScheduledValues(at);
  parameter.setValueAtTime(value, at);
}

/** Sinusoidal gain curves keep the perceived energy steady through a two-track crossfade. */
function equalPowerRamp(parameter: AudioParam, target: number, at: number, duration: number): void {
  holdParameter(parameter, at);
  const start = Math.max(0, Math.min(1, parameter.value));
  const end = Math.max(0, Math.min(1, target));
  const startAngle = Math.asin(start);
  const endAngle = Math.asin(end);
  const curve = new Float32Array(64);
  for (let index = 0; index < curve.length; index += 1) {
    const progress = index / (curve.length - 1);
    curve[index] = Math.sin(startAngle + (endAngle - startAngle) * progress);
  }
  parameter.setValueCurveAtTime(curve, at, duration);
}

function circularDifference(left: number, right: number, duration: number): number {
  const direct = Math.abs(left - right);
  return Number.isFinite(duration) && duration > 0 ? Math.min(direct, Math.abs(duration - direct)) : direct;
}

function synchronizeMutedTracks(runtime: MusicRuntime, leaderIndex: number, force = false): void {
  const leader = runtime.tracks[leaderIndex]?.audio;
  if (!leader || !Number.isFinite(leader.currentTime)) return;
  for (let index = 0; index < runtime.tracks.length; index += 1) {
    if (index === leaderIndex) continue;
    const track = runtime.tracks[index];
    const difference = circularDifference(track.audio.currentTime, leader.currentTime, leader.duration);
    // Never seek an audible crossfading track; corrections are prepared while it is silent.
    if ((force || track.gain.gain.value < 0.06) && difference > TRACK_SYNC_TOLERANCE_SECONDS) {
      track.audio.currentTime = leader.currentTime;
    }
  }
}

function applyMix(runtime: MusicRuntime, view: MusicView, era: EraKey, duration = CROSSFADE_SECONDS): void {
  const nextTrack = targetTrack(view, era);
  if (nextTrack !== runtime.activeTrack) {
    synchronizeMutedTracks(runtime, runtime.activeTrack, true);
    const leaderTime = runtime.tracks[runtime.activeTrack]?.audio.currentTime;
    if (Number.isFinite(leaderTime)) runtime.tracks[nextTrack].audio.currentTime = leaderTime;
  }
  const now = runtime.context.currentTime;
  runtime.tracks.forEach((track, index) => {
    equalPowerRamp(track.gain.gain, index === nextTrack ? 1 : 0, now, duration);
  });
  runtime.activeTrack = nextTrack;
}

function setMasterAudible(runtime: MusicRuntime, audible: boolean, duration = 0.45): void {
  const now = runtime.context.currentTime;
  holdParameter(runtime.master.gain, now);
  runtime.master.gain.linearRampToValueAtTime(audible ? NORMAL_MASTER_GAIN : 0.0001, now + duration);
}

function boostForChaoticArrival(runtime: MusicRuntime): void {
  const now = runtime.context.currentTime;
  holdParameter(runtime.master.gain, now);
  runtime.master.gain.linearRampToValueAtTime(CHAOS_BOOST_GAIN, now + CHAOS_BOOST_ATTACK_SECONDS);
  runtime.master.gain.exponentialRampToValueAtTime(
    NORMAL_MASTER_GAIN,
    now + CHAOS_BOOST_ATTACK_SECONDS + CHAOS_BOOST_RELEASE_SECONDS,
  );
}

/**
 * Keeps all three 176-second cues running on the same timeline and changes only their gains.
 * Playback starts after the first user gesture to satisfy browser autoplay policies.
 */
export default function AdaptiveMusic({ view, era, audible }: Props) {
  const runtimeRef = useRef<MusicRuntime | null>(null);
  const viewRef = useRef(view);
  const eraRef = useRef(era);
  const audibleRef = useRef(audible);
  const previousChaoticRef = useRef(isChaoticEra(era));

  viewRef.current = view;
  eraRef.current = era;
  audibleRef.current = audible;

  useEffect(() => {
    const context = new AudioContext();
    const master = context.createGain();
    master.gain.value = 0.0001;
    master.connect(context.destination);

    const basePath = `${import.meta.env.BASE_URL}audio/bgm/`;
    const tracks = TRACKS.map(({ role, file }) => {
      const audio = new Audio(`${basePath}${file}`);
      audio.loop = true;
      audio.preload = 'auto';
      audio.setAttribute('playsinline', '');
      const source = context.createMediaElementSource(audio);
      const gain = context.createGain();
      gain.gain.value = 0;
      source.connect(gain).connect(master);
      audio.load();
      return { role, audio, source, gain };
    });

    const runtime: MusicRuntime = {
      context,
      tracks,
      master,
      activeTrack: targetTrack(viewRef.current, eraRef.current),
      started: false,
      starting: false,
      destroyed: false,
      syncTimer: null,
    };
    tracks[runtime.activeTrack].gain.gain.value = 1;
    runtimeRef.current = runtime;

    const removeUnlockListeners = () => {
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('touchstart', unlock, true);
      window.removeEventListener('keydown', unlock, true);
    };

    const start = async () => {
      if (runtime.destroyed || runtime.started || runtime.starting) return;
      runtime.starting = true;
      try {
        runtime.tracks.forEach((track) => { track.audio.currentTime = 0; });
        // Start media elements inside the gesture before awaiting AudioContext.resume().
        await Promise.all(runtime.tracks.map((track) => track.audio.play()));
        await runtime.context.resume();
        if (runtime.destroyed) return;
        runtime.started = true;
        runtime.activeTrack = targetTrack(viewRef.current, eraRef.current);
        synchronizeMutedTracks(runtime, runtime.activeTrack, true);
        applyMix(runtime, viewRef.current, eraRef.current, 0.12);
        setMasterAudible(runtime, audibleRef.current, 1.2);
        runtime.syncTimer = setInterval(() => {
          synchronizeMutedTracks(runtime, runtime.activeTrack);
        }, 4_000);
        removeUnlockListeners();
      } catch {
        // A later gesture retries; silence is preferable to an autoplay warning in the UI.
        runtime.tracks.forEach((track) => track.audio.pause());
      } finally {
        runtime.starting = false;
      }
    };

    const unlock = () => { void start(); };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('touchstart', unlock, true);
    window.addEventListener('keydown', unlock, true);

    return () => {
      runtime.destroyed = true;
      removeUnlockListeners();
      if (runtime.syncTimer) clearInterval(runtime.syncTimer);
      runtime.tracks.forEach((track) => {
        track.audio.pause();
        track.audio.removeAttribute('src');
        track.audio.load();
        track.source.disconnect();
        track.gain.disconnect();
      });
      master.disconnect();
      void context.close();
      if (runtimeRef.current === runtime) runtimeRef.current = null;
    };
  }, []);

  useEffect(() => {
    const runtime = runtimeRef.current;
    const chaotic = isChaoticEra(era);
    const enteringChaos = chaotic && !previousChaoticRef.current;
    previousChaoticRef.current = chaotic;
    if (!runtime?.started) return;

    const nextTrack = targetTrack(view, era);
    if (nextTrack !== runtime.activeTrack) applyMix(runtime, view, era);
    if (enteringChaos && audible) boostForChaoticArrival(runtime);
  }, [audible, era, view]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime?.started) return;
    if (audible) {
      void runtime.context.resume();
      void Promise.all(runtime.tracks.map((track) => track.audio.play())).then(() => {
        synchronizeMutedTracks(runtime, runtime.activeTrack);
      });
    }
    setMasterAudible(runtime, audible);
  }, [audible]);

  return null;
}
