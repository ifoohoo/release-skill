---
name: release-help
description: "Discoverable entry point for release-skill: dependency and environment checks, capability overview, minimal examples, read-only diagnosis, dry-run guidance, and failure triage"
---

> **Kimi Code 安装入口解析协议**：Kimi Code 官方技能契约提供正文占位符 `${KIMI_SKILL_DIR}`，宿主在向 Agent 发送正文前会将其展开为当前 `SKILL.md` 所在目录的绝对路径。必须把展开后的字面量作为当前技能目录的唯一权威输入，记为 `SKILL_DIR`。
> 禁止从工作目录、可执行搜索路径、源码仓库、shell 调用上下文或任何未记载的宿主元数据路径猜测技能目录。若正文中的 `${KIMI_SKILL_DIR}` 未被宿主展开（仍是字面量占位符），立即停止并报告安装定位失败。
> 对 `SKILL_DIR` 执行 `realpath`，取其目录向上两级得到 `PLUGIN_ROOT`；校验真实技能路径匹配 `PLUGIN_ROOT/skills/*/SKILL.md` 且仍位于插件根内（路径包含检查）。
> 令 `RELEASE_SKILL_ENTRY=PLUGIN_ROOT/bin/release-skill.mjs`，对入口执行 `realpath` containment、`lstat` 非符号链接且为普通文件校验。
> 令 `RELEASE_SKILL_LOCAL_FINISH_ENTRY=PLUGIN_ROOT/bin/release-skill-local-finish.mjs`，对入口执行 `realpath` containment、`lstat` 非符号链接且为普通文件校验。
> 每一次 shell 工具调用都必须在同一个调用中用上述已验证绝对值设置 `RELEASE_SKILL_ENTRY` 与 `RELEASE_SKILL_LOCAL_FINISH_ENTRY`，然后执行 `node "$RELEASE_SKILL_ENTRY" ...` 或 `node "$RELEASE_SKILL_LOCAL_FINISH_ENTRY" ...`；不得依赖前一次 shell 的变量。
>

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

## 0.9.35 能力与证据边界

四类工程材料接到现有 `release-project` 字段。公开正式材料写入 `publicFiles`（`sourceScope` / `from` / `to` / `mode`）。运行必需资源写入 `requiredPublicFiles`，必须被同一单元 `publicFiles[].to` 精确覆盖。私有正式材料与非正式运行材料不列入 `publicFiles`，需要挡住时使用 `forbiddenPaths` / `forbiddenContentPatterns`。正式不等于公开。是否进入公开快照由 `publicFiles` 是否列出决定。npm 是载荷渠道。`package.json` 的 `files` 与入口闭包和公开映射同时约束。`delivery.include` / `delivery.exclude` 只选择宿主，不是文件包含或排除。排除不得拿掉运行必需资源。互相冲突的配置必须失败关闭。

首次接线使用 `release-setup`。已有 `.release-skill/project.yaml` 返回 `ALREADY_CONFIGURED` / `CONFIG_EXISTS`，不覆盖。存量增量由 `release-assess` 诊断，再由已有 `release-config` Skill 处理。`release-config` 不是新增 CLI。必须先 `route`：实际为 `config-only` 才执行 `prepare --workflow config`；`full-happy-end` 或混合走普通 full。不得无条件触发 `prepare --workflow config`。

`REQUIRED_PUBLIC_FILE_MISSING` 只属于 `setup --assess-adoption`。接入评估按 `requiredPublicFiles` 的快照目标找到对应 `publicFiles[].to`，再检查仓根相对 `from` 是否存在；缺失记该码。普通 `assess` 与 `verify-records` 不使用该码。`prepare` 仍使用自身原生错误，例如 `PUBLIC_FILE_MISSING`、`CONFIG_INVALID`。`LICENSE_MISSING` 不能代替运行必需资源。Foundation 建议不能作为发布批准。

Skill Family Hub 保持统一市场。GitHub Git Data API 机制延续，写入采用 `compare-and-swap` 语义；不自动回滚或覆盖已完成步骤。这是已有机制，不是本轮新实现的 Hub，也不表示已经完成发布。本轮未变更远端写入授权。确认边界、冻结安装 URL/ref/sha、安装后 name/version 与载荷核对规则仍有效。Hub 门禁失败将阻止 GitHub Git Data API 写入。写入绑定已观察的分支头并比较后写入；部分发布不回滚、不覆盖已完成步骤、不自动强推。独立检查点批准、历史冻结计划不重放、`ALREADY_CURRENT` 仍强制执行。

继续采用 Foundation 0.25.0 精确依赖，不能因为邻仓版本较新就升级。空白项目走 `release-setup`；已有配置保留合法字段，用 `release-assess` / `release-config` 做增量。仅禁路径一类的 `config-only` 增量，离线非生产 `prepare` 可为 `PREPARED`，`workflowDecision` 为 `indeterminable` / `publish-needed`，这是合法结果。npm 入口缺失时失败关闭，错误为 `GATE_FAILED` / `npm-entry-closure` / `entry_missing`。旧版独立的 `release-skill` 市场已弃用，使用 `ifoohoo/skill-family-hub` 与 `release-skill@skill-family-hub`。

