# ELAND · 没有写好的历史

42 秒中文横屏宣传片。成片为 `ELAND-promo-1080p.mp4`，1920 × 1080、30 fps、H.264 / AAC，带中文字幕和项目自带配乐。

视频以宇宙俯冲、自然生态、河畔住房、先民对话和三星轨道串起 ELAND 的文明模拟主题。

## 素材

- 项目原有 `knowledge-base/assets/hero-loop.mp4` 游戏实录。
- 2026-09-09 补录：正式 `SocietyScene3D` 渲染器播放实际第 0 → 1 月的动物运动路径，以及第 16 号文明真实存档的住房展示。住房镜头使用展示页固定的恒纪元日照。
- 项目原有游戏截图 `world-dialogue.png`、`cosmos-orbits.png`，经过缓慢推近处理。
- 项目自带宇宙、人间、乱纪元三首配乐，按镜头剪辑和交叉淡化。

素材包含不同开发时点的游戏画面。字幕、裁切、转场、缓慢推近和片尾压暗属于剪辑处理。未加入 AI 生成场景或虚构的游戏行为。未改动游戏源码或存档。

## 编辑

- `titles.ass`：带排版、字号与淡入淡出的标题字幕。
- `subtitles.srt`：可导入剪辑软件的中文字幕。
- `sources.json`：镜头来源及时间信息。
- `render.py`：使用 FFmpeg 从 `source/` 中间素材重新合成。
- `capture.mjs`：使用独立 Chrome CDP 实例录制只读预览页，原始捕获记录在 `source/`。

此版本保留为早期成片归档，后续高清版本见 `../promo-v2/`。`source/`、`work/`、`qa/` 中的录制与渲染中间文件已清理；若需重新合成，应先按 `sources.json` 恢复原始素材，再在本目录运行 `python3 render.py`。
