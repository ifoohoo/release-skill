# 05 -- 证据与错误

本文档定义 release-skill 的稳定错误码、JSON/JSONL 事件格式、脱敏规则和证据目录结构。状态机见 `01-state-machine.md`，配置约束见 `02-project-config.md`。

---

## 1. 稳定错误码

以下列出用户最常遇到的稳定错误码。实现中的完整列表由 `src/core/errors.mjs` 维护；已发布错误码不得重命名或删除。

| 错误码 | 含义 | 触发场景 | 典型恢复 |
|---|---|---|---|
| `CONFIG_INVALID` | 配置文件格式或内容不合法 | YAML 语法错误、schema 校验失败、路径逃逸、hook 不合规 | 修正配置文件后重新运行 |
| `BASELINE_CHANGED` | 发布计划冻结后 Git tree 发生变化（仅 planVersion 1 计划硬失败） | 有文件被修改、新增或删除导致 tree hash 不匹配。planVersion 2 计划的基线是记录层审计数据：漂移只记录 warning 级证据事件并继续执行，不抛此错误，产物完整性由发布前冻结产物重验兜底 | 重新运行 `prepare` 冻结新基线 |
| `DIRTY_SCOPE_CONFLICT` | 工作目录存在未提交变更且可能影响发布范围 | dirty 文件与发布单元的源码路径重叠 | 提交或暂存变更后重试 |
| `GATE_FAILED` | 发布门（构建、测试、lint、文档验证等）未通过 | hook 返回非零退出码 | 修复失败项后重新运行 `prepare` |
| `AUTH_MISSING` | 缺少必要的认证凭据或权限 | GitHub token 未配置、npm 登录缺失、marketplace 凭据不足 | 配置凭据后重试 |
| `REMOTE_CONFLICT` | 远端资源状态与冻结计划不一致 | tag 已存在但指向不同 commit、npm 版本已发布、Release 已存在且内容不同 | 人工检查远端状态并决定处理方式 |
| `HOOK_TIMEOUT` | 项目 hook 执行超时 | hook 运行时间超过 `timeoutMs` 配置 | 增加超时值或优化 hook 执行效率 |
| `PARTIAL_RELEASE` | 发布部分成功 | 至少一个外部检查点成功但后续检查点失败 | 使用 `reconcile` 从检查点恢复 |
| `POST_PUBLISH_VERIFY_FAILED` | 发布后验证未通过 | 安装测试失败、泄漏审计未通过、provenance 验证失败 | 检查失败原因，可能需要人工干预 |
| `SETUP_DIGEST_MISMATCH` | setup 事实或答案已漂移 | dry-run 后 README/package/manifest/remote/answers 发生变化，或确认摘要错误 | 重新运行 setup dry-run、审阅并确认新摘要 |
| `CONFIG_EXISTS` | setup 目标配置已经存在 | 写入模式试图创建已有 `.release-skill/project.yaml` | 不覆盖；运行 assess 并人工增量编辑 |
| `RELEASE_DOCS_INVALID` | 发布文档配置或说明数据语义非法 | `releaseDocuments` 配置不合规、说明源含重复键/alias/未知字段、版本漂移 | 修正配置或说明源后重新演练 |
| `RELEASE_DOCS_TRANSLATION_MISSING` | 说明源缺少或多余配置语种 | `locales` 声明多个语种但说明源只含其一 | 补齐全部配置语种，禁止语种回退 |
| `RELEASE_DOCS_CONFLICT` | 目标文档存在人工冲突 | 非受管同版本 CHANGELOG 条目、受管标记缺失/重复/损坏、版本标记非唯一 | 人工修复目标并保留人工修改后重新演练 |
| `RELEASE_DOCS_REFRESH_STALE` | 写入确认绑定的候选已变化 | 演练后说明源或目标发生变化，仍用旧 `refreshDigest` 写入 | 重新演练取得新的 `refreshDigest` 并重新确认 |
| `RELEASE_DOCS_STALE` | prepare 检测到发布文档未刷新 | 说明源已更新但 README/CHANGELOG 受管内容未同步 | `docs refresh` 演练 → 确认写入 → 审阅提交 → 重新 prepare |
| `CONFIG_MISSING` | 生产源码权威配置缺失 | 缺少明确的 `project.sourceRepository` 或 `project.defaultBranch` | 补充经人工确认的 workspace 源仓库与默认分支后重新 prepare |
| `REMOTE_UNAVAILABLE` | 无法可靠读取 workspace 源仓库 | 网络、认证或远端协议错误导致默认分支内容不可观察 | 修复网络或认证后基于同一冻结计划重试；不得猜测成功 |
| `REF_MISSING` | 配置的远端默认分支不存在 | `refs/heads/<defaultBranch>` 不存在 | 核对真实分支名并重新 prepare |
| `NOT_DEFAULT` | 配置分支不是远端实际默认分支 | 默认分支在 prepare 后改变，或配置错误 | 人工确认远端默认分支，更新配置并重新 prepare |
| `CONTENT_MISMATCH` | 远端默认分支缺少冻结源码内容 | README、版本源、公开映射输入的内容或 mode 不一致 | 人工 merge/adopt/reject；接受的内容进入默认分支后重试 publish |
| `DIRTY_SOURCE_INPUT` | 源码输入闭包存在未提交变化 | `publicFiles.from` 或 `version.source` 有 staged、unstaged、untracked 变化 | 提交或撤销这些具体输入的变化后重新 prepare；无关 dirty 不受影响 |
| `BUNDLE_STALE` | bundle 与其源码输入失步（fail-closed 前置门禁） | `bin/release-skill.bundle.mjs` 内嵌的源码摘要与当前 `src/` 摘要不一致，或 bundle/内嵌摘要缺失；在 prepare 加载 config 后的早期阶段检测，任何 workflow 均不可豁免 | 按错误提示在 release-skill 包根运行 `node scripts/build-bundle.mjs`（或 `pnpm build`）重建 bundle 后重新 prepare |

