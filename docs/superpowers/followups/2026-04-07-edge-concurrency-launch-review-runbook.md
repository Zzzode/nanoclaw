# Claw Framework Edge Concurrency Launch Review 手册

日期：2026-04-07
状态：执行版
适用对象：你本人 / 内部操作者
适用范围：只针对 terminal channel 的 edge-only 并发 launch review，不涉及 WhatsApp、Telegram、飞书等真实聊天平台

当前执行前提：

- 你当前没有 Claude 账号
- 你当前使用的是自配 `openai-compatible` provider
- 本轮执行档位固定为 `edge-only`
- 本轮目标不是验证 heavy/container，而是验证单条 prompt 是否能触发 edge agent team fanout
- 本轮目标同时覆盖“用户可见行为”和“框架内部观测”

当前代码状态（2026-04-07 更新）：

- [x] edge team prompt 已接入真实 fanout 编排，不再只是普通单轮文本回答
- [x] 同一轮会创建 root / 3 个 child / 1 个 aggregate 的真实 graph + executions
- [x] follow-up reminder 已支持同一条 prompt 中创建多条 once task
- [x] fanout child / aggregate 已强制使用专属 worker prompt，不再被 terminal chat history 覆盖
- [x] fanout 启动和汇总前会输出进度回执，避免 terminal 前台看起来“卡死”
- [x] fanout child / aggregate deadline 降为 90s，避免单个 edge worker 静默占满 5 分钟
- [x] 已通过 `src/team-orchestrator.test.ts`、`src/backends/edge-backend.test.ts`
- [ ] 仍需你按本手册再跑一轮 terminal dogfooding，确认真实 provider 下的前台体验和 observability

补充说明：

- 如果你当前要回答的问题是“能不能在 terminal 里直接看见多个 edge agents 并行运行”，优先执行 `2026-04-07-terminal-edge-team-observability-runbook.md`
- 本手册更偏完整 fanout 链路、历史问题记录与 sqlite/observability 复盘，不把 `/agents`、`/graph` 作为主验收面

---

## 1. 本次要验证的功能、目标与通过标准

本轮 launch review 只验证一个核心场景：

**在 terminal 中输入一条“创建 agent team 并行工作”的 prompt，系统能够在 edge 平面完成 fanout、并发执行、汇总、落 task，并且 observability 能解释这件事。**

### 1.1 验证项总表

- [ ] terminal channel 能启动并进入交互 shell
- [ ] team fanout prompt 能正常触发
- [ ] 前台输出能体现 team 分工
- [ ] 前台输出能体现最终汇总
- [ ] follow-up task 能成功创建
- [ ] `/tasks` 能看到新增 task
- [ ] observability 文件能读取
- [ ] 同一轮 graph 下存在多个 execution
- [ ] 多个 execution 走的是 `edge`
- [ ] 本轮没有命中 heavy/container fallback
- [ ] 本轮结果已记录

### 1.2 本轮目标

本轮目标只有三个：

1. 验证用户在 terminal 中能真实触发“agent team 并行工作”的体验
2. 验证 claw framework 是否能把该类团队任务留在 edge 平面执行
3. 验证你是否能通过 observability 文件解释 fanout、并发、汇总、落 task 的系统行为

### 1.3 本轮不验证的内容

- 多群放量
- 浏览器执行
- app 执行
- 复杂本地环境依赖
- heavy/container 主执行链路
- 生产级自动 replan 闭环

### 1.4 总通过标准

本轮通过必须同时满足：

- [ ] terminal 可以稳定启动
- [ ] team fanout prompt 有明确回复
- [ ] 回复中有清晰的 team 分工痕迹
- [ ] 回复中有统一汇总结果
- [ ] 至少创建 2 个 follow-up task
- [ ] `/tasks` 中能看到新增 task
- [ ] observability 文件可读取
- [ ] observability 中能看到同一轮 graph 下多个 execution
- [ ] 这些 execution 的 `backend` / `workerClass` 为 `edge`
- [ ] 没有 `fallbackTarget=heavy`
- [ ] 没有 `Edge execution exceeded deadline`
- [ ] 本轮结果已按模板记录

---

## 2. 主场景与固定提示词

### 2.1 本轮固定主场景

主题固定为：

**帮我规划下一轮 terminal-only claw framework launch review。**

原因：

- 不依赖外网
- 不依赖浏览器 / app / 本地重工具
- 贴近当前项目
- 适合拆成 3 个 edge agents 并行工作

