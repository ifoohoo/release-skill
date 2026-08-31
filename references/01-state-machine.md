# 01 -- 状态机

本文档定义 release-skill 发布生命周期的全部状态、合法转换、禁止转换和异常处理规则。设计原则见 `00-target-state.md`。

---

## 1. 状态定义

发布生命周期包含 9 个主状态和 3 个异常状态，共计 12 个状态。

### 1.1 主状态

| 状态 | 含义 | 进入条件 |
|---|---|---|
| **DISCOVERED** | 系统首次识别到一个可发布项目 | 通过配置文件发现或用户指定项目根目录 |
| **ASSESSED** | 项目拓扑、配置、文档、供应链和发布流程已完成只读评估 | `assess` 命令成功退出 |
| **PREPARED** | 发布门全部通过，发布计划已冻结写入磁盘 | `prepare` 命令成功退出，所有门均通过，计划 schema 验证通过 |
| **APPROVED** | 人工审阅并批准了冻结的发布计划 | 批准记录绑定到发布计划 hash，且未过期 |
| **PUBLISHING** | 外部写操作正在按检查点依次执行 | `publish` 命令读取已批准计划并开始执行 |
| **PUBLISHED** | 所有发布检查点均已成功完成 | 最后一个检查点的 `observe` 验证通过 |
| **DISTRIBUTING** | 发布后分发正在执行：载荷物化、目标镜像推送与 distribute 阶段 postPublish hooks 按检查点依次进行 | 计划声明 `postPublish`（targets 或 hooks），`ship` 路由到 `distribute` 并通过全部安全门后开始执行 |
| **DISTRIBUTED** | 分发完成：全部目标与 distribute 阶段 hooks 成功（或远端已一致而幂等跳过） | `distribute` run 无失败且无待批准检查点 |
| **VERIFIED** | 发布后验证全部通过 | `verify` 命令在全新环境中完成安装、调用、泄漏审计和远端一致性校验 |

### 1.2 异常状态

| 状态 | 含义 | 进入条件 |
|---|---|---|
| **NEEDS_INPUT** | 缺少会改变发布结果的用户选择或授权 | 配置中存在歧义、版本来源未确定或需要额外授权 |
| **BLOCKED** | 认证、权限、验证门或外部服务阻止继续，且没有安全的本地替代路径 | 认证缺失（AUTH_MISSING）、远端服务不可达或权限不足 |
| **PARTIAL** | 至少一个外部检查点已经成功，但发布单元尚未全部完成 | `publish` 在中途失败且已有检查点成功 |

---

## 2. 合法转换

以下表格列出全部合法的状态转换。不在表中的转换均为禁止转换。

