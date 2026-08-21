# 06 -- Adapter 契约

本文档定义 release-skill adapter 的接口规范、外部写授权门和幂等重试机制。状态机见 `01-state-machine.md`，安全要求见 `04-supply-chain.md`，错误码见 `05-evidence-and-errors.md`。

---

## 1. Adapter 接口

每个 adapter 必须实现以下四个方法。所有 adapter 遵循同一接口契约，由 adapter registry 统一调度。

### 1.1 preflight(action, context)

- **职责**：在执行外部写操作前检查远端状态，确认操作可安全执行。
- **时机**：在 `publish` 命令执行每个检查点之前调用。
- **输入**：`action` 描述待执行的外部操作，`context` 包含冻结计划、批准记录和授权标志。
- **输出**：结构化观察结果，包含远端当前状态和是否可安全执行。
- **失败处理**：preflight 失败时不执行后续操作，返回 `REMOTE_CONFLICT` 或 `AUTH_MISSING`。

### 1.2 execute(action, context)

- **职责**：执行外部写操作。
- **前置条件**：`context.externalWritesAuthorized === true`，即批准记录有效且未过期。
- **输入**：`action` 描述待执行的外部操作，`context` 包含冻结计划和授权信息。
- **输出**：结构化执行结果，包含远端资源标识（commit hash、tag、包版本等）。
- **安全约束**：若授权标志为 false，execute 必须拒绝执行并返回 `AUTH_MISSING`。

### 1.3 observe(action, context)

- **职责**：查询远端实际状态，与冻结计划对比。
- **时机**：在 `reconcile` 和 `verify` 阶段调用，也用于 `execute` 后的即时验证。
- **输入**：`action` 描述已计划的外部操作，`context` 包含冻结计划。
- **输出**：远端实际状态和与计划的一致性判断。
- **一致性判断**：
  - `CONSISTENT`：远端状态与计划完全匹配。
  - `MISSING`：远端资源尚未创建。
  - `CONFLICTING`：远端资源存在但与计划不匹配。

- **调用方退避策略（重要）**：`observe` 是只读查询，其契约状态只有
  上面三种（`CONSISTENT` / `MISSING` / `CONFLICTING`）。`PROPAGATING`
  （“写入已发生但远端尚不可见”的暂态）**不是 adapter 契约状态**，
  而是调用方在 `observe` 之外的内部分类，由
  `src/core/observe-retry.mjs` 的 `observeWithRetry` 统一实现：
  - 当 `observe` 抛错、返回空观察、或显式缺失（`exists:false` 等）
    时，调用方视为“信息不足”，按固定退避策略（`maxAttempts:5`、
    `delaysMs:[10_000,20_000,40_000,80_000]`，总窗口约 150s）重试只读
    `observe`，以消化最终一致性传播延迟（如 `npm publish` 成功后
    `npm view` 暂查不到新版本）。
  - 一旦 `observe` 读到**具体且非空**的远端对象，立即停（无论是否匹配）：
    匹配则 `CONSISTENT`，不匹配则 `CONFLICTING`——**绝不对
    `CONFLICTING` 重试**，因为它已是权威冲突，必须失败关闭交人决策。
  - 重试耗尽仍缺失，按现状语义判 `FAILED`/`UNCERTAIN`，终态不变。
  - `preflight`（资源是否被占用）不存在传播暂态，保持单次调用，不接入
    退避。
  - 退避策略常量集中在 `observe-retry.mjs`，不进冻结计划 schema、不做用户配置，
    因此改变退避参数不会使已批准发布的摘要失效。
  - 测试逃生口：环境变量 `RELEASE_SKILL_OBSERVE_RETRY_NO_WAIT=1` 仅使
    重试间隔立即返回（跳过挂钟等待），供 spawn 真实 CLI 子进程的测试沙箱
    使用；尝试次数、顺序与 PROPAGATING/CONFLICTING 分类完全不变，
    因此它不可能弱化任何失败关闭决策。进程内测试应优先使用
    `observeRetrySleep` 依赖注入而非该环境变量。