**动作状态码** (adapter execute/observe/verify):

- `NO_CHANGE`: 幂等时 payload 无差异，不创建 commit/tag/push。
- `PENDING`: 预检查阶段等待前置动作完成。
- `DISTRIBUTING`: 分发执行中。
- `DISTRIBUTED`: 分发已完成检查点（commit+tag+push）。
- `VERIFIED`: 分发的 verify 阶段通过最终验证。

---

## 2. JSON/JSONL 事件格式

每次执行产生 JSONL 格式的事件流（`evidence.jsonl`），每个事件为一行 JSON 对象。0.8.0 起所有新事件使用 **evidence v2**（`schemas/evidence-event-v2.schema.json`）；v1 schema（`evidence-event.schema.json`）只按 legacy 读取，不用于新写入，也不改写历史文件。

### 2.1 事件结构（v2）

v2 的顶层结构封闭（`additionalProperties: false`），只接受 Schema 声明的信封、阶段、错误、耗时和 `details` 字段。`phase`、`status`、`error.code` 保留开放字符串词汇；`command` 使用 Schema 的命令枚举，不能任意扩展。

阶段扩展信息放在 `details` 中。writer（证据写入器）把调用方传入的未知顶层扩展键归入 `details`，再统一校验和脱敏；直接写入磁盘的事件不能含未知顶层字段。

`details` 允许扩展键，但已声明字段仍受类型约束：定位字段为字符串，`cached` 为布尔值，`exitCode` 为整数，`durationMs` 为非负整数或 `null`。结构非法时拒绝写入，不能用开放词汇绕过类型检查。

```json
{
  "schemaVersion": 2,
  "runId": "<uuid>",
  "sequence": 1,
  "timestamp": "2026-07-15T12:00:00.000Z",
  "command": "prepare",
  "producer": { "name": "release-skill", "version": "0.8.0" },
  "phase": "baseline",
  "status": "started",
  "error": null
}
```

### 2.2 必填字段（v2 信封）

信封字段由 writer 拥有，调用方不得覆盖；试图伪造信封字段的事件在写入前失败关闭。

| 字段 | 类型 | 说明 |
|---|---|---|
| `schemaVersion` | 整数 | 事件格式版本，当前为 2 |
| `runId` | 字符串 | 本次执行的唯一标识（运行目录名，UUID） |
| `sequence` | 整数 | 事件在本次执行中的真实序号，从 1 开始递增；`append()` 返回实际分配的序号 |
| `timestamp` | 字符串 | ISO 8601 格式的 UTC 时间 |
| `command` | 字符串 | 触发命令名（assess、prepare、publish、reconcile、verify、distribute、postverify 等） |
| `phase` | 字符串 | 当前执行阶段标识（开放词汇） |
| `status` | 字符串 | 状态值：`started`、`succeeded`、`failed`、`skipped`（开放词汇） |
| `producer` | 对象 | `{ name, version }`，只用于归因；不参与批准、发布真实性或防篡改判断 |

### 2.3 可选字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `error` | 对象或 null | 失败诊断，只允许 `code`、`message`；写入前规范化，数字退出码如 Git 128 记为 `EXIT_128`，保留原始原因 |
| `duration` | 非负整数 | 阶段耗时（毫秒） |
| `details` | 对象 | 阶段补充信息；扩展键开放，已声明字段受类型约束 |

### 2.4 摘要输出

