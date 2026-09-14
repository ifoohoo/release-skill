---
name: release-help
description: "Discoverable entry point for release-skill: dependency and environment checks, capability overview, minimal examples, read-only diagnosis, dry-run guidance, and failure triage"
---

> **Qoder 安装入口解析协议**：在调用 CLI 前，Agent 必须从宿主当前已加载技能的元数据中取得本 `SKILL.md` 的实际绝对路径，并将该字面量记为 `SKILL_FILE`。
> `SKILL_FILE` 不是环境变量；禁止从工作目录、可执行搜索路径、源码仓库或 shell 调用上下文猜测。若宿主未提供该绝对路径，立即停止并报告安装定位失败。
> 对 `SKILL_FILE` 执行 `realpath`，取其目录向上两级得到 `PLUGIN_ROOT`；校验真实技能路径匹配 `PLUGIN_ROOT/skills/*/SKILL.md` 且仍位于插件根内（路径包含检查）。
> 令 `RELEASE_SKILL_LOCAL_FINISH_ENTRY=PLUGIN_ROOT/bin/release-skill-local-finish.mjs`，对入口执行 `realpath` containment、`lstat` 非符号链接且为普通文件校验。
> 每一次 shell 工具调用都必须在同一个调用中用上述已验证绝对值设置 `RELEASE_SKILL_LOCAL_FINISH_ENTRY`，然后执行 `node "$RELEASE_SKILL_LOCAL_FINISH_ENTRY" ...`；不得依赖前一次 shell 的变量。
>

# release-help

## 触发

询问 release-skill 的用法、发布流程、依赖、环境、只读诊断或 dry-run 时使用。本入口只做能力说明和分诊；专用工作流交给对应 Skill。

## 只读边界

`help` 不联网、不检查认证、不改文件、不生成计划，也不执行 Git、宿主安装或外部发布写入。它只根据当前环境报告准备度并给出下一步。优先调用插件自带入口；不可用时才回退到源码入口。

核心流程跨平台；WorkBuddy 本机收尾仅支持 macOS。Node.js >= 22 和 Git 决定本地准备度。npm、gh 只影响生产发布依赖；pnpm 缺失只进入建议。

本地阶段通过须同时满足 `status: "READY"` 和 exit code 0。读取 `readiness.localPreparation.status` 与 `missingRequired`。生产另读 `readiness.productionPublish`：缺 npm/gh 为 `NOT_READY`，已安装也只是 `AUTH_CHECK_REQUIRED`，不代表认证、权限或发布授权已经成立。

## 0.9.19 候选边界

当前 0.9.19 候选精确消费 Foundation 0.21.0 的公开包根 API。0.9.19 仍是源码候选，不能从本说明推断已批准、发布或验证。

冻结前，`prepare` 或新建 `ship` 状态可重复传入 `--unit <id>`；不传则选择全部单元。延期单元不进入计划，也不获得发布状态。完整配置、生成物新鲜度和顶层 Hook 仍覆盖全项目；`publicSourceAuthorityReceipt` 的 coordinator 与 subjects 必须共同选择。冻结后以 `plan.units` 为唯一范围，publish、reconcile、verify、distribute 不再接受 `--unit`。

每个单元都要声明 `previousPublicBaseline`：确认没有前序版本才用 `none`，否则使用带 repo/ref/commit 的 `bound`。`none` 不绕过 publish 的唯一性预检。

Hook cache v2 只复用绝对路径，或已用真实 cwd 核验的 cwd-relative executable identity；裸 PATH、PATHEXT、Windows 或观察不可用时冷执行，并失败关闭。稳定隔离安装树只在宿主命令退出、目录隔离且扫描期间无并发写入时记录；附加链接只记录、不跟随，声明载荷中的 symlink 失败关闭。

## 最短路径

1. 从插件根运行 `help --json`，检查本地准备度；生产发布再检查生产准备度。
2. 缺少 `.release-skill/project.yaml` 时进入 `release-setup`；已有配置时进入 `release-assess`。
3. 本地评估使用 `release-assess` 和 `prepare --offline`。默认在审阅计划与快照后停止。
4. 生产发布优先使用可恢复的 `ship`；也可走 `prepare --online --production → approve → publish → verify`。

