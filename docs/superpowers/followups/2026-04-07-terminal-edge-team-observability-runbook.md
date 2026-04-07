# Terminal Edge Team Observability Launch Review 手册

日期：2026-04-07
状态：执行版
适用对象：你本人 / 内部操作者
适用范围：只针对 terminal channel 的 edge-only team observability launch review，不涉及 WhatsApp、Telegram、飞书等真实聊天平台

当前执行前提：

- 你当前没有 Claude 账号
- 你当前使用的是自配 `openai-compatible` provider
- 本轮执行档位固定为 `edge-only`
- 本轮目标不是验证 heavy/container，而是验证 terminal 内能否直接观测多个 edge agents 并行运行
- 本轮把 `/agents` 与 `/graph` 作为硬验收面

---

## 1. 本次要验证的功能、目标与通过标准

本轮 launch review 只验证一个核心场景：

**在 terminal 中输入一条固定的 `3-agent team` LR prompt，系统能够在 edge 平面完成 fanout，并且操作者能在 terminal 前台、`/agents`、`/graph` 三个面上直接看见这个并行过程。**

### 1.1 验证项总表

- [ ] terminal channel 能启动并进入交互 shell
- [ ] 固定 team fanout prompt 能正常触发
- [ ] 前台能先显示 fanout 启动回执
- [ ] `/agents` 能显示多个 worker
- [ ] `/graph` 能显示 root / child / aggregate
- [ ] 最终输出能显示 team 分工与统一汇总
- [ ] 当前 run 停留在 `edge`
- [ ] 本轮结果已记录

### 1.2 本轮目标

本轮目标只有三个：

1. 验证 terminal 中存在真实可观测的 edge team fanout 体验
2. 验证操作者不离开 terminal 也能判断“多个 edge agent 正在并行运行”
3. 验证该体验不依赖 heavy/container fallback

### 1.3 本轮不验证的内容

- 通用 terminal 健康检查之外的轻量问答质量
- heavy/container 主执行链路
- replan / commit conflict 闭环
- WhatsApp、Telegram、飞书等真实渠道
- 大规模 swarm / 多群放量
- 浏览器执行 / app 执行

### 1.4 总通过标准

本轮通过必须同时满足：

- [ ] 固定 `3-agent team` prompt 有明确启动回执
- [ ] `/agents` 中至少能看到 2 个 worker 条目
- [ ] `/graph` 中能看到 `fanout_child` 与 `aggregate`
- [ ] `/agents` 或 `/graph` 展示的 backend 为 `edge`
- [ ] 最终 assistant 输出包含分工结果与统一汇总
- [ ] 本轮不依赖 heavy/container fallback

软检查但不作为硬阻塞：

- [ ] worker 级 system event 是否逐条都可见
- [ ] 本轮是否顺带创建 follow-up tasks
- [ ] 是否额外用 sqlite 验证同一 graph 的 execution 明细

---

## 2. 固定场景与固定提示词

### 2.1 固定场景

主题固定为：

**帮我规划下一轮 terminal-only claw framework launch review。**

原因：

- 不依赖外网
- 不依赖浏览器 / app / 本地重工具
- 贴近当前项目
- 天然适合拆成 3 个 edge workers

### 2.2 固定提示词

在 terminal 中固定使用下面这条 prompt，不要临时改写：

```text
请创建一个 3-agent team，并行完成下一轮 terminal-only claw framework launch review 设计：1) 一个 agent 负责目标与验收标准，2) 一个 agent 负责风险与失败点，3) 一个 agent 负责执行步骤与结果记录模板。最后统一汇总成一个简明计划。
```

说明：

- 本 runbook 主目标是 team observability，因此默认不把 follow-up task 创建放进硬通过标准
- 如果你想顺带覆盖 task.create，可以在本轮通过后再追加一轮带 follow-up task 的 prompt

---

## 3. 执行步骤