### 2.2 本轮固定演示 prompt

在 terminal 中固定使用下面这条 prompt，不要临时改写：

```text
请创建一个 3-agent team，并行完成下一轮 terminal-only claw framework launch review 设计：1) 一个 agent 负责目标与验收标准，2) 一个 agent 负责风险与失败点，3) 一个 agent 负责执行步骤与结果记录模板。最后统一汇总成一个简明计划，并创建 2 个 follow-up task：一个 10 分钟后提醒我检查并发执行结果，一个 20 分钟后提醒我回顾风险项。
```

### 2.3 预期产品行为

如果系统行为正确，你应该看到：

- terminal 前台不是只回一段普通答案
- 回复里明显有 team 分工
- 回复里明显有统一汇总
- 回复末尾或中间出现 task 创建结果
- `/tasks` 中能看到 2 个新增 task

### 2.4 预期框架行为

如果框架行为正确，你应该能在 observability 里确认：

- 存在一个新的 root graph
- 该 graph 下不只有 1 个 execution
- 多个 execution 属于同一 graph
- 多个 execution 的 `backend=edge`
- 多个 execution 的 `workerClass=edge`
- 本轮没有 heavy fallback

---

## 3. 从启动到逐项验证的完整操作步骤

本节是执行步骤。
按顺序做，逐条打勾。
每一步都包含：

- 操作命令
- 观察结果
- 预期结果
- 不符合预期时的记录与修复建议

### 3.1 启动前准备

#### Task 1：进入项目目录

操作命令：

```bash
cd /Users/bytedance/Develop/OneCell/nanoclaw
pwd
```

观察结果：

- 当前目录应为 `/Users/bytedance/Develop/OneCell/nanoclaw`

预期结果：

- [x] 当前目录正确

不符合预期时记录：

- 实际目录：
- 问题描述：

修复建议：

- 重新执行 `cd /Users/bytedance/Develop/OneCell/nanoclaw`

#### Task 2：构建成功

操作命令：

```bash
npm run build
```

观察结果：

- TypeScript 编译成功
- `dist/index.js` 存在

预期结果：

- [x] `npm run build` 成功

不符合预期时记录：

- 错误输出：
- 失败阶段：

修复建议：

- 先修复编译错误，再继续 LR

#### Task 3：准备第二个观察窗口

操作命令：

```bash
cd /Users/bytedance/Develop/OneCell/nanoclaw
```

观察结果：

- 第二个 terminal 窗口准备好

预期结果：

- [x] 第二个观察窗口已准备好

不符合预期时记录：

- 问题描述：

修复建议：

- 重新打开一个 terminal 窗口

---

### 3.2 启动 terminal claw

#### Task 4：启动 edge-only terminal

操作命令：

```bash
TERMINAL_RESET_SESSION_ON_START=true npm run dogfood:terminal
```

观察结果：

- terminal shell 启动
- 出现 `you>` 提示符
- 进程不退出

预期结果：

- [x] terminal shell 已启动
- [x] 有可输入提示符
- [x] 进程保持运行

不符合预期时记录：

- 实际报错：
- 是否立即退出：是 / 否

修复建议：

- 启动失败时先停止 LR
- 回到 build / env / provider 配置排查

执行备注：

- 2026-04-07 16:11（Asia/Shanghai）启动成功
- 启动首屏已出现历史状态噪音：`tasks:0 running/1 scheduled`
- 该现象说明当前 `terminal_canary` 下存在历史遗留 execution / task 状态，但不阻塞本轮继续执行
- 2026-04-07 17:36（Asia/Shanghai）已补充干净会话启动开关：`TERMINAL_RESET_SESSION_ON_START=true`
- 已启动后如需手动切断上一轮 provider session，可在 terminal 输入 `/new`

#### Task 5：基础状态检查

在第一个 terminal 窗口输入：

```text
/status
```

观察结果：

- 能返回 `mode`、`provider`、`model`
- 能返回 `framework.graphs`、`framework.executions`

预期结果：

- [x] `/status` 正常

不符合预期时记录：

- 实际输出：

修复建议：

- 先修复 terminal 状态输出，再继续

执行备注：

- 2026-04-07 16:11（Asia/Shanghai）`/status` 返回正常
- 当前状态显示 `tasks:1 running/1 scheduled`
- `framework.graphs=44`、`framework.executions=46`
- 说明本轮开始前数据库中已存在历史执行记录；本轮 LR 后续判断必须以“新增 graph / 新增 execution”为准，不能直接用总量做通过判定

