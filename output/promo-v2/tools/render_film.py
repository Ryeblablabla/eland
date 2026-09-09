"""Native 1440p edit, from the per-frame captures listed in timeline.json."""
from pathlib import Path
import json
import subprocess

BASE=Path(__file__).resolve().parents[1]
REPO=BASE.parents[1]
TIMELINE=json.loads((BASE/'timeline.json').read_text())
CLIPS=TIMELINE['clips']
WORK=BASE/'work'
WORK.mkdir(exist_ok=True)

def run(args):
    subprocess.run(['ffmpeg','-hide_banner','-loglevel','warning','-y',*map(str,args)],check=True,cwd=BASE)

args=[]
for clip in CLIPS:
    source=BASE/'shots'/(clip['shot']+'.mp4')
    if not source.exists():raise FileNotFoundError(source)
    args+=['-i',source]

audio_files=[
 REPO/'three-body/public/audio/bgm/triple-dusk-cosmic-loop.mp3',
 REPO/'three-body/public/audio/bgm/triple-dusk-human-world-loop.mp3',
 REPO/'three-body/public/audio/bgm/triple-dusk-chaotic-era-loop.mp3',
 *[BASE/'audio'/f'narration_{n}.mp3' for n in ['01','02','03','05','06','07']],
 BASE/'audio/ambient_wind_70s.wav',BASE/'audio/ambient_rain_70s.wav',
 BASE/'audio/sfx_light_tap_01.wav',BASE/'audio/sfx_light_tap_02.wav',BASE/'audio/sfx_low_transition_01.wav',
]
for source in audio_files:args+=['-i',source]
idx={path.name:len(CLIPS)+i for i,path in enumerate(audio_files)}
chain=[]
for i,clip in enumerate(CLIPS):
    grade='eq=contrast=1.035:saturation=0.93:brightness=0.005'
    if clip['shot'].startswith('cold'):
        grade='eq=contrast=1.09:saturation=0.47:brightness=-0.065,colorbalance=rs=-0.04:bs=0.055:rm=-0.025:bm=0.035'
    elif clip['shot'] in ('cosmos','stars','dive'):
        grade='eq=contrast=1.05:brightness=0.008:saturation=1.02'
    elif clip['shot']=='final':
        grade='drawbox=x=0:y=0:w=iw:h=ih:color=0x071210@0.68:t=fill'
    elif clip['shot'] in ('teaching','future','memory','atmosphere'):
        grade='null'
    chain += [f"[{i}:v]trim=start={clip['source_in']}:duration={clip['duration']},setpts=PTS-STARTPTS,settb=AVTB,{grade},format=yuv420p[v{i}]"]

current='v0'
for i,clip in enumerate(CLIPS[1:],1):
    if clip['transition_seconds']:
        kind='fadeblack' if clip['shot']=='cosmos' else 'fade'
        chain += [f"[{current}][v{i}]xfade=transition={kind}:duration={clip['transition_seconds']}:offset={clip['start']}[cut{i}]"]
    else:
        chain += [f'[{current}][v{i}]concat=n=2:v=1:a=0[cut{i}]']
    current=f'cut{i}'
chain += [f'[{current}]drawbox=x=0:y=0:w=iw:h=84:color=0x080e12:t=fill,drawbox=x=0:y=ih-84:w=iw:h=84:color=0x080e12:t=fill,fade=t=in:st=0:d=0.3,ass=titles.ass,fade=t=out:st=73.3:d=0.7,format=yuv420p[vout]']