### 3.1 启动前准备

#### Task 1：进入项目目录

操作命令：

```bash
cd /Users/bytedance/Develop/OneCell/nanoclaw
pwd
```

预期结果：

- [ ] 当前目录为 `/Users/bytedance/Develop/OneCell/nanoclaw`

#### Task 2：构建成功

操作命令：

```bash
npm run build
```

预期结果：

- [ ] `npm run build` 成功

#### Task 3：准备第二个观察窗口

操作命令：

```bash
cd /Users/bytedance/Develop/OneCell/nanoclaw
```

预期结果：

- [ ] 第二个 terminal 窗口已准备好

---

### 3.2 启动 terminal claw

#### Task 4：启动 edge-only terminal

操作命令：

```bash
TERMINAL_RESET_SESSION_ON_START=true npm run dogfood:terminal
```

预期结果：

- [ ] terminal shell 已启动
- [ ] 出现 `you>` 提示符
- [ ] 进程保持运行

不符合预期时修复建议：

- 启动失败时先停止本轮 LR
- 回到 build / env / provider 配置排查
- 如果怀疑 provider session 污染，启动后先执行 `/new`

#### Task 5：基础状态检查

在第一个 terminal 窗口输入：

```text
/status
```

预期结果：

- [ ] `/status` 返回正常
- [ ] 输出中包含 `mode`、`provider`、`model`
- [ ] 输出中包含 `framework.graphs`、`framework.executions`

说明：

- 本轮后续判断必须以“新出现的 team graph / worker 状态”为准，不要直接拿历史总量做通过判定

---

### 3.3 触发 team fanout 并进行 terminal 内观测

#### Task 6：发送固定 team fanout prompt

在第一个 terminal 窗口输入：

```text
请创建一个 3-agent team，并行完成下一轮 terminal-only claw framework launch review 设计：1) 一个 agent 负责目标与验收标准，2) 一个 agent 负责风险与失败点，3) 一个 agent 负责执行步骤与结果记录模板。最后统一汇总成一个简明计划。
```

预期结果：

- [ ] prompt 成功触发执行
- [ ] 前台先出现 fanout 启动回执

硬判定：

- 前台必须先出现类似 `已启动 3 个 edge agents 并行处理，正在等待汇总结果。`
- 如果直接只给一段普通答案，本轮判定为未触发真实 team fanout

#### Task 7：在执行进行中查看 `/agents`

在看到启动回执后，尽快在第一个 terminal 窗口输入：

```text
/agents
```

预期结果：

- [ ] 返回当前 team graph 的 agent 视图
- [ ] 至少能看到 2 个 worker 条目
- [ ] 条目中包含 `status`、`health`、`backend`
- [ ] backend 为 `edge`

通过标准：

- 返回里应能看到 `graphId`
- 应能看到 `agent: worker 1`、`agent: worker 2`，最好还能看到 `agent: worker 3` 或 `agent: aggregate`
- 如果只看到“当前没有可观察的 edge team graph”，本轮判定为 terminal observability 不通过

#### Task 8：在执行进行中或刚完成时查看 `/graph`

在第一个 terminal 窗口输入：

```text
/graph
```

预期结果：

- [ ] 返回当前 team graph 明细
- [ ] 能看到 `root`、`fanout_child`、`aggregate` 结构
- [ ] 能看到 `routeReason`
- [ ] 能看到 node 级 `executionStatus`

通过标准：

- 输出中应出现 `graphId`
- 输出中应出现 `nodeKind: fanout_child`
- 输出中应出现 `nodeKind: aggregate`
- 输出中应出现 `routeReason: edge.team_fanout` 或 `routeReason: edge.team_aggregate`

如果 `/graph` 只能看到普通单轮 graph，本轮判定为 team structure 不可观测。

---

### 3.4 最终输出验收

#### Task 9：检查最终 assistant 输出

观察点：