---

### 3.3 执行并发 edge agent team 场景

#### Task 6：发送固定 team fanout prompt

在第一个 terminal 窗口输入：

```text
请创建一个 3-agent team，并行完成下一轮 terminal-only claw framework launch review 设计：1) 一个 agent 负责目标与验收标准，2) 一个 agent 负责风险与失败点，3) 一个 agent 负责执行步骤与结果记录模板。最后统一汇总成一个简明计划，并创建 2 个 follow-up task：一个 10 分钟后提醒我检查并发执行结果，一个 20 分钟后提醒我回顾风险项。
```

观察结果：

- terminal 开始处理
- 最终出现一段完整回复

预期结果：

- [x] prompt 成功触发执行

不符合预期时记录：

- 实际输出：
- 是否空回复：
- 是否卡住：

修复建议：

- 如果空回复，先保留前台原文
- 如果卡住，补采日志与 observability 再排查

执行备注：

- 2026-04-07 16:14（Asia/Shanghai）prompt 已被执行，前台返回了完整文本
- 但 assistant 明确声明“我没有创建并行 agent 的能力”
- 这说明当前产品形态还没有把“创建 team 并行工作”映射为真实 fanout 执行能力
- 2026-04-07 17:04（Asia/Shanghai）第三轮复测已通过 fanout 触发
- 前台先输出：`已启动 3 个 edge agents 并行处理，正在等待汇总结果。`
- 之后输出统一汇总结果，说明 terminal 已具备真实 edge team fanout 主链路

#### Task 7：检查前台是否有 team 分工痕迹

观察点：

- 回复里是否明确出现 3 个角色 / 3 个分工
- 回复里是否能区分“目标/验收”、“风险”、“执行步骤/记录模板”

预期结果：

- [x] 前台输出包含 team 分工痕迹

失败判定：

- 只有一段普通回答，没有分工结构
- 看不出多个 agent 并行工作的痕迹

修复建议：

- 强化 planner/fanout prompt 模板
- 增加 team fanout 的显式输出格式约束

执行备注：

- 本轮未通过
- 前台明确表示“不具备创建并行 agent 的能力”
- 没有出现 3 个 agent 的真实分工结果，只给了替代方案说明
- 2026-04-07 17:05（Asia/Shanghai）第三轮复测通过
- 最终输出中明确包含三段分工结果：目标与验收标准 / 风险与失败点 / 执行步骤与记录模板
- 但内容质量仍需继续优化：存在泛化模板和虚构 `claw --version`、`claw doctor` 等命令，不够贴合 `nanoclaw` 真实能力

#### Task 8：检查前台是否有最终汇总

观察点：

- 回复末尾是否出现统一结论 / 合并后的简明计划

预期结果：

- [x] 前台输出包含统一汇总

失败判定：

- 只看到多个碎片结果，没有最终收敛

修复建议：

- 补 reducer / join 阶段的固定输出模板

执行备注：

- 本轮未通过
- 虽然前台有“简明计划总结”，但它不是建立在真实 team fanout 结果之上的汇总
- 因此不能算作本轮目标所需的 join / reduce 成功
- 2026-04-07 17:05（Asia/Shanghai）第三轮复测通过
- 前台在三个分工结果后输出 `简明计划`
- 当前 join/reduce 已由 coordinator 本地汇总完成，不再卡在最后一个 aggregate LLM 调用

#### Task 9：检查 follow-up task 是否创建成功

观察点：

- 回复中是否出现 2 个 task 创建结果
- 允许是 JSON 形式，也允许是自然语言形式

预期结果：

- [x] 至少 2 个 task 已创建

失败判定：

- 没有 taskId
- 只创建 1 个 task
- 报 `task.create` 不可用

修复建议：

- 排查 direct tool invocation
- 排查 `task.manage` capability

执行备注：

- 本轮未通过
- 前台明确报错：`follow-up tasks 创建失败（Invalid once timestamp 错误）`
- 说明当前相对时间解析至少对“20 分钟后”这一分支没有稳定打通
- 2026-04-07 17:07（Asia/Shanghai）第三轮复测通过
- `/tasks` 中已出现 2 个新增 active tasks：
- `task-1775552730749-vegai0`
- `task-1775552730751-ianyk1`
- `scheduleValue` 分别为 `2026-04-07T09:14:52.726Z` / `2026-04-07T09:24:52.726Z`

