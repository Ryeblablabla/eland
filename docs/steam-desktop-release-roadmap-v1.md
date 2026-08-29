# ELAND Steam 桌面发行路线 v1

状态：未来目标，尚未实现。本文只确定发行方向、技术边界、里程碑与验收标准，不代表当前仓库已经具备 Electron、SteamPipe、代码签名或 Steamworks 集成能力。

## 目标

ELAND 计划以同一套游戏代码发布到 Steam，首批支持：

- Windows 64 位（x64）；
- macOS 64 位通用包（Intel x64 + Apple Silicon arm64）。

Steam 版本应是一款可独立安装和启动的单机桌面游戏。玩家不需要安装 Node.js、运行命令行、启动独立后端或理解本地端口。没有模型配置或网络不可用时，本地规则主链仍能完整推进文明。

桌面发行只改变宿主、文件位置和交付方式，不改变模拟权威：

- `domain/`、`world/` 与应用用例继续产生唯一权威状态和可回放事实；
- Electron、Steamworks、窗口与表现层不得成为第二套演进来源；
- Windows 与 macOS 必须读取相同协议的存档，不因平台产生不同领域规则；
- Steam 成就、云存档和统计只能观察或搬运已提交事实，不能反向奖励人物或改变文明结果。

## 计划采用的桌面架构

当前 React / Vite 前端与 Node 演化服务保持分离，使用 Electron 承担桌面宿主，使用 Electron Forge 生成平台包。

```text
Steam
  ↓
ELAND.exe / ELAND.app
  ↓
Electron main process
  ├─ BrowserWindow：加载现有全屏游戏前端
  ├─ 应用生命周期：启动、退出、崩溃提示
  └─ utility process：启动现有 Node 演化服务
       ├─ /api
       ├─ worker_threads 演化 Worker
       ├─ SQLite 权威存档
       └─ dist/ 前端静态文件
```

选择 Electron 而不是在首个发行版本中迁移到 Tauri 或原生引擎，原因是当前后端已经依赖 Node HTTP、`worker_threads`、`node:sqlite` 与服务端模型适配器。Electron 可以携带兼容的 Node 运行时，避免重写模拟内核或额外要求玩家安装 Node sidecar。

### 进程与端口

- 开发环境继续使用 Vite `3217` 和后端 `3220`。
- 桌面发行环境只监听 `127.0.0.1`，由操作系统分配空闲端口，不固定占用 `3220`。
- 后端就绪后把实际端口通知 Electron 主进程；主进程通过健康检查确认服务可用后再显示游戏窗口。
- 发行环境由同一后端同时提供 `dist/` 和 `/api`，使现有相对 API 路径保持同源，不引入 `file://` 特判。
- 关闭窗口时先停止推进并正常关闭 Worker 与 SQLite，再结束 Electron 进程。

计划新增或调整的工程入口：

```text
three-body/
├── desktop/
│   └── main.ts             # Electron 主进程与桌面生命周期
├── server/
│   └── main.ts             # 增加桌面静态文件、随机端口和就绪通知
├── forge.config.ts         # 平台打包、包含/排除规则与签名配置
├── dist/                   # Vite 前端发行产物
└── dist-server/            # Node 服务与 Worker 发行产物
```

这只是预期落点。实施时若现有模块边界要求拆出 `server/app-server.ts` 等更明确入口，可以调整文件名，但不得复制 HTTP 路由或模拟规则。

## 玩家数据与配置

安装目录只保存只读程序文件。SQLite、模型端点配置、日志和崩溃诊断写入操作系统的用户数据目录，由 Electron `app.getPath('userData')` 确定。

预期结构：

```text
<userData>/
├── data/
│   └── eland.sqlite3
├── model-endpoints.json
└── logs/
```

硬性边界：

- 不把仓库中的 `three-body/data/`、实验运行、手动存档或文明编号打进发行包；
- 不把 `.env*`、模型密钥、开发端点配置或本机绝对路径打进发行包；
- 不从 Steam 安装目录直接打开可写 SQLite；
- 更新程序不得覆盖玩家数据；
- 若以后启用 Steam Cloud，必须在后端正常关闭并完成 SQLite WAL 收束后同步可恢复文件，不能只在运行中复制主数据库文件。