- 最终输出是否包含三个分工部分
- 最终输出是否包含一个统一汇总

预期结果：

- [ ] 最终输出包含分工结果
- [ ] 最终输出包含统一汇总

通过标准：

- 能区分“目标与验收标准 / 风险与失败点 / 执行步骤与结果记录模板”
- 在这些分工结果之后，存在统一的计划或总结段落

失败判定：

- 只有一段普通回答，看不出 team 分工
- 有分工但没有统一汇总
- 最终答案依赖 heavy/container fallback 才成功

---

### 3.5 可选辅助校验

本节只做辅助确认，不作为本轮硬通过前提。

#### Task 10：读取 observability 文件

在第二个 terminal 窗口执行：

```bash
ls data/ipc/terminal_canary
cat data/ipc/terminal_canary/framework_observability.json
```

观察点：

- 文件存在且可读取
- 可辅助确认本轮 graph / execution 新增

#### Task 11：按需读取 sqlite 明细

在第二个 terminal 窗口执行：

```bash
sqlite3 -header -column store/messages.db "select graph_id, request_kind, status, created_at from task_graphs order by created_at desc limit 10;"
sqlite3 -header -column store/messages.db "select task_id, graph_id, node_kind, worker_class, backend_id, status, created_at from task_nodes order by created_at desc limit 20;"
sqlite3 -header -column store/messages.db "select execution_id, turn_id, task_node_id, backend, status, created_at, finished_at from execution_state order by created_at desc limit 20;"
```

观察点：

- 最新一轮 graph 对应多条 child / aggregate nodes
- execution 记录对应多个 edge task nodes

说明：

- 这些检查是辅助证据
- 本 runbook 的主目标仍然是 terminal 内可观测，而不是数据库取证

---

## 4. 失败分类

### 4.1 No Fanout Trigger

现象：

- 固定 prompt 被当成普通单轮回答处理

含义：

- team capability 没有暴露给当前产品路径

### 4.2 Fanout Exists But Terminal Cannot Show It

现象：

- 后台可能有多 execution，但 `/agents` 或 `/graph` 看不出来

含义：

- 编排存在，但 terminal 产品面太黑箱

### 4.3 Terminal Can Show Fanout But Final Output Is Weak

现象：

- `/agents`、`/graph` 都能看到 team fanout
- 但最终输出没有清晰分工或没有统一汇总

含义：

- runtime observability 已具备
- 最终产品输出还不够稳定

### 4.4 Run Falls Out Of Edge

现象：

- 成功结果依赖 heavy/container fallback

含义：

- 不能算 terminal-visible edge team 能力通过

---

## 5. 本轮结果模板

### 5.1 结果总表

- 日期：
- 执行人：
- 分支/版本：
- provider：`openai-compatible`
- 启动命令：`TERMINAL_RESET_SESSION_ON_START=true npm run dogfood:terminal`
- 固定 prompt 是否触发 fanout：是 / 否
- `/agents` 是否看见多个 worker：是 / 否
- `/graph` 是否看见 child + aggregate：是 / 否
- 最终输出是否有分工 + 汇总：是 / 否
- 是否命中 heavy/container fallback：是 / 否
- 本轮结论：通过 / 不通过

### 5.2 问题记录模板

```text
问题编号:
发生步骤:
问题标题:
实际现象:
预期现象:
是否阻塞: 是 / 否
初步归因:
修复建议:
是否已修复: 是 / 否
备注:
```

---

## 6. 与现有文档的关系

- 如果你要验证 terminal 基础健康检查，仍然看 `2026-04-07-claw-framework-dogfooding-runbook.md`
- 如果你要回看 edge fanout 的更完整实现背景、历史问题与 sqlite 级复盘，仍然看 `2026-04-07-edge-concurrency-launch-review-runbook.md`
- 如果你要回答“我能不能在 terminal 里直接看见多个 edge agents 并行运行”，优先执行本手册