#### Task 10：用 `/tasks` 验证新增任务

在第一个 terminal 窗口输入：

```text
/tasks
```

观察结果：

- 能看到新增的 2 个 task
- `status` 应为 `active`

预期结果：

- [x] `/tasks` 能看到新增的 2 个 task

不符合预期时记录：

- 实际输出：

修复建议：

- 如果前台创建成功但 `/tasks` 没看到，先查数据库

执行备注：

- 本轮未通过
- `/tasks` 里没有出现本轮新增的 2 个 task
- 当前只看到历史遗留 task：`task-1775547962290-7yectu` 等
- 2026-04-07 17:07（Asia/Shanghai）第三轮复测通过
- `/tasks` 已看到本轮新增的 2 个 active tasks
- 仍存在历史遗留脏任务与 stale running task，需要后续清理，但不阻塞本轮 fanout 主链路验收

---

### 3.4 观测框架内部并发行为

#### Task 11：读取 observability 文件

在第二个 terminal 窗口执行：

```bash
ls data/ipc/terminal_canary
cat data/ipc/terminal_canary/framework_observability.json
```

观察结果：

- 文件存在
- 可读取 JSON

预期结果：

- [ ] observability 文件存在且可读取

不符合预期时记录：

- 文件是否存在：
- 实际报错：

修复建议：

- 回查 foreground snapshot 写出链路

执行备注：

- 已通过
- 文件可读取
- 但本轮必须结合数据库新增 graph / execution 来判断 fanout，而不能只看文件存在

#### Task 12：确认同一轮 graph 下有多个 execution

在第二个 terminal 窗口执行：

```bash
sqlite3 -header -column store/messages.db "select graph_id, request_kind, status, created_at from task_graphs order by created_at desc limit 10;"
sqlite3 -header -column store/messages.db "select task_id, graph_id, node_kind, worker_class, backend_id, status, created_at from task_nodes order by created_at desc limit 20;"
sqlite3 -header -column store/messages.db "select execution_id, turn_id, task_node_id, backend, status, created_at, finished_at from execution_state order by created_at desc limit 20;"
```

观察结果：

- 最新一轮 graph 应该对应多条 `task_nodes`
- 最新一轮 execution 应该对应同一 graph / 同一批 fanout child

预期结果：

- [x] 至少存在一个 graph 拥有多个 execution

失败判定：

- 所有 graph 都只有 1 个 execution

修复建议：

- 当前并没有真正 fanout
- 需要排查 team planner 是否只是单 agent 串行回答

执行备注：

- 本轮未通过
- 原始 SQL 写错了：`execution_state` 表中没有 `graph_id` 列，必须通过 `task_graphs` / `task_nodes` / `execution_state.task_node_id` 联合判断
- 实际检查结果显示：最新 graph `graph:turn_59816e26-15f1-4694-99d3-f9208d17548a` 只有一个 root node 和一个 edge execution
- 这说明本轮没有发生真实 fanout
- 2026-04-07 17:07（Asia/Shanghai）第三轮复测通过
- 最新 graph：`graph:turn_430e54ae-09b6-4523-bad5-5dfe4a0d25eb`
- 对应节点：`root + child-1 + child-2 + child-3 + aggregate`
- 对应 execution 共 5 条，证明同一轮 graph 下发生了真实 fanout

#### Task 13：确认这些 execution 走的是 edge

在第二个 terminal 窗口执行：

```bash
sqlite3 -header -column store/messages.db "select execution_id, task_node_id, backend, status, created_at from execution_state order by created_at desc limit 20;"
```

观察结果：

- 这些 execution 的 `backend` 应为 `edge`

预期结果：

- [x] fanout 出来的 execution 走的是 edge

失败判定：

- 出现 `container`
- 出现 heavy fallback

修复建议：

- 排查 capability 路由
- 排查 planner 是否错误声明了 heavy 能力

执行备注：

- 本轮不判定通过 / 失败为 fanout backend 检查失败，而是前置失败
- 原因：本轮根本没有形成 fanout child executions
- 但现有最新 execution 的确仍是 `edge`
- 2026-04-07 17:07（Asia/Shanghai）第三轮复测通过
- 最新 fanout graph 对应 execution 的 `backend` 全部为 `edge`
- 本轮观测到：
- `task:turn_430e54ae-09b6-4523-bad5-5dfe4a0d25eb:root`
- `task:turn_430e54ae-09b6-4523-bad5-5dfe4a0d25eb:child-1`
- `task:turn_430e54ae-09b6-4523-bad5-5dfe4a0d25eb:child-2`
- `task:turn_430e54ae-09b6-4523-bad5-5dfe4a0d25eb:child-3`
- `task:turn_430e54ae-09b6-4523-bad5-5dfe4a0d25eb:aggregate`