`summary.json` 只是 evidence 的有界诊断投影：它必须可由 `evidence.jsonl` 重建，**不参与发布事实判断**。`route` 等发布判断只消费经过 Schema、摘要与血缘校验的 `release-run.json`；summary 丢失、损坏或被改写不能改变发布状态。

每次执行结束时产生一个面向用户的中文摘要，包含：

- 执行的命令和最终状态。
- 每个阶段的执行结果。
- 失败的错误码和建议恢复方式。
- 关键产物路径（发布计划、证据目录、批准记录）。

失败摘要（`status: FAILED`）额外写入有上限的定位字段：

| 字段 | 说明 |
|---|---|
| `stablePhase` | 第一个 failed 状态事件的实际阶段；无事件时回退为最后阶段或 `unknown` |
| `evidencePath` | 证据流相对位置（`evidence.jsonl`），诊断指针 |
| `failedUnitId` / `failedHook` / `failedAction` | 首个失败事件中的单元、Hook 或动作定位；无法确定时为 `unknown` |
| `evidenceSequence` | 对应事件的真实序号；没有失败事件时为 `null` |
| `producer` | 生产者名称和版本，只用于归因 |
| `recoveryActionCode` | 恢复建议码（见下），只供展示；不持久化可执行 shell 命令字符串 |

恢复建议以本次 `readRunRecovery` 对运行、计划、血缘、检查点和批准的校验结果为准，不能只按成功检查点数量判断阶段。冲突、认证未知或批准问题优先诊断；没有证据或旧生产者输入返回 `unknown`。

0.8.0 候选已接齐恢复建议输出，仍待独立验收，尚未发布。有本次证据且 FAILED 摘要收到明确的领域建议时，顶层采用同一次计算结果。兼容 `details` 和返回错误如保留建议，只镜像同一结果。未提供领域建议时保留原通用回退，无证据时仍为 `unknown`，成功 verify 的 `null` 不得改成重试建议。不得从磁盘摘要或历史 `details` 反向读取授权事实。

恢复动作码值域：

| 动作码 | 含义 |
|---|---|
| `RECONCILE` | 已校验的 publish/reconcile 部分完成且可安全恢复；核对远端状态，跳过已成功步骤 |
| `DISTRIBUTE` | 已发布但缺必要分发，或已校验的分发运行可恢复 |
| `VERIFY` | 分发要求已满足，或验证失败但发布源仍合法；继续发布后验证 |
| `DIAGNOSE` | 冲突、认证未知、批准问题或权威不足，先人工诊断 |
| `FIX_CONFIG` | 修正配置后重试同一阶段 |
| `FIX_HOOK` | 修正声明的 hook 后重试 |
| `FIX_AUTH` | 通用回退中的凭据修复分类；领域冲突、认证或批准问题仍优先 `DIAGNOSE` |
| `RESOLVE_LOCK` | 锁冲突：显示 owner 与精确人工恢复参数（`artifacts break-lock --owner ... --reason ...`）；系统不推断进程生死，也不自动删除锁 |
| `RETRY_COMMAND` | 修复原因后重试同阶段（无外部写入时） |
| `unknown` | 无法归因的失败 |

---

## 3. 命令记录

每个 hook 和外部命令的执行记录包含以下信息：

| 字段 | 说明 |
|---|---|
| `command` | 命令和参数数组 |
| `cwd` | 执行目录（相对路径） |
| `startedAt` | 开始时间（ISO 8601） |
| `finishedAt` | 结束时间（ISO 8601） |
| `exitCode` | 退出码 |
| `stdoutTail` / `stderrTail` | Hook 输出的有界尾部（脱敏后存储，见第 4 节） |

验证 gate 不保存原始 stdout/stderr；证据仅记录命令数组、相对 cwd、时间、exit code、字节数、SHA-256 摘要和结构化裁决，避免把项目命令输出中的凭证复制进证据。Hook 输出沿用有界尾部（`stdoutTail`、`stderrTail`），不创建第二份输出文件。

---

## 4. 脱敏规则

### 4.1 日志脱敏

日志不得记录以下内容：

- token、认证头、npm 配置内容。
- 未经脱敏的环境变量值。
- 私钥内容。

### 4.2 输出脱敏

命令输出中的敏感信息按以下规则脱敏：

| 模式 | 脱敏方式 |
|---|---|
| 键名匹配 `/token\|secret\|password\|authorization\|cookie/i` | 值替换为 `<REDACTED>` |
| 字符串中匹配 `ghp_` 凭据形状 | 每处匹配均脱敏，包括消息中部和同一字符串的多处凭据 |
| 字符串中匹配 `github_pat_` 凭据形状 | 每处匹配均脱敏 |
| 字符串中匹配 `npm_` 凭据形状 | 每处匹配均脱敏；普通 `npm_config_*` 配置名不按凭据处理 |
| 字符串中匹配 `AKIA` 凭据形状 | 每处匹配均脱敏 |
| 匹配私钥头尾标记 | 整段替换为 `<REDACTED_PRIVATE_KEY>` |
| 内嵌 URL userinfo（`https://user:pass@host/...`） | 在字符串处理前剥离凭据段 |
| 绝对文件系统路径（本机路径，含用户主目录） | 替换为 `<redacted-path>`；发布身份数据保持相对形式 |

