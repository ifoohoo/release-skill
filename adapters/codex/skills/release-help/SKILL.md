---
name: release-help
description: "Discoverable entry point for release-skill: dependency and environment checks, capability overview, minimal examples, read-only diagnosis, dry-run guidance, and failure triage"
---

> **Codex 安装入口解析协议**：在调用 CLI 前，Agent 必须从宿主当前已加载技能的元数据中取得本 `SKILL.md` 的实际绝对路径，并将该字面量记为 `SKILL_FILE`。
> `SKILL_FILE` 不是环境变量；禁止从工作目录、可执行搜索路径、源码仓库或 shell 调用上下文猜测。若宿主未提供该绝对路径，立即停止并报告安装定位失败。
> 对 `SKILL_FILE` 执行 `realpath`，取其目录向上两级得到 `PLUGIN_ROOT`；校验真实技能路径匹配 `PLUGIN_ROOT/skills/*/SKILL.md` 且仍位于插件根内（路径包含检查）。
> 令 `RELEASE_SKILL_ENTRY=PLUGIN_ROOT/bin/release-skill.mjs`，对入口执行 `realpath` containment、`lstat` 非符号链接且为普通文件校验。
> 每一次 shell 工具调用都必须在同一个调用中用上述已验证绝对值设置 `RELEASE_SKILL_ENTRY`，然后执行 `node "$RELEASE_SKILL_ENTRY" ...`；不得依赖前一次 shell 的变量。
>

# release-help

## 触发

用户询问如何使用 release-skill、发布流程是什么、或请求只读诊断和 dry-run 安全检查。

## 职责

- 依赖和环境检查：Node.js >= 22、Git 决定本地准备就绪度；npm/gh 另行决定生产依赖就绪度
- 能力说明：缺少配置时走 `help → setup → assess`；已有配置的安全默认路径是 `help → assess → prepare --offline`；日常生产发布优先使用可恢复的 `ship`，兼容的分阶段闭环仍是 `prepare --online --production → approve → publish → verify`。冻结计划批准是正常发布级流程的唯一批准门；声明 `requiresApproval: true` 的 postPublish hook 仍须等待独立 checkpoint 批准。若计划声明 `postVerify` hook，可用 `postverify` 直接执行独立收尾 run，也可由 `ship` 编排该阶段；本机收尾必须等待完成的 postVerify run，不能把仅有 `VERIFIED` 的 verify run 当作本机收尾授权。核心发布流程跨平台，WorkBuddy 本机收尾仅支持 macOS
- 最小示例：展示从 release-help 到 release-assess 的最短路径
- 只读诊断：运行 dry-run 检查，不修改任何文件
- 故障引导：根据错误码指向对应的修复 Skill

## 0.9.5 候选边界

当前源码候选允许多发布单元项目在计划冻结前显式选择本轮范围。`prepare` 和新建的 `ship` 状态支持重复传入 `--unit <id>`；未传时继续选择全部配置单元。成功选择会列出选中与延期单元。延期单元不进入本轮计划，也不获得发布状态。

选择只影响按单元绑定的检查与动作。完整配置、生成物新鲜度和顶层 Hook 仍覆盖整个项目。`publicSourceAuthorityReceipt` 涉及的 coordinator 和 subjects 必须作为完整闭包共同选择，系统不会自动扩选。计划冻结后，`plan.units` 是唯一范围权威；publish、reconcile、verify 和 distribute 不接受 `--unit`。

0.9.3 引入的四项工作流保护、Hook cache v2 和稳定隔离安装树记录在 0.9.4 继续保留。0.9.4 精确消费 Foundation 0.16.0 的公开包根 API。Hook cache 只复用绝对路径或经真实 cwd 校验的 cwd-relative executable identity；裸 PATH、PATHEXT、Windows 和观察不可用时，Hook 仍冷执行，缓存复用失败关闭且不写入 v2 cache。缓存没有 TTL。

稳定隔离安装树记录只在宿主命令退出、目录已隔离且扫描期间没有并发写入时执行；宿主附加链接只记录、不跟随，声明载荷中的 symlink 失败关闭，legacy 全树语义保持不变。0.9.5 仍是源码候选，不能从本说明推断已批准、发布或验证。

**阶段通过规则**: `status` 与 `readiness.localPreparation.status` 只判断本地 help/assess/prepare；其充要条件是 `READY` 且 exit code 为 0。`missingRequired` 列出缺失的 Node/Git。生产发布必须另外读取 `readiness.productionPublish`：缺少 npm/gh 时为 `NOT_READY`，依赖存在时仍是 `AUTH_CHECK_REQUIRED`，因为 help 不访问网络、不验证认证。Agent 无权把本地就绪解释为生产就绪。