def sound(name):return f"[{idx[name]}:a]"
fmt='aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo'
chain += [
 sound('triple-dusk-cosmic-loop.mp3')+f'atrim=start=0:duration=12,asetpts=PTS-STARTPTS,{fmt},volume=0.22,afade=t=in:st=0:d=0.4,afade=t=out:st=10:d=2[mc]',
 sound('triple-dusk-human-world-loop.mp3')+f"atrim=start=18:duration=63,asetpts=PTS-STARTPTS,{fmt},volume='if(between(t,42,49),0.09,0.28)':eval=frame,afade=t=in:st=0:d=2,adelay=11000|11000[mh]",
 sound('triple-dusk-chaotic-era-loop.mp3')+f'atrim=start=20:duration=10,asetpts=PTS-STARTPTS,{fmt},volume=0.22,afade=t=in:st=0:d=1.5,afade=t=out:st=8:d=2,adelay=50500|50500[md]',
 '[mc][mh][md]amix=inputs=3:duration=longest:normalize=0[music]',
 sound('narration_01.mp3')+f'{fmt},volume=1.5,adelay=300|300[n01]',
 sound('narration_02.mp3')+f'{fmt},volume=1.5,adelay=8100|8100[n02]',
 sound('narration_03.mp3')+'asplit=2[n03a][n03b]',
 f'[n03a]atrim=start=0:duration=2.10,asetpts=PTS-STARTPTS,{fmt},volume=1.5,adelay=14400|14400[n03first]',
 f'[n03b]atrim=start=2.10:end=5.15,asetpts=PTS-STARTPTS,{fmt},volume=1.5,adelay=21200|21200[n03last]',
 sound('narration_05.mp3')+f'{fmt},volume=1.5,adelay=36600|36600[n05]',
 sound('narration_06.mp3')+f'{fmt},volume=1.5,adelay=54000|54000[n06]',
 sound('narration_07.mp3')+f'{fmt},volume=1.5,adelay=63800|63800[n07]',
 '[n01][n02][n03first][n03last][n05][n06][n07]amix=inputs=7:duration=longest:normalize=0,apad=whole_dur=74,asplit=2[voice][side]',
 '[music][side]sidechaincompress=threshold=0.02:ratio=4:attack=15:release=400[ducked]',
 sound('ambient_wind_70s.wav')+f"{fmt},apad=whole_dur=74,volume='if(lt(t,4),1.4,0.7)':eval=frame[wind]",
 sound('ambient_rain_70s.wav')+f"{fmt},apad=whole_dur=74,volume='if(lt(t,4),1.2,if(between(t,21,26),0.8,0.2))':eval=frame[rain]",
 sound('sfx_light_tap_01.wav')+f'{fmt},asplit=3[tap1][tap2][tap3]',
 '[tap1]volume=0.65,adelay=18800|18800[tap1d]',
 '[tap2]volume=0.55,adelay=19550|19550[tap2d]',
 '[tap3]volume=0.65,adelay=21800|21800[tap3d]',
 sound('sfx_light_tap_02.wav')+f'{fmt},volume=0.5,adelay=31100|31100[tap4d]',
 sound('sfx_low_transition_01.wav')+f'{fmt},asplit=2[sw1][sw2]',
 '[sw1]volume=0.6,adelay=3550|3550[sw1d]',
 '[sw2]volume=0.45,adelay=53500|53500[sw2d]',
 '[ducked][voice][wind][rain][tap1d][tap2d][tap3d][tap4d][sw1d][sw2d]amix=inputs=10:duration=longest:normalize=0,highpass=f=35,alimiter=limit=0.89:level=0,afade=t=out:st=71.2:d=2.8,atrim=duration=74[aout]',
]
script=WORK/'edit.ffscript'
script.write_text(';\n'.join(chain),encoding='utf-8')
args+=['-filter_complex_threads','2','-filter_complex_script',script,'-map','[vout]','-map','[aout]','-t','74',
 '-c:v','libx264','-preset','medium','-crf','16','-threads','4','-pix_fmt','yuv420p',
 '-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709',
 '-c:a','aac','-b:a','256k','-ar','48000','-ac','2','-movflags','+faststart',
 '-metadata','title=ELAND · 他们称你为「主」',
 '-metadata','comment=Native 2560x1440 official renderer capture from actual saved game states. Recorded dialogue and memory excerpts. Editorial narration and soundtrack.',
 WORK/'premaster.mp4']
print('Rendering full 74-second native 1440p film',flush=True)
run(args)
run(['-i',WORK/'premaster.mp4','-map','0:v:0','-map','0:a:0','-c:v','copy',
     '-af','loudnorm=I=-18:TP=-1.5:LRA=11,aformat=sample_rates=48000:channel_layouts=stereo',
     '-c:a','aac','-b:a','256k','-t','74','-movflags','+faststart',BASE/'ELAND-promo-v2-1440p.mp4'])
print('Finished',BASE/'ELAND-promo-v2-1440p.mp4',flush=True)
