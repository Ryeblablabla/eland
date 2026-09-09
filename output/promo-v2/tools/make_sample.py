from pathlib import Path
import subprocess
p=Path(__file__).resolve().parents[1]
repo=p.parents[1]
f=';'.join([
 '[0:v]trim=duration=5,setpts=PTS-STARTPTS,settb=AVTB[a]',
 '[1:v]trim=start=1:duration=8,setpts=PTS-STARTPTS,settb=AVTB[b]',
 '[2:v]trim=duration=3,setpts=PTS-STARTPTS,settb=AVTB,eq=saturation=0.55:brightness=-0.045:contrast=1.08[c]',
 '[a][b]xfade=transition=fade:duration=0.5:offset=4.5[x]',
 '[x][c]xfade=transition=fadeblack:duration=0.5:offset=12[y]',
 "[y]drawbox=x=0:y=0:w=iw:h=84:color=0x080e12:t=fill,drawbox=x=0:y=ih-84:w=iw:h=84:color=0x080e12:t=fill,drawtext=fontfile='/System/Library/Fonts/Avenir Next.ttc':text='ELAND':x=76:y=27:fontsize=28:fontcolor=0xe8e5d5,fade=t=in:st=0:d=0.35,fade=t=out:st=14.5:d=0.5[v]",
 '[3:a]atrim=start=24:duration=15,asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=.2[m]',
 '[4:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,adelay=400|400,volume=1.4[n1]',
 '[5:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,adelay=7600|7600,volume=1.4[n2]',
 '[6:a]atrim=duration=15,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=.6[w]',
 '[m][n1][n2][w]amix=inputs=4:duration=longest:normalize=0,alimiter=limit=.89,afade=t=out:st=13.7:d=1.3[aout]'
])
args=['ffmpeg','-hide_banner','-loglevel','warning','-y']
for file in [p/'shots/walk.mp4',p/'shots/future.mp4',p/'shots/cold.mp4',repo/'three-body/public/audio/bgm/triple-dusk-human-world-loop.mp3',p/'audio/narration_05.mp3',p/'audio/narration_07.mp3',p/'audio/ambient_wind_70s.wav']:
 args+=['-i',str(file)]
args+=['-filter_complex_threads','2','-filter_complex',f,'-map','[v]','-map','[aout]','-t','15','-c:v','libx264','-crf','16','-preset','fast','-threads','4','-pix_fmt','yuv420p','-c:a','aac','-b:a','256k','-movflags','+faststart',str(p/'ELAND-sample-15s-1440p.mp4')]
subprocess.run(args,check=True)
