---
name: release-help
description: "Discoverable entry point for release-skill: dependency and environment checks, capability overview, minimal examples, read-only diagnosis, dry-run guidance, and failure triage"
---

> **Qoder 安装入口解析协议**：在调用 CLI 前，Agent 必须从宿主当前已加载技能的元数据中取得本 `SKILL.md` 的实际绝对路径，并将该字面量记为 `SKILL_FILE`。
> `SKILL_FILE` 不是环境变量；禁止从工作目录、可执行搜索路径、源码仓库或 shell 调用上下文猜测。若宿主未提供该绝对路径，立即停止并报告安装定位失败。
> 对 `SKILL_FILE` 执行 `realpath`，取其目录向上两级得到 `PLUGIN_ROOT`；校验真实技能路径匹配 `PLUGIN_ROOT/skills/*/SKILL.md` 且仍位于插件根内（路径包含检查）。
> 令 `RELEASE_SKILL_ENTRY=PLUGIN_ROOT/bin/release-skill.mjs`，对入口执行 `realpath` containment、`lstat` 非符号链接且为普通文件校验。
> 令 `RELEASE_SKILL_LOCAL_FINISH_ENTRY=PLUGIN_ROOT/bin/release-skill-local-finish.mjs`，对入口执行 `realpath` containment、`lstat` 非符号链接且为普通文件校验。
> 每一次 shell 工具调用都必须在同一个调用中用上述已验证绝对值设置 `RELEASE_SKILL_ENTRY` 与 `RELEASE_SKILL_LOCAL_FINISH_ENTRY`，然后执行 `node "$RELEASE_SKILL_ENTRY" ...` 或 `node "$RELEASE_SKILL_LOCAL_FINISH_ENTRY" ...`；不得依赖前一次 shell 的变量。
>

# release-help

## 触发

用户询问 `release-skill` 用法、流程、依赖、环境、只读诊断或 `dry-run` 时使用。

## 只读边界

`help` 命令不联网、不检查认证、不修改文件、不生成发布计划，也不执行 Git 操作、宿主安装或外部发布写入。它根据环境评估准备度，并给出下一步建议。

核心流程跨平台；WorkBuddy 本机收尾仅支持 macOS。本地准备度由 Node.js ≥ 22 和 Git 决定。`npm` 与 `gh` 仅影响生产发布依赖；`pnpm` 缺失仅触发建议，不影响准备度判断。

本地阶段通过需同时满足：
- `status: "READY"`
- 退出码为 0

本地阶段是否通过，由 `readiness.localPreparation.status` 与 `missingRequired` 判断。生产发布另需检查 `readiness.productionPublish`：
- 缺失 `npm` 或 `gh` 时为 `NOT_READY`
- 已安装时仅为 `AUTH_CHECK_REQUIRED`，不代表认证、权限或发布授权已成立

## 治理诊断分流

只请求治理诊断时，按意图选择入口：

| 意图 | 推荐入口 | 说明 |
|------|----------|------|
| 了解能力、依赖或安全边界 | `release-help`（当前入口） | 仅提供能力说明与分诊 |
| 检查接入状态 | `release-setup --assess-adoption` | `NOT_CONFIGURED` 表示首次接入，不创建配置 |
| 分析配置、文档与发布就绪缺口 | `release-assess --offline` | 离线诊断，不运行构建或发布动作 |
| 核对历史记录 | `release-assess`（显式提供 plan/approval/run 文件） | 仅读取用户提供的文件，不重新扫描 |
| 读取已有证明 | `release-skill read-proof --proof-root <root> --proof <relative> --json`，只读现有文件、不扫描目标 | 三个只读入口可用 `--conclusion-output <absolute-path>` 排他输出共同证明 |

诊断只运行 `release-skill` 自身只读检查，不调用目标 Skill、业务脚本、构建、hook 或发布动作。`prepare`、`verify`、`release-finish` 不作为静态治理入口。用户要求实际接入或发布时，应将已有授权带入对应原业务入口，各入口继续执行原有确认、副作用与状态机规则。

## 0.9.38 能力与证据边界