#### Task 14：确认没有 heavy fallback

在第二个 terminal 窗口执行：

```bash
cat data/ipc/terminal_canary/framework_observability.json | rg -n '"fallbackTarget":|"backend":|"workerClass":' -n
```

观察结果：

- 本轮相关记录中不应出现 `fallbackTarget: "heavy"`
- `workerClass` 应为 `edge`

预期结果：

- [ ] 本轮没有 heavy fallback

失败判定：

- 出现 `fallbackTarget=heavy`
- 出现 `workerClass=heavy`

修复建议：

- 说明该 team 场景超出当前 edge-only 能力边界

执行备注：

- 本轮通过
- 当前检查到的最新执行仍为 `edge`
- 没有看到本轮命中 heavy/container fallback

#### Task 15：确认没有明显超时或 stale 噪音

在第二个 terminal 窗口执行：

```bash
tail -n 80 groups/terminal_canary/logs/*.log 2>/dev/null
```

观察结果：

- 不应出现新的 `Edge execution exceeded deadline`
- 不应出现明显的 stale `running` 噪音和本轮结果矛盾

预期结果：

- [ ] 本轮没有明显超时或错误噪音

失败判定：

- 本轮出现 deadline exceeded
- 本轮前台成功，但后台状态明显未收敛

修复建议：

- 记录 executionId / graphId
- 下一轮优先修 stale execution 收敛逻辑

执行备注：

- 本轮存在产品级失败，但没有看到新的 `Edge execution exceeded deadline`
- 仍有历史 stale `running` execution 噪音，需要与本轮结果分离判断

---

## 4. 本轮必须收集的结果

本轮结束后必须记录以下内容：

### 4.1 前台原始输出

- team fanout prompt 的完整前台回复
- `/tasks` 的完整输出

### 4.2 观测文件原始输出

- `data/ipc/terminal_canary/framework_observability.json`

### 4.3 数据库查询结果

- `graph_id, count(*)`
- 最新 fanout graph 的 `execution_id, backend, status`

### 4.4 日志

- `groups/terminal_canary/logs/*.log` 中本轮相关输出

---

## 5. 结果记录模板

```text
本轮 LR 是否通过:

用户可见行为是否通过:
- 是否看到了 team 分工:
- 是否看到了最终汇总:
- 是否创建了 2 个 task:

框架内部行为是否通过:
- 是否存在 fanout graph:
- fanout graph 下 execution 数量:
- execution backend 是否全为 edge:
- 是否出现 heavy fallback:

本轮新增问题:
- 问题编号:
- 问题标题:
- 实际现象:
- 预期现象:
- 修复建议:

下一步动作:
```

---

## 5.1 本轮实际结论（2026-04-07 16:14 Asia/Shanghai）

```text
本轮 LR 是否通过: 未通过

用户可见行为是否通过:
- 是否看到了 team 分工: 否
- 是否看到了最终汇总: 否（只有替代性摘要，不是真实 team 汇总）
- 是否创建了 2 个 task: 否

框架内部行为是否通过:
- 是否存在 fanout graph: 否
- fanout graph 下 execution 数量: 0
- 最新本轮 graph execution 数量: 1
- execution backend 是否全为 edge: 是（但只有单 execution）
- 是否出现 heavy fallback: 否

核心失败点:
- 当前 assistant 明确声明“不具备创建并行 agent 的能力”
- 当前产品形态还没有把“创建 3-agent team”翻译为真实 task-graph fanout
- `task.create` 的相对时间解析对“20 分钟后”场景失败，报 `Invalid once timestamp`
- 文档原始 SQL 有误，`execution_state` 没有 `graph_id` 列，需改为通过 `task_graphs` / `task_nodes` / `execution_state.task_node_id` 联合观测

下一步动作:
- 先实现“team fanout prompt -> task graph fanout children”的真实编排能力
- 再修 `task.create` 相对时间解析，确保多条 follow-up task 稳定创建
- 最后回到本 runbook 做第二轮复测
```

---