| 源状态 | 目标状态 | 触发条件 |
|---|---|---|
| DISCOVERED | ASSESSED | `assess` 成功完成 |
| DISCOVERED | NEEDS_INPUT | 发现歧义或缺失用户输入 |
| ASSESSED | PREPARED | `prepare` 所有门通过且计划冻结 |
| ASSESSED | NEEDS_INPUT | 评估发现需要用户输入 |
| ASSESSED | BLOCKED | 认证缺失或外部服务阻止 |
| PREPARED | APPROVED | 人工批准记录创建，且计划 digest（v2：产物+动作+版本+配置绑定层）、目标版本均未变化；tree hash/workspace digest 漂移在 v2 下仅记录证据、不使批准失效（v1 计划仍按旧规则失效） |
| PREPARED | NEEDS_INPUT | 计划需要补充信息 |
| APPROVED | PUBLISHING | `publish` 读取未过期批准并开始执行 |
| APPROVED | PREPARED | 批准过期或计划变更导致批准失效，回退到重新准备 |
| PUBLISHING | PUBLISHED | 所有检查点成功 |
| PUBLISHING | PARTIAL | 至少一个检查点成功但后续失败 |
| PUBLISHING | BLOCKED | 外部服务阻断且无法继续 |
| PUBLISHED | DISTRIBUTING | 计划声明 `postPublish`（targets 或 hooks），`ship` 路由到 `distribute` 开始执行 |
| PUBLISHED | VERIFIED | 无 `postPublish` 声明时，`verify` 的远端、npm、Claude/Codex 等自动化检查全部通过（Kimi/CodeBuddy 人工安装任务不由系统核验且不阻塞）；声明了 `postPublish` 时必须先经 DISTRIBUTING/DISTRIBUTED 门禁 |
| DISTRIBUTING | DISTRIBUTED | 全部目标与 distribute 阶段 hooks 成功（或远端已一致幂等跳过），且无待批准检查点 |
| DISTRIBUTING | PARTIAL | 至少一个外部 checkpoint 已成功后，目标/hooks 失败或存在待批准 checkpoint |
| DISTRIBUTING | NEEDS_INPUT | `requiresApproval` hook 缺少 checkpoint 级批准，且尚无任何外部副作用 |
| DISTRIBUTING | BLOCKED | 零外部写入落地且安全门或 hook 失败（失败关闭） |
| DISTRIBUTED | VERIFIED | `verify` 的 distribute 门禁通过：存在 DISTRIBUTED（或经 `blocksVerified:false` 合法豁免的 PARTIAL）分发 run，且安装/远端校验全部通过 |
| NEEDS_INPUT | DISTRIBUTING | checkpoint 批准补齐后重跑 `distribute` |
| PARTIAL | DISTRIBUTING | `distribute` 重跑即 reconcile：跳过已一致目标，仅重跑安全未完成项 |
| PUBLISHED | POST_PUBLISH_VERIFY_FAILED | 发布后验证失败（保留 PUBLISHED 事实但标记验证失败） |
| NEEDS_INPUT | DISCOVERED | 用户提供输入后重新开始评估 |
| NEEDS_INPUT | ASSESSED | 用户提供输入后恢复评估 |
| BLOCKED | ASSESSED | 阻断因素解除后重新评估 |
| BLOCKED | PUBLISHING | 阻断因素解除后从检查点恢复 |
| PARTIAL | PUBLISHING | `reconcile` 从记录的检查点恢复执行 |
| PARTIAL | VERIFIED | `reconcile` 补齐剩余步骤且 `verify` 通过 |
| VERIFIED | DISCOVERED | 新版本周期开始 |

### 2.1 自动转换规则

以下转换在条件满足时自动触发，无需人工干预：

- APPROVED -> PREPARED：当批准记录的计划 hash 与当前冻结计划不匹配时，批准自动失效。
- APPROVED -> PREPARED：当 plan digest、目标版本或已批准 action 列表变化时，批准自动失效。planVersion 2 计划的 digest 只绑定信任边界（冻结产物身份、动作列表、目标版本、配置摘要），工作区基线（Git tree hash、workspace digest）是记录层审计数据，不使批准失效；planVersion 1（旧版）计划维持旧规则，Git tree hash 与 workspace digest 变化同样使批准失效。
- PUBLISHING -> PARTIAL：当任一检查点成功后下一检查点失败时，自动计算 PARTIAL 状态。

### 2.2 分发阶段与 postVerify 阶段（v0.6.3）

postPublish hooks 分两个阶段，各自对应独立的 distribute run：