`release-project` 的四类材料：公开正式（`publicFiles`：`sourceScope`、`from`、`to`、`mode`）、运行必需（`requiredPublicFiles`）、私有正式与非正式。公开≠正式。`requiredPublicFiles` 须被同单元的 `publicFiles[].to` 精确覆盖。私有材料由 `forbiddenPaths`、`forbiddenContentPatterns` 拦截，不进 `publicFiles`。`npm` 包由 `package.json.files`、入口闭包与映射共同限定；`delivery.include`、`delivery.exclude` 仅选宿主，不删必需资源，冲突拒绝。字段见 [配置](https://github.com/ifoohoo/release-skill/blob/release-skill-v0.9.38/references/02-project-config.md)及 `release-prepare`。

首次 `release-setup`：若已有配置（`ALREADY_CONFIGURED`/`CONFIG_EXISTS`），不得覆盖；合法旧字段保留。增量操作（`release-assess` / `release-config`）：先运行 `route`，仅 `config-only` 走 `prepare --workflow config`；`full-happy-end` / `mixed` 走完整流程。Foundation 0.25.0 版本精确，不因邻仓升级而变更。

`REQUIRED_PUBLIC_FILE_MISSING`：仅 `setup --assess-adoption` 触发，按 `requiredPublicFiles` 匹配 `publicFiles[].to`，再检查仓根相对 `from` 是否存在。普通 `assess` / `verify-records` 无此码；`prepare` 原有 `PUBLIC_FILE_MISSING` / `CONFIG_INVALID`。`LICENSE_MISSING` 不能替代运行必需资源。仅禁路径类 `config-only` 增量在离线非生产 `prepare` 中可为 `PREPARED`，`workflowDecision` 为 `indeterminable` / `publish-needed`；`npm-entry-closure` / `entry_missing` 触发 `GATE_FAILED`。Foundation 建议不是发布批准。

GitHub Git Data API `compare-and-swap` 绑定已观察分支头，远端授权不变。冻结安装 URL/ref/sha，安装后核对 name/version/载荷，门禁失败不写入。独立 checkpoint 批准；不支持回滚覆盖强推或重放旧计划。`ALREADY_CURRENT` 仍需核验。市场使用 `ifoohoo/skill-family-hub` 及 `release-skill@skill-family-hub`，旧独立市场弃用。

`release-finish`：Kimi 2.2.0 变动行/无换行与 0.40.1 旧确认措辞兼容，始终核精确 ID/完整帧/唯一选中项再提交。未知歧义/未移动/不完整/timeout/EOF 拒绝。共享环境 setup 按 `unitId/plugin/version` 归并，Claude/Codex 的不同物理 `skillFile` 不会分裂 setup 归属。一个已加载宿主的精确 setup 反馈可满足共享环境，但各宿主安装加载专属配置分别核，反馈绑定 `host/unit/path/plan/config/root`。真正多插件归属仍须消歧；任一宿主失败则收尾为 `FAILED`，不改 `VERIFIED` / `DISTRIBUTED`。

`--host-coverage <file>` / `--observe-hosts` 仍可诊断。Codex 0.154.0 对 11 份真实 Skill 的原字节静态检查不证明安装、会话选择或业务通过。批准、发布和验证状态以对应计划、批准及执行记录为准。

Qoder 支持路径：`./adapters/qoder/skills/` 与 `./skills/`，核对 `name/version/skills`、包含性与载荷。私有 Hub 的 `RELEASE_SKILL_HUB_RELEASE_EVIDENCE` 必须由原始描述符指向已有普通文件的绝对路径，拒绝 `symlink`。交 `npm run release:check -- --release-evidence <file>` 核验。

冻结前 `prepare` / 新 `ship` 可重复 `--unit <id>`，默认全部；延期不进计划，不获状态。完整配置、生成物新鲜度及顶层 Hook 仍作用于全项目。`publicSourceAuthorityReceipt` 的 coordinator 与全部 subjects 必须共同选择。冻结后 `publish` / `reconcile` / `verify` / `distribute` 拒 `--unit`，只认 `plan.units`。

推荐 production ship 或转入新生产准备前核对 `testIntake`。缺失时默认推动 `skill-family-test:skill-family-test-plan` → 授权内 `skill-family-test:skill-family-test-run`。跳过须先征询，并取得本轮项目、版本、范围匹配的明确同意。沉默/拒绝/普通发布预授权/旧轮次、其他项目、版本或范围不匹配均不可跳过。本轮匹配答复可复用。不得把跳过写成测试已达标。只读路径只报告缺口。声明后仅生产 `prepare`：首次 `NEEDS_INPUT` / `exit13` 非正式候选，`--candidate` 续接才正式。候选不可 `approve` / `publish`，不能清除 `PARTIAL` / `PUBLISHED` / `VERIFIED`。轻量工作流和单元选择不免除项目级要求，未声明时原 hook 与完整门不变。非生产 `CONFIG_INVALID`；非交互 CLI 仍可选 `testIntake`，不新增选择参数。

每个单元必须声明 `previousPublicBaseline`；确认无前版为 `none`，否则为 `bound` + `repo/ref/commit`。`none` 不绕唯一性预检。Hook cache v2 仅绝对或真实 `cwd` 核验相对可执行身份复用；裸 `PATH` / `PATHEXT` / `Windows` / 观察不可用冷执行且失败关闭。隔离安装树仅宿主退出 + 隔离 + 扫描无并发才记录；附加链接记录不跟随，声明载荷 `symlink` 拒绝。

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

随后进入 `release-finish`，通过公共入口编排宿主更新、加载确认、已配置 setup 和源码分支检查。

```bash
node "$RELEASE_SKILL_LOCAL_FINISH_ENTRY" \
  --root <project-root> --plan <plan-path> --run <verify-or-postverify-run-path> \
  --finish --json
```

完整参数、反馈合同、宿主限制和 macOS Cursor 安装见 `release-finish`。仅有 `VERIFIED` 不构成本机写入、插件更新、分支合并或 setup 写入授权；收尾结果也不改写发布状态。

## 专用工作流路由

- 消费项目的 Cursor 场景配置、受控可执行目录、用户状态目录、结果不确定时的现场保留与复验，见 `release-verify`。 
- README、CHANGELOG 和双语说明的 `docs refresh` 演练、摘要确认与受管写入，见 `release-docs`。 
- VERIFIED 后的分支决定、宿主更新、加载反馈、setup 和源码检查，见 `release-finish`。 
- 纯配置变更，见 `release-config`。 
- 纯 marketplace 索引与快照变更，见 `release-marketplace`。

这些入口保留各自的参数、确认和失败关闭规则；help 不复制或放宽它们。

## 故障分诊

| 错误 | 处理 |
|------|------|
| Node.js 或 Git 缺失 | 读取 `missingRequired`，补齐依赖后重跑 help |
| npm/gh 缺失或未认证 | 本地准备仍可继续；生产发布前另行完成 gh、Git HTTPS credential 与 npm auth 检查 |
| CLI 入口缺失 | 确认 `$RELEASE_SKILL_ENTRY` 存在；缺失时重新安装插件 |
| 项目配置缺失 | 进入 `release-setup` 的只读发现，不直接生成或覆盖 README/配置 |
| assess 失败 | 运行 `release-assess` 的离线诊断并按错误码处理 |
| `PARTIAL` 或远端冲突 | 进入 `release-reconcile`，保留已经成功的 checkpoint |
| `testIntake` 返回 `NEEDS_INPUT` | 停留在给出的候选上补齐结果，再用 `--candidate` 续接。不要把候选文件交给 approve 或 publish |
| 文档、Cursor、宿主更新或本机收尾失败 | 转到上节对应专用 Skill，不在 help 中猜测恢复步骤 |

## 人类最终回复

纯问询或转交时短答：写明这次实际回答了什么、适用范围或转交理由、仍然有效的限制、以及下一步入口。已有 JSON 按既定输出格式在回复中呈现。`route` 分类、推荐命令和未执行动作保持为建议。栏目只收录当前命令或分支已经返回的事实；有内容才设标题，短答直接成段。

## 0.9.38：替代未发布计划

仅生产 `testIntake` 启用：项目、发布单元ID集合、目标版本及外部目标均相同，旧计划 `PREPARED` 且从未产生发布运行权威。已有首个运行状态或 `PARTIAL`、`PUBLISHED`、`VERIFIED` 均拒绝。替代不代表发布成功或独立验收。

首次 `prepare` 须显式指定 `--replace-unpublished-plan <path>`，选择本项目 `.release-skill/plans/<digest>.json` 不可变旧正式计划。首个新候选冻结前驱（旧计划），`--candidate` 续接不可后补前驱；重传不符前驱即拒绝。新候选用独立 `resultFile`，旧要求、判据、结果、计划、批准、运行全保留，由原接受方对新对象重新核收 `TEST`。

新正式计划排他原子写入 `plans/<digest>.json` 才生效；写前失败无效，写后即使最新计划指针、FROZEN 标记或证据封口失败，也不得恢复旧计划发布资格，保留失败记录，沿原幂等路径核对新权威。新计划须新批准，旧批准不可跨用；`approve`、`publish`、`ship` 拒绝已替代计划。已发布或部分发布走原恢复谱系，不得以替代冒充恢复。来源提交须与远端 `main` 精确相等，`TEST`、远端冲突和批准门不变。Foundation 0.25.0 机制不变；0.9.38 入口不承诺全局撤销任意旧软件。

字段、精确历史 writer 分支及失败处理见 `release-prepare`、`release-reconcile` 与[状态机](https://github.com/ifoohoo/release-skill/blob/release-skill-v0.9.38/references/01-state-machine.md)。
