---
name: release-help
description: "Discoverable entry point for release-skill: dependency and environment checks, capability overview, minimal examples, read-only diagnosis, dry-run guidance, and failure triage"
---

# release-help

## 触发

询问 release-skill 的用法、发布流程、依赖、环境、只读诊断或 dry-run 时使用。本入口只做能力说明和分诊；专用工作流交给对应 Skill。

## 只读边界

`help` 不联网、不检查认证、不改文件、不生成计划，也不执行 Git、宿主安装或外部发布写入。它只根据当前环境报告准备度并给出下一步。优先调用插件自带入口；不可用时才回退到源码入口。

核心流程跨平台；WorkBuddy 本机收尾仅支持 macOS。Node.js >= 22 和 Git 决定本地准备度。npm、gh 只影响生产发布依赖；pnpm 缺失只进入建议。

本地阶段通过须同时满足 `status: "READY"` 和 exit code 0。读取 `readiness.localPreparation.status` 与 `missingRequired`。生产另读 `readiness.productionPublish`：缺 npm/gh 为 `NOT_READY`，已安装也只是 `AUTH_CHECK_REQUIRED`，不代表认证、权限或发布授权已经成立。

## 治理诊断分流

用户只要求治理诊断时，按意图选择一个入口：

- 了解能力、依赖或安全边界：留在 `release-help`。
- 检查接入：转 `release-setup`，运行 `setup --assess-adoption`；`NOT_CONFIGURED` 指向首次接入，不创建配置。
- 分析配置、文档和发布就绪缺口：转 `release-assess`，运行离线 `assess`。
- 核对历史记录：转 `release-assess`，只核对用户显式提供的 plan、approval 和 run 文件。
- 读取已有共同证明：转 `release-assess`，运行 `read-proof`。三个只读入口可用 `--conclusion-output` 排他写出证明；读取不重新扫描目标。

治理诊断只运行 release-skill 自己的只读检查程序，不运行目标 Skill、业务脚本、构建、hook 或发布动作，也不把 `prepare`、`verify`、`release-finish` 当作静态治理入口。用户要求实际接入或发布时，把已有授权带到对应原业务入口；各入口继续执行原有确认、副作用和状态机合同。

## 0.9.28 能力与证据边界

release-skill 0.9.28 精确依赖 Foundation 0.25.0 的公开包根 API。本版本新增可选宿主覆盖诊断能力，支持通过 `--host-coverage <file>` 提供输入文件，报告每个宿主在声明范围内的覆盖状态与事实缺口；同时采用 Codex 0.154.0 静态加载规则检查，基于 11 份真实生成 Skill 的原字节在隔离环境中完成诊断，不证明安装、会话选择或业务执行通过。批准、发布和验证状态以对应计划、批准及执行记录为准，不能由本说明推断。

在冻结前，`prepare` 或新建 `ship` 状态时可重复传入 `--unit <id>`；未传入则默认选择全部单元。延期单元不进入发布计划，亦不获得发布状态。完整配置、生成物新鲜度检查及顶层 Hook 仍作用于全项目范围。`publicSourceAuthorityReceipt` 的 coordinator 与全部 subjects 必须共同选择。

冻结后，发布流程（publish、reconcile、verify、distribute）不再接受 `--unit` 参数，仅以 `plan.units` 为唯一有效范围。

每个单元必须声明 `previousPublicBaseline`：只有确认没有前序公开版本时，才使用 `none`；否则必须提供 `bound`，并包含 `repo/ref/commit` 信息。`none` 不绕过 publish 阶段的唯一性预检。

Hook 缓存 v2 仅复用绝对路径，或已通过真实 cwd 核验的 cwd-relative 可执行文件身份；若依赖裸 PATH、PATHEXT、Windows 环境或观察不可用，将触发冷执行并失败关闭。稳定隔离安装树仅在宿主命令退出、目录隔离且扫描期间无并发写入时记录；附加链接仅记录，不跟随；声明载荷中出现 symlink 将导致失败关闭。

## 最短路径

1. 从插件根运行 `help --json`，检查本地准备度；生产发布再检查生产准备度。
2. 只检查治理接入时，按上节选择 `release-setup` 或 `release-assess`，结束于范围明确的结论和下一入口。
3. 实际接入时进入 `release-setup`；实际发布评估使用 `release-assess`，准备发布时再进入 `prepare --offline`。
4. 生产发布优先使用可恢复的 `ship`；也可走 `prepare --online --production → approve → publish → verify`。

```bash
node "${CODEBUDDY_PLUGIN_ROOT}/bin/release-skill.mjs" help --json
node "${CODEBUDDY_PLUGIN_ROOT}/bin/release-skill.mjs" setup --root <path> --json
node "${CODEBUDDY_PLUGIN_ROOT}/bin/release-skill.mjs" assess --root <path> --offline --json
node "${CODEBUDDY_PLUGIN_ROOT}/bin/release-skill.mjs" route --root <path> --target-version <version> --json
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
node "${CODEBUDDY_PLUGIN_ROOT}/bin/release-skill-local-finish.mjs" \
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
- CLI 入口缺失：确认 `${CODEBUDDY_PLUGIN_ROOT}/bin/release-skill.mjs` 存在；缺失时重新安装插件。
- 项目配置缺失：进入 `release-setup` 的只读发现，不直接生成或覆盖 README/配置。
- assess 失败：运行 `release-assess` 的离线诊断并按错误码处理。
- `PARTIAL` 或远端冲突：进入 `release-reconcile`，保留已经成功的 checkpoint。
- 文档、Cursor、宿主更新或本机收尾失败：转到上节对应专用 Skill，不在 help 中猜测恢复步骤。

## 后续引导

本地就绪后运行 `release-assess`；需要生产发布时，再确认 npm、gh、认证、冻结计划和有效批准。

## 人类最终回复

纯问询或转交时短答。写明这次实际回答了什么、适用范围或转交理由、仍然有效的限制、以及下一步入口。已有 JSON 按原合同在回复中呈现。route 分类、推荐命令和未执行动作保持为建议。栏目只收录当前命令或分支已经返回的事实；有内容才设标题，短答直接成段。