## 5.2 第二轮实际结论（2026-04-07 16:40 Asia/Shanghai）

```text
本轮 LR 是否通过: 未通过

用户可见行为是否通过:
- 是否看到了 team 分工: 否
- 是否看到了最终汇总: 否
- 是否创建了 2 个 task: 否
- 实际现象: terminal 输入 team prompt 后长时间无前台输出，看起来像卡死

框架内部行为是否通过:
- 是否存在 fanout graph: 是
- fanout graph: graph:turn_e87bad33-c215-4876-bce5-90da2186770e
- fanout graph 下 execution 数量: 5（root + 3 children + aggregate）
- execution backend 是否全为 edge: 是
- 是否出现 heavy fallback: 否
- child-1 / child-2: completed
- child-3: failed，原因为 Edge execution exceeded deadline of 300000ms
- aggregate: running（在 child-3 走满 5 分钟后才启动）

核心失败点:
- fanout 已真实发生，但前台没有 coordinator progress 回执，所以用户感知是“卡死”
- edge backend 在 fanout child / aggregate 场景下仍优先读取 terminal chat history，导致 worker 专属 prompt 被原始 team prompt 覆盖
- child deadline 仍为默认 300000ms，单个 child 卡住会造成至少 5 分钟静默等待
- 上一轮错误创建的 once tasks 使用了过去时间（2025-01 / 2025-02），会在 terminal 中立即触发并插话，污染 launch review 观察

已完成修复:
- fanout child / aggregate 强制使用 input.prompt 作为本轮 recentMessages
- fanout 启动时输出“已启动 N 个 edge agents...”进度回执
- child 返回后输出“N/N 个 edge agents 已返回...”进度回执
- fanout child / aggregate deadline 降为 90000ms
- 新增回归测试覆盖 stale chat history 不再覆盖 fanout worker prompt

验证命令:
- npm run build
- npx vitest run src/team-orchestrator.test.ts src/backends/edge-backend.test.ts

下一步动作:
- 停掉当前卡住的 terminal 进程
- 重新执行 npm run build
- 先清掉历史脏任务，避免 scheduled task 插话
- 重新启动 terminal canary
- 使用同一条 team prompt 做第三轮复测
```

---

## 5.3 第三轮实际结论（2026-04-07 17:07 Asia/Shanghai）

```text
本轮 LR 是否通过: 部分通过

用户可见行为是否通过:
- 是否看到了 team 分工: 是
- 是否看到了最终汇总: 是
- 是否创建了 2 个 task: 是

框架内部行为是否通过:
- 是否存在 fanout graph: 是
- fanout graph: graph:turn_430e54ae-09b6-4523-bad5-5dfe4a0d25eb
- fanout graph 下 execution 数量: 5
- execution backend 是否全为 edge: 是
- 是否出现 heavy fallback: 否

仍未完全通过的原因:
- 内容质量未达标，worker 输出中仍有泛化模板和虚构命令（如 claw --version / claw doctor）
- terminal_canary 下仍有历史脏任务与 stale running task，状态栏噪音较大

结论:
- edge team fanout 编排链路已打通
- terminal-only 场景下并发 edge agent、汇总、follow-up task 创建均已工作
- 下一步重点从“链路打通”切换到“内容 grounding / 结果质量”
```

---

## 6. 本轮结论判定规则

### 判定为“通过”

同时满足以下条件：

- 前台有 team 分工
- 前台有最终汇总
- 成功创建 2 个 task
- `/tasks` 中可见新增 task
- observability / DB 能证明至少一个 graph 下有多个 execution
- 这些 execution 走的是 edge
- 没有 heavy fallback

### 判定为“部分通过”

满足以下任一情况：

- 前台表现正确，但 observability 不能证明 fanout
- observability 证明了 fanout，但前台缺少明显 team 分工
- task 只创建了 1 个

### 判定为“未通过”

满足以下任一情况：

- terminal 无法启动
- fanout prompt 无响应或卡死
- 没有 task 创建
- 没有 fanout graph
- fanout execution 命中 heavy/container

---

## 7. 本轮建议优先级

如果本轮通过，下一步优先做：

1. 把 `task.create` 回执从 JSON 提升为自然语言
2. 清理 stale `running` execution 观测噪音
3. 补一份“多轮 team fanout 压力 LR”

如果本轮未通过，下一步优先做：

1. 先修 fanout 是否真实发生
2. 再修 observability 是否能解释 fanout
3. 最后再优化用户可见输出文案
