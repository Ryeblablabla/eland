#!/usr/bin/env python3
"""Create reproducible human-world and chaotic-era variations from a stereo master.

This is deliberately a master-level transformation rather than a claim of stem-level
re-orchestration. It preserves the source as a thematic anchor, reshapes its spectral
and spatial balance, and adds deterministic procedural textures derived from the
detected tempo and key.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import subprocess
import tempfile
import wave
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np


NOTE_NAMES = ("C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B")
MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


@dataclass(frozen=True)
class Analysis:
    duration_seconds: float
    sample_rate: int
    channels: int
    peak_dbfs: float
    rms_dbfs: float
    stereo_correlation: float
    estimated_bpm: float
    estimated_key: str
    key_confidence: float
    spectral_centroid_hz: float
    low_band_energy_ratio: float


def run(command: list[str]) -> None:
    subprocess.run(command, check=True)


def decode_pcm16(ffmpeg: str, source: Path, target: Path) -> None:
    run([
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(source),
        "-ar",
        "44100",
        "-ac",
        "2",
        "-c:a",
        "pcm_s16le",
        str(target),
    ])


def read_pcm16(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as wav:
        if wav.getsampwidth() != 2:
            raise ValueError("Expected a 16-bit PCM analysis file")
        sample_rate = wav.getframerate()
        channels = wav.getnchannels()
        data = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2")
    audio = data.reshape(-1, channels).astype(np.float32) / 32768.0
    return audio, sample_rate


def write_pcm16(path: Path, audio: np.ndarray, sample_rate: int) -> None:
    clipped = np.clip(audio, -0.999, 0.999)
    pcm = np.rint(clipped * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(audio.shape[1])
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm.tobytes())


def stft_magnitude(mono: np.ndarray, sample_rate: int) -> tuple[np.ndarray, np.ndarray, float]:
    target_rate = 11025
    stride = max(1, round(sample_rate / target_rate))
    reduced = mono[::stride]
    analysis_rate = sample_rate / stride
    frame_size = 4096
    hop_size = 1024
    frame_count = max(1, 1 + (len(reduced) - frame_size) // hop_size)
    window = np.hanning(frame_size).astype(np.float32)
    spectrum = np.empty((frame_count, frame_size // 2 + 1), dtype=np.float32)
    for index in range(frame_count):
        start = index * hop_size
        frame = reduced[start : start + frame_size]
        if len(frame) < frame_size:
            frame = np.pad(frame, (0, frame_size - len(frame)))
        spectrum[index] = np.abs(np.fft.rfft(frame * window))
    frequencies = np.fft.rfftfreq(frame_size, 1.0 / analysis_rate)
    return spectrum, frequencies, hop_size / analysis_rate


def estimate_key(spectrum: np.ndarray, frequencies: np.ndarray) -> tuple[str, float, int]:
    mask = (frequencies >= 45.0) & (frequencies <= 5000.0)
    midi = np.rint(69.0 + 12.0 * np.log2(frequencies[mask] / 440.0)).astype(int)
    weights = np.sqrt(spectrum[:, mask]).mean(axis=0)
    chroma = np.zeros(12, dtype=np.float64)
    for pitch_class, weight in zip(midi % 12, weights):
        chroma[pitch_class] += weight
    chroma /= max(chroma.sum(), 1e-12)
    normalized = (chroma - chroma.mean()) / max(chroma.std(), 1e-12)
    candidates: list[tuple[float, str, int]] = []
    for root in range(12):
        for label, profile in (("major", MAJOR_PROFILE), ("minor", MINOR_PROFILE)):
            profile = (profile - profile.mean()) / profile.std()
            score = float(np.dot(normalized, np.roll(profile, root)) / 12.0)
            candidates.append((score, f"{NOTE_NAMES[root]} {label}", root))
    score, name, root = max(candidates)
    return name, score, root


def estimate_tempo(spectrum: np.ndarray, seconds_per_hop: float) -> float:
    log_spectrum = np.log1p(spectrum)
    flux = np.maximum(0.0, np.diff(log_spectrum, axis=0)).mean(axis=1)
    local_mean = np.convolve(flux, np.ones(16) / 16.0, mode="same")
    flux = np.maximum(flux - local_mean, 0.0)
    flux /= max(float(flux.std()), 1e-8)
    autocorrelation = np.correlate(flux, flux, mode="full")[len(flux) - 1 :]
    minimum_lag = max(1, round(60.0 / (180.0 * seconds_per_hop)))
    maximum_lag = min(len(autocorrelation) - 1, round(60.0 / (40.0 * seconds_per_hop)))
    lag = minimum_lag + int(np.argmax(autocorrelation[minimum_lag : maximum_lag + 1]))
    bpm = 60.0 / (lag * seconds_per_hop)
    # Ambient scores often expose the first strong autocorrelation at double time.
    if bpm > 90.0:
        bpm /= 2.0
    return bpm


def analyze(audio: np.ndarray, sample_rate: int) -> tuple[Analysis, int]:
    mono = audio.mean(axis=1)
    spectrum, frequencies, seconds_per_hop = stft_magnitude(mono, sample_rate)
    power = spectrum * spectrum
    mean_power = power.mean(axis=0)
    total_power = max(float(mean_power.sum()), 1e-12)
    centroid = float(np.dot(frequencies, mean_power) / total_power)
    low_ratio = float(mean_power[frequencies < 250.0].sum() / total_power)
    key, key_confidence, root = estimate_key(spectrum, frequencies)
    peak = float(np.max(np.abs(audio)))
    rms = float(np.sqrt(np.mean(audio * audio)))
    correlation = float(np.corrcoef(audio[:, 0], audio[:, 1])[0, 1])
    return Analysis(
        duration_seconds=len(audio) / sample_rate,
        sample_rate=sample_rate,
        channels=audio.shape[1],
        peak_dbfs=20.0 * math.log10(max(peak, 1e-12)),
        rms_dbfs=20.0 * math.log10(max(rms, 1e-12)),
        stereo_correlation=correlation,
        estimated_bpm=estimate_tempo(spectrum, seconds_per_hop),
        estimated_key=key,
        key_confidence=key_confidence,
        spectral_centroid_hz=centroid,
        low_band_energy_ratio=low_ratio,
    ), root


def note_frequency(pitch_class: int, octave: int) -> float:
    midi = 12 * (octave + 1) + pitch_class
    return 440.0 * 2.0 ** ((midi - 69) / 12.0)


def add_stereo_event(target: np.ndarray, event: np.ndarray, start: int, pan: float) -> None:
    end = min(len(target), start + len(event))
    if end <= start:
        return
    event = event[: end - start]
    angle = (pan + 1.0) * math.pi / 4.0
    target[start:end, 0] += event * math.cos(angle)
    target[start:end, 1] += event * math.sin(angle)


def create_human_texture(
    source: np.ndarray,
    sample_rate: int,
    bpm: float,
    root: int,
    rng: np.random.Generator,
) -> np.ndarray:
    texture = np.zeros_like(source, dtype=np.float32)
    duration = len(source) / sample_rate
    beat = 60.0 / bpm

    # Sparse dry wood/stone pulses give the human layer a tactile working rhythm.
    pulse_times = np.arange(10.0, duration - 8.0, beat * 2.0)
    for index, event_time in enumerate(pulse_times):
        if rng.random() < 0.22:
            continue
        event_duration = 0.105 if index % 3 else 0.15
        count = round(event_duration * sample_rate)
        t = np.arange(count, dtype=np.float32) / sample_rate
        noise = rng.normal(0.0, 1.0, count).astype(np.float32)
        resonance = np.sin(2.0 * math.pi * (285.0 + 35.0 * (index % 3)) * t)
        envelope = np.exp(-t * (31.0 if index % 3 else 23.0))
        event = (0.0090 * noise + 0.0140 * resonance) * envelope
        add_stereo_event(texture, event, round(event_time * sample_rate), rng.uniform(-0.45, 0.45))

    # Felt-like modal tones: tonic, fifth, minor seventh; atmosphere, not a new melody.
    modal_pitch_classes = (root, (root + 7) % 12, (root + 3) % 12, (root + 10) % 12)
    tone_times = np.arange(15.0, duration - 10.0, beat * 8.0)
    for index, event_time in enumerate(tone_times):
        pitch_class = modal_pitch_classes[index % len(modal_pitch_classes)]
        octave = 3 if index % 4 else 2
        frequency = note_frequency(pitch_class, octave)
        tone_duration = 3.8
        count = round(tone_duration * sample_rate)
        t = np.arange(count, dtype=np.float32) / sample_rate
        attack = np.minimum(t / 0.028, 1.0)
        envelope = attack * np.exp(-t / 1.35)
        detune = 1.0 + rng.uniform(-0.0018, 0.0018)
        tone = (
            np.sin(2.0 * math.pi * frequency * detune * t)
            + 0.32 * np.sin(2.0 * math.pi * frequency * 2.0 * t + 0.3)
            + 0.12 * np.sin(2.0 * math.pi * frequency * 3.0 * t + 0.7)
        )
        hammer = rng.normal(0.0, 1.0, count).astype(np.float32) * np.exp(-t * 45.0)
        event = (0.0110 * tone + 0.0028 * hammer) * envelope
        add_stereo_event(texture, event, round(event_time * sample_rate), rng.uniform(-0.35, 0.35))
    return texture


def lowpass(signal: np.ndarray, cutoff_hz: float, sample_rate: int) -> np.ndarray:
    coefficient = math.exp(-2.0 * math.pi * cutoff_hz / sample_rate)
    output = np.empty_like(signal)
    previous = 0.0
    for index, sample in enumerate(signal):
        previous = (1.0 - coefficient) * float(sample) + coefficient * previous
        output[index] = previous
    return output


def create_chaos_texture(
    source: np.ndarray,
    sample_rate: int,
    bpm: float,
    root: int,
    rng: np.random.Generator,
) -> np.ndarray:
    texture = np.zeros_like(source, dtype=np.float32)
    duration = len(source) / sample_rate
    beat = 60.0 / bpm

    # Irregular sub pulses alternate between the tonic and tritone.
    event_time = 14.0
    event_index = 0
    while event_time < duration - 10.0:
        pitch_class = root if event_index % 3 else (root + 6) % 12
        frequency = note_frequency(pitch_class, 1)
        event_duration = rng.uniform(1.4, 2.8)
        count = round(event_duration * sample_rate)
        t = np.arange(count, dtype=np.float32) / sample_rate
        envelope = np.sin(np.minimum(t / 0.16, 1.0) * math.pi / 2.0) * np.exp(-t / 0.75)
        drift = 1.0 + 0.012 * np.sin(2.0 * math.pi * rng.uniform(0.12, 0.31) * t)
        phase = 2.0 * math.pi * frequency * np.cumsum(drift) / sample_rate
        event = 0.040 * np.sin(phase) * envelope
        add_stereo_event(texture, event, round(event_time * sample_rate), rng.uniform(-0.25, 0.25))
        event_time += beat * rng.uniform(4.5, 9.0)
        event_index += 1

    # Filtered gusts create heat/cold pressure without turning into literal weather foley.
    for event_time in np.arange(28.0, duration - 12.0, beat * 19.0):
        event_time += rng.uniform(-beat * 2.0, beat * 2.0)
        event_duration = rng.uniform(1.2, 3.2)
        count = round(event_duration * sample_rate)
        t = np.arange(count, dtype=np.float32) / sample_rate
        white = rng.normal(0.0, 1.0, count).astype(np.float32)
        dark = lowpass(white, rng.uniform(700.0, 1500.0), sample_rate)
        darker = lowpass(dark, 90.0, sample_rate)
        band = dark - darker
        envelope = np.sin(np.pi * np.clip(t / event_duration, 0.0, 1.0)) ** 2
        event = 0.024 * band * envelope
        add_stereo_event(texture, event, round(event_time * sample_rate), rng.uniform(-0.75, 0.75))

    # Deterministic micro-stutters reuse source material, keeping the original identity audible.
    anchors = (28.0, 45.0, 62.0, 79.0, 96.0, 113.0, 130.0, 147.0, 162.0)
    for index, anchor in enumerate(anchors):
        source_start = max(0, round((anchor - rng.uniform(0.8, 1.7)) * sample_rate))
        fragment_length = round(rng.uniform(0.16, 0.34) * sample_rate)
        fragment = source[source_start : source_start + fragment_length].copy()
        if not len(fragment):
            continue
        if index % 2:
            fragment = fragment[::-1]
        window = np.hanning(len(fragment)).astype(np.float32)[:, None]
        fragment *= window * 0.240
        target_start = round(anchor * sample_rate)
        for repeat in range(5):
            offset = target_start + round(repeat * len(fragment) * rng.uniform(0.72, 0.94))
            end = min(len(texture), offset + len(fragment))
            if end > offset:
                texture[offset:end] += fragment[: end - offset]
    return texture


def human_filter() -> str:
    return (
        "[0:a]asplit=3[base][warm][near];"
        "[base]highpass=f=48,equalizer=f=82:t=q:w=0.9:g=-8.0,"
        "equalizer=f=410:t=q:w=1.0:g=4.2,treble=g=-2.2:f=6200,"
        "stereotools=slev=0.40,volume=0.50[base1];"
        "[warm]highpass=f=105,lowpass=f=2350,acompressor=threshold=0.12:ratio=2.2:attack=22:release=260,"
        "aecho=0.68:0.26:43|91:0.13|0.07,volume=0.25[warm1];"
        "[near]highpass=f=260,lowpass=f=4900,stereotools=slev=0.20,volume=0.25[near1];"
        "[1:a]highpass=f=70,lowpass=f=5200,volume=1.45[texture];"
        "[base1][warm1][near1][texture]amix=inputs=4:normalize=0:dropout_transition=0,"
        "alimiter=limit=0.88:attack=5:release=80,loudnorm=I=-20:LRA=7:TP=-1.5[out]"
    )


def chaos_filter(sample_rate: int) -> str:
    up_ratio = 2.0 ** (23.0 / 1200.0)
    down_ratio = 2.0 ** (-31.0 / 1200.0)
    up_rate = round(sample_rate * up_ratio)
    down_rate = round(sample_rate * down_ratio)
    return (
        "[0:a]asplit=5[dry][sub][up][down][crush];"
        "[dry]highpass=f=30,equalizer=f=95:t=q:w=0.8:g=1.8,"
        "equalizer=f=1300:t=q:w=1.1:g=-2.5,stereotools=slev=1.28,volume=0.34[dry1];"
        "[sub]lowpass=f=230,tremolo=f=0.13:d=0.78,volume=0.42[sub1];"
        f"[up]highpass=f=145,lowpass=f=6200,asetrate={up_rate},aresample={sample_rate},"
        f"atempo={1.0 / up_ratio:.8f},vibrato=f=0.21:d=0.34,volume=0.27[up1];"
        f"[down]highpass=f=120,lowpass=f=4700,asetrate={down_rate},aresample={sample_rate},"
        f"atempo={1.0 / down_ratio:.8f},vibrato=f=0.17:d=0.42,volume=0.24[down1];"
        "[crush]highpass=f=260,lowpass=f=5200,"
        "acrusher=bits=9.5:mix=0.72:samples=9:lfo=1:lforange=18:lforate=0.11,"
        "aphaser=in_gain=0.55:out_gain=0.72:delay=3.7:decay=0.62:speed=0.23,volume=0.18[crush1];"
        "[1:a]highpass=f=28,lowpass=f=6500,volume=1.45[texture];"
        "[dry1][sub1][up1][down1][crush1][texture]amix=inputs=6:normalize=0:dropout_transition=0,"
        "acompressor=threshold=0.22:ratio=1.6:attack=18:release=240,"
        "alimiter=limit=0.86:attack=4:release=100,loudnorm=I=-18.5:LRA=9:TP=-1.5[out]"
    )


def render_processed(
    ffmpeg: str,
    source: Path,
    texture: Path,
    target: Path,
    filter_complex: str,
) -> None:
    run([
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(source),
        "-i",
        str(texture),
        "-filter_complex",
        filter_complex,
        "-map",
        "[out]",
        "-ar",
        "44100",
        "-c:a",
        "pcm_s24le",
        str(target),
    ])


def create_loop(ffmpeg: str, source: Path, target: Path, duration: float, crossfade: float) -> float:
    if duration <= crossfade * 3.0:
        raise ValueError("Source is too short for the requested loop crossfade")
    body_end = duration - crossfade
    filter_complex = (
        f"[0:a]atrim=start={crossfade:.6f}:end={body_end:.6f},asetpts=PTS-STARTPTS[body];"
        f"[0:a]atrim=start={body_end:.6f}:end={duration:.6f},asetpts=PTS-STARTPTS[tail];"
        f"[0:a]atrim=start=0:end={crossfade:.6f},asetpts=PTS-STARTPTS[head];"
        f"[tail][head]acrossfade=d={crossfade:.6f}:c1=qsin:c2=qsin[seam];"
        "[body][seam]concat=n=2:v=0:a=1[out]"
    )
    run([
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(source),
        "-filter_complex",
        filter_complex,
        "-map",
        "[out]",
        "-ar",
        "44100",
        "-c:a",
        "pcm_s24le",
        str(target),
    ])
    return duration - crossfade


def make_preview(ffmpeg: str, source: Path, target: Path) -> None:
    run([
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(source),
        "-af",
        "loudnorm=I=-16:LRA=7:TP=-1.0",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "192k",
        str(target),
    ])


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Source audio master")
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--seed", type=int, default=6080)
    parser.add_argument("--crossfade", type=float, default=8.0)
    parser.add_argument("--ffmpeg", default=shutil.which("ffmpeg") or "ffmpeg")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    source = args.source.expanduser().resolve()
    output_dir = args.output_dir.expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    rng_human = np.random.default_rng(args.seed)
    rng_chaos = np.random.default_rng(args.seed + 1)

    with tempfile.TemporaryDirectory(prefix="eland-bgm-") as temp_name:
        temp = Path(temp_name)
        analysis_wav = temp / "source-pcm16.wav"
        decode_pcm16(args.ffmpeg, source, analysis_wav)
        audio, sample_rate = read_pcm16(analysis_wav)
        analysis, root = analyze(audio, sample_rate)

        human_texture = temp / "human-texture.wav"
        chaos_texture = temp / "chaos-texture.wav"
        write_pcm16(
            human_texture,
            create_human_texture(audio, sample_rate, analysis.estimated_bpm, root, rng_human),
            sample_rate,
        )
        write_pcm16(
            chaos_texture,
            create_chaos_texture(audio, sample_rate, analysis.estimated_bpm, root, rng_chaos),
            sample_rate,
        )

        human_preloop = temp / "human-preloop.wav"
        chaos_preloop = temp / "chaos-preloop.wav"
        render_processed(args.ffmpeg, analysis_wav, human_texture, human_preloop, human_filter())
        render_processed(args.ffmpeg, analysis_wav, chaos_texture, chaos_preloop, chaos_filter(sample_rate))

        cosmic_output = output_dir / "triple-dusk-cosmic-loop.wav"
        human_output = output_dir / "triple-dusk-human-world-loop.wav"
        chaos_output = output_dir / "triple-dusk-chaotic-era-loop.wav"
        loop_duration = create_loop(
            args.ffmpeg,
            analysis_wav,
            cosmic_output,
            analysis.duration_seconds,
            args.crossfade,
        )
        create_loop(
            args.ffmpeg,
            human_preloop,
            human_output,
            analysis.duration_seconds,
            args.crossfade,
        )
        create_loop(
            args.ffmpeg,
            chaos_preloop,
            chaos_output,
            analysis.duration_seconds,
            args.crossfade,
        )
        make_preview(args.ffmpeg, cosmic_output, output_dir / "triple-dusk-cosmic-preview.mp3")
        make_preview(args.ffmpeg, human_output, output_dir / "triple-dusk-human-world-preview.mp3")
        make_preview(args.ffmpeg, chaos_output, output_dir / "triple-dusk-chaotic-era-preview.mp3")

    manifest = {
        "source": str(source),
        "analysis": asdict(analysis),
        "generation": {
            "seed": args.seed,
            "crossfade_seconds": args.crossfade,
            "loop_duration_seconds": loop_duration,
            "human_target_lufs": -20.0,
            "chaotic_target_lufs": -18.5,
            "true_peak_ceiling_dbtp": -1.5,
            "method": "deterministic stereo-master DSP plus procedural modal textures",
            "variation_profile": "pronounced human-world transformation and strong chaotic-era transformation",
        },
        "outputs": {
            "cosmic_wav": "triple-dusk-cosmic-loop.wav",
            "human_world_wav": "triple-dusk-human-world-loop.wav",
            "chaotic_era_wav": "triple-dusk-chaotic-era-loop.wav",
            "cosmic_preview": "triple-dusk-cosmic-preview.mp3",
            "human_world_preview": "triple-dusk-human-world-preview.mp3",
            "chaotic_era_preview": "triple-dusk-chaotic-era-preview.mp3",
        },
    }
    (output_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