### 1.4 verify(action, context)

- **职责**：对外部写操作的结果进行深度验证。
- **时机**：在 `verify` 阶段调用。
- **输入**：`action` 描述已执行的外部操作，`context` 包含冻结计划和执行记录。
- **输出**：验证结果，包括 integrity、provenance、签名状态等。
- **验证范围**：
  - Git tag 指向正确的 commit。
  - GitHub Release 内容与计划一致。
  - npm 包的 integrity 和 provenance 有效。
  - 插件清单可被 marketplace 发现。
  - 公开仓库通过泄漏审计。

---

## 2. 标准 Adapter 列表

### 2.1 Git/GitHub Adapter

| 操作 | 方法 | 说明 |
|---|---|---|
| 推送版本提交 | execute | 推送已批准的父工程版本提交 |
| 推送子仓库快照 | execute | 更新并推送公开子仓库快照 |
| 创建签名 tag | execute | 创建并推送签名或可追溯 tag |
| 创建 GitHub Release | execute | 基于冻结计划创建 Release |
| 查询 tag 状态 | observe | 检查 tag 是否存在及指向 |
| 查询 Release 状态 | observe | 检查 Release 是否存在及内容 |
| 验证 tag 指向 | verify | 确认 tag 指向正确的 commit |

工具：`git` CLI 和 `gh` CLI，使用 `execFile` 参数数组调用。

### 2.4.1 Distribute Adapter（postPublish）

| 操作 | 方法 | 说明 | 幂等规则 |
|---|---|---|---|
| 预检远端分支 | preflight | 检查 branch 存在性、协议合法性 | 禁止 SSH URL，必须 file:// 或 https:// |
| 克隆→wipe→write→commit | execute | 写入 payload，创建 bot identity 提交 + tag | NO_CHANGE 若 tree 相同；REMOTE_CONFLICT 若 tag move |
| 观察远端 refs | observe | 检查 branch tip 与 tag OID 一致性 | CONSISTENT / MISSING / CONFLICTING |
| 验证 content diff | verify | 二次 fetch 确认 payload 字节一致 | VERIFIED / FAILED |

**never-force rule**: distribute adapter **永远不使用 force push**。即使是在追加模式，也仅允许普通快进；tag 移动视为冲突，要求人工决策。

工具：`git` CLI via `distribute-git.mjs` adapter，参数数组调用。

### 2.2 npm Adapter

| 操作 | 方法 | 说明 |
|---|---|---|
| 发布 npm 包 | execute | 使用 `npm publish --provenance --access public` |
| 查询版本状态 | observe | 使用 `npm view` 检查版本是否存在 |
| 验证 integrity | verify | 验证包的 integrity hash 和 provenance 状态 |

工具：`npm` CLI，使用 `execFile` 参数数组调用。

### 2.3 插件 Marketplace Adapter

| 操作 | 方法 | 说明 |
|---|---|---|
| 注册插件 | execute | 在 marketplace 注册插件清单 |
| 查询插件状态 | observe | 检查插件是否可被发现 |
| 验证安装性 | verify | 在全新环境中安装并验证插件可调用 |

支持目标：Claude Code plugin marketplace、Codex plugin manifest/marketplace、Kimi Code（发布后人工安装任务）、CodeBuddy/WorkBuddy（发布后人工安装任务）。

**Kimi/CodeBuddy/WorkBuddy 接入形态（非阻塞人工跟进）**：目录名 `workbuddy` 与平台名 `codebuddy` 指同一目标——build adapter 目录保持 `adapters/workbuddy/`（由 build-adapters 生成的自包含分发适配器，清单 `.codebuddy-plugin/plugin.json`，组件位于插件根，技能以 `${CODEBUDDY_PLUGIN_ROOT}` 渲染），而 platform id / distributionType / actionType 分别为 `codebuddy` / `codebuddy-plugin` / `codebuddy-marketplace-install`。Kimi 没有可脚本化安装接口；codebuddy CLI 的 `plugin marketplace add` 与 `plugin install` 均无 ref 选项、安装跟踪市场默认分支，无法可靠核验冻结产物同一性。因此新计划设置 `humanConsumersStrategy: manualFollowUps`：