**边界**: help 不修改文件系统、不执行外部写操作、不生成发布计划。优先探测 PATH 上的全局安装命令 `release-skill`，不可用时回退到源码路径。每个 unit 必须配置 `previousPublicBaseline`：首次发布且确认无前序版本用 none，已有版本用 bound + repo/ref/commit；none 不是绕过 publish 唯一性预检的开关。v0.1.1 已完成 GitHub/npm 真实生产发布、冻结 Git ref 的 Claude/Codex 消费者安装、精确 npm 安装 smoke 与最终 VERIFIED；生产等价本地协议套件继续覆盖 fake gh/npm/Claude/Codex 和本地 bare Git。测试未做 OS 级禁网，且一次成功发布不能证明其他项目的认证、权限、限流或最终一致性行为；每个项目的首次生产发布仍应作为受监控 canary。

## 正向执行路径

1. 使用插件根相对路径运行 CLI：`node "$RELEASE_SKILL_ENTRY" help --json`
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
# 多发布单元项目显式选择本轮范围；未传 --unit 时仍为全部单元
node "$RELEASE_SKILL_ENTRY" ship --root <path> \
  --target-version <version> --unit <unit-a> --unit <unit-b> --json
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

发布单元配置 `releaseDocuments` 后，一份结构化双语说明源可确定性刷新 README 受管区域、唯一版本标记的机器值和 CHANGELOG 当前版本受管条目。核心 CLI 不联网、不调用大模型、不自动翻译；只改写声明过的受管区域、版本标记机器值和当前受管条目，区域外字节逐字保留。`prepare` 只检查新鲜度，不写工作树。

- **配置**：`releaseDocuments.notesSource`（说明源路径，只允许 `{version}` 占位符与 `.yaml`/`.yml`/`.json` 后缀）、`locales`（如 `[en, zh-CN]`）、`changelogs`（path + locale）、`readmes`（path + locale + `regions` 受管区域 id + `versionMarkers` 版本标记模式）。版本标记模式必须与 README 现有唯一标记精确匹配，`{version}` 代表机器版本值，刷新只替换该值；零次或多次匹配失败关闭。
- **说明源**：`version` 必须与单元版本精确一致，`date` 为 `YYYY-MM-DD`，每个配置语种恰好出现一次且 `summary`、变更项非空，`security`/`breaking`/`added`/`changed`/`deprecated`/`removed`/`fixed` 至少一个类别含条目。YAML alias、重复键、未知字段和语种回退都失败关闭。
- **只读演练**：`docs refresh --unit <id> --json` 输出逐文件相对路径、locale、新旧摘要、`version`、`locales`、`inputDigest`、`refreshDigest` 和 `nextCommand.argv`；候选无变化时 `status: "clean"`。
- **确认写入**：必须同时提供 `--write`、精确 `--confirm-refresh <refreshDigest>` 和 `--ack-local-document-write`，全部目标作为一个事务提交；成功后立即复演必须为 `clean`。

**授权边界**：本地发布文档写入授权只覆盖声明的本地文档目标，不是 Git 提交、push、publish 或安装的授权。hook/gate 由对应命令调用直接授权——在 project.yaml 配置 hook 即完成授权（配置时刻即授权契约，FM-16 处置 A）：hook 是任意本地进程、无文件系统/网络隔离、触发前无确认点，配置者须对其内容负责；恢复触发前强制确认门为后续加固项。写入后必须审阅、提交，再重新 prepare。

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

对于不清楚如何开始的用户，推荐使用 `release-skill route` 命令进行自动化工作流选择：

```bash
# 快速分类变更并推荐工作流；已知目标版本时显式传入，未知时省略
node "$RELEASE_SKILL_ENTRY" route --root <path> --json
node "$RELEASE_SKILL_ENTRY" route --root <path> \
  --target-version <version> --json

# JSON 输出包含 classification 和 recommendation 字段
{
  "classification": {
    "code": [],
    "docs": ["README.md"],
    "config": [],
    "marketplace": [],
    "mixed": false
  },
  "recommendation": {
    "workflowKind": "docs-only",
    "reason": "Pure documentation changes detected...",
    "firstCommand": "release-docs"
  }
}
```

**可用工作流**:
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

## 后续引导

本地准备就绪后下一步运行 `release-assess`：`node "$RELEASE_SKILL_ENTRY" assess`。生产发布还要求 npm、gh 可用，并在发布前另行完成认证检查。
