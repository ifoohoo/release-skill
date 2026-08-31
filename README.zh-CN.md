# release-skill

[English](README.md) · 安装指南：[中文](INSTALL.zh-CN.md) / [English](INSTALL.md)

<!-- release-skill:release-version: 0.9.4 -->
面向 Claude Code、CodeBuddy、WorkBuddy、Codex 和 Kimi Code 的发布准备工具，完整保留人工维护的文件内容。

release-skill 帮助维护者回答三个问题：准备发布什么、还有哪些检查未通过、最终发布的内容是什么。它不重新生成、也不回写项目源文件。`prepare` 把每个配置的公开文件复制到隔离快照并验证字节——先冻结并供人工审阅，再从同一份冻结产物发布。`setup` 只显示确定性的 `compactSummary` 审阅视图，完整报告保留在临时会话目录中。

<!-- release-skill:managed:start id=latest-release -->
**0.9.4** (2026-09-01)

0.9.4 是支持多发布单元项目显式冻结安全发布范围、延期无关单元的本地源码候选。三项 Foundation 依赖均精确消费已发布的 0.16.0。本说明不代表已经发布、完成真实宿主验收、完成消费者安装验证或通过独立验收。

**安全**

- ship 只在计划冻结前保存显式单元请求；沿用同一状态恢复时不能改变范围。外部写入开始后若出现部分成功，状态仍为 `PARTIAL`，只能在原计划内向前恢复。
- 任何宿主计划都必须是合格冻结计划，且宿主验收要求 VERIFIED run；本源码候选不提供该验收。

**新增**

- prepare 和冻结前的 ship 支持重复传入 `--unit <id>`。显式选择成功后，命令会列出选中单元、延期单元，以及下一次准备延期单元的精确命令。
- 显式范围命中现有 `publicSourceAuthorityReceipt` 依赖闭包时，必须同时包含 coordinator 和全部 subjects。范围不完整会在 Hook、快照和计划写入前停止，并列出缺少的单元；命令不会自动扩大范围。

**变更**

- 版本、发布文档、快照、分发和按单元绑定的验证门只处理选中单元。完整项目配置校验、生成物新鲜度检查和顶层 Hook 仍覆盖整个项目。
- `plan.units` 继续作为冻结后的唯一发布范围权威。publish、reconcile、verify 和 distribute 仍消费完整冻结计划，不增加单元选择参数。
- 通过公开包根 API 精确消费 skill-family-contracts、skill-family-harness-node 和 skill-family-engineering-kit 0.16.0。CodeBuddy plugin 显式声明 marketplace: release-skill，两个 release-finish local-finish 示例都显式传入 --root <project-root>。
- CodeBuddy 只对封闭的插件管理命令集合采用完整只读输出：即使命令报告 childExitCode 0 但残留进程组，仍保留 Foundation 异常和已完成的 SIGTERM 清理事实；每个写命令最多执行一次，并要求最终插件版本和提交精确一致。该处理不扩展到 WorkBuddy，也不改变发布状态。
- 修正 Kimi TUI 对 ANSI 框线提示以及命令输出中 `>` 字符的识别，使信任安装和重新加载提示能够被识别，同时避免把普通输出误判为输入提示。

**升级说明**

未传 `--unit` 的现有命令继续选择配置中的全部发布单元。多发布单元项目可以在 prepare 或新的 ship 状态上重复传入 `--unit`，延期无关单元。批准前应审阅 `releaseScope.deferredUnitIds` 和批准摘要。范围只要命中 `publicSourceAuthorityReceipt`，就必须包含 coordinator 和全部 subjects。publish、reconcile、verify、distribute 不接受 `--unit`，这些命令必须完整执行冻结计划。只有 0.9.4 正式发布并达到 VERIFIED，且先安装或重载正式的 0.9.4 入口，才能开始真实宿主验收。源码候选、旧的已安装入口或仅存在计划和运行文件都不能完成真实宿主验收。每个选定宿主都须首次成功更新。第二次运行时，Claude、Kimi、CodeBuddy 和 WorkBuddy 必须返回 `ALREADY_CURRENT`；Codex 可以返回 `UPDATED`，但仅当再次安装同一精确 0.9.4 冻结引用、载荷验证通过且声明 `restartRequired=true`。
<!-- release-skill:managed:end id=latest-release -->

<!-- release-skill:capability:external-write-boundary -->
> **当前边界：** v0.9.4 只是当前源码候选。本 README 记录预期范围与验证边界，
> 不代表已经发布、完成消费者安装验证或通过独立验收。
> 版本可用性以对应发布记录及发布后验证结果为准。
> v0.4.1 是更早的已发布里程碑（v0.2.2 曾处于已发布状态，后因平台验证收敛修复而更新）。
> v0.1.1 已完成 GitHub 与 npm 的
> 真实生产发布，是首次生产验证的历史里程碑，并从冻结 Git ref 完成精确 npm
> 安装及 Claude/Codex 消费者安装验证；"当前发布版本"与"首次生产验证里程碑"
> 是两个不同的事实，不得混写成同一含义。同一工作流还通过了本地
> 生产等价协议套件：测试运行真实 release-skill CLI 和冻结制品，Git 目标是
> 本地 bare remote，`gh`、`npm`、Claude、Codex 使用协议级 fake。该套件没有
> 提供 OS 级网络隔离，也不能证明其他项目的认证、权限、限流和最终一致性行为
> 与本次发布相同；每个项目的第一次生产发布仍应作为受监控 canary。
> `prepare --online` 观察 bound 前序公开基线，漂移或不可观察时失败关闭；
> 远端唯一性检查在 `publish` 全局预检执行。