- `publish` 不执行 Kimi/CodeBuddy 安装，也不因其尚未安装进入 `PARTIAL`；自动化发布完成后进入 `PUBLISHED`，并返回含平台、插件、版本和安装说明的 `manualFollowUps`。
- `verify` 跳过这两个平台的安装核验，为每个任务返回 `verifiedBySystem: false`；任务完成与否不改变自动化发布的 `VERIFIED` 状态，系统不得声称已验证其安装。
- 操作者可在发布完成后经 Kimi 交互安装、WorkBuddy 桌面市场或 codebuddy CLI 安装；这是团队待办，不是 release-skill 门禁。
- 缺少 `humanConsumersStrategy` 的旧冻结计划继续按历史 attestation 契约读取证明，避免升级后破坏进行中的旧发布；`attest` 只用于该兼容路径。

**外部独立市场形态（claude/codex）**：distribution 声明可选字段 `marketplaceRepo`（`owner/name`）即启用外部形态，marketplace 索引与插件仓库解耦：

- **权威分布**：marketplace 索引（`marketplace.json`）集中于外部独立市场仓库（如 `ifoohoo/artifact-skill-set`），插件仓库的冻结快照**只含 plugin 清单**（claude=`.claude-plugin/plugin.json`、codex=`.codex-plugin/plugin.json`），**不含自市场 marketplace.json**。marketplaceAdd 目标即外部市场仓库（action `repo=marketplaceRepo`），`marketplace` 字段为外部市场名（不必等于 unit.id）。
- **ref 冻结的不对称**（CLI 实测结论）：prepare 仅在 `--online` 生产路径经 `git ls-remote --symref` 解析外部市场仓库当前 HEAD，并经 GitHub contents API 校验该 sha 处的索引条目（`name` 匹配、`plugins[]` 中目标插件恰一条、claude 形态 `entry.version` 等于目标版本）后冻结。**codex 能钉裸 commit sha**（`--ref <sha>`，强冻）→ action `ref` 取 HEAD sha；**claude 只能钉分支/tag 名**（`@<sha>` 失败、`@<name>` 成功，且本地不存解析 sha，弱冻）→ action `ref` 取默认分支名。二者**始终**把解析出的 HEAD sha 冻结为 `marketplaceCommitSha`（审计/期望字段；claude 弱冻下它是 prepare 时刻的快照状态）。非在线而声明 `marketplaceRepo` → 失败关闭。外部仓库全程**只读**（`git ls-remote`/`gh api` 读，绝不写）。
- **载荷权威不变**：安装侧载荷权威仍是**本单元冻结快照整树**（`snapshotPath`/`manifestDigest` 指本单元快照），marketplace 索引只在远端、不进快照权威。校验契约见 §2.4 `external-marketplace-v1`。
- **时序约束（先市场后插件）**：外部市场索引必须先于插件发布定版——即先在外部市场仓库（artifact-skill-set-workspace 的 `plugins.mjs`）定版并 publish 市场，使索引 `entry.version` 等于目标发布版本（claude 形态强校验该条），prepare 才能冻结到**含该条目**的市场 sha。若市场索引尚未定版到目标版本，prepare 在线索引校验即失败关闭。
- **范围与边界**：kimi/codebuddy 无 marketplace add 能力，distribution 出现 `marketplaceRepo` 在 plan 完整性与 prepare 均失败关闭；本形态不写外部仓库（市场索引更新属另立项的 Phase B）。

### 2.4 安装载荷校验契约（declared-manifest-v1 / external-marketplace-v1）

marketplace install action 的安装侧载荷校验以 action 参数 `payloadContract` 选择语义：