桌面进程预期向后端提供：

```text
THREEBODY_HOST=127.0.0.1
THREEBODY_PORT=0
THREEBODY_DATA_DIR=<userData>/data
THREEBODY_MODEL_CONFIG=<userData>/model-endpoints.json
ELAND_WEB_ROOT=<packaged-app>/dist
```

## 构建目标

计划使用 Electron Forge 的 `package` 结果作为 SteamPipe 输入。Steam 自己负责安装和差分更新，因此 Steam depot 不上传 Squirrel、DMG 或其他面向官网分发的安装器。

计划中的脚本职责如下，名称可在实施时按现有 `package.json` 统一：

| 脚本 | 职责 |
| --- | --- |
| `build:desktop:runtime` | 构建 Vite 前端、Node 后端与两个 Worker |
| `package:steam:win` | 在 Windows 上生成 `win32-x64` 应用目录 |
| `package:steam:mac` | 在 macOS 上生成 `darwin-universal` 应用目录并签名、公证 |
| `package:steam` | 只作为同一构建环境中的编排入口，不假定一台机器可靠跨平台产出 |

预期产物：

```text
out/
├── ELAND-win32-x64/
│   └── ELAND.exe
└── ELAND-darwin-universal/
    └── ELAND.app
```

平台构建原则：

- Windows 包在 Windows x64 环境构建并测试；
- macOS universal 包在安装 Xcode 的 Mac 上构建、签名、公证并测试；
- 不把“在 Mac 上下载到 Windows Electron 二进制”当作 Windows 发行验收；
- 初期不要求为此建立大型 CI。先让两个平台的本地可重复构建成立，再决定是否增加最小双平台构建任务。

Electron 应避免把频繁变化的大型前后端包合成不利于 SteamPipe 差分更新的单一归档。实施阶段应评估关闭 ASAR，或只把确有需要的文件放入 ASAR；后端 Worker 必须能从最终安装目录可靠加载。生产包排除源码映射、开发脚本、知识库、实验数据和无关文档。

## Steam 应用与 depot

ELAND 使用一个 Steam AppID，首期设置两个完整平台 depot：

| Depot | 平台条件 | 内容 | 启动项 |
| --- | --- | --- | --- |
| ELAND Windows | Windows 64 位 | `ELAND-win32-x64/` 内容 | `ELAND.exe` |
| ELAND macOS | macOS 64 位 | `ELAND.app` 及运行依赖 | `ELAND.app/Contents/MacOS/ELAND` |

由于 Electron 运行时本身具有平台差异，首期不为了减少少量重复文件拆公共 depot。只有在实测更新体积确有收益、且不会增加挂载与回滚复杂度时，才考虑共享内容 depot。

SteamPipe 上传顺序为：平台本地打包 → 本地启动验证 → 上传对应 depot → 设置私有测试分支 → 从 Steam 客户端全新安装验证 → 再考虑发布分支。不得把本机未通过启动验证的目录直接设为默认分支。

## 里程碑

### M0：发行基线

- 当前普通前端与后端构建通过；
- 明确最终包的包含与排除清单；
- 确认发行包不读取仓库开发数据；
- 选定 Electron 主版本、最低 Windows/macOS 版本和应用标识。

完成标志：现有浏览器开发形态保持可用，发行工作有可重复的干净输入。

### M1：本地桌面壳

- Electron 启动现有后端 utility process；
- 后端使用随机回环端口并返回就绪信号；
- BrowserWindow 能完成宇宙到人间体素世界的连续缩放；
- 新文明、自动推进、手动存档、读取与正常退出可用；
- 玩家数据只写入 `userData`。

完成标志：开发机不启动 Vite、不手动启动后端，也能从桌面入口完整游玩和恢复。

### M2：Windows Steam 候选包

