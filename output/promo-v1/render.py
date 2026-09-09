"""Rebuild ELAND's 42-second trailer from the recorded project assets."""
import json
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
WORK = HERE / 'work'
WORK.mkdir(exist_ok=True)
FFMPEG = 'ffmpeg'

def run(args):
    subprocess.run([FFMPEG, '-hide_banner', '-loglevel', 'warning', '-y', *map(str, args)], check=True, cwd=HERE)

video = HERE / 'source/cosmos-world.mp4'
gallery = REPO / 'knowledge-base/assets/gallery'
shots = [
    dict(name='01-cosmos', source=video, duration=5.6, start=0, span=5.6, crop='1152:490:64:0'),
    dict(name='02-descent', source=video, duration=5.6, start=8.7, span=7.6, crop='1152:490:64:0'),
    dict(name='03-wildlife', source=HERE/'source/wildlife.mp4', duration=6.6, start=.3, span=6.6, crop='1920:816:0:45'),
    dict(name='04-homestead', source=HERE/'source/homestead.mp4', duration=7.6, start=.3, span=7.6, crop='1920:816:0:80', zoom=True),
    dict(name='05-dialogue', source=gallery/'world-dialogue.png', duration=6.6, crop='1360:578:100:80', still=True, zoom=True),
    dict(name='06-orbits', source=gallery/'cosmos-orbits.png', duration=6.6, crop='1600:680:0:190', still=True, zoom=True),
    dict(name='07-end', source=video, duration=7, start=30, span=7, crop='1152:490:64:0', dark=True),
]
for shot in shots:
    destination = WORK / (shot['name']+'.mp4')
    if destination.exists():
        continue
    print('Rendering', shot['name'], flush=True)
    args=[]
    if shot.get('still'): args += ['-loop', '1', '-framerate', '30']
    args += ['-i', shot['source']]
    filters=[]
    if not shot.get('still'):
        filters += [f"trim=start={shot['start']}:duration={shot['span']}", f"setpts=(PTS-STARTPTS)*{shot['duration']/shot['span']}"]
    filters += ['fps=30',f"crop={shot['crop']}",'scale=1920:816:flags=lanczos','setsar=1']
    if shot.get('zoom'):
        filters += ["zoompan=z='1+on*0.00016':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=1920x816:fps=30"]
    if shot.get('dark'):
        filters += ['drawbox=x=0:y=0:w=iw:h=ih:color=0x07100e@0.66:t=fill']
    filters += ['format=yuv420p','tpad=stop_mode=clone:stop_duration=1']
    args += ['-vf', ','.join(filters), '-t', shot['duration'], '-an', '-c:v','libx264','-preset','fast','-crf','17','-threads','4',destination]
    run(args)

print('Composing picture and sound', flush=True)
args=[]
for shot in shots: args += ['-i', WORK/(shot['name']+'.mp4')]
music=REPO/'three-body/public/audio/bgm'
for name in ['cosmic','human-world','chaotic-era']:
    args += ['-i',music/f'triple-dusk-{name}-loop.mp3']
chain=[]
for i in range(7): chain += [f'[{i}:v]settb=AVTB,setpts=PTS-STARTPTS[v{i}]']
offsets=[5,10,16,23,29,35]
previous='v0'
for i,offset in enumerate(offsets,1):
    transition = 'fadeblack' if i==5 else 'fade'
    chain += [f'[{previous}][v{i}]xfade=transition={transition}:duration=0.6:offset={offset}[x{i}]']
    previous=f'x{i}'
chain += [f'[{previous}]pad=1920:1080:0:132:color=0x080d0f,fade=t=in:st=0:d=0.6,ass=titles.ass,fade=t=out:st=41.3:d=0.7,format=yuv420p[vout]']
chain += [
    '[7:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,atrim=start=0:duration=11,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=1.4[a0]',
    '[8:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asplit=2[human1][human2]',
    '[human1]atrim=start=18:duration=20,asetpts=PTS-STARTPTS[a1]',
    '[9:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,atrim=start=20:duration=7,asetpts=PTS-STARTPTS[a2]',
    '[human2]atrim=start=45:duration=7,asetpts=PTS-STARTPTS[a3]',
    '[a0][a1]acrossfade=d=1:c1=tri:c2=tri[m1]',
    '[m1][a2]acrossfade=d=1:c1=tri:c2=tri[m2]',
    '[m2][a3]acrossfade=d=1:c1=tri:c2=tri,loudnorm=I=-17:TP=-1.5:LRA=11,afade=t=out:st=39.2:d=2.8,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[aout]',
]
filter_script=WORK/'edit.ffscript'
filter_script.write_text(';\n'.join(chain),encoding='utf-8')
args += ['-filter_complex_threads','2','-filter_complex_script',filter_script,'-map','[vout]','-map','[aout]','-t','42',
         '-c:v','libx264','-preset','medium','-crf','18','-threads','4','-pix_fmt','yuv420p',
         '-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709',
         '-c:a','aac','-b:a','256k','-ar','48000','-movflags','+faststart',
         '-metadata','title=ELAND | 没有写好的历史', '-metadata','comment=Real project footage, screenshots and saved-state playback. Edited promotional trailer.',
         HERE/'ELAND-promo-1080p.mp4']
run(args)

manifest={
    'title':'ELAND · 没有写好的历史', 'duration_seconds':42,'resolution':'1920x1080','fps':30,
    'visual_sources':[dict(**{k:(str(v.relative_to(REPO)) if isinstance(v,Path) else v) for k,v in s.items()}) for s in shots],
    'capture_notes':[
        'cosmos-world.mp4 is a CFR transcode of knowledge-base/assets/hero-loop.mp4.',
        'wildlife.mp4: formal game renderer replaying movement-frames.json, actual month 0 to 1 animal paths.',
        'homestead.mp4: formal game renderer displaying civilization 16 saved state; stable showcase daylight.',
        'The wildlife and homestead footage was captured on 2026-09-09. Gallery screenshots and hero recording predate this capture.',
        'No generated AI video, synthetic actors, or simulated new gameplay outcomes were added.',
        'Screenshots are animated with editorial pan/zoom. The video uses crops, fades, title text, and a darkened closing shot.',
    ],
    'soundtrack':[str(p.relative_to(REPO)) for p in music.glob('*.mp3')],
}
(HERE/'sources.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
print('Done:',HERE/'ELAND-promo-1080p.mp4',flush=True)