- **`payloadContract: 'declared-manifest-v1'`**（新计划由 prepare 写入）：
  - 权威方 = 冻结快照经摘要密封后、按 marketplace 清单声明的 `source` 子树过滤出的条目集合（子树解析路径与清单版本校验不变）。
  - 安装侧 = 安装目录的完整文件遍历，**不做任何豁免**。
  - 判定：**权威方每一条 entry 必须在安装侧存在**，且 `type/size/contentDigest/mode（忽略写位 `& ~0o222`）` 全部一致。缺失、内容篡改、非写位 mode 变化（如可执行位丢失）→ 失败关闭（CONFLICTING），错误信息列出具体冲突路径（前 10 条，超出记总数）。
  - 安装侧多出的文件（宿主 CLI 副产物，如 claude `.in_use`、codex `.git` 检出与 `.codex-plugin/migrated-command-skills/`、以及任何未来新增物）**不视为失败**，收集为相对路径 `extraInstalledPaths`（上限 200 条，超出记录 `extraInstalledPathsTotal` 总数）写入 evidence/observation，供审计与宿主演进观察。
  - 安全性质不降：供应链校验的对象是我方声明拥有的文件；宿主副产物不是我方责任，纳入全等比较只会把宿主行为风险转嫁为发布阻断。
- **`payloadContract: 'external-marketplace-v1'`**（外部独立市场形态由 prepare 写入，见 §2.3）：
  - 权威方 = 冻结快照**整树**（子树解析短路为 `'.'`，**不读任何 marketplace 清单**——外部形态快照本就可无市场清单，索引在远端外部仓库）。
  - 安装侧 = 安装目录的完整文件遍历，**不做任何豁免**。
  - 判定：与 `declared-manifest-v1` **完全相同的包含语义**——权威方每一条 entry 必须在安装侧存在且 `type/size/contentDigest/mode（忽略写位）` 一致，缺失/篡改/非写位 mode 变化失败关闭；安装侧多出文件记 `extraInstalledPaths` 不视为失败。两契约仅权威子树来源不同（declared 经清单声明 source 裁子树，external 整树）。
  - **冻结强度权衡**：`marketplaceCommitSha`（codex sha 冻 / claude 名冻）只冻结**市场索引位置**，其强度**低于摘要密封**——它不密封插件载荷字节。载荷同一性仍由本单元冻结快照摘要（`manifestDigest`）独立保证；索引位置冻结与载荷摘要密封是两条互不替代的链。弱冻 claude 若默认分支漂移致安装版本不符，由**安装侧条目观察比对**补偿（claude `plugin list` version 绑定、codex `crossValidateListEntry` 绑 name/marketplace/version），版本不符即 fail-closed。verify/observe **离线绝不回查远端**，全靠冻结快照 + 本地消费者 CLI list 输出。
- **缺失 `payloadContract` 字段**（存量已冻结计划）：走 legacy 全等语义——安装侧整树（按 `consumerTransportExclusions` 豁免宿主传输元数据后）与权威方逐字节全等，任何差异失败关闭。行为逐字节保持，用于保护旧计划的恢复路径（reconcile/verify）。
- 未识别的 `payloadContract` 取值 → 失败关闭。
- `consumerTransportExclusions` 自本契约起 **deprecated**：仅 legacy 分支使用，待平台注册表任务（T2.2）迁入注册表后删除。

校验强度红线：我方文件少一个、改一字节、非写位 mode 变化，都必须仍是 CONFLICTING。版本一致性另由 `plugin list`/install evidence 与已安装清单 name/version 校验分别把关，本契约不替代那些检查。

---

## 3. 外部写授权门

### 3.1 授权要求

所有 adapter 的 `execute` 方法必须在以下条件全部满足时才能执行外部写操作：

