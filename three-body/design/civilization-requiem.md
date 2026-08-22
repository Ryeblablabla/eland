# 文明结算与终章演出

## 边界

文明终章由“权威结算”和“非权威表达”两部分组成，二者不能互相代替：

```text
自然结局 ─┐
          ├─> civilization outcome / GameFrame.civilizationEnd
手动结算 ─┘                         │
                                     v
                           CivilizationRequiemFacts
                                     │
                       model poem ────┴──── local fallback
                                     │
                                     v
                          单轴诗幕 + 降低背景音乐
```

- `application/civilization-settlement.ts` 是手动结算用例。它只提交 `concluded` 结局与环境事实，不改变人物身体、不伪造死亡。
- 自然毁灭、观察边界、里程碑结束和手动结算都投影为 `GameFrame.civilizationEnd`，由 `ImmersiveGame` 进入同一个终章组件。
- `civilization-requiem-service.ts` 只读取已经提交的结局、人口、名字、里程碑和纪事；诗、标题与风格均是 projection-only，不能写回模拟状态。

## 诗风决策与事实约束

服务端只保留六种内置诗风：中文的四言重章、田园纪事、诗史长歌，以及海外的古代名录史诗、鲁拜短章、自由诗名录。目录作为封闭候选交给叙事模型，由模型根据文明时长、结局与真实历史选择 `styleId`。玩家不保存诗风偏好，也不向生成接口传递诗风。模型必须返回结构化的诗风、标题、摘要与诗行。

模型输出通过本地校验后才能演出：系统字段、系统词和没有事实来源的具体事物会使输出失效。模型不可用、超时或输出非法时，本地规则按结局类型和文明时长代选诗风，并生成只依赖权威事实的保底诗。失败不影响已经完成的文明结算。

终章以 `civilizationId + branchId + endedAtMonth` 为幂等键持久化。相同结局重复打开时直接读取已生成终章，不重新选择诗风；schema 升级时旧投影不会冒充当前版本。

## 演出

`CivilizationRequiem` 使用单轴诗幕：当前句位于视觉中心，上一句缩小后向上淡出，更早内容只保留极弱回声。全诗使用同一颜色与声部，不采用左右交替或双流排版。

终章不提供语音朗读，也不调用浏览器 TTS。原有环境音乐只降低音量，不被新音轨取代。用户可以暂停、跳至落款、重新播放、查看历史或观察下一文明；系统开启 reduced motion 时直接显示落款。
