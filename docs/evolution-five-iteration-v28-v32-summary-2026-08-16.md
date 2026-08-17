# 历史推演双演进五轮总结：v28—v32

状态：五轮已完成；示范可达，完整模仿学习链尚未闭合。

## 固定实验合同

- 直接配对 seeds：`185 / 20260815 / 20260816`
- 快跑：每轮 `3×10y`、`chaosIntensity=0`、规则规划器、模型 token 为 0
- 只有预登记快跑门槛通过才扩展 `3×30y`；本轮序列均未满足各自的长跑门槛
- 文明指数公式均为 `causal-diversity-v3`，因果观察器均为 `causal-person-month-v21`
- 结论来自多种子配对历史、事实级回放和定向守卫；不从单次 run 推断整体成败

## 五轮结果

| 轮次 | 最小机制变化 | 10 年事实 | 决定 |
| --- | --- | --- | --- |
| v28 | 项目需求触发技术请求，可靠持有人必须实体示范，学习者必须本人模仿 | 请求 `2/1/21`；示范 0；模仿 0；生产 `2/7/2` | 请求可达；整包拒绝。单一首位近身受众漏掉真实持有人 |
| v29 | 请求广播给全部同地未询问者 | 请求 `5/4/0`；示范 0；生产 `0/1/4` | 广播语义保留；整包拒绝。受众集合进入 option ID，造成无关确定性分叉 |
| v30 | option ID 锚定稳定主受众，action audience 仍覆盖全部到达者 | 与 v29 逐种子所有指标一致；请求 `5/4/0` | 稳定身份基础设施接受；下一断点是可靠持有人不在同一体素 |
| v31 | 请求扩到学习者可见范围；教师在该范围内用本人物质现场示范 | 请求 `15/11/11`；seed 20260816 示范 1；模仿 0；生产 `0/1/3` | 可见请求和真实示范接受；整包修订。示范后回退普通路径并旁路可靠化 1 次 |
| v32 | pending demonstration basis 在项目内阻断 fallback，并只补示范技术的精确缺料 | 与 v31 逐种子全部指标 `Δ=0`；示范 `0/0/1`；模仿 0；完整链 0 | 定向机制暂存；自然历史候选拒绝。全局旧技术复现 intent 先于项目承诺抢占规划 |

## 留下的可复用机制

1. 请求的稳定语义身份与真实多受众到达分离。
2. 技术请求和示范都受学习者感知范围、真实人物、真实材料、真实操作和真实 response 约束。
3. 示范只形成带 request/demo/exact-source 的暂定 basis，不直接可靠化。
4. 项目编译器识别 pending basis 后，不再回退无关 hypothesis，并能把缺料收敛到示范技术的精确数量。
5. 观察器能审计 request→demonstration→imitation→reliable→project progress/completion 的每一段，并区分旁路可靠化。

## 当前最早断点

seed 20260816 的代表链在第 59 月形成生火示范，但下一 planning tick 选择的是无 projectId 的普通长矛复现 intent。它不是示范所需 Fiber 物流，也不是生火 imitation；因此 v32 的项目内承诺逻辑从未执行。下一轮只需检验一个假设：当人物拥有 pending demonstration basis 时，规划器应暂时抑制未绑定该 basis 的普通可靠技术复现，或让 project-bound imitation commitment 明确优先；如果历史仍无 imitation，断点再下移到精确材料取得或合法 target。

## 证据索引

- v28：`three-body/data/experiments/candidate-demand-bound-demonstration-v28-quick.json`
- v29：`three-body/data/experiments/candidate-local-technique-request-broadcast-v29-quick-reprojected.json`
- v30：`three-body/data/experiments/candidate-stable-technique-request-identity-v30-quick-reprojected.json`
- v31：`three-body/data/experiments/candidate-visible-technique-demonstration-v31-quick.json`
- v32：`three-body/data/experiments/candidate-demonstration-imitation-commitment-v32-quick.json`
- 最终配对比较：`three-body/data/experiments/compare-v31-v32-imitation-commitment-quick.txt`
