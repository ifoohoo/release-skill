---
name: release-help
description: "Discoverable entry point for release-skill: dependency and environment checks, capability overview, minimal examples, read-only diagnosis, dry-run guidance, and failure triage"
---

> **Kimi Code 安装入口解析协议**：Kimi Code 官方技能契约提供正文占位符 `${KIMI_SKILL_DIR}`，宿主在向 Agent 发送正文前会将其展开为当前 `SKILL.md` 所在目录的绝对路径。必须把展开后的字面量作为当前技能目录的唯一权威输入，记为 `SKILL_DIR`。
> 禁止从工作目录、可执行搜索路径、源码仓库、shell 调用上下文或任何未记载的宿主元数据路径猜测技能目录。若正文中的 `${KIMI_SKILL_DIR}` 未被宿主展开（仍是字面量占位符），立即停止并报告安装定位失败。
> 对 `SKILL_DIR` 执行 `realpath`，取其目录向上两级得到 `PLUGIN_ROOT`；校验真实技能路径匹配 `PLUGIN_ROOT/skills/*/SKILL.md` 且仍位于插件根内（路径包含检查）。
> 令 `RELEASE_SKILL_ENTRY=PLUGIN_ROOT/bin/release-skill.mjs`，对入口执行 `realpath` containment、`lstat` 非符号链接且为普通文件校验。
> 每一次 shell 工具调用都必须在同一个调用中用上述已验证绝对值设置 `RELEASE_SKILL_ENTRY`，然后执行 `node "$RELEASE_SKILL_ENTRY" ...`；不得依赖前一次 shell 的变量。
>

# release-help

## 触发

询问用法、发布流程、只读诊断或 dry-run 时使用。

## 职责

- 依赖和环境检查：Node.js >= 22、Git 决定本地准备就绪度；npm/gh 另行决定生产依赖就绪度
- 能力说明：缺配置走 `help → setup → assess`；已有配置默认走 `help → assess → prepare --offline`。生产发布优先用可恢复的 `ship`，也支持 `prepare --online --production → approve → publish → verify`。冻结计划批准是发布级唯一批准门；`requiresApproval: true` 的 postPublish hook 另需 checkpoint 批准。声明的 `postVerify` hook 可由 `postverify` 独立执行或由 `ship` 编排；本机收尾须等待完成的 postVerify run，仅有 `VERIFIED` 不构成授权。核心流程跨平台，WorkBuddy 本机收尾仅支持 macOS
- 示例与诊断：引导至 `release-assess`；dry-run 不改文件，失败按错误码路由

## 0.9.18 候选边界

多单元项目可在冻结前通过 `prepare` 或新建 `ship` 状态重复传入 `--unit <id>`，不传则选全部。输出列出选中与延期单元；延期单元不进入计划、不获得发布状态。

选择只影响单元检查与动作；完整配置、生成物新鲜度和顶层 Hook 仍覆盖全项目。`publicSourceAuthorityReceipt` 的 coordinator 和 subjects 必须共同选择，不自动扩选。冻结后以 `plan.units` 为唯一范围；publish、reconcile、verify、distribute 不接受 `--unit`。

0.9.3 引入的四项工作流保护、Hook cache v2 和稳定隔离安装树记录在后续版本继续保留。当前 0.9.18 候选精确消费 Foundation 0.21.0 的公开包根 API。Hook cache 只复用绝对路径或经真实 cwd 校验的 cwd-relative executable identity；裸 PATH、PATHEXT、Windows 和观察不可用时，Hook 仍冷执行，缓存复用失败关闭且不写入 v2 cache。缓存没有 TTL。

稳定隔离安装树记录只在宿主命令退出、目录已隔离且扫描期间没有并发写入时执行；宿主附加链接只记录、不跟随，声明载荷中的 symlink 失败关闭，legacy 全树语义保持不变。0.9.18 仍是源码候选，不能从本说明推断已批准、发布或验证。

**阶段通过规则**：本地 help/assess/prepare 通过须同时满足 `READY` 和 exit code 0；读取 `status`、`readiness.localPreparation.status`，缺失 Node/Git 见 `missingRequired`。生产另看 `readiness.productionPublish`：缺 npm/gh 为 `NOT_READY`，存在也只到 `AUTH_CHECK_REQUIRED`。help 不联网、不检查认证，本地就绪不等于生产就绪。

**边界**：help 不改文件、不执行外部写入、不生成计划；优先用 PATH 上的 `release-skill`，不可用才回退源码。每个 unit 必填 `previousPublicBaseline`：确认无前序版本才用 none，否则用 bound + repo/ref/commit；none 不绕过 publish 唯一性预检。v0.1.1 已完成 GitHub/npm 真实发布、冻结 Git ref 的 Claude/Codex 安装、精确 npm 安装 smoke 和 VERIFIED；本地协议套件覆盖 fake gh/npm/Claude/Codex 与 bare Git，未做 OS 级禁网。该历史结果不证明其他项目的认证、权限、限流或最终一致性；各项目首次发布仍须监控 canary。

