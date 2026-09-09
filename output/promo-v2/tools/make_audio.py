#!/usr/bin/env python3
"""Create separate ELAND promo-v2 narration, ambience and effect stems.

Run with output/promo-v2/tools/venv/bin/python. Existing verified narration is
reused; pass --force-voices to synthesize it again. This never mixes the film.
"""

from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import wave

import edge_tts
import numpy as np


ROOT = Path(__file__).resolve().parents[1]
AUDIO = ROOT / "audio"
RATE = "-10%"
PITCH = "-3Hz"
SAMPLE_RATE = 48_000
LINES = [
    ("01", "一场严寒，足以让一个文明结束。", "zh-CN-YunxiNeural"),
    ("02", "而新的故事，会从一无所有开始。", "zh-CN-YunxiNeural"),
    ("03", "她曾跟在母亲身边。后来，也有了自己的家。", "zh-CN-YunxiNeural"),
    ("04", "你可以走近他们，说出你的想法。", "zh-CN-YunxiNeural"),
    ("05", "他们称你为主，却有自己的主意。", "zh-CN-YunxiNeural"),
    ("06", "恒纪元与乱纪元之间，没有人知道结局。", "zh-CN-YunxiNeural"),
    ("07", "能延续，但得靠我们自己一步步去争取。", "zh-CN-XiaoxiaoNeural"),
    ("08", "没有写好的历史。", "zh-CN-YunxiNeural"),
]


def probe(path: Path) -> dict:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries",
         "format=duration,size:stream=codec_name,sample_rate,channels",
         "-of", "json", str(path)],
        check=True, capture_output=True, text=True,
    )
    data = json.loads(result.stdout)
    stream = data["streams"][0]
    duration = float(data["format"]["duration"])
    if duration <= 0:
        raise RuntimeError(f"Invalid audio duration: {path}")
    return {
        "duration_seconds": round(duration, 6),
        "size_bytes": int(data["format"]["size"]),
        "codec": stream["codec_name"],
        "sample_rate": int(stream["sample_rate"]),
        "channels": stream["channels"],
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }


async def make_voice(line: tuple[str, str, str], force: bool, gate: asyncio.Semaphore) -> dict:
    number, text, voice = line
    path = AUDIO / f"narration_{number}.mp3"
    async with gate:
        verified = None
        if path.exists() and not force:
            try:
                verified = probe(path)
            except (subprocess.CalledProcessError, ValueError, KeyError, RuntimeError):
                pass
        if verified is None:
            for attempt in range(2):
                temporary = path.with_suffix(".part.mp3")
                try:
                    await edge_tts.Communicate(
                        text, voice, rate=RATE, pitch=PITCH, volume="+0%",
                        connect_timeout=15, receive_timeout=60,
                    ).save(str(temporary))
                    verified = probe(temporary)
                    temporary.replace(path)
                    break
                except Exception as exc:
                    temporary.unlink(missing_ok=True)
                    print(f"VOICE {number} attempt {attempt + 1}/2 failed: {exc}", flush=True)
                    if attempt == 1:
                        raise
                    await asyncio.sleep(2)
        print(f"VOICE {number}: {verified['duration_seconds']:.3f}s — {text}", flush=True)
        return {
            "id": number,
            "file": path.name,
            "text": text,
            "voice": voice,
            "rate": RATE,
            "pitch": PITCH,
            "volume": "+0%",
            "source": "Microsoft Edge Read Aloud stock neural voice via edge-tts",
            "performance": "Synthetic narration, not a game recording or cloned character voice",
            **verified,
        }


def filtered_noise(rng: np.random.Generator, count: int, low_cut: float, high_cut: float) -> np.ndarray:
    """Band-limit white noise with smooth frequency-domain filters."""
    frequencies = np.fft.rfftfreq(count, 1 / SAMPLE_RATE)
    response = frequencies / np.sqrt(frequencies ** 2 + low_cut ** 2)
    response *= 1 / np.sqrt(1 + (frequencies / high_cut) ** 4)
    spectrum = np.fft.rfft(rng.standard_normal(count))
    return np.fft.irfft(spectrum * response, count)


def fade(signal: np.ndarray, fade_in: float, fade_out: float) -> np.ndarray:
    incoming = min(len(signal), round(fade_in * SAMPLE_RATE))
    outgoing = min(len(signal), round(fade_out * SAMPLE_RATE))
    if incoming:
        signal[:incoming] *= np.sin(np.linspace(0, np.pi / 2, incoming)) ** 2
    if outgoing:
        signal[-outgoing:] *= np.cos(np.linspace(0, np.pi / 2, outgoing)) ** 2
    return signal


def target_rms(signal: np.ndarray, dbfs: float, peak_dbfs: float = -15) -> np.ndarray:
    rms = max(float(np.sqrt(np.mean(signal ** 2))), 1e-12)
    signal *= 10 ** (dbfs / 20) / rms
    peak = max(float(np.max(np.abs(signal))), 1e-12)
    signal *= min(1.0, 10 ** (peak_dbfs / 20) / peak)
    return signal