- **distribute 阶段**（默认 `phase: distribute`）：在 DISTRIBUTING 中执行，载荷只能来自冻结 tagCommit 的 detached worktree（时序契约）。全部目标与 distribute 阶段 hooks 成功后进入 DISTRIBUTED；`verify` 在到达 VERIFIED 前检查 distribute 门禁——存在未 SUCCEEDED 且未经 `blocksVerified: false` 合法豁免的 hook 时不得 VERIFIED。NEEDS_INPUT/BLOCKED 不得静默转 VERIFIED（承袭治理规则）。
- **postVerify 阶段**（`phase: postVerify`）：主 run VERIFIED 后由 ship/verify 路由触发，产出独立的 distribute run（复用现有 run 记录与 checkpoint 机制）；失败即该 run PARTIAL、reconcile 可续。主 run 的 VERIFIED 不回退，但 postVerify run 的失败必须以证据显著记录，绝不静默。
- **checkpoint 级批准**：`requiresApproval: true` 的 hook 执行前需要绑定 `(planDigest, hookId)` 的独立批准记录（24h 过期、5 分钟时钟偏移容忍）。批准未获时：尚无外部 checkpoint 成功 → checkpoint 标记 `AWAITING_APPROVAL`、run 进 NEEDS_INPUT；已有外部 checkpoint 成功 → run 保持 PARTIAL。

---

## 3. 禁止转换

以下转换在任何条件下均不允许：

| 禁止转换 | 原因 |
|---|---|
| DISCOVERED -> PREPARED | 必须先完成评估 |
| DISCOVERED -> APPROVED | 必须先评估再准备再批准 |
| DISCOVERED -> PUBLISHING | 未评估未准备不能发布 |
| ASSESSED -> APPROVED | 必须先通过 prepare 生成冻结计划 |
| ASSESSED -> PUBLISHING | 必须先准备并获得批准 |
| PREPARED -> PUBLISHING | 未获批准不能发布 |
| PREPARED -> VERIFIED | 不能跳过发布直接验证 |
| APPROVED -> VERIFIED | 不能跳过发布直接验证 |
| APPROVED -> PUBLISHED | 不能跳过发布执行直接到已发布 |
| PUBLISHING -> VERIFIED | 发布完成后必须先到 PUBLISHED |
| DISTRIBUTING -> VERIFIED | 分发必须先达 DISTRIBUTED 再经 verify distribute 门禁 |
| DISTRIBUTING -> APPROVED | 分发进行中不能回退到批准 |
| PUBLISHING -> APPROVED | 发布进行中不能回退到批准 |
| PUBLISHING -> PREPARED | 发布进行中不能回退到准备 |
| PUBLISHED -> PUBLISHING | 已发布的不能重新发布同一计划 |
| PUBLISHED -> APPROVED | 不能从已发布回退到批准 |
| VERIFIED -> PUBLISHING | 已验证的不能重新发布 |
| VERIFIED -> PUBLISHED | 已验证的不能回退到已发布 |
| NEEDS_INPUT -> PUBLISHING | 缺少输入不能发布 |
| BLOCKED -> PUBLISHING（非恢复路径） | 阻断状态只能通过 `reconcile` 恢复 |
| PARTIAL -> VERIFIED（非 reconcile 路径） | 部分成功必须经过 `reconcile` 补齐 |

---

## 4. 异常处理

### 4.1 NEEDS_INPUT 处理

- 系统必须明确列出缺失的输入项、影响范围和可选方案。
- NEEDS_INPUT 不能被静默转换为 VERIFIED。
- 用户提供输入后，系统从 DISCOVERED 或 ASSESSED 重新开始。

### 4.2 BLOCKED 处理

- 系统必须记录阻断原因、相关错误码（见 `05-evidence-and-errors.md`）和建议的解除方式。
- BLOCKED 不能被静默转换为 VERIFIED。
- 阻断因素解除后，系统从 ASSESSED 重新评估或从 PUBLISHING 恢复。

### 4.3 PARTIAL 处理

- 系统必须保留至少一个已成功的外部检查点记录，不得丢失。
- PARTIAL 状态在任何后续操作前必须被显式处理。
- 恢复路径通过 `reconcile` 命令执行：查询远端实际状态，跳过已一致的步骤，仅重试安全且未完成的步骤。
- 系统不得自动删除远端 tag、覆盖 GitHub Release、unpublish npm 包或从头重跑。
- 远端状态与冻结计划不一致时（REMOTE_CONFLICT），停止并要求人工决策。

