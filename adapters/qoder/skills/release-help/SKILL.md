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
| 检查接入状态 | `release-setup`（调用 `setup --assess-adoption`） | `NOT_CONFIGURED` 表示尚未首次接入，不创建配置 |
| 分析配置、文档与发布就绪缺口 | `release-assess --offline` | 离线诊断，不运行构建或发布动作 |
| 核对历史记录 | `release-assess`（显式提供 plan/approval/run 文件） | 仅读取用户提供的文件，不重新扫描 |
| 读取已有证明 | `release-skill read-proof --proof-root <root> --proof <relative> --json`，只读现有文件、不扫描目标 | 三个只读入口可用 `--conclusion-output <absolute-path>` 排他输出共同证明 |

治理诊断只运行 `release-skill` 自身的只读检查，不调用目标 Skill、业务脚本、构建、钩子或发布动作；`prepare`、`verify`、`release-finish` 不充当静态治理入口。当用户要求实际接入或发布时，将已有授权带入对应原业务入口，各入口继续严格执行各自的确认、副作用披露与状态机规则。

## 0.11.0 能力与证据边界

- **四类工程材料边界**：项目配置区分公开正式资源（`publicFiles`：`sourceScope`、`from`、`to`、`mode`）、必需运行文件（`requiredPublicFiles`，须被同单元 `publicFiles[].to` 精确覆盖）、私有正式设计稿与非正式运行记录。公开不等于正式；私有内容由 `forbiddenPaths` 与 `forbiddenContentPatterns` 拦截，严禁写入 `publicFiles`。npm 载荷由 `package.json.files`、入口静态闭包与映射共同约束；`delivery.include` / `delivery.exclude` 只选宿主，不剔除必需运行文件。详见 [项目配置规范](https://github.com/ifoohoo/release-skill/blob/release-skill-v0.10.5/references/02-project-config.md) 与 `release-prepare`。
- **接入与工作流路由**：首次 `release-setup` 遇已有配置（`ALREADY_CONFIGURED` / `CONFIG_EXISTS`）绝不覆盖；增量调整先跑 `route`，纯配置走 `prepare --workflow config`，代码或混合改动走完整流程。底层绑定 Foundation 0.39.2 精确版本，单向核验 `--audit-conclusion` 与 `--eval-conclusion`（默认最低准入等级 `B`）。`REQUIRED_PUBLIC_FILE_MISSING` 仅由 `setup --assess-adoption` 报告，普通 `assess` 与 `prepare` 保持原生错误码（`PUBLIC_FILE_MISSING` / `CONFIG_INVALID`）。
- **冻结发布与多宿主核验**：GitHub 分支推进使用 Git Data API `compare-and-swap` 绑定已观察分支头；市场安装冻结 URL/ref/sha 并在安装后复核载荷，统一汇聚至 `ifoohoo/skill-family-hub`（`release-skill@skill-family-hub`）。`release-finish` 兼容 Kimi 终端核验、Claude/Codex 共享环境 `setup` 归并与 Qoder 双清单复验；单宿主更新失败仅将收尾标为 `FAILED`，绝不回退 `VERIFIED` 或 `DISTRIBUTED`。`--host-coverage <file>` 与 `--observe-hosts` 仅作只读诊断。批准、发布和验证状态以对应计划、批准及执行记录为准。
- **范围选择与基线完整性**：冻结前可用 `--unit <id>` 选择部分单元（含 `publicSourceAuthorityReceipt` 时须选齐 coordinator 与全部 subjects）；冻结后 `publish`、`reconcile`、`verify`、`distribute` 只认 `plan.units`。每单元须声明 `previousPublicBaseline`（`none` 或 `bound` + `repo/ref/commit`）。Hook cache v2 仅在可执行身份与输入指纹完整匹配时复用。
- **测试核收与可选跳过收据**：推荐 production ship 或新生产准备前须核对 `testIntake`。缺失时默认推动 `skill-family-test:skill-family-test-plan` 与授权范围内的 `skill-family-test:skill-family-test-run`。跳过前须先取得维护者明确同意；沉默、拒绝、预授权、旧轮次、其他项目、版本或范围不匹配均不可跳过，本轮匹配答复可复用，且不得把跳过写成测试已达标；只读路径只报告缺口。声明 `testIntake` 的项目仅支持生产 `prepare`（首次返回 `NEEDS_INPUT` / 退出码 13，补齐后用 `--candidate` 续接）；`optional: true` 项可凭 `explicitly_skipped` 收据（非空 `limitations`、严禁冒充 `passed`）记入 `skippedOptionalRequirementIds`。非交互 CLI 保持可选 `testIntake`，不新增选择参数。
- **钩子副作用确认与风险退出/退役**：标准只读钩子调用即执行；声明 `mutating: true` 或非只读 `sideEffects` 的钩子须披露命令与影响范围并经 `--acknowledge-hook-side-effects` 放行。已发布版本需紧急回退或整族退役时，用离线零远端写入的 `deprecate` / `retire` 生成通告收据、回退指南与 `skill-family-hub` 提案。
- **受控私有源与离线归档包**：默认公开模式锁定 `github.com` 与 `https://registry.npmjs.org`；内网源须配置 `policy.sourcePolicy.mode: "controlled-private"` 及 `allowedGitHosts`、`allowedNpmRegistries`，内嵌凭据 URL 或公私混发立即阻断。隔离环境用 `bundle-offline` 在仓外导出离线包（`.tgz`、`offline-manifest.json`、本地索引与 `OFFLINE-INSTALL.md`），安装前用 `verify-offline` 核验哈希、版本与零外网/零凭据残留。
- **供应链溯源签名与金丝雀/回滚**：`sign-provenance` 用原生 `Ed25519` 对 `plan.digest`、快照/产物哈希及 `skill-family-audit`、`skill-family-eval` 结论摘要签名（禁读仓内或软链私钥，零私钥落盘），`verify-provenance` 纯离线验签；`canary` 与 `rollback`（强制 `fallbackVersion < targetVersion` 并产出市场提案）实现离线渐进放量与回退治理。

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

`requiresApproval: true` 的 `postPublish` 钩子需要绑定 `(planDigest, hookId)` 的独立检查点批准（有效期最长 24 小时）。开发钩子无沙箱隔离：常规只读钩子随命令运行，声明了写或外部副作用的钩子必须经 `--acknowledge-hook-side-effects` 显式放行，help 不代用户作出授权。

外部写入按检查点推进，中断时记录 `PARTIAL`。禁止删远端标签、覆盖 Release、执行 npm unpublish 或从头强跑；统一用 `release-reconcile` 核对远端实况并幂等补齐未完成步骤，遇到已发布版本需紧急风险下线或整族退役时用 `deprecate` / `retire` 生成本地回退通告与市场提案。

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

字段、精确历史 writer 分支及失败处理见 `release-prepare`、`release-reconcile` 与[状态机规范](https://github.com/ifoohoo/release-skill/blob/release-skill-v0.10.5/references/01-state-machine.md)。