1. 发布计划已冻结且 schema 验证通过。
2. 发布计划摘要与批准记录中的摘要匹配。
3. 批准记录存在且未超过 24 小时有效期。
4. 工作区基线按 `planVersion` 分叉校验（与 `01-state-machine.md` §4.4 及根 `AGENTS.md` 的 Release Authorization 语义一致）：
   - **planVersion 1（旧版）计划**：继续绑定基线——Git tree hash（及 workspace digest）必须与批准记录中的匹配；批准后基线变化即使批准失效，硬失败（`BASELINE_CHANGED`）。
   - **planVersion 2 计划**：digest 只绑定信任边界（冻结产物身份：git commit/tree、manifestDigest、npm tarball 摘要；外部动作列表；目标版本；配置摘要）。工作区基线（tree hash、workspace digest）是记录层审计数据：不参与 digest、不使批准失效；publish/reconcile 检测到基线漂移时记录 warning 级证据事件并继续执行，产物身份与完整性由外部写之前的冻结产物复验保证。
5. 目标版本与批准记录中的匹配。
6. 远端无冲突状态（preflight 通过）。
7. `context.externalWritesAuthorized === true`。

任一条件不满足时，execute 返回对应错误码（`AUTH_MISSING`、`BASELINE_CHANGED`（仅 planVersion 1）、`REMOTE_CONFLICT` 等）并拒绝执行。

### 3.2 批准记录结构

```json
{
  "planDigest": "<sha256>",
  "baseline": {
    "gitTreeHash": "<sha256>"
  },
  "targetVersion": "1.0.0",
  "approvedActions": ["push-snapshot", "create-tag", "npm-publish", "github-release"],
  "actor": "maintainer",
  "approvedAt": "2026-07-15T12:00:00.000Z",
  "expiresAt": "2026-07-16T12:00:00.000Z"
}
```

- `approvedActions` 不得包含通配符。
- `expiresAt` 不得晚于 `approvedAt` + 24 小时。
- `baseline` 的约束力按 `planVersion` 分叉（见 §3.1 条件 4）：planVersion 1 计划中它是批准绑定字段；planVersion 2 计划中它只是记录层审计数据，不使批准失效。

---

## 4. 幂等重试

### 4.1 幂等规则

- `reconcile` 阶段首先通过 `observe` 查询所有计划操作的远端状态。
- 状态为 `CONSISTENT` 的操作幂等跳过，不重新执行。
- 状态为 `MISSING` 的操作安全重试。
- 状态为 `CONFLICTING` 的操作停止并返回 `REMOTE_CONFLICT`，要求人工决策。

### 4.2 重试安全约束

- 系统不得自动删除远端 tag。
- 系统不得覆盖已存在的 GitHub Release。
- 系统不得 unpublish npm 包。
- 系统不得从头重跑已完成的发布。
- 重试仅限于安全且未完成的步骤。

### 4.3 检查点记录

每个外部操作的执行结果作为检查点写入证据目录（见 `05-evidence-and-errors.md`）。检查点包含：

- 操作标识和类型。
- 执行前的 `observe` 结果。
- 执行结果（成功/失败/跳过）。
- 执行后的 `observe` 验证结果。
- 远端资源标识（commit、tag、版本、URL）。

---

## 5. 发布 Saga 执行流程

`publish` 命令按以下顺序执行：

1. 重新验证发布计划 schema。
2. 重新验证发布计划摘要。
3. 检查批准记录是否过期。
4. 按 planVersion 分叉复验工作区基线：planVersion 1 计划基线变化即失败（`BASELINE_CHANGED`）；planVersion 2 计划基线漂移仅记录 warning 级证据事件并继续，产物身份由外部写之前的冻结产物复验保证。
5. 执行远程 preflight。
6. 按批准的操作列表顺序执行每个检查点。
7. 每个检查点：preflight -> execute -> observe -> 记录。
8. 任一检查点失败时停止后续动作，计算 PARTIAL（若已有成功检查点）。
9. 所有检查点成功后进入 PUBLISHED 状态。

---

## 6. 跨标准引用

- 状态机中的 PUBLISHING、PARTIAL、PUBLISHED 和 VERIFIED 状态见 `01-state-machine.md`。
- 配置中的 hook 和安全策略见 `02-project-config.md`。
- 供应链安全中的 provenance、签名和最小权限见 `04-supply-chain.md`。
- 证据目录结构和事件格式见 `05-evidence-and-errors.md`。