<!-- release-skill:capability:safe-first-command -->
> **生产路径自 v0.1.1 里程碑起已完成真实生产验证；v0.9.4 是当前源码候选，本 README 不证明该候选已经发布、完成消费者安装验证或通过独立验收。**
> npm 安装的 CLI 是受支持的用户入口；源码 checkout 保留为开发/贡献者路径。
>
> **第一条命令：**
> - npm 安装：`npm install -g release-skill` → `release-skill help`
> - 源码 checkout：`node "$RELEASE_SKILL_HOME/packages/release-skill/bin/release-skill.mjs" help`

### 0.8.0 范围与验证边界

`prepare --workflow config` 按公开字节是否变化分支：

- 场景 A（`no-publish-needed`）没有外部动作，也不生成 `sourceAuthority`（源码来源权威），即使配置了公开来源收据也不例外。该分支直接结束，不进入 approve/publish/verify。
- 场景 B（`publish-needed`）的 production prepare 必须冻结 `plan.sourceAuthority`。docs production 适用同一要求；publish、reconcile、verify 继续校验冻结绑定和远端一致性。

marketplace 委托目标工作区发布的边界不变。

旧 production 计划缺少 `sourceAuthority` 时，在外部写入前拒绝。未发生外部写入的计划必须重新 prepare 并批准新摘要，不能补写旧计划或迁移批准。已有 `PARTIAL` 保留检查点，走匹配版本的恢复路径。evidence v1 只读；v2 顶层封闭，阶段扩展放在 `details`。摘要和恢复建议只作诊断，不构成发布权威。

当前 0.9.4 候选包含窄范围的 R-05 Hook cache v2 消费路径和稳定隔离安装树记录路径（A2/A3）。当前仍不包含 R-02 安全整树盘点、R-10 历史发布验证的产品实现、真实 Kimi/WorkBuddy 公开市场安装与调用门禁或 Audit 公开离线发布记录验证器。本范围说明不构成远端发布记录或消费者升级指引。

Foundation 三包精确依赖已发布的 0.16.0。新生成的 Kimi/CodeBuddy 同仓计划在 verify 阶段调用正式 `runPluginVerification`，把完整冻结载荷交给 Foundation，并记录最小的 `install-only` 观察收据。Kimi 映射为 `kimi-code`，CodeBuddy 映射为兼容的 `workbuddy`。`observed` 与 `payloadMatches` 只表示机制观察结果，不代表远端已发布或 release-skill 已完成领域验证。独立市场来源、真实市场安装和宿主调用仍是人工后续任务。

<!-- release-skill:maturity:distribute-v1 -->
<!-- release-skill:capability:distribute -->
> **分发能力 v1.0（W2 完成）：** postPublish 分发作为独立的 `distribute` 命令可用，支持镜像和 Marketplace 索引动作。`publish` 达到 PUBLISHED 状态后，可运行 `ship distribute` 或手动调用 `release-skill distribute --plan <path> --approval <path> --json`。分发动作实现 fail-closed 语义：空差异时 NO_CHANGE（不创建 commit/tag/push），tag 移动尝试时 REMOTE_CONFLICT（永不 force-push），外部写未授权时 AUTH_MISSING。支持的模式：`--dry-run`（仅本地提交+tag）、`--json`（结构化输出）、`--help`（命令参考）。标签承诺保证版本一致性——分发的 plugin.json.version 必须与输入 tag 匹配。详见 [docs/design/2026-08-17-postpublish-distribution.md](../../docs/design/2026-08-17-postpublish-distribution.md) 中的架构说明。
<!-- release-skill:capability:distribute -->

<!-- release-skill:maturity:postpublish-hooks-v2 -->
<!-- release-skill:capability:postpublish-hooks -->
> **postPublish hooks v2：** `releaseUnit.postPublish` 在既有 `targets` 之外接受
> 声明式 `hooks` 数组。每个 hook 要么是命名预设，要么是自定义 command hook；
> 自定义 command hook 遵循与 prepare hooks 相同的规则——可执行文件/参数数组、
> 相对 cwd、timeout 与环境变量白名单，拒绝 shell 字符串——并与其他配置的
> hook 和 gate 一样是无操作系统沙箱的进程。所有声明归一化进冻结计划，因此
> hook 变化即 plan digest 变化，既有批准随之失效。`requiresApproval: true`
> 的 hook（公开写预设缺省为 true；项目可以收紧，不得放松）执行前需要自己的
> checkpoint 级批准：用
> `release-skill approve --plan <plan> --hook <hookId> --actor <name>`
> 铸造批准记录，再由 `distribute --hook-approval <record>` 或
> `ship --hook-approval <record>` 消费（24 小时有效期，绑定 plan digest
> 与 hook id）。Git 凭证只来自宿主 credential helper / OS keychain；
> release-skill 绝不读取、存储或打印凭证。
<!-- release-skill:capability:postpublish-hooks -->