### 4.4 批准失效

批准记录绑定到发布计划 hash。以下任何变化均导致批准自动失效：

- 发布计划绑定层内容变化（plan digest 不匹配）。planVersion 2 的 digest 只绑定信任边界：冻结产物身份（git commit/tree、manifestDigest、npm tarball 摘要）、外部动作列表（不含运行时 status）、目标版本、配置摘要、校验门。
- 目标版本变化。
- 已批准的 action 列表变化。

工作区基线（Git tree hash、workspace digest、捕获时间）与生命周期状态（计划 status、createdAt、action 运行时 status）是**记录层审计数据**：继续写入计划与审批文件以备查，但不参与 planVersion 2 的 digest、不使批准失效。publish/reconcile 检测到基线漂移时记录 warning 级证据事件并继续执行，产物完整性由发布前的冻结产物重验兜底。planVersion 1（旧版）计划维持旧规则：Git tree hash 与 workspace digest 变化同样使批准失效，基线漂移硬失败（BASELINE_CHANGED）。

远端冲突状态不在 approval 绑定字段中。远端对象已存在但与冻结计划完全一致时，`publish`/`reconcile` 把对应检查点标为 `SKIPPED`；存在且不一致，或无法可靠判断时，preflight 阶段阻断执行并要求人工决策。npm 版本只有在观察到有效且与冻结计划相同的 integrity 时才能进入 `SKIPPED`；integrity 缺失、空白、无法解析或不同都在任何 Adapter execute 前失败关闭。

失效后系统回退到 PREPARED 状态，要求重新批准。

### 4.5 路由诊断与当前恢复

`route` 负责选择 workflow 和展示 diagnostics，不承担发布授权。传入
`--target-version <ver>` 时，只有既有校验器确认 `release-run.json`、绑定 plan、摘要
身份和 lineage 完整，且计划目标等于该版本、仍有未完成动作的记录，才可生成
`reconcile`、`distribute` 或 `verify` 建议。目录名、mtime、producer 版本、`summary.json`、
错误文案和旧阶段名只能进入 diagnostics。

未传 target 时，route 始终依据当前 diff/baseline 选择 workflow。历史 `PARTIAL`、
`DIAGNOSE` 或损坏记录保持可见，但不能把 workflow 改成恢复阶段或诊断入口。多个当前
有效候选必须保留候选列表并要求明确选择，不生成猜测命令。

这些路由规则不改变状态机的发布门。`publish`、`reconcile` 和 `verify` 仍必须校验
plan、approval、冻结制品身份、远端状态、检查点和 `PARTIAL` 血缘。

### 4.6 发布检查点失败

发布按以下检查点顺序执行（详见 `06-adapter-contract.md`）：

1. 推送父工程版本提交（若配置管理该步骤）。
2. 更新并推送公开子仓库快照。
3. 创建并推送签名或可追溯 tag。
4. 发布 npm 包。
5. 创建 GitHub Release。
6. 写入远端 URL、commit、tag、包版本、integrity 和执行结果。若 npm 检查点因执行前观察结果为 `CONSISTENT` 而跳过，只把本次观察到的 integrity 保存到检查点的 `remoteRef.integrity`；包名、版本、registry、预期 integrity 和 tarball 摘要继续以冻结计划为准。

任一步失败都停止后续动作，保存检查点并进入 PARTIAL。已完成的检查点通过 `observe` 验证后在 `reconcile` 中幂等跳过。

---

## 5. 跨标准引用

- 配置中的状态声明和 hook 参数约束见 `02-project-config.md`。
- 错误码与证据格式见 `05-evidence-and-errors.md`。
- Adapter 的 preflight/execute/observe/verify 接口和授权门见 `06-adapter-contract.md`。
- 发布计划冻结和批准界面内容要求见本文档第 4.4 节和 `06-adapter-contract.md` 第 3 节。