脱敏在写入点统一组合（证据流与摘要同一套规则），不存在第三套 sanitizer。证据、summary 与诊断数组中的本机绝对路径和凭据均不得外泄。

### 4.3 错误信息脱敏

错误信息中不记录 secret 的实际值。错误码和错误消息仅描述错误类型和位置，不包含敏感数据。`SECRET_DETECTED` 错误的报告中仅记录 secret 的类型（如"GitHub PAT"）和文件路径，不记录实际值。

---

## 5. 证据目录结构

每次执行产生一个证据目录，位于 `.release-skill/runs/<runId>/`。目录结构按命令类型略有差异：

```text
.release-skill/runs/<runId>/
├── evidence.jsonl            # JSONL 事件流（v2 信封，追加写入）
├── summary.json              # 有界诊断投影（可重建，非事实源）
├── release-run.json          # 经 Schema、摘要与血缘校验的运行记录（发布判断事实源；publish/reconcile/distribute/postverify 产生）
├── states/                   # 外部检查点状态台账（不可变写集，stateSequence 递增）
├── git/                      # prepare：冻结 Git 对象（拆分公开仓与 postverify 共用）
├── snapshots/                # prepare：公开文件隔离快照
├── tarballs/                 # prepare：npm 载荷 tarball
├── consumers/                # verify：消费者安装验证结果
└── evidence/                 # verify：消费者验证证据
```

冻结计划存放在 `.release-skill/plans/<planDigest>.json`；批准记录存放在 `.release-skill/approvals/<planDigest>/<approvalDigest>.json`，均不在运行目录内。

### 5.1 文件保留

- 证据目录在执行完成后不得被自动删除。
- `evidence.jsonl` 为追加写入，不得在执行过程中被截断。
- `summary.json` 在执行结束时原子写入（writer 单次封口：`finish()` 只能成功一次，封口后 append/finish 均为 no-op；正常命令的成功与失败路径都必须封口）。
- `states/` 台账为不可变写集：外部检查点成功后立即记账，失败时保留 `PARTIAL` 状态，reconcile 据此跳过已成功步骤。

### 5.2 引用与存储

- Hook 输出只保留脱敏后的有界尾部（`stdoutTail`、`stderrTail`），完整输出不进入证据。
- 事件和摘要中通过相对路径引用证据文件。
- 存储的输出内容经过第 4 节脱敏规则处理。

### 5.3 外部检查点证据

publish/reconcile/distribute/postverify 的外部写入步骤在 `states/` 中逐个记账，每个状态记录包含：

| 字段 | 类型 | 说明 |
|---|---|---|
| `runId` | 字符串 | 本次执行运行目录名 |
| `command` | 字符串 | 触发命令名 |
| `status` | 字符串 | NO_CHANGE / PENDING / DISTRIBUTING / DISTRIBUTED / VERIFIED / EXECUTE_FAILED 等 |
| `planDigest` | 字符串 | 绑定计划的摘要 |
| `sourceRunId` | 字符串 | 来源 publish 运行的 `release-run.json`（血缘） |
| `stateSequence` | 整数 | 状态台账递增序号 |
| `checkpoints` | 数组 | 外部检查点执行结果（actionId、状态、远端观察等） |
| `runDigest` | 字符串 | 状态记录自身摘要 |

checkpoint 状态语义：

- `NO_CHANGE`: payload tree 与当前分支 tip 相同，不创建任何 git ref。
- `DISTRIBUTED`: commit+tag+push 已成功，branchTip === pushedCommit && tagOid === pushedCommit。
- `VERIFIED`: observe + content diff 验证全部通过。

计划变更后的恢复流程：

- PARTIAL 状态下 reconcile 读取 `states/` 台账与 `release-run.json` 重建状态。
- 对于已成功的 checkpoint (DISTRIBUTED)，跳过该步骤；仅重试未完成或未达标的检查点。
- remote state 冲突（如 tag move）必须人工决策，不得自动修复。

---

## 6. 跨标准引用

- 状态机中的异常状态和恢复规则见 `01-state-machine.md`。
- 配置中的 hook 约束和验证规则见 `02-project-config.md`。
- 供应链安全中的 secret 检测范围见 `04-supply-chain.md`。
- Adapter 接口和检查点记录见 `06-adapter-contract.md`。