<!-- release-skill:capability:postpublish-presets -->
> **postPublish 预设：** 六个内置预设随 bundle 分发，由
> `release-skill distribute --list-presets` 枚举：`git-mirror` 与
> `marketplace-index-render`（以 `targets` 形态声明），以及
> `proposal-inbox`、`marketplace-registry-entry`、`docs-refresh`、
> `notify-handoff`（以 `hooks` 形态声明）。`proposal-inbox` 通过 git-push 或
> local-file 传输投递机器可读更新提案，供下游自治消费；未声明 target 时
> 退化为 `notify-handoff` 行为而非报错。`notify-handoff` 是零写地板：
> 只渲染确定性的人工同步清单。release-skill 自己也在使用该能力：本仓库的
> 项目配置声明了一个 `proposal-inbox`（git-push）hub 提案，指向公开仓
> `skill-family-hub`，将在 v0.7.0 发布的 postVerify 阶段经自身的
> checkpoint 批准投递。
<!-- release-skill:capability:postpublish-presets -->

<!-- release-skill:capability:postverify-stage -->
> **postVerify 阶段：** 声明 `phase: postVerify` 的 hook 只在主 run 到达
> VERIFIED 之后执行；`ship` 把它们路由进一个独立的 postVerify run，其 hook
> 上下文携带验证证据（`verifyEvidence` 仅该阶段存在）。postVerify run 失败
> 即保持 PARTIAL、可 reconcile，但绝不把主 run 从 VERIFIED 回退——失败在
> evidence 中显著记录，绝不静默。
<!-- release-skill:capability:postverify-stage -->

<!-- release-skill:maturity:v0.1-boundary -->
<!-- release-skill:maturity:boundary -->
> **安全默认路径：** 推荐 `help → assess → prepare --offline → 人工审阅`。
> `help` 与 `assess` 只读；`prepare --offline` 中由 release-skill 自身控制的部分只写
> `.release-skill/`，且不调用远端发布适配器。但配置的 hook 和 gate 是无操作系统沙箱的进程，
> 可以写出项目目录、访问凭据、发起网络请求或执行远端发布。只有未配置这些进程，或已单独审计并
> 显式确认其副作用时，才可以把 `prepare` 视为”仅本地”。生产发布使用
> `ship --target-version <ver> → ship --approve --actor <name>`。
> 正常发布级流程只有一次人工批准：批准冻结计划。
> 这里的“唯一”仅指正常发布级流程。
> 有效 `requiresApproval: true` 的 postPublish hook 仍须等待独立 checkpoint 批准；
> 该批准绑定计划摘要与 hook id，有效期最长 24 小时。
> Kimi/CodeBuddy 的同仓发布先由 Foundation 在新鲜本地目录观察完整冻结载荷。
> 真实市场安装和宿主调用仍是非阻塞的人工后续任务。

## 目录