```bash
node "$RELEASE_SKILL_ENTRY" help --json
node "$RELEASE_SKILL_ENTRY" setup --root <path> --json
node "$RELEASE_SKILL_ENTRY" assess --root <path> --offline --json
node "$RELEASE_SKILL_ENTRY" route --root <path> --target-version <version> --json
```

`route` 只做分类和推荐，不是授权门。分类为 docs、config、marketplace、code 或 mixed；存在 `PARTIAL` 时先进入 reconcile，不能确定时按更安全的完整路径处理。

## 生产发布与恢复边界

只有用户明确要求生产发布，且冻结计划摘要已经人工审阅，才进入 `release-publish`。冻结计划批准是发布级唯一批准门；publish 会自行核对 plan、approval、digest、目标版本、远端冲突和允许动作。route、help、`READY`、历史成功或 `VERIFIED` 都不能替代批准。

`requiresApproval: true` 的 postPublish hook 还需要独立 checkpoint 批准。项目配置中的其他 hook 是任意本地进程，没有文件系统或网络隔离；执行相应命令即授权运行，help 不替用户作出该授权。

外部写入按 checkpoint 停止；部分成功进入 `PARTIAL`。不得自动删除远端标签、覆盖 Release、unpublish npm 或从头重跑。使用 `release-reconcile` 查询远端实际状态，只重试安全且未完成的动作；冲突交回人工决定。

## VERIFIED 后收尾

声明的 `postVerify` hook 可由 `postverify` 独立执行或由 `ship` 编排。计划声明该 hook 时，本机收尾必须等待完成的 postVerify run；没有声明时使用同一计划的 `VERIFIED` verify run。

随后进入 `release-finish`，通过公共入口编排宿主更新、加载确认、已配置 setup 和源码分支检查：

```bash
node "$RELEASE_SKILL_LOCAL_FINISH_ENTRY" \
  --root <project-root> --plan <plan-path> --run <verify-or-postverify-run-path> \
  --finish --json
```

首次结果可能请求用户选择分支和本机宿主，或返回需要智能体实际加载并调用 setup 的请求。将绑定反馈写入文件后，以同一入口增加 `--finish-feedback <feedback-path>` 再次汇总。完整参数、反馈合同、宿主限制和 macOS Cursor 安装见 `release-finish`。仅有 `VERIFIED` 不构成本机写入、插件更新、分支合并或 setup 写入授权；收尾结果也不改写发布状态。

## 专用工作流路由

- 消费项目的 Cursor 场景配置、受控可执行目录、用户状态目录、结果不确定时的现场保留与复验，见 `release-verify`。
- README、CHANGELOG 和双语说明的 `docs refresh` 演练、摘要确认与受管写入，见 `release-docs`。
- VERIFIED 后的分支决定、宿主更新、加载反馈、setup 和源码检查，见 `release-finish`。
- 纯配置变更，见 `release-config`。
- 纯 marketplace 索引与快照变更，见 `release-marketplace`。

这些入口保留各自的参数、确认和失败关闭规则；help 不复制或放宽它们。

## 故障分诊

- Node.js 或 Git 缺失：读取 `missingRequired`，补齐依赖后重跑 help。
- npm/gh 缺失或未认证：本地准备仍可继续；生产发布前另行完成 gh、Git HTTPS credential 与 npm auth 检查。
- CLI 入口缺失：确认 `$RELEASE_SKILL_ENTRY` 存在；缺失时重新安装插件。
- 项目配置缺失：进入 `release-setup` 的只读发现，不直接生成或覆盖 README/配置。
- assess 失败：运行 `release-assess` 的离线诊断并按错误码处理。
- `PARTIAL` 或远端冲突：进入 `release-reconcile`，保留已经成功的 checkpoint。
- 文档、Cursor、宿主更新或本机收尾失败：转到上节对应专用 Skill，不在 help 中猜测恢复步骤。

## 后续引导

本地就绪后运行 `release-assess`；需要生产发布时，再确认 npm、gh、认证、冻结计划和有效批准。