## Cursor 消费项目验证

消费项目的 `cursor-plugin` 必填 `entrySkill` 和 `hostVerification`。场景含 UTF-8 `workloadDocument`、非空 `fixtureFiles` 与 `protectedWorkspaceFiles`、JSON 对象 `platformManifest`、提示词 `effectivePrompt` 和预期字符串 `expectedResult`。文件格式为 `{path, content}`；路径须安全、相对，不得重复、互为父子或指向 `.cursor`。场景进入公开冻结计划，禁止含凭证。`timeoutMs` 限制验证时长，默认 300000 毫秒。

`prepare` 冻结到 `hostVerificationContract.scenario`；`verify` 复验冻结单 Skill 载荷后，由 Foundation 0.21.0 准备并执行 Cursor 调用。仅当宿主成功且 `result` 严格等于 `expectedResult` 时自动通过；不证明完整插件安装或团队市场分发。

每次运行 `verify` 或通过 `ship` 进入验证阶段，都须传入以下两个绝对目录：

- `--cursor-executable-root <absolute-directory>`：包含 `cursor-agent` 的受控目录。
- `--cursor-user-state-root <absolute-directory>`：本次获准使用的现有 Cursor 用户状态目录。

目录不写入计划、ship 状态或公开收据，恢复时须重传，不从 `PATH`/`HOME` 推断。须有用户状态使用权限；宿主可能刷新该状态。

成功、失败或拒绝后读取证据并清理临时目录；结果不确定则保留现场，返回 `CONSUMER_VERIFICATION_DEFERRED` 和临时目录名 `sceneId`。人工检查进程与现场后才重试，并用新目录；不确定结果不构成 Cursor 发布检查点或 `PARTIAL`。

## 正向执行路径

1. 从插件根运行下节的 `help --json` 命令
2. 检查 `readiness.localPreparation`；需要生产发布时再检查 `readiness.productionPublish`
3. 若环境就绪且缺少 `.release-skill/project.yaml`，先路由 `release-setup`；配置已存在才运行 `release-assess`
4. 默认在审阅本地计划和快照后停止；只有用户明确要求且完成摘要审批时才进入 `release-publish`。已持有合法批准的 production plan 时，publish 自行完成权威校验，不把 route 当作授权门

## 确定性脚本调用

```bash
# 从插件根运行（自包含 bundle，无需 node_modules）
node "$RELEASE_SKILL_ENTRY" help --json
node "$RELEASE_SKILL_ENTRY" setup --root <path> --json
node "$RELEASE_SKILL_ENTRY" assess --root <path> --offline --json
# 日常发布快速路径：发布前确认可读计划摘要，状态文件可恢复。
# 受限 postPublish hook 的 checkpoint 批准与计划批准分开。
node "$RELEASE_SKILL_ENTRY" ship --root <path> --target-version <version> --json
# 对已经 VERIFIED 的计划独立执行 postVerify hook；不读取或写入 ship state
node "$RELEASE_SKILL_ENTRY" postverify --root <path> \
  --plan <plan-path> --approval <approval-path> --run <verified-run-path> \
  --hook-approval <immutable-hook-approval-path> --json
# 开发阶段执行声明 hooks 并生成 prepare 可复用的内容绑定收据
# 配置时刻即授权（FM-16 处置 A）：hook 是任意本地进程、无隔离、触发前无确认点，
# 命令调用本身即授权执行配置中的 hooks
node "$RELEASE_SKILL_ENTRY" hooks validate --root <path> --json
# 仅旧冻结计划兼容：记录历史 Kimi/CodeBuddy 人工证明
# （本地自声明收据，证明力弱：--actor 仅非空字符串校验、无外部签名核验；新计划不适用）
node "$RELEASE_SKILL_ENTRY" attest --root <path> \
  --platform <kimi|codebuddy> --plugin <id> --result <passed|failed> --actor <person> --json
# 发布文档刷新：默认只读演练
node "$RELEASE_SKILL_ENTRY" docs refresh --unit <id> --json
# 摘要确认后的本地写入（三项绑定缺一不可）
node "$RELEASE_SKILL_ENTRY" docs refresh --unit <id> \
  --write --confirm-refresh <refreshDigest> --ack-local-document-write --json
```

## 发布文档刷新（docs refresh）

配置 `releaseDocuments` 后，双语说明源可刷新 README 受管区域、唯一版本标记机器值及 CHANGELOG 当前受管条目。CLI 不联网、不调用大模型、不翻译；只写声明的上述目标，其余字节保留。`prepare` 只查新鲜度、不写工作树。