- [快速开始](#快速开始)
- [发布工作流](#发布工作流)
- [文档导航](#文档导航)
- [Skills](#skills)
- [平台分发](#平台分发)
- [许可证](#许可证)

## 快速开始

发布单元是独立配置版本、公开文件和分发目标的发布对象。

### 选择本轮发布范围

多发布单元项目可以在计划冻结前重复传入 `--unit <id>`。不传该参数时，继续选择
配置中的全部单元：

```bash
release-skill prepare --root "$PROJECT" --offline \
  --unit runtime --unit plugin --json
release-skill ship --root "$PROJECT" --target-version 1.2.3 \
  --unit runtime --unit plugin --json
```

命令会按项目配置顺序整理单元 ID。版本、发布文档、快照、分发和按单元绑定的验证门
只处理选中范围；完整配置校验、生成物新鲜度检查和顶层 Hook 仍覆盖整个项目。

显式范围只要包含 `publicSourceAuthorityReceipt` 声明的任一单元，就必须同时包含
coordinator 和全部 subjects。release-skill 会列出缺少的单元，并在 Hook 或计划写入前
停止，不会自动扩大范围。选择成功后，`releaseScope.selectedUnitIds` 和
`releaseScope.deferredUnitIds` 分别列出本轮单元与延期单元；返回结果还会给出下一次
准备延期单元的精确命令。

计划冻结后，`plan.units` 是唯一发布范围权威，批准覆盖计划内的全部动作。
`publish`、`reconcile`、`verify` 和 `distribute` 不接受 `--unit`。外部写入部分成功时
仍进入 `PARTIAL`，只能在同一冻结计划内向前恢复。恢复已有 ship 状态时可以省略
`--unit` 并沿用首次请求，但不能改变该请求，也不能给旧的全范围状态追加该参数。

### 安装

- Node.js 22+、Git 2.30+、至少已有一个提交的目标 Git 仓库。

**npm（推荐）：**

```bash
npm install -g release-skill
release-skill help
```

或免安装直接运行：

```bash
npx release-skill help
```

**插件（Claude Code / CodeBuddy / WorkBuddy / Codex）：**

Claude Code、CodeBuddy、WorkBuddy 和 Codex 从 bundled-family 市场
`ifoohoo/release-skill` 安装：

```
/plugin marketplace add ifoohoo/release-skill
/plugin install release-skill@release-skill
```

> **前置条件：GitHub 访问。** `owner/repo` 简写会让 Claude Code 通过 SSH 克隆。
> 如不使用 SSH，可传完整 HTTPS 地址——
> `/plugin marketplace add https://github.com/ifoohoo/release-skill`——
> 或设置 `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1`。

**Kimi Code：** Kimi Code 没有市场安装接口，需手动安装并钉死到特定 release
tag——见 [INSTALL.zh-CN.md](INSTALL.zh-CN.md#安装为-kimi-code-插件)。

CodeBuddy、Codex 和 Kimi Code 的完整命令见 [INSTALL.zh-CN.md](INSTALL.zh-CN.md)。

### 主流程

日常发布优先使用可恢复的快速路径。它会持久化所有权威文件路径。
冻结计划批准是正常发布级流程的唯一批准门。`ship` 自动执行配置中的 hooks 和验证门禁，不进入
hook 授权等待态。受限的 postPublish hook 仍须独立批准，计划批准不包含该 checkpoint。Kimi/CodeBuddy 的同仓发布先由 Foundation 在新鲜本地目录
观察完整冻结载荷。真实市场安装和宿主调用仍是发布完成后的非阻塞人工后续任务，
系统不核验其完成结果。

发布计划是供批准前审阅的记录，将目标版本、冻结产物和拟执行的外部动作关联起来；详见[人工审阅与批准步骤](#release-plan-review)。

```bash
release-skill ship --root "$PROJECT" --target-version 1.2.3 --json
release-skill ship --root "$PROJECT" --approve --actor "$ACTOR" --json
```

开发阶段可运行 `release-skill hooks validate`；它会执行声明的 hooks，并写入
`prepare` 可复用的内容绑定收据。

按以下顺序执行。步骤 1-3 只读。步骤 4 中，release-skill 自身的 prepare 流水线仅在本地写入，
且不会调用远端发布适配器；配置的 hook 和 gate 仍是可产生本地或远端副作用的任意无沙箱进程。
只有这些进程不存在，或已单独审计并显式确认副作用时，步骤 4 才能视为“仅本地”。步骤 5-9
需要显式人工门禁。

```bash
CLI=(release-skill)           # 或：CLI=(node "$RELEASE_SKILL_HOME/packages/release-skill/bin/release-skill.mjs")
PROJECT=/absolute/path/to/my-project
ACTOR=your-name
```

1. **help** — 环境检查：
   ```bash
   "${CLI[@]}" help
   ```
2. **setup** — 首次接入（只读发现，然后 create-once 配置）：
   ```bash
   SETUP_SESSION="$(mktemp -d "${TMPDIR:-/tmp}/release-setup.XXXXXX")"
   REPORT="$SETUP_SESSION/discovery.json"
   ANSWERS="$SETUP_SESSION/answers.json"
   printf 'SETUP_SESSION=%s\nPROJECT=%s\n' "$SETUP_SESSION" "$PROJECT"
   "${CLI[@]}" setup --root "$PROJECT" --json > "$REPORT" || test "$?" -eq 2
   ```
   若 `proposalConflicts` 非空，必须停止并由人工修正冲突的仓库或映射权威。无冲突时
   机械提取 `recommendedAnswers`（不得手写完整 answers）：
   ```bash
   SETUP_SESSION='<上一步打印的会话目录绝对路径>'
   node -e 'const fs=require("node:fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if((r.proposalConflicts??[]).length){console.error("proposal conflicts require human resolution");process.exit(2)}if(!r.recommendedAnswers){console.error("recommendedAnswers missing");process.exit(2)}fs.writeFileSync(process.argv[2],JSON.stringify(r.recommendedAnswers,null,2)+"\n",{flag:"wx",mode:0o600})' "$REPORT" "$ANSWERS"
   ```
   确认绑定后的 `setupDigest` 一次，然后创建配置：
   ```bash
   SETUP_SESSION='<会话目录绝对路径>'
   PROJECT='<项目绝对路径>'
   ANSWERS="$SETUP_SESSION/answers.json"
   CREATED_REPORT="$SETUP_SESSION/created.json"
   POST_REPORT="$SETUP_SESSION/post-setup.json"
   ASSESS_REPORT="$SETUP_SESSION/assess.json"
   "${CLI[@]}" setup --root "$PROJECT" --answers "$ANSWERS" \
     --write --confirm-setup <已确认的setupDigest> --json > "$CREATED_REPORT"
   "${CLI[@]}" setup --root "$PROJECT" --json > "$POST_REPORT"
   set +e
   "${CLI[@]}" assess --root "$PROJECT" --offline --json > "$ASSESS_REPORT"
   ASSESS_EXIT=$?
   set -e
   [ "$ASSESS_EXIT" -eq 0 ] || [ "$ASSESS_EXIT" -eq 1 ] || exit "$ASSESS_EXIT"
   node -e 'const fs=require("node:fs");const [c,p,a]=process.argv.slice(1).map(x=>JSON.parse(fs.readFileSync(x,"utf8")));if(c.status!=="CONFIG_CREATED"||p.status!=="ALREADY_CONFIGURED"||!["ASSESSED","NEEDS_INPUT","BLOCKED"].includes(a.status)){process.exit(2)}' "$CREATED_REPORT" "$POST_REPORT" "$ASSESS_REPORT"
   node -e 'require("node:fs").rmSync(process.argv[1],{recursive:true,force:false})' "$SETUP_SESSION"
   ```
   写入必须返回 `CONFIG_CREATED`，下一次 setup 必须返回 `ALREADY_CONFIGURED`。
   已有配置永不重新生成，后续只做经审阅的增量编辑。发现的脚本标记为
   `SIDE_EFFECTS_UNPROVEN`。对于 npm 单元，setup 还会把具体
   `bin`/`main`/`module`/`types`/`typings`/`exports` 目标和旧
   `npmRequiredPackagePaths` 标成已跟踪、未跟踪、已忽略、缺失或非普通文件。
   这些只是假设候选：setup 不会自动写入 `publicFiles` 或
   `requiredPublicFiles`。只有在人工审阅之后才添加项目专属 hook 或 gate：
   编辑 `projectConfig.hooks`，或编辑 `verificationGates` 并把同一个 id 加入
   `selectedGateIds`，然后重新运行绑定 dry-run。配置已存在时跳过。
   下游 postPublish 引导在确认前同样只读：`setup --discover-downstream`
   枚举下游候选（git remote、邻近的 marketplace/docs 仓、
   `artifact-graph.config.yaml`，以及存在时的 foundation profile）；
   `setup --propose-hooks` 把这些线索转为由 `setupDigest` 绑定的 postPublish
   hook 声明草案。对已接入的项目，
   `setup --propose-hooks --write --confirm-setup <digest>` 只追加目标发布
   单元的 `postPublish.hooks` 段，绝不重新生成或改写配置的任何其他部分
   （create-once 边界不受影响）。foundation profile 只是提案输入之一，绝不
   自动生效。
   完整多步流程见 [INSTALL.zh-CN.md](INSTALL.zh-CN.md#首次接入)。
   **接入评估（只读）：** 对已接入项目，`setup --assess-adoption` 报告已满足项、
   必选缺口、可选建议和不适用项，不写入任何文件；未配置项目返回 `NOT_CONFIGURED`
   并指向首次接入。Hook 耗时建议只从当前版本生产者产生的事件推导；工具绝不代猜
   或代写项目的 `cacheInputs`。
3. **assess** — 只读就绪评估：
   ```bash
   "${CLI[@]}" assess --root "$PROJECT" --offline --json
   ```
4. **prepare** — 本地快照与计划冻结：
   ```bash
   "${CLI[@]}" prepare --root "$PROJECT" --offline --json
   ```
5. <a id="release-plan-review"></a>**人工审阅：** 检查 `planPath`、`externalActions`、`targetVersion` 和 `planDigest`。
6. **prepare --production** — 冻结生产计划：
   ```bash
   PLAN_JSON=$("${CLI[@]}" prepare --root "$PROJECT" --online --production --json)
   PLAN_PATH=$(printf '%s\n' "$PLAN_JSON" | jq -r '.planPath')
   PLAN_DIGEST=$(printf '%s\n' "$PLAN_JSON" | jq -r '.planDigest')
   ```
7. **approve** — 人工批准（24 小时有效期，摘要从计划自动读取）：
   ```bash
   APPROVAL_JSON=$("${CLI[@]}" approve --plan "$PLAN_PATH" \
     --actor "$ACTOR" --json)
   APPROVAL_PATH=$(printf '%s\n' "$APPROVAL_JSON" | jq -r '.approvalPath')
   ```
   批准绑定计划摘要（`planDigest`）、各发布单元的目标版本和获批动作集合。这些绑定发生变化时，必须重新批准。

   `planVersion: 2` 的摘要绑定冻结产物、配置和动作。
   工作区基线（baseline）漂移仅作为记录层审计数据，不会单独使批准失效；发布前仍必须重新核验冻结产物。
   `planVersion: 1` 保留包含工作区基线的旧绑定规则。

   `--actor` 只是未经身份认证的本地审计字符串，不是身份核验、数字签名，也不能证明某位特定人员
   已批准计划；需要此类保证时，应接入外部已认证的审批系统。
8. **publish** — 远端写入开始：
   ```bash
   PUBLISH_JSON=$("${CLI[@]}" publish --root "$PROJECT" \
     --plan "$PLAN_PATH" --approval "$APPROVAL_PATH" --json)
   PUBLISH_RUN_PATH=$(printf '%s\n' "$PUBLISH_JSON" | jq -r '.runPath')
   ```
   持有合法批准的 production plan 时可以直接进入 `publish`；`route` 只是工作流建议。`publish` 仍要求计划、批准、冻结摘要与制品身份、远端预检，并在检查点失败时保持 fail-closed 的 `PARTIAL` 规则。
   `PUBLISHED` **不是**终态。
9. **verify** — 消费者安装检查：
   ```bash
   "${CLI[@]}" verify --root "$PROJECT" \
     --plan "$PLAN_PATH" --run "$PUBLISH_RUN_PATH" --json
   ```

示例需要 `jq`。没有 jq 时，直接复制返回的 JSON 字段；不要把尖括号占位符当作 shell 语法。

### PARTIAL 恢复与 reconcile

当 `publish` 在部分检查点成功但在其他检查点失败时，运行进入 `PARTIAL` 状态。**不要从头重跑，也不要删除远端状态。**

```bash
RECONCILE_JSON=$("${CLI[@]}" reconcile --root "$PROJECT" \
  --run "$PUBLISH_RUN_PATH" \
  --plan "$PLAN_PATH" \
  --approval "$APPROVAL_PATH" --json)
RECONCILE_RUN_PATH=$(printf '%s\n' "$RECONCILE_JSON" | jq -r '.runPath')
"${CLI[@]}" verify --root "$PROJECT" \
  --plan "$PLAN_PATH" --run "$RECONCILE_RUN_PATH" --json
```

`reconcile` 查询实际远端状态，跳过已一致步骤，只重试安全未完成的动作。远端冲突需人工决策。reconcile 成功只返回 `PUBLISHED`，不返回 `VERIFIED`。

## 发布工作流

release-skill 把发布生命周期建模为严格状态机（规范定义见 `references/01-state-machine.md`）：

```text
DISCOVERED -> ASSESSED -> PREPARED -> APPROVED -> PUBLISHING -> PUBLISHED -> VERIFIED
                                   异常态：NEEDS_INPUT / BLOCKED / PARTIAL
```

每个 CLI 命令对应一次状态转换。`PUBLISHED` **不是**终态——只有全新运行的 `verify` 确认远端状态和消费者安装与冻结计划一致时，才到达 `VERIFIED`。

**保存契约：** release-skill 不重新生成或回写项目源文件。`prepare` 把每个配置的公开文件复制到隔离快照并验证字节。后续 prepare 重新读取当前文件，不会从模板重建。只有 `publicFiles` 列出的文件会被复制。`prepare` 不会刷新或重写人工文档——维护者先更新 README、INSTALL 和 CHANGELOG，再 prepare、审阅和批准。

**写入安全：** `setup` 默认只读（摘要确认后仅首次创建配置）。release-skill 自身的 `prepare`
流水线只写 `.release-skill/`，且不调用远端发布适配器。项目 hook 和 gate 在对应命令调用时获得
授权，但没有操作系统沙箱；它们可以写出项目目录、访问凭据、发起网络请求或执行远端发布。
`publish` 是 release-skill 自身的生产写入入口，需要有效批准；内部计划摘要由系统自动绑定和校验。

**Workspace 源码权威：** 生产配置使用 `project.sourceRepository` 指定 workspace
源仓库，并用 `project.defaultBranch` 指定其真实远端默认分支。prepare 冻结所有
`publicFiles.from` 展开文件及各 `version.source` 的内容与 Git mode；publish 在第一个
adapter 写入前与远端默认分支比较。普通 merge、squash、rebase 后内容仍一致即可通过；
README 被冲突解决或 revert 丢失时会精确到路径阻断。系统不会自动合并、切分支、push
或创建 PR。

## 文档导航

| 文档 | 说明 |
|---|---|
| [INSTALL.md](INSTALL.md) / [INSTALL.zh-CN.md](INSTALL.zh-CN.md) | 完整安装指南：npm、插件、源码 checkout、setup 流程、分支策略 |
| [CHANGELOG.md](CHANGELOG.md) | 发布历史 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 贡献指南（含生成产物规则） |
| [SECURITY.md](SECURITY.md) | 安全策略 |
| `references/01-state-machine.md` | 规范状态机定义 |
| `references/02-project-config.md` | 项目配置 schema 参考 |
| `references/05-evidence-and-errors.md` | 证据格式和错误码 |
| `references/06-adapter-contract.md` | 适配器和市场契约详情 |
| [GitHub Issues](https://github.com/ifoohoo/release-skill/issues) | 问题报告和功能请求 |

## 配置

最小人工编写配置（完整 schema 和 setup 流程见 [INSTALL.zh-CN.md](INSTALL.zh-CN.md)）：

```yaml
apiVersion: release-skill/v1
kind: ReleaseProject
project:
  name: my-project
  defaultBranch: main
  sourceRepository: owner/my-workspace
releaseUnits:
  - id: my-project
    source: .
    publicRepo: owner/my-project
    version:
      source: package.json
      tagTemplate: v{version}
    publicFiles:
      - from: README.md
        to: README.md
        mode: preserve
      - from: package.json
        to: package.json
        mode: preserve
    requiredPublicFiles: [README.md, package.json]
    previousPublicBaseline:
      mode: none
    distributions:
      - type: npm
        package: my-project
        access: public
        provenance: false
        tag: latest
        registry: https://registry.npmjs.org
        publisher: my-npm-username
    production:
      branchTemplate: release/{tag}
      branchStrategy: create-release-branch
```

`version.source` 相对于该发布单元的 `source` 目录解析（`version.source` is resolved relative to that release unit's `source` directory）。monorepo 中 npm 和插件分开发布时定义多个发布单元：

```yaml
apiVersion: release-skill/v1
kind: ReleaseProject
project:
  name: my-workspace
  defaultBranch: main
  sourceRepository: owner/my-workspace
releaseUnits:
  - id: my-app
    source: packages/app
    publicRepo: owner/my-app
    version:
      source: package.json
      tagTemplate: my-app-v{version}
    distributions:
      - type: npm
        package: my-app
        access: public
        provenance: false
        tag: latest
        registry: https://registry.npmjs.org
        publisher: my-npm-username
    publicFiles:
      - from: packages/app/package.json
        to: package.json
        mode: preserve
    requiredPublicFiles: [package.json]
    previousPublicBaseline:
      mode: none
    production:
      branchTemplate: release/{tag}
      branchStrategy: create-release-branch
  - id: my-plugin
    source: packages/plugin
    publicRepo: owner/my-plugin
    version:
      source: package.json
      tagTemplate: my-plugin-v{version}
    distributions:
      - type: claude-plugin
        plugin: my-plugin
        marketplace: my-plugin
        entrySkill: my-plugin-help
        marketplaceSourceType: bundled-family
    publicFiles:
      - from: packages/plugin/package.json
        to: package.json
        mode: preserve
      - from: packages/plugin/.claude-plugin/marketplace.json
        to: .claude-plugin/marketplace.json
        mode: preserve
      - from: packages/plugin/.claude-plugin/plugin.json
        to: .claude-plugin/plugin.json
        mode: preserve
      - from: packages/plugin/skills/my-plugin-help/SKILL.md
        to: skills/my-plugin-help/SKILL.md
        mode: preserve
    requiredPublicFiles:
      - package.json
      - .claude-plugin/marketplace.json
      - .claude-plugin/plugin.json
      - skills/my-plugin-help/SKILL.md
    previousPublicBaseline:
      mode: none
    production:
      branchTemplate: release/{tag}
      branchStrategy: create-release-branch
```

本例把插件放在快照根目录。准备前须在 `packages/plugin` 下创建映射中的四个源文件：

- 市场索引 `.claude-plugin/marketplace.json` 的名称为 `my-plugin`，其中 `my-plugin` 条目的 `source` 设为 `"./"`。
- 插件清单 `.claude-plugin/plugin.json` 的 `name` 设为 `my-plugin`，`version` 与 `package.json` 一致，`skills` 设为 `"./skills/"`。
- 入口文件为 `skills/my-plugin-help/SKILL.md`，其前置元数据声明 `name: my-plugin-help`。

这个最小 Skill 不引用其他文件；新增引用时，须逐文件映射所需资源。

在提取出的 `recommendedAnswers` 中添加 gate：编辑 `verificationGates` 并在 `selectedGateIds` 中绑定同一 id：

```json
{
  "projectConfig": {
    "apiVersion": "release-skill/v1",
    "kind": "ReleaseProject",
    "project": {
      "name": "my-project",
      "defaultBranch": "main",
      "sourceRepository": "owner/my-workspace"
    },
    "releaseUnits": [{
      "id": "my-project",
      "source": ".",
      "publicRepo": "owner/my-project",
      "version": { "source": "package.json", "tagTemplate": "v{version}" },
      "distributions": [{
        "type": "npm", "package": "my-project", "access": "public",
        "provenance": false, "tag": "latest",
        "registry": "https://registry.npmjs.org", "publisher": "my-npm-username"
      }],
      "publicFiles": [{ "from": "package.json", "to": "package.json", "mode": "preserve" }],
      "requiredPublicFiles": ["package.json"],
      "previousPublicBaseline": { "mode": "none" },
      "production": { "branchTemplate": "release/{tag}", "branchStrategy": "create-release-branch" }
    }],
    "verificationGates": [{
      "id": "my-project-script-test",
      "phase": "snapshot-verify",
      "scope": { "unit": "my-project" },
      "command": ["node", "-e", "const p=require('./package.json');if(!p.name)process.exit(1)"],
      "cwd": ".",
      "timeoutMs": 30000,
      "envAllowlist": []
    }]
  },
  "selectedGateIds": ["my-project-script-test"]
}
```

### hook 与 gate

`hooks.docs/build/test/typecheck/lint` 在快照冻结前运行。每个 hook 是一个对象——`command` 是可执行文件/参数数组，不是 shell 字符串（`command` is an executable/argument array, not a shell string）：

```yaml
hooks:
  build:
    command: [node, scripts/build.mjs]
    cwd: .
    timeoutMs: 120000
    envAllowlist: [CI]
  test:
    command: [node, --test, test/]
    cwd: .
    timeoutMs: 300000
    envAllowlist: []
```

hook 在 `prepare` 调用时运行；配置命令并调用工作流即授权执行，不再增加触发前确认点。旧参数 `--acknowledge-hook-side-effects` 和 `--acknowledge-gate-side-effects` 只作为无效果的兼容输入保留。gate 是发布校准的受控扩展点（见 `references/02-project-config.md`）。

### postPublish hook

`postPublish.hooks` 声明 `publish` 之后执行的下游投递动作。每个条目要么是命名预设，要么是自定义 command hook，遵守与上文相同的命令规则（可执行文件/参数数组，不是 shell 字符串）。预设收到冻结计划的只读投影；自定义 command hook 在冻结 tag 工作树中执行。`materialize` 钩子是可选的：缺省时，`distribute` 改为把发布单元冻结的 `publicFiles` 映射经 Foundation 托管投影物化——全新载荷根、全量预检、零写入拒绝、完整闭包回滚——计划冻结后绝不重读实时项目配置：

```yaml
postPublish:
  materialize:
    command: [node, scripts/materialize-payload.mjs]
    cwd: .
    timeoutMs: 600000
    outputMarker: "payload dir: "
  commitIdentity:
    name: release-bot
    email: mzdbxqh@example.com
  hooks:
    - id: mirror-downstream
      preset: git-mirror
      config:
        target:
          remoteUrl: https://gitlab.example.internal/team/my-project.git
          branch: main
    - id: hub-entry-proposal
      preset: proposal-inbox
      phase: postVerify
      requiresApproval: true
      config:
        delivery: git-push
        target:
          remoteUrl: https://github.com/example/hub.git
          branch: main
    - id: custom-notify
      command: [node, scripts/notify-downstream.mjs]
      timeoutMs: 300000
      envAllowlist: [CI]
```

`requiresApproval: true` 的 hook 停留在 `AWAITING_APPROVAL`，直到 checkpoint 批准被铸造并消费。批准记录绑定 plan digest 与 hook id，24 小时后过期。冻结计划批准不包含该 checkpoint 批准：

```bash
release-skill approve --plan "$PLAN_PATH" --hook hub-entry-proposal --actor "$ACTOR" --json
release-skill ship --root "$PROJECT" --hook-approval "$HOOK_APPROVAL_PATH" --json
```

对已接入的项目，`setup --discover-downstream` 与 `setup --propose-hooks` 起草这些声明供人工审阅；仅追加的增量流程见上文 setup 步骤与 [INSTALL.zh-CN.md](INSTALL.zh-CN.md#首次接入)。

## Skills

- `release-help`：环境检查和下一步引导。
- `release-setup`：首次接入的只读发现、人工校准、create-once 配置创建和只读接入评估（`setup --assess-adoption`）。
- `release-assess`：只读发布就绪度报告。
- `release-prepare`：本地快照和可审阅发布计划。
- `release-publish`：经批准的冻结 GitHub+npm 发布；内部摘要由系统自动校验。
- `release-reconcile`：基于证据恢复 PARTIAL；冲突时人工介入。
- `release-verify`：发布后验证；只有 `VERIFIED` 才是 happy end。

## 平台分发

同一个确定性核心引擎通过 build-only 适配器闭包分发到多个目标。发布单元用 `distributions` 声明要发布给谁：

| `distributions` 类型 | 物理产物 | 安装方式 |
|---|---|---|
| `npm` | 带 CLI 入口的 npm 包 | `npm install -g release-skill` |
| `claude-plugin` | `adapters/claude/` 下的自包含闭包 | 自动化 marketplace 检查点 |
| `codex-plugin` | `adapters/codex/` 下的自包含闭包 | 自动化 marketplace 检查点 |
| `kimi-plugin` | 自包含闭包（无可脚本化安装接口） | 发布后非阻塞人工任务 |
| `codebuddy-plugin` | 生成的 `adapters/workbuddy/`，带 `.codebuddy-plugin/plugin.json` | 发布后非阻塞人工任务 |

每个适配器闭包都自带 CLI、skills 和 schemas 副本，安装后无需外部依赖即可运行。Claude/Codex 验证是自动化的；Kimi Code 和 CodeBuddy/WorkBuddy 以 `manualFollowUps` 返回并标记 `verifiedBySystem: false`，其完成情况不阻塞自动发布进入 `VERIFIED`。

发布达到 `VERIFIED` 后，可选的 `release-finish` 工作流可以按冻结市场身份更新 Claude
和 Codex，也可以在同一个受控 TUI 会话中迁移或更新 Kimi，并核对真实受管载荷。
对于已有的 bundled-family CodeBuddy/WorkBuddy 条目，只有冻结标签与可变分支都解析到
冻结提交时才允许更新。该流程要求用户明确同意，且不改变发布状态。目标缺失、使用
standalone 来源、远端不可访问或身份含糊时仍转人工处理，不修改宿主。

`codebuddy-plugin` 分发可以可选地声明 `marketplace`（以及 `marketplaceSource`，即消费者添加市场所用的 URL）来覆盖默认统一市场 `artifact-skill-set`；未声明的分发保持默认值，冻结计划字节不变。

每个 npm 分发在 `prepare` 时都会针对精确封装的 tarball 静态校验
`package.json` 声明的具体入口。`publish` 与 `reconcile` 在任何远端动作前对同一
冻结 tarball 重复校验，`verify` 则在允许进入 `VERIFIED` 前对精确安装目录重复校验。
`smokeBin` 仍是可选的：配置后增加需授权的运行时烟雾测试；未配置时，静态入口闭包
检查仍然是强制门禁。通配符 exports 与 fallback array 刻意不纳入首版最小语义边界，
静态门禁会阻断，直到入口声明收窄为具体目标。

<!-- release-skill:capability:unsupported-scope -->
- **当前版本不含：** 消费者安装整树盘点（R-02）——当前版本只处理声明的公开表面和稳定隔离安装树记录；真实宿主（Kimi/WorkBuddy）验证门禁——宿主验证仍是非阻断的人工后续任务，不产生 `PASS` 或 `VERIFIED` 证据；
- 不自动生成 README，不覆盖项目源文件；
- 不自动合并冲突，也不要求回滚工作流；
- 不声称已经替项目完成真实生产 canary，不声称已完成真实插件市场验证；
- `prepare --online` 只观察 bound 前序基线；目标唯一性由 publish 全局预检完成；
- 不覆盖已有 branch/tag/Release，不 unpublish npm；
- 发布状态机不提供 Kimi 或 CodeBuddy/WorkBuddy marketplace 安装检查点——可选的 release-finish 可以在本机驱动并复查 Kimi，也可以在严格核对冻结身份后更新已有 CodeBuddy/WorkBuddy 条目，但这些结果不构成发布证据；
- 不承诺 Windows 或广泛的跨平台原生写入；
- 不会隐藏地 commit、push、打 tag、创建 Release 或发布包。

## 许可证

Apache License 2.0，见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