- 生成 Windows x64 应用目录；
- 在没有 Node.js 开发环境的 Windows 机器上启动；
- 从空用户目录建立文明并重启恢复；
- 退出后不存在遗留后端进程；
- 包内没有实验数据库、模型密钥、源码映射和本机路径。

完成标志：Windows 候选包可作为 SteamPipe Windows depot 内容。

### M3：macOS Steam 候选包

- 生成同时支持 Intel 与 Apple Silicon 的 universal 应用；
- 完成 Developer ID 签名与 Apple 公证；
- 分别验证原生 arm64 与可获得的 x64 环境；
- 验证窗口、GPU 渲染、Worker、SQLite、退出与重新打开。

完成标志：macOS 候选包可作为 SteamPipe macOS depot 内容，不要求玩家绕过 Gatekeeper。

### M4：Steam 私有分支

- 建立 Windows/macOS 独立 depot 与启动项；
- 上传两个候选包至密码保护的测试分支；
- 分别从 Steam 客户端全新安装，不复用本地构建目录；
- 验证更新覆盖程序但保留玩家数据；
- 验证离线启动与没有模型配置时的本地规则回退。

完成标志：两平台都能从 Steam 客户端安装、启动、保存、退出、更新和恢复。

### M5：商店发行候选

- 商店声明的操作系统、语言和功能与实际构建一致；
- 截图和预告片只展示发行候选包中真实存在的游戏内容；
- 完成字体、肖像、名称、音频、图像与生成式 AI 内容的发行权利审计；
- 确定最低/推荐内存与 GPU，特别覆盖演化 Worker 的真实内存峰值；
- 完成一次 Windows 和 macOS 的发行候选烟测记录。

完成标志：构建、商店页和内容声明可一起提交 Steam 审核。

## 首个发行版本的验收标准

以下条件全部满足，才可以把“支持 Steam Windows/macOS”写成当前能力：

1. Windows 与 macOS 均可从 Steam 私有分支全新安装并启动。
2. 玩家无需安装 Node.js、数据库或命令行工具。
3. 没有模型配置或网络失败时，规则模拟仍能建立并推进文明。
4. 新文明、自动推进、宇宙/人间连续缩放、观察菜单、存档和恢复均可用。
5. 正常退出会关闭后端与 Worker；再次启动不会因端口、锁或 WAL 状态失败。
6. 更新程序不会覆盖玩家 SQLite 与模型配置。
7. 安装包不包含开发数据库、实验产物、密钥、绝对路径或非发行素材。
8. 两个平台对同一可迁移权威状态保持协议兼容；平台差异不得改变领域规则。
9. macOS 构建已签名并公证；Windows/macOS 的 Steam 启动项均指向真实可执行文件。
10. 商店页承诺的所有功能在提交审核的构建中已经存在。

## 首期非目标

以下内容不阻塞第一份可玩的 Steam 双平台构建：

- Linux / SteamOS 原生版本；
- Steam 成就、排行榜、Workshop、好友或多人功能；
- Steam Cloud 跨平台存档；
- 官网安装器和 Electron 自动更新；
- 为桌面发行重写领域内核、HTTP API 或 SQLite codec；
- 把模型密钥预置给玩家；
- 为构建路线建立与改动无关的全量 CI、安全扫描或超长模拟矩阵。

Steam Cloud 若后续启用，应单独设计 SQLite 一致性、跨平台冲突、存档版本迁移和离线覆盖规则。Steam 成就若后续启用，只能从权威历史投影，不能进入人物决策、文明指数或规则奖励。

## 尚待决定

- Steam AppID、开发者/发行者主体与商店名称；
- Electron 的固定主版本及其对应最低 macOS 版本；
- Windows 是否在首个测试包阶段即启用代码签名；
- macOS universal 单 depot，或未来按架构拆分 depot；
- 玩家日志保留时长与显式导出入口；
- Steam Cloud、成就和 Steam Overlay 的后续优先级；
- 抢先体验还是正式版发行，以及首发价格和语言范围。

这些选择不得阻塞 M0–M1 的桌面架构验证；涉及对外承诺、证书、付费或平台账户操作时，再由项目负责人明确决定。