def write_wav(name: str, stereo: np.ndarray, description: str, seed: int) -> dict:
    path = AUDIO / name
    stereo = np.asarray(stereo)
    if stereo.ndim == 1:
        stereo = np.column_stack((stereo, stereo))
    pcm = np.round(np.clip(stereo, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(SAMPLE_RATE)
        output.writeframes(pcm.tobytes())
    peak = max(float(np.max(np.abs(stereo))), 1e-12)
    rms = max(float(np.sqrt(np.mean(stereo ** 2))), 1e-12)
    result = {
        "file": name,
        "description": description,
        "source": "Original procedural NumPy waveforms and frequency-domain filtering",
        "seed": seed,
        "peak_dbfs": round(20 * np.log10(peak), 2),
        "rms_dbfs": round(20 * np.log10(rms), 2),
        **probe(path),
    }
    print(f"STEM {name}: {result['duration_seconds']:.3f}s, RMS {result['rms_dbfs']} dBFS", flush=True)
    return result


def make_procedural_stems() -> list[dict]:
    stems = []
    seconds = 70
    count = seconds * SAMPLE_RATE
    time = np.arange(count) / SAMPLE_RATE
    seed = 1600791
    rng = np.random.default_rng(seed)
    wind_channels = []
    for phase in (0.0, 0.7):
        wind = filtered_noise(rng, count, 36, 470)
        envelope = 0.74 + 0.13 * np.sin(2 * np.pi * 0.071 * time + phase)
        envelope += 0.075 * np.sin(2 * np.pi * 0.173 * time + 1.3 + phase)
        wind_channels.append(target_rms(fade(wind * envelope, 1.5, 2.0), -35))
    stems.append(write_wav(
        "ambient_wind_70s.wav", np.column_stack(wind_channels),
        "Quiet stereo wind bed, slow gust modulation; 70 seconds; separate from narration/music.", seed,
    ))
    del wind_channels
    rain_channels = []
    for phase in (0.0, 0.35):
        rain = filtered_noise(rng, count, 650, 6200)
        envelope = 0.8 + 0.08 * np.sin(2 * np.pi * 0.039 * time + phase)
        envelope += 0.045 * np.sin(2 * np.pi * 0.21 * time + 2.0 + phase)
        rain_channels.append(target_rms(fade(rain * envelope, 1.5, 2.0), -38))
    stems.append(write_wav(
        "ambient_rain_70s.wav", np.column_stack(rain_channels),
        "Quiet stereo fine-rain bed; no thunder; 70 seconds; use only on rain/weather passages.", seed,
    ))
    del rain_channels, time
    for index, fundamental in ((1, 420), (2, 310)):
        seconds = 0.42 if index == 1 else 0.5
        count = round(seconds * SAMPLE_RATE)
        time = np.arange(count) / SAMPLE_RATE
        tap = (np.sin(2 * np.pi * fundamental * time) * np.exp(-time * 45)
               + 0.34 * np.sin(2 * np.pi * fundamental * 2.13 * time) * np.exp(-time * 68))
        tap += filtered_noise(rng, count, 450, 3200) * np.exp(-time * 95) * 0.55
        tap = target_rms(fade(tap, 0.002, 0.06), -31, -17)
        stems.append(write_wav(
            f"sfx_light_tap_{index:02d}.wav", tap,
            "Soft short wooden tap; editorial accent, not recorded gameplay sound.", seed,
        ))
    seconds = 1.4
    count = round(seconds * SAMPLE_RATE)
    time = np.arange(count) / SAMPLE_RATE
    # Gentle falling low tone, with enough upper partial to translate on small speakers.
    phase = 2 * np.pi * (76 * time - 12 * time ** 2)
    low = 0.7 * np.sin(phase) + 0.16 * np.sin(phase * 1.98)
    low += filtered_noise(rng, count, 30, 160) * 0.18
    low *= np.sin(np.pi * np.clip(time / seconds, 0, 1)) ** 1.7
    low = target_rms(fade(low, 0.14, 0.35), -29, -18)
    stems.append(write_wav(
        "sfx_low_transition_01.wav", low,
        "Subtle descending low-frequency transition; soft attack/release, no explosion.", seed,
    ))
    return stems


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--force-voices", action="store_true")
    parser.add_argument("--stems-only", action="store_true")
    args = parser.parse_args()
    AUDIO.mkdir(parents=True, exist_ok=True)
    manifest_path = AUDIO / "manifest.json"
    manifest = {
        "project": "ELAND promo v2",
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
        "source_script": "../tools/make_audio.py",
        "voice_notes": (
            "Stock Microsoft neural voices synthesized using edge-tts. No voice cloning or impersonation. "
            "Line 07 reads supplied actual dialogue using stock Xiaoxiao; it is not a recording of an in-game voice. "
            "Narration, ambience and effects are separate stems; final timing and mix belong to the film editor."
        ),
        "edge_tts_version": edge_tts.__version__,
        "narration": [],
        "procedural_stems": [],
        "errors": [],
    }
    if args.stems_only and manifest_path.exists():
        manifest["narration"] = json.loads(manifest_path.read_text())["narration"]
    if not args.stems_only:
        gate = asyncio.Semaphore(2)
        results = await asyncio.gather(
            *(make_voice(line, args.force_voices, gate) for line in LINES), return_exceptions=True,
        )
        for line, result in zip(LINES, results):
            if isinstance(result, BaseException):
                manifest["errors"].append({"voice_id": line[0], "error": str(result)})
            else:
                manifest["narration"].append(result)
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    manifest["procedural_stems"] = make_procedural_stems()
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(f"MANIFEST {manifest_path}", flush=True)
    if manifest["errors"]:
        raise SystemExit("Some network voices failed after one retry; no local fallback was used.")


if __name__ == "__main__":
    asyncio.run(main())