- **配置**：`releaseDocuments.notesSource` 只允许 `{version}` 占位符及 `.yaml`/`.yml`/`.json`；`locales` 声明语种；`changelogs` 声明 path + locale；`readmes` 另含 `regions` 区域 id 和 `versionMarkers` 模式。模式须精确匹配 README 唯一标记，只替换 `{version}` 机器值；零次或多次匹配失败关闭。
- **说明源**：`version` 须与单元一致，`date` 为 `YYYY-MM-DD`；每种配置语种恰好一次，`summary` 非空，`security`/`breaking`/`added`/`changed`/`deprecated`/`removed`/`fixed` 至少一类含非空条目。YAML alias、重复键、未知字段、语种回退均失败关闭。
- **只读演练**：`docs refresh --unit <id> --json` 输出逐文件相对路径、locale、新旧摘要、`version`、`locales`、`inputDigest`、`refreshDigest` 和 `nextCommand.argv`；候选无变化时 `status: "clean"`。
- **确认写入**：必须同时提供 `--write`、精确 `--confirm-refresh <refreshDigest>` 和 `--ack-local-document-write`，全部目标作为一个事务提交；成功后立即复演必须为 `clean`。

**授权边界**：文档写入只覆盖声明的本地目标，不授权 Git 提交、push、publish 或安装。hook/gate 由命令直接授权；project.yaml 配置 hook 即授权（FM-16 处置 A），配置者负责其内容。hook 是任意本地进程，无文件系统/网络隔离，触发前无确认；恢复确认门留待后续加固。写入后须审阅、提交，再 prepare。

## 故障路由

| 场景 | 处理 |
|---|---|
| Node.js 版本不足 | `status: "NOT_READY"`, `missingRequired` 含 `"node>=22"`；提示升级至 >= 22 |
| Git 未安装 | `status: "NOT_READY"`, `missingRequired` 含 `"git"`；提示安装 Git |
| pnpm 未安装 | 不影响本地准备；仅出现在 recommendations 中 |
| npm/gh 未安装 | 本地准备仍可就绪，但 `readiness.productionPublish.status` 为 `NOT_READY` |
| npm/gh 已安装 | 生产状态仍为 `AUTH_CHECK_REQUIRED`；发布前验证 `gh auth`、Git HTTPS credential 和 npm auth |
| CLI 入口不存在 | 确认 `$RELEASE_SKILL_ENTRY` 存在；不存在时重新安装插件 |
| 项目配置不存在 | 路由 `release-setup`，默认只读；不得直接生成或覆盖 README/配置 |
| assess 失败 | 运行 `node "$RELEASE_SKILL_ENTRY" assess --offline --json` 获取详情 |
| 请求生产发布 | 已有公开版本先调用 `release-prepare --online --production` 观察 bound 基线；人工审阅后直接调用 `release-publish`，由 publish 自行完成计划、approval、digest、远端冲突和 `PARTIAL` 校验 |
| RELEASE_DOCS_INVALID | 配置或说明源语义非法（重复键、alias、未知字段、版本漂移等）；修正配置或说明源后重新演练 |
| RELEASE_DOCS_TRANSLATION_MISSING | 配置语种缺失或多余；补齐说明源语种，与 `releaseDocuments.locales` 完全一致，不得回退 |

## Routing Suggestions (§4.3 Quickstart Routing)

不确定入口时用 `release-skill route` 推荐工作流：

```bash
# 快速分类变更并推荐工作流；已知目标版本时显式传入，未知时省略
node "$RELEASE_SKILL_ENTRY" route --root <path> \
  --target-version <version> --json

```

输出 `classification` 区分 code/docs/config/marketplace 和 mixed，`recommendation` 给出 workflowKind、reason、firstCommand。

**可用工作流**：

- `docs-only`: 纯文档变更（跳过代码类门限）
- `config-only`: 纯配置变更（schema 验证 + 决策分支）
- `marketplace-only`: 纯 marketplace 索引变更（条目更新 + snapshot 同步）
- `full-happy-end`: 混合变更或无法确定（fail-closed 到最安全路径）
- `reconcile`: 存在 PARTIAL 运行时需先恢复
- `help`: 无变更且未指定目标版本

参考文档：
- [`release-docs`](../release-docs/SKILL.md) - 文档工作流详解
- [`release-config`](../release-config/SKILL.md) - 配置工作流详解
- [`release-marketplace`](../release-marketplace/SKILL.md) - Marketplace 工作流详解

| RELEASE_DOCS_CONFLICT | 目标含非受管同版本条目、受管标记损坏或人工冲突；人工修复目标并保留人工修改后重新演练 |
| RELEASE_DOCS_REFRESH_STALE | 确认绑定后候选已变化；重新演练取得新 `refreshDigest` 再确认写入 |
| RELEASE_DOCS_STALE | prepare 检测到文档未刷新；按 `docs refresh` → 审阅 → 提交 → 重新 prepare 恢复 |

## Cursor 本地安装

完整 `adapters/cursor/` 插件的首次安装和升级见 `release-finish`；macOS 需退出 Cursor 并传入 `--cursor-plugins-root`。安装与加载分别验收。

## 后续引导

本地就绪后运行 `release-assess`；生产发布另需 npm、gh 和认证检查。