**0.9.32 历史事实**  
Kimi 2.2.0 移除菜单移动后，真实终端只重绘变动的菜单行，不重发插件标题，末行也没有换行；适配器曾因等待完整标题失败。适配器在移动后必须先重新观察选中项，确认唯一选中 `Remove plugin` 后才允许提交操作。读取帧前先核实初始精确插件 ID，读完该帧后才发送方向键，再读取完整增量帧并核对唯一选中项，完整标题重绘时仍核对精确 ID。未知、歧义、未移动、帧未完成、timeout、EOF 均导致失败关闭，不继续安装。移除确认页仍采用 `Remove <displayName> (<id>)?`，包含 Cancel 和 Remove plugin 选项；已选中 `Remove plugin` 时无需方向键。显示名含 Confirm 或 Sure，或标题分块到达，仍核对精确身份，不触发旧宽泛正则路径。保留 Kimi 0.40.1 实际确认措辞 `Confirm remove plugin "<id>"?`、括号粘贴与 CSI Enter 输入方式。该修复面向真实更新流程，提供方升级不扩大宿主授权，也无需重发原领域插件。真实 Kimi 2.2.0 已完成确认前的精确身份、移动及选中项观察，随后按 Esc 取消并退出，未执行移除、安装或更新。47 项聚焦测试通过，独立代码审阅无发现；真实消费者的完整更新与加载验收仍待执行。

同一 `unitId/plugin/version` 的共享环境 setup 按单元、插件、版本归并，Claude/Codex 不同物理 `skillFile` 路径不再视为多个 setup 归属。仅需一个已加载宿主的精确 setup 反馈即可满足共享环境检查要求。各宿主的安装、加载及专属配置仍需分别核实，反馈继续绑定 `host/unit/path/plan/config/root`；真正多插件归属仍需消歧，Kimi 失败或其他宿主失败均导致收尾状态为 FAILED，不改变 `VERIFIED`/`DISTRIBUTED` 发布状态。

可选宿主覆盖诊断输入 `--host-coverage <file>` 与 `--observe-hosts`、Codex 0.154.0 对 11 份真实生成 Skill 的原字节静态检查能力未变。静态检查不证明安装、会话选择或业务执行通过，批准、发布和验证状态以对应计划、批准及执行记录为准。

Qoder 本机更新路径处理维持既有能力，支持 `./adapters/qoder/skills/` 与 `./skills/` 两种布局，仍核对安装 name/version/skills、路径包含性与实际载荷。私有 Hub 的 `RELEASE_SKILL_HUB_RELEASE_EVIDENCE` 环境变量继续要求原始描述符指向的已有普通文件绝对路径（拒绝符号链接），交由 `npm run release:check -- --release-evidence <file>` 验证。

在冻结前，`prepare` 或新建 `ship` 状态时可重复传入 `--unit <id>`；未传入则默认选择全部单元。延期单元不进入发布计划，亦不获得发布状态。完整配置、生成物新鲜度检查及顶层 Hook 仍作用于全项目范围。`publicSourceAuthorityReceipt` 的 coordinator 与全部 subjects 必须共同选择。

可选 `testIntake` 只在生产 prepare 生效。首次准备返回 `NEEDS_INPUT` 和一份非正式候选，退出码 13；同一候选用 `prepare --candidate <path>` 续接，接受后才有正式计划。候选不能批准或发布，也不能清除 `PARTIAL`、`PUBLISHED` 或 `VERIFIED`。未声明的项目、原有 hook 和完整门保持不变。轻量工作流和单元选择都不免除项目级要求。非生产 prepare 遇到 `testIntake` 返回 `CONFIG_INVALID`。

冻结后，发布流程（publish、reconcile、verify、distribute）不再接受 `--unit` 参数，仅以 `plan.units` 为唯一有效范围。

每个单元必须声明 `previousPublicBaseline`：只有确认没有前序公开版本时，才使用 `none`；否则必须提供 `bound`，并包含 `repo/ref/commit` 信息。`none` 不绕过 publish 阶段的唯一性预检。

Hook 缓存 v2 仅复用绝对路径，或已通过真实 cwd 核验的 cwd-relative 可执行文件身份；若依赖裸 PATH、PATHEXT、Windows 环境或观察不可用，将触发冷执行并失败关闭。稳定隔离安装树仅在宿主命令退出、目录隔离且扫描期间无并发写入时记录；附加链接仅记录，不跟随；声明载荷中出现 symlink 将导致失败关闭。

实际版本能力不能等同于发布状态或真实宿主验收。

## 最短路径

1. 从插件根运行 `help --json`，检查本地准备度；生产发布再检查生产准备度。
2. 只检查治理接入时，按上节选择 `release-setup` 或 `release-assess`，结束于范围明确的结论和下一入口。
3. 实际接入时进入 `release-setup`；实际发布评估使用 `release-assess`，准备发布时再进入 `prepare --offline`。
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
- `testIntake` 返回 `NEEDS_INPUT`：停留在给出的候选上补齐结果，再用 `--candidate` 续接。不要把候选文件交给 approve 或 publish。
- 文档、Cursor、宿主更新或本机收尾失败：转到上节对应专用 Skill，不在 help 中猜测恢复步骤。

## 后续引导

本地就绪后运行 `release-assess`；需要生产发布时，再确认 npm、gh、认证、冻结计划和有效批准。

## 人类最终回复

纯问询或转交时短答。写明这次实际回答了什么、适用范围或转交理由、仍然有效的限制、以及下一步入口。已有 JSON 按原合同在回复中呈现。route 分类、推荐命令和未执行动作保持为建议。栏目只收录当前命令或分支已经返回的事实；有内容才设标题，短答直接成段。
