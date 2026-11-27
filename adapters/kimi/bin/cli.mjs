#!/usr/bin/env node
// @feature FND-FR-001
// @feature FND-FR-005
// @feature FND-FR-023
// @feature FND-FR-025
// @decision FND-ADR-031
// @design FND-DES-002
import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readFileContained, resolveContained } from "skill-family-harness-node";
import { bundledProfilesRoot } from "./licensing.mjs";
import { checkEntriesAction } from "./entry-check.mjs";
import { checkHostLoadingAction } from "./host-loading-check.mjs";
import { checkSelectedArtifactsAction } from "./selected-artifact-check.mjs";
import { runSourceGeneratedCheck } from "./source-generated-check.mjs";
import { checkBranchFieldsAction, checkNativeEntryBindingsAction, checkNativeProjectionsAction, checkPublicSurfaceBindingsAction, checkSkillSurfaceBindingsAction } from "./static-contract-binding-check.mjs";
import { relockAction } from "./relock.mjs";
import { registerExistingAction } from "./register-existing.mjs";
import { checkReportAction, renderReportAction } from "./report.mjs";
import {
  COMMAND_SIDE_EFFECTS,
  KIT_EXIT_CODES,
  REFUSED_MUTATION_FLAGS,
  runCommand,
  TOP_LEVEL_COMMANDS,
} from "./index.mjs";
import { invalidParamsError, mutationModeError, unknownCommandError } from "./errors.mjs";
import { describeHost } from "./host-profiles.mjs";
import { buildHostAdapter, materializeHostBuild, planHost, probeHost, refuseHostApply } from "./host.mjs";
import { createProfessionalProof, readProfessionalProof } from "./professional-conclusion.mjs";
import {
  bumpInternalDependencyMin,
  checkSupportWorkspaceDependencies,
  describePublishTopology,
  formatDepsResolveReport,
  formatPublishTopologyReport,
  formatSupportLagReport,
  linkWorkspaceDependencies,
  resolveInternalDependencies,
  unlinkWorkspaceDependencies,
} from "./internal-dependencies.mjs";
import { checkSkillShadowing, formatSkillShadowingReport } from "./skill-shadowing-check.mjs";
import {
  collectMonitorSnapshot,
  DEFAULT_LOCK_WARN_MS,
  DEFAULT_MONITOR_PORT,
  DEFAULT_REGISTRY_PATH,
  ensureRuntimeMonitor,
  probeRuntimeMonitorHealth,
  registerMonitorTarget,
  serveRuntimeMonitorViaStudio,
} from "./runtime-monitor.mjs";
import { applyAdoption, formatAdoptApplyReport } from "./adopt-apply.mjs";
import {
  addAdoptedCapability,
  formatCapabilityReport,
  listAdoptedCapabilities,
  removeAdoptedCapability,
} from "./capability-cli.mjs";
import { checkPrereqs, formatPrereqsReport } from "./prereqs-check.mjs";
import {
  formatSimulatedHostReport,
  listSimulatedHosts,
  materializeSimulatedHostShims,
  runSimulatedHostMatrix,
} from "./host-simulator.mjs";
import { buildCapabilityAssessment } from "./capability-assessment.mjs";
import { QUALIFICATION_NOTICE, runQualification } from "./qualification.mjs";

/**
 * skill-family-engineering-kit CLI.
 *
 * Exactly four top-level commands exist; there is no fifth. The report layer
 * (FND-ADR-005) hangs under two of them as positional sub-actions —
 * `projection report` (render) and `check report` (graded diagnosis) — not as
 * a fifth command. Exit codes are stable: 0 = ok/clean, 1 = findings (check),
 * 2 = rejected/usage/mechanism error. Every refusal prints its registered
 * SFC code and stable kind.
 */

const HELP_TEXT = `skill-family-engineering-kit —— 构建期工程工具包（恰好四个顶层命令）

用法: skill-family-kit <command> [options]

命令（四且仅四）:
  scaffold     在空目录生成 Skill Family 项目骨架。
               副作用: 只向空目标目录写入骨架文件（原子写、路径收容）；
               非空或冲突目标被拒绝且不被触碰。
  adopt-plan   严格只读地规划存量仓采用与迁移闭环。
               副作用: 无 —— 不写任何文件（含临时文件），不运行 git 写命令，
               不改名、不触碰远端；输出精确写集、冲突、风险、旧实现退出清单、
               临时例外校验与迁移完成判定（JSON 到 stdout）。
  projection   投影受管生成物。
               副作用: 只写 manifest 授权且被目标声明为受管的路径；
               未授权路径、手写文件与越界路径一律拒绝（拒绝时零写入）。
               报告子动作: projection report 将调用方提交的 report-model 确定性渲染为
               中立 Markdown（FND-ADR-005）；默认只写 stdout，给定 --out/
               --binding 时只写这两个显式且被 --root 收容的路径（原子写）。
  check        契约/漂移/闭包/版本/文档事实/Git 前置状态诊断。
               副作用: 默认诊断及 runChecks/runEntryContractCheck 纯读取函数零写入，
               绝不自动修复，git 仅只读探测。declared 模式下，只有
               runCommand("check")/checkEntriesAction 包装入口在显式提供已有输出根
               和根内相对路径时独占创建一份结论；不建父目录、不覆盖既有项。
               check proof 只读解释本族证明；check proof-create 按同一排他规则
               从 Skill 审阅结果独占创建一份结论。
               check selected-artifacts 只读核对显式选集的已采用 Schema 与可信字节基准；
               仅输出 stdout，发现或不足退出 1，不执行目标或写文件。
               check branch-fields  核对指定 if 条件或直接比较表达式的字段与 Schema 声明；
               check public-surface-bindings  检查既有双入口共同协议的静态声明；
               check native-entry-bindings  检查共同源清单、平台清单与实际 Skill 的有限身份关系；
               check skill-surface-bindings  检查选定 Skill 与 Markdown 合同的四组直接声明关系；
               check native-projections  检查选定原生身份、完整 Skill 内容与资源字节；
               check source-generated 读取真实声明，比较同一映射的来源与生成根坐标；
               允许跨映射串联，动态或祖先含义不足，不运行生成器。
               报告子动作: check report 对一份已渲染报告做分级诊断：
               硬失败（SFC3001/3002/3003）计为发现（退出码 1）；
               风格告警只报告、绝不阻塞机器正确的报告。
               入口契约子动作: check entries 运行共享入口契约门禁
               （SFA-ENTRY-003/004/005/007 + SFA-CONTEXT-001/002），
               legacy 读取 skill-family.entry-contract.json；declared 从项目清单
               静态核对 engineering.entries，不运行目标文件。
               受控重锁子动作: check relock 运行受控 relock 事务（SG-36）：
               把新手写文件登记进 .foundation/file-registry.json，并以当前字节
               重算 skill-family.managed-file-lock.json（单次 fail-closed 事务；
               只写这两个收容状态文档，任何拒绝都零写入）。
               首次非空登记子动作: check register-existing 为已有非空工程生成
               三份闭世界登记（file-registry / project-manifest / managed-file-lock）。
               消费已确认的 profile 身份与调用方分类/engineering；重复执行幂等，
               冲突拒绝且零覆盖。不走 scaffold，也不把 adopt-plan 写成 apply。
               显式资格子动作: check qualification 仅在显式提供
               capability/request/bindings/native 后适配目录声明的能力特定入口，
               可在预检后调用能力特定的原生宿主。
               宿主加载子动作: check host-loading 按已校准宿主版本只读检查所选项目技能容器
               （Codex 0.154.0 的 .agents/skills，以及 Claude/Cursor/Kimi/WorkBuddy/CodeBuddy/Qoder/DSH
               各自精确版本的项目根类别）；不启动宿主、模型、hook 或脚本，零写入。
               受控写子动作（归口 adopt-plan，显式收容写入）:
               adopt-plan apply  复用 adopt-plan 探测结果，在不覆盖或删除已有业务文件的前提下补齐 skill-family.project-manifest.json、迁移清单与目录骨架。
               adopt-plan capability <list|add|remove>  管理 adoptedCapabilities，remove 时只读扫描项目内残留宿主投影与配置引用。
               adopt-plan deps <bump-min|--bump|--link-workspace|--unlink-workspace|resolve>  受控抬升内部依赖 minVersion 或管理支撑仓本地联调覆盖。
               内部依赖只读检查: check deps [resolve] [--root <dir>] [--workspace-root <dir>] [--topology] [--format <json|text>]  只读解析兼容版本（无参默认检查当前目录）、检查支撑仓滞后与输出第 0-3 层拓扑顺序。
               同名遮蔽排障: check shadowing（兼容 check check-shadowing）只读扫描项目/插件/用户多层技能目录，定位同名覆盖关系并给出修复建议。
               运行态无界面监控与工作台委托: check monitor <serve|ensure|register|snapshot>  只读观测 state-store 哈希链、token-lock 排他锁、supervise-process 子进程与执行计划；serve/ensure 轻量委托启动 skill-family-studio。
               按需能力只读查询: check capability [list]  只读查询已采用能力清单（修改能力须用 adopt-plan capability add|remove）。
               运行期前置环境体检: check prereqs（兼容 check check-prereqs）核验 Node.js / Python / 环境变量（零值回显）、SKILL.md 摘要一致性及业务仓温和基线提示。
               多宿主生命周期模拟: check host-sim <run|materialize-shims|list-hosts>  无需本机安装各家 CLI 或付费登录，在本地隔离沙箱内完成十大规范宿主八阶段全生命周期核验。

全局选项:
  --root <dir>  目标工作区根目录（默认当前目录）
  --help, -h    显示本帮助或单个命令的帮助

退出码: 0 成功/无发现；1 check 有发现；2 拒绝/用法/机制错误。
错误码复用 contracts 的 SFC* 体系（SFC2002/SFC2003/SFC2004 + 稳定 details.kind；
报告层硬失败使用 SFC3001/SFC3002/SFC3003）。
禁止项: git init/commit/push/tag、发布、删除、远端写入；不存在第五个顶层命令。
`;

const COMMAND_HELP_SIDE_EFFECTS_ZH = Object.freeze({
  scaffold:
    "仅向空目标目录（或父目录已存在的不存在路径）写入骨架文件；全部写入均为原子写且严格路径收容，非空或冲突目标在写入前直接拒绝。",
  "adopt-plan":
    "默认规划模式无任何写入——严格只读：不写任何文件（含临时文件），不执行 git 写命令，不改名、不触碰远端，将写集、冲突、风险、旧实现退出清单、临时例外校验与完成判定输出至 stdout；仅当显式调用 apply、capability add/remove 或 deps bump-min/--link-workspace/--unlink-workspace 子动作时，才在收容边界内写入对应清单与覆盖状态文件。",
  projection:
    "仅写入或清理 manifest 显式授权且归属本工程的受管业务生成物；Windows 在显式投影合同下还可能创建邻接暂存目录并保留 .foundation-file-apply 日志与前后对照材料（恢复原状不等于零写入）；报告子动作（projection report）仅写入 --root 收容范围内显式指定的 --out/--binding 路径（未传 --out 时只输出至 stdout）；未授权、手写、越界或冲突路径一律在变更前拒绝。",
  check:
    "默认诊断及纯函数 runChecks/runEntryContractCheck 零写入，绝不自动修复，git 仅执行单次只读状态探测；declared 策略下，仅 runCommand('check') 与 checkEntriesAction 包装入口在调用方显式提供已有输出根与根内收容相对路径时独占创建一份结论，绝不建父目录、不覆盖既有条目；check proof 只读解释证明且零写入，check proof-create 按同一排他规则从审阅输入独占创建一份结论；check host-loading 与 check selected-artifacts 均严格只读，零写入、不启动外部进程、不访问网络；check relock 仍为独立显式的受控写事务；check register-existing 仍为独立显式的首次非空三份闭世界文档登记写入，绝不覆盖字节不匹配的既有文件；check qualification 仍为独立显式入口，仅在预检通过后方可调用能力绑定的原生宿主。Foundation 自身不发起网络请求，沙箱与出网控制由调用方及运行环境负责。",
});

function commandHelp(command) {
  const sideEffect = COMMAND_SIDE_EFFECTS[command];
  const sideEffectZh = COMMAND_HELP_SIDE_EFFECTS_ZH[command] ?? sideEffect.sideEffect;
  const details = {
    scaffold: [
      "选项:",
      "  --root <dir>          目标目录（必须为空，或其父目录存在的不存在路径）",
      "  --project-id <id>     kebab-case 项目 id（默认取目录名）",
      "  --project-name <name> 人类可读项目名（默认同 id）",
      "  --profile <id>        Profile id（默认 generic）",
      "  --licensing-profile <id> 许可证 Profile id（默认 registry 第一个变体）",
      "  --licensing-variant <id> 多变体 Profile 的必选变体 id",
      "  --profiles-root <dir> 许可证 Profile 根目录",
      "  --capability <id>      可重复的稳定能力 ID（重复值会去重并按 ASCII 排序）",
      "",
      "宿主构建: skill-family-kit scaffold host-build --root <workspace> --host <id>",
      "  --path-category <id> --input <relpath> --out <relpath> [--hosts-root <dir>]",
      "  将完整 source closure 逐字节写入 sibling staging，验证后一次 rename；目标必须不存在。",
    ],
    "adopt-plan": [
      "选项:",
      "  --root <dir>          目标工作区（默认当前目录）",
      "  --project-id <id>     计划采用的项目 id（默认取目录名）",
      "  --profile <id>        目标 Profile id（默认 generic）",
      "  --licensing-profile <id> 许可证 Profile id（默认 registry 第一个变体）",
      "  --licensing-variant <id> 多变体 Profile 的必选变体 id",
      "  --profiles-root <dir> 许可证 Profile 根目录",
      "  --no-git-spawn        禁用只读 git status 探测，仅用文件系统事实",
      "  --engineering-baseline <relative-json-path>  工程基线合同（须与 --compare-skeleton 成对）",
      "  --compare-skeleton    只读比较基线参考骨架与目标结构",
      "",
      "  能力查询（仍属于 adopt-plan，不增加顶层命令）:",
      "  --list-capabilities --locale <en|zh-CN>",
      "    覆盖: --all --scope <scope>",
      "    项目评估: --all --scope <scope> --uses <relative-json-path>",
      "    单需求: [--scope <scope>] [--filter <text>] [--limit <1..10>]",
      "    精确展开: --capability <exact-id>",
      "",
      "只读宿主子动作: host-describe | host-probe | host-plan | host-apply",
      "  host-probe 默认不执行进程；仅 --allow-host-spawn + --host-executable <绝对路径> 可启用受审计版本向量；",
      "  host-plan 必须显式提供 --build-manifest/--probe-facts，绝不隐式探测；",
      "  host-apply 在本阶段稳定拒绝，且不会产生占位文件或临时目录。",
      "",
      "迁移闭环（FND-070）: 只读读取目标仓 skill-family.migration.json",
      "  （旧实现退出清单 + 临时例外）；例外缺 owner/reason/deadline/",
      "  migrationTarget 任一字段即计为冲突；到期例外不自动续期；",
      "  旧实现未全部退出时完成判定恒为 false（双轨接入不算完成）。",
      "",
      "显式写子动作（归口 adopt-plan，严禁放入只读 check）:",
      "  adopt-plan apply [--root <dir>] [--dry-run] [--update-manifest] [--format <json|text>]",
      "  adopt-plan capability <list | add --id <cap> | remove --id <cap>> [--root <dir>] [--dry-run] [--format <json|text>]",
      "  adopt-plan deps bump-min [--root <dir>] --package <pkg> --to <ver> [--verified-ceiling <ver>] [--clear-ceiling] [--allow-major-upgrade] [--json]",
      "  adopt-plan deps --bump [--root <dir>] --package <pkg> --to <ver> [...]",
      "  adopt-plan deps --link-workspace <sourceRoot> [--root <dir>] [--package <pkg>]... [--dry-run] [--json]",
      "  adopt-plan deps --unlink-workspace [--root <dir>] [--dry-run] [--json]",
    ],
    projection: [
      "选项:",
      "  --root <dir>          目标工作区（默认当前目录）",
      "  --manifest <relpath>  投影 manifest 相对路径（默认 skill-family.projection.json）",
      "  --operation-id <uuid>：小写UUIDv4，唯一标识本次投影，Windows必填",
      "  --validation-timeout-ms <ms>：十进制整数，1至2147483647毫秒，Windows必填",
      "  --cooperative-writers：无值开关，出现即为true，Windows必填",
      "  Windows运行必须完整提供三参数，缺一即拒绝，包括no-op；POSIX显式提供任一即拒绝",
      "  CLI中三参数不得重复，report子动作不接受任何三项参数",
      "  Windows 整个调用受合作式独占覆盖，目录准备、文件应用、验证与清理均需独占访问",
      "  Kit允许邻接暂存及恢复根/日志/before-after材料保留，失败可能不清理",
      "  恢复不等于零写入，机制材料保留需明确报告，不可默认为空",
      "",
      "报告子动作: skill-family-kit projection report [options]",
      "  --model <relpath>     经 Contracts 验证的 report-model JSON（必填）",
      "  --result <relpath>    机器结果 JSON（必填，仅用于摘要和错误绑定核对）",
      "  --out <relpath>       报告 Markdown 输出路径；缺省时 Markdown 只写 stdout",
      "  --binding <relpath>   同时写出 report-binding JSON（model/result/report 三摘要）",
      "  确定性: 同一 report-model 反复渲染字节一致；Harness 不推导状态、不补造事实。",
    ],
    check: [
      "分支字段: skill-family-kit check branch-fields --root <dir> --selection <rel> --json",
      "双入口协议: skill-family-kit check public-surface-bindings --root <dir> --selection <rel> --json",
      "原生入口身份: skill-family-kit check native-entry-bindings --root <dir> --selection <rel> --json",
      "Skill 文本声明: skill-family-kit check skill-surface-bindings --root <dir> --selection <rel> --json",
      "原生投影: skill-family-kit check native-projections --root <dir> --selection <rel> --json",
      "方向检查: skill-family-kit check source-generated --root <dir> --declaration <rel> --json",
      "  仅比较真实声明内同一映射的固定根相等；跨映射串联允许，祖先或动态坐标记为不足。",
      "选集检查: skill-family-kit check selected-artifacts --root <dir> --selection <rel> --json",
      "  选集文件仅含 artifacts；真实读取文档与 Schema，核对可信 SHA256，不扫描整树或执行目标。",
      "  完整无发现退出 0；发现或不足退出 1；用法或未处理机制错误退出 2。",
      "",
      "登记子动作: skill-family-kit check relock --root <dir> [--files <relative-paths>]",
      "  --registration-class <handwritten|trackedToolLocks|artifacts>  登记类别，默认 handwritten",
      "  trackedToolLocks 必须提供非空 --files 清单，只登记路径，不锁定工具锁内容。",
      "  artifacts 必须提供非空 --files 精确根锚定忽略项，可含未来运行目录。",
      "",
      "首次非空登记: skill-family-kit check register-existing --root <dir> --handwritten <globs>",
      "  --engineering <json>  可选，现有 project-manifest.engineering 对象",
      "  --tracked-tool-locks <paths>  可选，已存在的持久工具锁路径",
      "  --artifacts <patterns>  可选，额外忽略模式；不得把已跟踪生成物列为忽略运行目录",
      "  目标必须已有合法 profile.json；三份登记全部缺失则独占创建，全部匹配则幂等，其它情况拒绝零覆盖。",
      "",
      "选项:",
      "  --root <dir>          目标工作区（默认当前目录）",
      "  --only <class>        只运行一个诊断类: contracts|drift|closure|version|docs|git|identity|boundary|platform",
      "  --profiles-root <dir> 许可证 Profile 根目录",
      "  --no-git-spawn        禁用只读 git status 探测，仅用文件系统事实",
      "  --policy <legacy|declared>  检查政策；declared 版本检查须与 --only version 配对",
      "  --conclusion-root <dir>    专业结论输出根（须与 --conclusion-output 配对）",
      "  --conclusion-output <rel>  在输出根内独占创建专业结论文件",
      "",
      "证明读取子动作: skill-family-kit check proof --proof-root <dir> --proof <rel> --json",
      "  读取本族共同证明并解释领域码；不扫描目标、不追随 details 中的路径、不鉴伪。",
      "  退出 0 表示证明记载通过；1 表示证明记载未通过；2 表示无法读取或解释。",
      "",
      "出证子动作: skill-family-kit check proof-create --review-root <dir> --review-input <rel>",
      "  --conclusion-root <dir> --conclusion-output <rel> --json",
      "  把 foundation-engineering-check 的静态审阅结果投影为共同证明；不鉴伪、不重新审阅。",
      "  独占创建，不覆盖既有文件，不建父目录。",
      "",
      "报告子动作: skill-family-kit check report [options]",
      "  --report <relpath>    已渲染报告 Markdown（必填，只读）",
      "  --model <relpath>     对应 report-model JSON（必填，只读）",
      "  --result <relpath>    对应机器结果 JSON（必填，只读；核对 digest/errors）",
      "  --binding <relpath>   可选 report-binding JSON；摘要过期即 SFC3001",
      "  分级: 硬失败（SFC3001/3002/3003）计为发现，退出码 1；",
      "  风格告警（超长句/重复段/翻译腔/未解释术语）只报告、绝不改变判定。",
      "",
      "显式资格子动作: skill-family-kit check qualification [options]",
      "  --root <dir>          消费方工作区（--request/--bindings 文件必须收容其中）",
      "  --capability <id>     foundation.kit.plugin-verification 或 foundation.kit.skill-family-directory-verification",
      "  --request <relpath>   受注册合同约束的 plugin-verification-request 或目录 request JSON",
      "  --bindings <relpath>  受对应固定资格入口约束的私有绑定 JSON",
      "  --native              显式确认允许本次真实资格；缺失即零宿主副作用。",
      "",
      "宿主加载子动作: skill-family-kit check host-loading [options]",
      "  --root <dir>          绝对或可解析的项目工作目录（默认当前目录）",
      "  --host <id>           宿主 id（codex 或已校准七宿主之一）",
      "  --host-version <ver>  精确版本（Codex 0.154.0 或对应已校准原生版本）",
      "  --path-category <id>  发现形态（codex-project-skills 或对应已校准项目根类别）",
      "  --activation-rules <relpath>  仅 Codex：根内相对 JSON，有序 name XOR path + enabled 规则；其他宿主仅允许省略或 null",
      "  --hosts-root <dir>    可选宿主 Profile 根；缺省为包内 bundledHostProfilesRoot()",
      "",
      "内部依赖只读检查与拓扑: skill-family-kit check deps [resolve] [--root <dir>] [--catalog <json-path>] [--workspace-root <sourceRoot>] [--topology] [--format <json|text>] [--json]",
      "  check deps [resolve] [--root <dir>] [--catalog <json-path>] [--session-id <id>] [--receipt-out <relpath>] [--format <json|text>] [--json]（无参默认解析当前目录）",
      "  check deps --workspace-root <sourceRoot> [--format <json|text>] [--json]  扫描支撑层仓库落后基线（发现滞后退出 1）",
      "  check deps --topology [--workspace-root <sourceRoot>] [--format <json|text>] [--json]  输出第 0-3 层发版拓扑顺序",
      "  （写动作 bump-min / --link-workspace / --unlink-workspace 请改用 adopt-plan deps）",
      "",
      "同名技能遮蔽排障: skill-family-kit check shadowing（兼容 check check-shadowing）",
      "  [--root <dir>] [--plugin-root <dir>]... [--user-home <dir>] [--host <id>] [--hosts-root <dir>]",
      "  [--layer <scope:dir>]... [--format <json|markdown>] [--json]",
      "",
      "运行态无界面监控与工作台委托: skill-family-kit check monitor <serve|ensure|register|snapshot>",
      "  check monitor serve [--root <dir>] [--port <0..65535>] [--registry <path>] [--lock-warn-ms <ms>] [--allowed-root <dir>]...（委托 skill-family-studio，未安装时回退 JSON 摘要）",
      "  check monitor ensure [--root <dir>] [--port <0..65535>] [--registry <path>] [--id <id> --title <name>] [--state-dir <dir>] [--plan <file>] [--runs-dir <dir>] [--lock-path <path>]... [--no-spawn]",
      "  check monitor register [--root <dir>] [--port <0..65535>] [--registry <path>] --id <id> --title <name> [--state-dir <dir>] [--plan <file>] [--runs-dir <dir>] [--lock-path <path>]...",
      "  check monitor snapshot [--root <dir>] [--registry <path>] [--lock-warn-ms <ms>] [--target <id>] [--json]",
      "",
      "按需能力只读查询: skill-family-kit check capability [list] [--root <dir>] [--format <json|text>]",
      "运行期前置环境体检: skill-family-kit check prereqs（兼容 check check-prereqs）[--root <dir>] [--require-python] [--require-env <VAR>]... [--skill-file <path> --loaded-sha256 <hex>] [--latest-versions <json-or-file>] [--format <json|text>]",
      "多宿主全生命周期模拟器: skill-family-kit check host-sim <run|materialize-shims|list-hosts>",
      "  check host-sim run --root <skill-or-plugin-dir> [--hosts <all|claude,codex,antigravity,...>] [--output <receipt.json>] [--prompt <text>] [--format <json|text>]",
      "  check host-sim materialize-shims --output-dir <dir> [--hosts <all|claude,codex,antigravity,...>] [--json]",
      "  check host-sim list-hosts [--json]",
    ],
  };
  return [
    `${command} —— ${sideEffect.summary}`,
    `副作用: ${sideEffectZh}`,
    "",
    ...details[command],
    "",
    `退出码: ${sideEffect.exitCodes}`,
  ].join("\n");
}

function printError(error) {
  const code = error && error.code ? error.code : "SFC2004";
  const kind = error && error.details && error.details.kind ? ` (${error.details.kind})` : "";
  process.stderr.write(`[kit] ${code}${kind}: ${error && error.message ? error.message : String(error)}\n`);
}

function parseOptions(argv, spec) {
  const options = {};
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (REFUSED_MUTATION_FLAGS.includes(arg)) {
      throw mutationModeError(arg, spec.command);
    }
    if (arg === "--help" || arg === "-h") {
      if (seen.has("help")) {
        throw invalidParamsError(`duplicate option for '${spec.command}': --help`, { reason: "duplicate-option", flag: "--help" });
      }
      seen.add("help");
      options.help = true;
      continue;
    }
    const flagSpec = spec.flags[arg];
    if (!flagSpec) {
      throw invalidParamsError(`unknown option for '${spec.command}': ${arg}`, { flag: arg, reason: "unknown-option" });
    }
    if ((spec.rejectDuplicates || flagSpec.rejectDuplicate) && seen.has(arg) && !flagSpec.repeat) {
      throw invalidParamsError(`duplicate option for '${spec.command}': ${arg}`, { reason: "duplicate-option", flag: arg });
    }
    seen.add(arg);
    if (flagSpec.value) {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) {
        throw invalidParamsError(`option ${arg} requires a value`, { flag: arg, reason: "missing-option-value" });
      }
      if (flagSpec.repeat) {
        if (!Array.isArray(options[flagSpec.key])) options[flagSpec.key] = [];
        options[flagSpec.key].push(value);
      } else {
        options[flagSpec.key] = value;
      }
    } else {
      options[flagSpec.key] = true;
    }
  }
  return options;
}

const COMMAND_SPECS = {
  scaffold: {
    rejectDuplicates: true,
    flags: {
      "--root": { key: "root", value: true },
      "--project-id": { key: "projectId", value: true },
      "--project-name": { key: "projectName", value: true },
      "--profile": { key: "profileId", value: true },
      "--licensing-profile": { key: "licensingProfile", value: true },
      "--licensing-variant": { key: "licensingVariant", value: true },
      "--profiles-root": { key: "profilesRoot", value: true },
      "--capability": { key: "capabilities", value: true, repeat: true },
      "--engineering": { key: "engineeringJson", value: true },
    },
  },
  "adopt-plan": {
    flags: {
      "--root": { key: "root", value: true },
      "--project-id": { key: "projectId", value: true },
      "--project-name": { key: "projectName", value: true },
      "--profile": { key: "profileId", value: true },
      "--licensing-profile": { key: "licensingProfile", value: true },
      "--licensing-variant": { key: "licensingVariant", value: true },
      "--profiles-root": { key: "profilesRoot", value: true },
      "--no-git-spawn": { key: "noGitSpawn", value: false },
      "--engineering-baseline": { key: "engineeringBaselinePath", value: true },
      "--engineering": { key: "engineeringJson", value: true },
      "--compare-skeleton": { key: "compareSkeleton", value: false },
      "--list-capabilities": { key: "listCapabilities", value: false },
      "--scope": { key: "scope", value: true },
      "--locale": { key: "locale", value: true },
      "--all": { key: "all", value: false },
      "--uses": { key: "uses", value: true },
      "--filter": { key: "filter", value: true },
      "--capability": { key: "capability", value: true },
      "--limit": { key: "limit", value: true },
    },
  },
  projection: {
    flags: {
      "--root": { key: "root", value: true },
      "--manifest": { key: "manifest", value: true },
      "--engineering": { key: "engineeringJson", value: true },
      "--operation-id": { key: "operationId", value: true, rejectDuplicate: true },
      "--validation-timeout-ms": { key: "validationTimeoutMs", value: true, rejectDuplicate: true },
      "--cooperative-writers": { key: "cooperativeWriters", value: false, rejectDuplicate: true },
    },
  },
  check: {
    flags: {
      "--root": { key: "root", value: true },
      "--only": { key: "only", value: true },
      "--policy": { key: "policy", value: true },
      "--conclusion-root": { key: "conclusionRoot", value: true },
      "--conclusion-output": { key: "conclusionOutputPath", value: true },
      "--profiles-root": { key: "profilesRoot", value: true },
      "--no-git-spawn": { key: "noGitSpawn", value: false },
    },
  },
  "projection report": {
    flags: {
      "--root": { key: "root", value: true },
      "--model": { key: "model", value: true },
      "--result": { key: "result", value: true },
      "--out": { key: "out", value: true },
      "--binding": { key: "binding", value: true },
    },
  },
  "check report": {
    flags: {
      "--root": { key: "root", value: true },
      "--report": { key: "report", value: true },
      "--model": { key: "model", value: true },
      "--result": { key: "result", value: true },
      "--binding": { key: "binding", value: true },
    },
  },
  "check entries": {
    flags: {
      "--root": { key: "root", value: true },
      "--policy": { key: "policy", value: true },
      "--conclusion-root": { key: "conclusionRoot", value: true },
      "--conclusion-output": { key: "conclusionOutputPath", value: true },
    },
  },
  "check relock": {
    flags: {
      "--root": { key: "root", value: true },
      "--files": { key: "files", value: true },
      "--registration-class": { key: "registrationClass", value: true },
    },
  },
  "check register-existing": {
    rejectDuplicates: true,
    flags: {
      "--root": { key: "root", value: true },
      "--handwritten": { key: "handwritten", value: true },
      "--engineering": { key: "engineeringJson", value: true },
      "--tracked-tool-locks": { key: "trackedToolLocks", value: true },
      "--artifacts": { key: "artifacts", value: true },
    },
  },
  "check qualification": {
    rejectDuplicates: true,
    flags: {
      "--root": { key: "root", value: true },
      "--capability": { key: "capability", value: true },
      "--request": { key: "requestPath", value: true },
      "--bindings": { key: "bindingsPath", value: true },
      "--native": { key: "native", value: false },
    },
  },
  "check host-loading": {
    rejectDuplicates: true,
    flags: {
      "--root": { key: "root", value: true },
      "--host": { key: "hostId", value: true },
      "--host-version": { key: "hostVersion", value: true },
      "--path-category": { key: "pathCategory", value: true },
      "--activation-rules": { key: "activationRulesPath", value: true },
      "--hosts-root": { key: "hostsRoot", value: true },
    },
  },
  "check proof": {
    flags: {
      "--proof-root": { key: "proofRoot", value: true },
      "--proof": { key: "proof", value: true },
      "--json": { key: "json", value: false },
    },
  },
  "check selected-artifacts": {
    flags: {
      "--root": { key: "root", value: true },
      "--selection": { key: "selection", value: true },
      "--json": { key: "json", value: false },
    },
  },
  "check branch-fields": {
    flags: {
      "--root": { key: "root", value: true },
      "--selection": { key: "selection", value: true },
      "--json": { key: "json", value: false },
    },
  },
  "check public-surface-bindings": {
    flags: {
      "--root": { key: "root", value: true },
      "--selection": { key: "selection", value: true },
      "--json": { key: "json", value: false },
    },
  },
  "check native-entry-bindings": {
    flags: {
      "--root": { key: "root", value: true },
      "--selection": { key: "selection", value: true },
      "--json": { key: "json", value: false },
    },
  },
  "check skill-surface-bindings": {
    flags: {
      "--root": { key: "root", value: true },
      "--selection": { key: "selection", value: true },
      "--json": { key: "json", value: false },
    },
  },
  "check native-projections": {
    flags: {
      "--root": { key: "root", value: true },
      "--selection": { key: "selection", value: true },
      "--json": { key: "json", value: false },
    },
  },
  "check source-generated": {
    flags: {
      "--root": { key: "root", value: true },
      "--declaration": { key: "declaration", value: true },
      "--json": { key: "json", value: false },
    },
  },
  "check proof-create": {
    flags: {
      "--review-root": { key: "reviewRoot", value: true },
      "--review-input": { key: "reviewInput", value: true },
      "--conclusion-root": { key: "conclusionRoot", value: true },
      "--conclusion-output": { key: "conclusionOutputPath", value: true },
      "--json": { key: "json", value: false },
    },
  },
  "check deps": {
    rejectDuplicates: true,
    flags: {
      "--root": { key: "root", value: true },
      "--catalog": { key: "catalogPath", value: true },
      "--session-id": { key: "sessionId", value: true },
      "--resolved-at": { key: "resolvedAt", value: true },
      "--receipt-out": { key: "receiptOut", value: true },
      "--workspace-root": { key: "workspaceRoot", value: true },
      "--topology": { key: "topology", value: false },
      "--format": { key: "format", value: true },
      "--json": { key: "json", value: false },
    },
  },
  "adopt-plan deps": {
    flags: {
      "--root": { key: "root", value: true, rejectDuplicate: true },
      "--bump": { key: "bump", value: false, rejectDuplicate: true },
      "--package": { key: "packages", value: true, repeat: true },
      "--to": { key: "toVersion", value: true, rejectDuplicate: true },
      "--verified-ceiling": { key: "verifiedCeiling", value: true, rejectDuplicate: true },
      "--clear-ceiling": { key: "clearCeiling", value: false, rejectDuplicate: true },
      "--allow-major-upgrade": { key: "allowMajorUpgrade", value: false, rejectDuplicate: true },
      "--link-workspace": { key: "linkWorkspace", value: true, rejectDuplicate: true },
      "--unlink-workspace": { key: "unlinkWorkspace", value: false, rejectDuplicate: true },
      "--workspace-root": { key: "workspaceRoot", value: true, rejectDuplicate: true },
      "--catalog": { key: "catalogPath", value: true, rejectDuplicate: true },
      "--session-id": { key: "sessionId", value: true, rejectDuplicate: true },
      "--resolved-at": { key: "resolvedAt", value: true, rejectDuplicate: true },
      "--receipt-out": { key: "receiptOut", value: true, rejectDuplicate: true },
      "--dry-run": { key: "dryRun", value: false, rejectDuplicate: true },
      "--json": { key: "json", value: false, rejectDuplicate: true },
    },
  },
  "check shadowing": {
    flags: {
      "--root": { key: "root", value: true, rejectDuplicate: true },
      "--project-root": { key: "projectRoot", value: true, rejectDuplicate: true },
      "--plugin-root": { key: "pluginRoots", value: true, repeat: true },
      "--user-home": { key: "userHome", value: true, rejectDuplicate: true },
      "--host": { key: "hostId", value: true, rejectDuplicate: true },
      "--hosts-root": { key: "hostsRoot", value: true, rejectDuplicate: true },
      "--layer": { key: "layerSpecs", value: true, repeat: true },
      "--format": { key: "format", value: true, rejectDuplicate: true },
      "--json": { key: "json", value: false, rejectDuplicate: true },
    },
  },
  "check monitor serve": {
    flags: {
      "--root": { key: "root", value: true, rejectDuplicate: true },
      "--port": { key: "port", value: true, rejectDuplicate: true },
      "--registry": { key: "registryPath", value: true, rejectDuplicate: true },
      "--lock-warn-ms": { key: "lockWarnMs", value: true, rejectDuplicate: true },
      "--allowed-root": { key: "allowedRoots", value: true, repeat: true },
      "--workbench-url": { key: "workbenchUrl", value: true, rejectDuplicate: true },
      "--json": { key: "json", value: false, rejectDuplicate: true },
    },
  },
  "check monitor ensure": {
    flags: {
      "--root": { key: "root", value: true, rejectDuplicate: true },
      "--port": { key: "port", value: true, rejectDuplicate: true },
      "--registry": { key: "registryPath", value: true, rejectDuplicate: true },
      "--lock-warn-ms": { key: "lockWarnMs", value: true, rejectDuplicate: true },
      "--id": { key: "id", value: true, rejectDuplicate: true },
      "--title": { key: "title", value: true, rejectDuplicate: true },
      "--badge": { key: "badge", value: true, rejectDuplicate: true },
      "--description": { key: "description", value: true, rejectDuplicate: true },
      "--state-dir": { key: "stateDir", value: true, rejectDuplicate: true },
      "--plan": { key: "planPath", value: true, rejectDuplicate: true },
      "--runs-dir": { key: "runsDir", value: true, rejectDuplicate: true },
      "--lock-path": { key: "lockPaths", value: true, repeat: true },
      "--allowed-root": { key: "allowedRoots", value: true, repeat: true },
      "--no-spawn": { key: "noSpawn", value: false, rejectDuplicate: true },
      "--timeout-ms": { key: "timeoutMs", value: true, rejectDuplicate: true },
      "--json": { key: "json", value: false, rejectDuplicate: true },
    },
  },
  "check monitor register": {
    flags: {
      "--root": { key: "root", value: true, rejectDuplicate: true },
      "--port": { key: "port", value: true, rejectDuplicate: true },
      "--registry": { key: "registryPath", value: true, rejectDuplicate: true },
      "--id": { key: "id", value: true, rejectDuplicate: true },
      "--title": { key: "title", value: true, rejectDuplicate: true },
      "--badge": { key: "badge", value: true, rejectDuplicate: true },
      "--description": { key: "description", value: true, rejectDuplicate: true },
      "--state-dir": { key: "stateDir", value: true, rejectDuplicate: true },
      "--plan": { key: "planPath", value: true, rejectDuplicate: true },
      "--runs-dir": { key: "runsDir", value: true, rejectDuplicate: true },
      "--lock-path": { key: "lockPaths", value: true, repeat: true },
      "--allowed-root": { key: "allowedRoots", value: true, repeat: true },
      "--json": { key: "json", value: false, rejectDuplicate: true },
    },
  },
  "check monitor snapshot": {
    flags: {
      "--root": { key: "root", value: true, rejectDuplicate: true },
      "--registry": { key: "registryPath", value: true, rejectDuplicate: true },
      "--lock-warn-ms": { key: "lockWarnMs", value: true, rejectDuplicate: true },
      "--target": { key: "targetFilter", value: true, rejectDuplicate: true },
      "--allowed-root": { key: "allowedRoots", value: true, repeat: true },
      "--json": { key: "json", value: false, rejectDuplicate: true },
    },
  },
  "scaffold host-build": {
    flags: {
      "--root": { key: "root", value: true },
      "--host": { key: "hostId", value: true },
      "--path-category": { key: "pathCategoryId", value: true },
      "--input": { key: "input", value: true },
      "--out": { key: "out", value: true },
      "--hosts-root": { key: "hostsRoot", value: true },
    },
  },
  "adopt-plan host-describe": {
    flags: { "--host": { key: "hostId", value: true }, "--hosts-root": { key: "hostsRoot", value: true } },
  },
  "adopt-plan host-probe": {
    flags: {
      "--host": { key: "hostId", value: true },
      "--hosts-root": { key: "hostsRoot", value: true },
      "--allow-host-spawn": { key: "allowHostSpawn", value: false },
      "--host-executable": { key: "hostExecutable", value: true },
    },
  },
  "adopt-plan host-plan": {
    flags: {
      "--root": { key: "root", value: true },
      "--host": { key: "hostId", value: true },
      "--path-category": { key: "pathCategoryId", value: true },
      "--build-manifest": { key: "buildManifest", value: true },
      "--probe-facts": { key: "probeFacts", value: true },
      "--hosts-root": { key: "hostsRoot", value: true },
    },
  },
  "adopt-plan host-apply": { flags: {} },
  "adopt-plan apply": {
    flags: {
      "--root": { key: "root", value: true, rejectDuplicate: true },
      "--project-id": { key: "projectId", value: true, rejectDuplicate: true },
      "--project-name": { key: "projectName", value: true, rejectDuplicate: true },
      "--profile": { key: "profileId", value: true, rejectDuplicate: true },
      "--licensing-profile": { key: "licensingProfile", value: true, rejectDuplicate: true },
      "--licensing-variant": { key: "licensingVariant", value: true, rejectDuplicate: true },
      "--profiles-root": { key: "profilesRoot", value: true, rejectDuplicate: true },
      "--capability": { key: "capabilities", value: true, repeat: true },
      "--no-git-spawn": { key: "noGitSpawn", value: false, rejectDuplicate: true },
      "--dry-run": { key: "dryRun", value: false, rejectDuplicate: true },
      "--update-manifest": { key: "updateManifest", value: false, rejectDuplicate: true },
      "--format": { key: "format", value: true, rejectDuplicate: true },
      "--json": { key: "json", value: false, rejectDuplicate: true },
    },
  },
  "check capability": {
    flags: {
      "--root": { key: "root", value: true, rejectDuplicate: true },
      "--format": { key: "format", value: true, rejectDuplicate: true },
      "--json": { key: "json", value: false, rejectDuplicate: true },
    },
  },
  "adopt-plan capability list": {
    flags: {
      "--root": { key: "root", value: true, rejectDuplicate: true },
      "--format": { key: "format", value: true, rejectDuplicate: true },
      "--json": { key: "json", value: false, rejectDuplicate: true },
    },
  },
  "adopt-plan capability add": {
    flags: {
      "--root": { key: "root", value: true, rejectDuplicate: true },
      "--id": { key: "id", value: true, rejectDuplicate: true },
      "--dry-run": { key: "dryRun", value: false, rejectDuplicate: true },
      "--format": { key: "format", value: true, rejectDuplicate: true },
      "--json": { key: "json", value: false, rejectDuplicate: true },
    },
  },
  "adopt-plan capability remove": {
    flags: {
      "--root": { key: "root", value: true, rejectDuplicate: true },
      "--id": { key: "id", value: true, rejectDuplicate: true },
      "--dry-run": { key: "dryRun", value: false, rejectDuplicate: true },
      "--format": { key: "format", value: true, rejectDuplicate: true },
      "--json": { key: "json", value: false, rejectDuplicate: true },
    },
  },
  "check prereqs": {
    flags: {
      "--root": { key: "root", value: true, rejectDuplicate: true },
      "--require-python": { key: "requirePython", value: false, rejectDuplicate: true },
      "--require-env": { key: "requireEnv", value: true, repeat: true },
      "--skill-file": { key: "skillFile", value: true, rejectDuplicate: true },
      "--loaded-sha256": { key: "loadedSha256", value: true, rejectDuplicate: true },
      "--latest-versions": { key: "latestVersions", value: true, rejectDuplicate: true },
      "--format": { key: "format", value: true, rejectDuplicate: true },
      "--json": { key: "json", value: false, rejectDuplicate: true },
    },
  },
  "check host-sim run": {
    flags: {
      "--root": { key: "root", value: true, rejectDuplicate: true },
      "--hosts": { key: "hosts", value: true, rejectDuplicate: true },
      "--output": { key: "output", value: true, rejectDuplicate: true },
      "--prompt": { key: "prompt", value: true, rejectDuplicate: true },
      "--hosts-root": { key: "hostsRoot", value: true, rejectDuplicate: true },
      "--format": { key: "format", value: true, rejectDuplicate: true },
      "--json": { key: "json", value: false, rejectDuplicate: true },
    },
  },
  "check host-sim materialize-shims": {
    flags: {
      "--output-dir": { key: "outputDir", value: true, rejectDuplicate: true },
      "--hosts": { key: "hosts", value: true, rejectDuplicate: true },
      "--hosts-root": { key: "hostsRoot", value: true, rejectDuplicate: true },
      "--json": { key: "json", value: false, rejectDuplicate: true },
    },
  },
  "check host-sim list-hosts": {
    flags: {
      "--json": { key: "json", value: false, rejectDuplicate: true },
    },
  },
};

function conclusionOutputFromOptions(options) {
  const hasRoot = options.conclusionRoot !== undefined;
  const hasPath = options.conclusionOutputPath !== undefined;
  if (hasRoot !== hasPath) {
    throw invalidParamsError("--conclusion-root and --conclusion-output must be provided together", {
      reason: "invalid-option-combination",
    });
  }
  return hasRoot ? { root: options.conclusionRoot, path: options.conclusionOutputPath } : undefined;
}

async function readJson(root, relPath, label) {
  if (!relPath) throw invalidParamsError(`${label} is required`);
  try {
    return JSON.parse((await readFileContained(root, relPath)).toString("utf8"));
  } catch (cause) {
    if (cause?.code?.startsWith?.("SFC")) throw cause;
    throw invalidParamsError(`${label} must name valid JSON contained in --root`);
  }
}

async function readEngineeringBaselineJson(root, relPath) {
  if (
    typeof relPath !== "string"
    || relPath.length === 0
    || relPath.includes("\0")
    || path.posix.isAbsolute(relPath)
    || path.win32.isAbsolute(relPath)
  ) {
    throw invalidParamsError("--engineering-baseline must name a relative JSON path contained in --root", {
      flag: "--engineering-baseline",
      reason: "invalid-engineering-baseline-path",
    });
  }
  try {
    return JSON.parse((await readFileContained(root, relPath)).toString("utf8"));
  } catch {
    throw invalidParamsError("--engineering-baseline must name valid JSON contained in --root", {
      flag: "--engineering-baseline",
      reason: "invalid-engineering-baseline-json",
    });
  }
}

async function runCapabilityList(options) {
  const forbidden = [
    "projectId",
    "projectName",
    "profileId",
    "licensingProfile",
    "licensingVariant",
    "profilesRoot",
    "noGitSpawn",
    "engineeringBaselinePath",
    "engineeringJson",
    "compareSkeleton",
  ];
  if (forbidden.some((key) => options[key] !== undefined)) {
    throw invalidParamsError("adopt-plan capability query cannot use repository planning options", { reason: "invalid-option-combination" });
  }
  let mode;
  if (options.capability !== undefined) mode = "exact-capability";
  else if (options.all === true) mode = options.uses !== undefined ? "project-assessment" : "coverage";
  else mode = "incremental-query";
  const limit = options.limit === undefined ? undefined : Number(options.limit);
  const output = await buildCapabilityAssessment({
    mode,
    scope: options.scope,
    locale: options.locale,
    all: options.all,
    root: options.root ?? ".",
    usesPath: options.uses,
    filter: options.filter,
    capability: options.capability,
    limit,
  });
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return KIT_EXIT_CODES.ok;
}

async function runHostSubAction(command, action, rest) {
  const specName = `${command} ${action}`;
  try {
    if (action === "host-apply") refuseHostApply();
    const spec = COMMAND_SPECS[specName];
    const options = parseOptions(rest, { command: specName, flags: spec.flags });
    const hostsRoot = options.hostsRoot;
    let output;
    if (action === "host-describe") {
      output = await describeHost({ hostId: options.hostId, hostsRoot });
    } else if (action === "host-probe") {
      output = await probeHost({ hostId: options.hostId, hostsRoot, allowSpawn: options.allowHostSpawn === true, executable: options.hostExecutable });
    } else if (action === "host-build") {
      const root = options.root ?? ".";
      const input = await readJson(root, options.input, "--input");
      const build = await buildHostAdapter({ hostId: options.hostId, pathCategoryId: options.pathCategoryId, input, hostsRoot });
      if (build.status === "built") {
        if (!options.out) throw invalidParamsError("--out is required");
        const targetRoot = await resolveContained(root, options.out);
        await materializeHostBuild({ targetRoot, build });
      }
      output = build.status === "built" ? { status: "built", manifest: build.manifest, outputRoot: options.out } : build;
    } else if (action === "host-plan") {
      const root = options.root ?? ".";
      const buildManifest = await readJson(root, options.buildManifest, "--build-manifest");
      const probeDocument = await readJson(root, options.probeFacts, "--probe-facts");
      const probeFacts = Array.isArray(probeDocument) ? probeDocument : probeDocument.facts;
      output = await planHost({ hostId: options.hostId, pathCategoryId: options.pathCategoryId, buildManifest, probeFacts, hostsRoot });
    }
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return KIT_EXIT_CODES.ok;
  } catch (error) {
    printError(error);
    return KIT_EXIT_CODES.rejected;
  }
}

async function runReportSubAction(command, rest) {
  const specName = `${command} report`;
  try {
    const options = parseOptions(rest, { command: specName, flags: COMMAND_SPECS[specName].flags });
    if (options.help) {
      process.stdout.write(`${commandHelp(command)}\n`);
      return KIT_EXIT_CODES.ok;
    }
    const action = command === "projection" ? renderReportAction : checkReportAction;
    const { status, output } = await action({
      root: options.root,
      model: options.model,
      result: options.result,
      report: options.report,
      out: options.out,
      binding: options.binding,
    });
    if (output !== undefined) {
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    }
    if (status === "ok") return KIT_EXIT_CODES.ok;
    if (status === "findings") return KIT_EXIT_CODES.findings;
    return KIT_EXIT_CODES.rejected;
  } catch (error) {
    printError(error);
    return KIT_EXIT_CODES.rejected;
  }
}

async function runEntriesSubAction(rest) {
  const specName = "check entries";
  try {
    const options = parseOptions(rest, { command: specName, flags: COMMAND_SPECS[specName].flags });
    if (options.help) {
      process.stdout.write(`${commandHelp("check")}\n`);
      return KIT_EXIT_CODES.ok;
    }
    const { status, output } = await checkEntriesAction({
      root: options.root,
      policy: options.policy,
      conclusionOutput: conclusionOutputFromOptions(options),
    });
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (status === "ok") return KIT_EXIT_CODES.ok;
    if (status === "findings") return KIT_EXIT_CODES.findings;
    return KIT_EXIT_CODES.rejected;
  } catch (error) {
    printError(error);
    return KIT_EXIT_CODES.rejected;
  }
}

async function runRelockSubAction(rest) {
  const specName = "check relock";
  try {
    const options = parseOptions(rest, { command: specName, flags: COMMAND_SPECS[specName].flags });
    if (options.help) {
      process.stdout.write(`${commandHelp("check")}\n`);
      return KIT_EXIT_CODES.ok;
    }
    // --files is one comma-separated relative-path list; absent means the
    // default handwritten auto-discovery; trackedToolLocks requires a list.
    const files =
      options.files === undefined
        ? null
        : options.files
            .split(",")
            .map((rel) => rel.trim())
            .filter((rel) => rel.length > 0);
    const { status, output } = await relockAction({ root: options.root, files, registrationClass: options.registrationClass });
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    // Relock has no findings state: it either commits the whole transaction
    // or throws (exit 2). Any status other than "ok" is a mechanism error.
    return status === "ok" ? KIT_EXIT_CODES.ok : KIT_EXIT_CODES.rejected;
  } catch (error) {
    printError(error);
    return KIT_EXIT_CODES.rejected;
  }
}

async function runRegisterExistingSubAction(rest) {
  const specName = "check register-existing";
  try {
    const options = parseOptions(rest, { command: specName, flags: COMMAND_SPECS[specName].flags, rejectDuplicates: true });
    if (options.help) {
      process.stdout.write(`${commandHelp("check")}\n`);
      return KIT_EXIT_CODES.ok;
    }
    let engineering;
    if (options.engineeringJson !== undefined) {
      try {
        engineering = JSON.parse(options.engineeringJson);
      } catch {
        throw invalidParamsError("--engineering must be a JSON engineering object", { flag: "--engineering" });
      }
    }
    const { status, output } = await registerExistingAction({
      root: options.root,
      handwritten: options.handwritten,
      engineering,
      trackedToolLocks: options.trackedToolLocks,
      artifacts: options.artifacts,
    });
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return status === "ok" ? KIT_EXIT_CODES.ok : KIT_EXIT_CODES.rejected;
  } catch (error) {
    printError(error);
    return KIT_EXIT_CODES.rejected;
  }
}

function requireJsonFlag(options, specName) {
  if (options.json !== true) {
    throw invalidParamsError(`${specName} requires --json`, { reason: "missing-option-value", flag: "--json" });
  }
}

function proofCreateExitCode(code) {
  return code === "FOUNDATION_STATIC_CLEAR" ? KIT_EXIT_CODES.ok : KIT_EXIT_CODES.findings;
}

async function runSelectedArtifactsSubAction(rest) {
  const specName = "check selected-artifacts";
  try {
    const options = parseOptions(rest, { command: specName, flags: COMMAND_SPECS[specName].flags, rejectDuplicates: true });
    if (options.help) {
      process.stdout.write(`${commandHelp("check")}\n`);
      return KIT_EXIT_CODES.ok;
    }
    requireJsonFlag(options, specName);
    const output = await checkSelectedArtifactsAction({ root: options.root, selection: options.selection });
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return output.outcome.completion === "complete" && output.outcome.code === "ENGINEERING_CLEAR"
      ? KIT_EXIT_CODES.ok : KIT_EXIT_CODES.findings;
  } catch (error) {
    printError(error);
    return KIT_EXIT_CODES.rejected;
  }
}

async function runBranchFieldsSubAction(rest) {
  const specName = "check branch-fields";
  try {
    const options = parseOptions(rest, { command: specName, flags: COMMAND_SPECS[specName].flags, rejectDuplicates: true });
    if (options.help) {
      process.stdout.write(`${commandHelp("check")}\n`);
      return KIT_EXIT_CODES.ok;
    }
    requireJsonFlag(options, specName);
    const output = await checkBranchFieldsAction({ root: options.root, selection: options.selection });
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return output.outcome.completion === "complete" && output.outcome.code === "ENGINEERING_CLEAR"
      ? KIT_EXIT_CODES.ok : KIT_EXIT_CODES.findings;
  } catch (error) {
    printError(error);
    return KIT_EXIT_CODES.rejected;
  }
}

async function runPublicSurfaceBindingsSubAction(rest) {
  const specName = "check public-surface-bindings";
  try {
    const options = parseOptions(rest, { command: specName, flags: COMMAND_SPECS[specName].flags, rejectDuplicates: true });
    if (options.help) {
      process.stdout.write(`${commandHelp("check")}\n`);
      return KIT_EXIT_CODES.ok;
    }
    requireJsonFlag(options, specName);
    const output = await checkPublicSurfaceBindingsAction({ root: options.root, selection: options.selection });
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return output.outcome.completion === "complete" && output.outcome.code === "ENGINEERING_CLEAR"
      ? KIT_EXIT_CODES.ok : KIT_EXIT_CODES.findings;
  } catch (error) {
    printError(error);
    return KIT_EXIT_CODES.rejected;
  }
}

async function runBindingCheckSubAction(rest, specName = "check native-entry-bindings", action = checkNativeEntryBindingsAction) {
  try {
    const options = parseOptions(rest, { command: specName, flags: COMMAND_SPECS[specName].flags, rejectDuplicates: true });
    if (options.help) {
      process.stdout.write(`${commandHelp("check")}\n`);
      return KIT_EXIT_CODES.ok;
    }
    requireJsonFlag(options, specName);
    const output = await action({ root: options.root, selection: options.selection });
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return output.outcome.completion === "complete" && output.outcome.code === "ENGINEERING_CLEAR"
      ? KIT_EXIT_CODES.ok : KIT_EXIT_CODES.findings;
  } catch (error) {
    printError(error);
    return KIT_EXIT_CODES.rejected;
  }
}

async function runSourceGeneratedSubAction(rest) {
  const specName = "check source-generated";
  try {
    const options = parseOptions(rest, { command: specName, flags: COMMAND_SPECS[specName].flags, rejectDuplicates: true });
    if (options.help) {
      process.stdout.write(`${commandHelp("check")}\n`);
      return KIT_EXIT_CODES.ok;
    }
    requireJsonFlag(options, specName);
    const output = await runSourceGeneratedCheck({ root: options.root, declaration: options.declaration });
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return output.outcome.completion === "complete" && output.outcome.code === "ENGINEERING_CLEAR"
      ? KIT_EXIT_CODES.ok : KIT_EXIT_CODES.findings;
  } catch (error) {
    printError(error);
    return KIT_EXIT_CODES.rejected;
  }
}

async function runProofSubAction(rest) {
  const specName = "check proof";
  try {
    const options = parseOptions(rest, { command: specName, flags: COMMAND_SPECS[specName].flags });
    if (options.help) {
      process.stdout.write(`${commandHelp("check")}\n`);
      return KIT_EXIT_CODES.ok;
    }
    requireJsonFlag(options, specName);
    if (options.proofRoot === undefined || options.proof === undefined) {
      throw invalidParamsError("--proof-root and --proof are both required", { reason: "invalid-option-combination" });
    }
    const output = await readProfessionalProof({ proofRoot: options.proofRoot, proof: options.proof });
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (output.status === "pass") return KIT_EXIT_CODES.ok;
    if (output.status === "not_pass") return KIT_EXIT_CODES.findings;
    return KIT_EXIT_CODES.rejected;
  } catch (error) {
    printError(error);
    return KIT_EXIT_CODES.rejected;
  }
}

async function runProofCreateSubAction(rest) {
  const specName = "check proof-create";
  try {
    const options = parseOptions(rest, { command: specName, flags: COMMAND_SPECS[specName].flags });
    if (options.help) {
      process.stdout.write(`${commandHelp("check")}\n`);
      return KIT_EXIT_CODES.ok;
    }
    requireJsonFlag(options, specName);
    const output = await createProfessionalProof({
      reviewRoot: options.reviewRoot,
      reviewInput: options.reviewInput,
      conclusionOutput: conclusionOutputFromOptions(options),
    });
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return proofCreateExitCode(output.conclusion.outcome.code);
  } catch (error) {
    printError(error);
    return KIT_EXIT_CODES.rejected;
  }
}

async function runHostLoadingSubAction(rest) {
  const specName = "check host-loading";
  try {
    const options = parseOptions(rest, {
      command: specName,
      flags: COMMAND_SPECS[specName].flags,
      rejectDuplicates: true,
    });
    if (options.help) {
      process.stdout.write(`${commandHelp("check")}\n`);
      return KIT_EXIT_CODES.ok;
    }
    if (!options.hostId || !options.hostVersion || !options.pathCategory) {
      throw invalidParamsError("--host, --host-version, and --path-category are required", {
        reason: "invalid-option-combination",
      });
    }
    const root = path.resolve(options.root ?? ".");
    let activationRules;
    if (options.activationRulesPath !== undefined) {
      activationRules = await readJson(root, options.activationRulesPath, "--activation-rules");
    }
    const { status, output } = await checkHostLoadingAction({
      root,
      hostId: options.hostId,
      hostVersion: options.hostVersion,
      pathCategory: options.pathCategory,
      activationRules,
      hostsRoot: options.hostsRoot,
    });
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (status === "ok") return KIT_EXIT_CODES.ok;
    if (status === "findings") return KIT_EXIT_CODES.findings;
    return KIT_EXIT_CODES.rejected;
  } catch (error) {
    printError(error);
    return KIT_EXIT_CODES.rejected;
  }
}

async function runQualificationSubAction(rest) {
  const specName = "check qualification";
  try {
    const options = parseOptions(rest, {
      command: specName,
      flags: COMMAND_SPECS[specName].flags,
      rejectDuplicates: true,
    });
    if (options.help) {
      process.stdout.write(`${commandHelp("check")}\n`);
      return KIT_EXIT_CODES.ok;
    }
    const result = await runQualification({
      root: options.root,
      capability: options.capability,
      requestPath: options.requestPath,
      bindingsPath: options.bindingsPath,
      native: options.native === true,
    });
    const notice = result[QUALIFICATION_NOTICE];
    if (notice) {
      process.stderr.write(`[qualification] 保留私有资格现场：${notice.parentRoot}（证据根：${notice.privateEvidenceRoot}）。请在人工检查后删除该临时目录。\n`);
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return KIT_EXIT_CODES.ok;
  } catch (error) {
    const notice = error?.[QUALIFICATION_NOTICE];
    if (notice) {
      const evidence = notice.privateEvidenceRoot ? `（证据根：${notice.privateEvidenceRoot}）` : "";
      process.stderr.write(`[qualification] 保留私有资格现场：${notice.parentRoot}${evidence}。请在人工检查后删除该临时目录。\n`);
    }
    printError(error);
    return KIT_EXIT_CODES.rejected;
  }
}

async function parseCatalogJsonOption(catalogPath) {
  if (catalogPath === undefined) return undefined;
  let rawText;
  try {
    rawText = await readFile(path.resolve(catalogPath), "utf8");
  } catch (cause) {
    throw invalidParamsError(
      `无法读取 --catalog 文件 "${catalogPath}"：${cause?.message ?? "读取失败"}`,
      { flag: "--catalog" },
    );
  }
  try {
    return JSON.parse(rawText);
  } catch {
    throw invalidParamsError(
      `--catalog 文件 "${catalogPath}" 不是合法 JSON`,
      { flag: "--catalog" },
    );
  }
}

async function runDepsSubAction(parentCommand, argv) {
  try {
    if (argv[0] === "--help" || argv[0] === "-h" || (parentCommand === "adopt-plan" && argv.length === 0)) {
      process.stdout.write(`${commandHelp(parentCommand)}\n`);
      return KIT_EXIT_CODES.ok;
    }

    const firstArg = argv[0];
    const hasPositional = firstArg !== undefined && !firstArg.startsWith("-");
    const action = hasPositional ? firstArg : null;
    const flagArgs = hasPositional ? argv.slice(1) : argv;

    if (parentCommand === "check") {
      const writeActions = ["bump-min", "bump", "link-workspace", "unlink-workspace"];
      const writeFlags = [
        "--bump",
        "--to",
        "--package",
        "--verified-ceiling",
        "--clear-ceiling",
        "--allow-major-upgrade",
        "--link-workspace",
        "--unlink-workspace",
        "--dry-run",
      ];
      if ((action && writeActions.includes(action)) || flagArgs.some((arg) => writeFlags.includes(arg))) {
        throw invalidParamsError(
          "check deps 仅允许只读检查（resolve / --workspace-root / --topology）；如需修改 minVersion 或写入本地联调覆盖，请改用 skill-family-kit adopt-plan deps ...",
          { action, suggestedCommand: "adopt-plan deps" },
        );
      }
      if (action && action !== "resolve") {
        throw invalidParamsError(
          `check deps 不支持子动作 "${action}"；支持只读用法：check deps [resolve]、check deps --workspace-root <dir>、check deps --topology`,
          { action },
        );
      }
      const options = parseOptions(flagArgs, {
        command: "check deps",
        flags: COMMAND_SPECS["check deps"].flags,
        rejectDuplicates: true,
      });
      if (options.help) {
        process.stdout.write(`${commandHelp("check")}\n`);
        return KIT_EXIT_CODES.ok;
      }
      const useTextFormat = resolveOutputFormat(options) === "text";
      if (options.topology === true) {
        const topology = await describePublishTopology({ workspaceRoot: options.workspaceRoot });
        process.stdout.write(
          useTextFormat ? formatPublishTopologyReport(topology) : `${JSON.stringify(topology, null, 2)}\n`,
        );
        return KIT_EXIT_CODES.ok;
      }
      if (options.workspaceRoot !== undefined) {
        const report = await checkSupportWorkspaceDependencies({ workspaceRoot: options.workspaceRoot });
        process.stdout.write(
          useTextFormat ? formatSupportLagReport(report) : `${JSON.stringify(report, null, 2)}\n`,
        );
        if (!report.ok) {
          process.stderr.write(
            "[kit] 存在版本落后于本机最新底座源码且未开启本地联调覆盖的支撑层仓库，请同迭代拉齐版本或运行 adopt-plan deps --link-workspace。\n",
          );
          return KIT_EXIT_CODES.findings;
        }
        return KIT_EXIT_CODES.ok;
      }
      const catalog = await parseCatalogJsonOption(options.catalogPath);
      const receipt = await resolveInternalDependencies({
        root: options.root ?? ".",
        catalog,
        sessionId: options.sessionId,
        resolvedAt: options.resolvedAt,
        receiptOut: options.receiptOut,
      });
      process.stdout.write(
        useTextFormat ? formatDepsResolveReport(receipt) : `${JSON.stringify(receipt, null, 2)}\n`,
      );
      if (receipt.status !== "resolved") {
        process.stderr.write(
          "[kit] 存在未命中的内部依赖，请检查各包的 minVersion、verifiedCeiling 与候选版本目录。\n",
        );
        return KIT_EXIT_CODES.findings;
      }
      return KIT_EXIT_CODES.ok;
    }

    // parentCommand === "adopt-plan"
    const allowedActions = ["bump-min", "bump", "resolve", "link-workspace", "unlink-workspace"];
    if (action && !allowedActions.includes(action)) {
      throw invalidParamsError(
        `未知的 adopt-plan deps 子动作 "${action}"；支持动作：bump-min（或 --bump）、link-workspace（或 --link-workspace）、unlink-workspace（或 --unlink-workspace）、resolve`,
        { action },
      );
    }
    const options = parseOptions(flagArgs, {
      command: "adopt-plan deps",
      flags: COMMAND_SPECS["adopt-plan deps"].flags,
    });
    if (options.help) {
      process.stdout.write(`${commandHelp("adopt-plan")}\n`);
      return KIT_EXIT_CODES.ok;
    }

    if (action === "unlink-workspace" || options.unlinkWorkspace === true) {
      const report = await unlinkWorkspaceDependencies({
        root: options.root ?? ".",
        dryRun: options.dryRun === true,
      });
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return KIT_EXIT_CODES.ok;
    }

    if (action === "link-workspace" || options.linkWorkspace !== undefined) {
      const sourceRoot = options.linkWorkspace ?? options.workspaceRoot;
      const report = await linkWorkspaceDependencies({
        root: options.root ?? ".",
        sourceRoot,
        packages: options.packages,
        dryRun: options.dryRun === true,
      });
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return KIT_EXIT_CODES.ok;
    }

    if (action === "resolve") {
      const catalog = await parseCatalogJsonOption(options.catalogPath);
      const receipt = await resolveInternalDependencies({
        root: options.root ?? ".",
        catalog,
        sessionId: options.sessionId,
        resolvedAt: options.resolvedAt,
        receiptOut: options.receiptOut,
      });
      process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
      return receipt.status === "resolved" ? KIT_EXIT_CODES.ok : KIT_EXIT_CODES.findings;
    }

    if (
      action === "bump-min"
      || action === "bump"
      || options.bump === true
      || options.toVersion !== undefined
    ) {
      const packageList = Array.isArray(options.packages) ? options.packages : [];
      if (packageList.length > 1) {
        throw invalidParamsError("bump-min 仅允许指定单个 --package", { flag: "--package" });
      }
      const report = await bumpInternalDependencyMin({
        root: options.root ?? ".",
        packageName: packageList[0],
        toVersion: options.toVersion,
        verifiedCeiling: options.verifiedCeiling,
        clearCeiling: options.clearCeiling === true,
        allowMajorUpgrade: options.allowMajorUpgrade === true,
      });
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return KIT_EXIT_CODES.ok;
    }

    throw invalidParamsError(
      "请为 adopt-plan deps 指定有效操作：bump-min（或 --bump --package <pkg> --to <ver>）、--link-workspace <sourceRoot> 或 --unlink-workspace",
    );
  } catch (error) {
    printError(error);
    return KIT_EXIT_CODES.rejected;
  }
}

async function runCheckShadowingSubAction(argv) {
  try {
    const options = parseOptions(argv, {
      command: "check shadowing",
      flags: COMMAND_SPECS["check shadowing"].flags,
    });
    if (options.help) {
      process.stdout.write(`${commandHelp("check")}\n`);
      return KIT_EXIT_CODES.ok;
    }
    if (options.root !== undefined && options.projectRoot !== undefined) {
      throw invalidParamsError(
        "--root 与 --project-root 不能同时指定，请仅保留其一",
        { reason: "invalid-option-combination" },
      );
    }
    if (options.format !== undefined && options.format !== "json" && options.format !== "markdown" && options.format !== "text") {
      throw invalidParamsError(
        `--format 仅支持 json、markdown 或 text（收到 "${String(options.format)}"）`,
        { flag: "--format" },
      );
    }
    const shadowingFormat = options.json === true
      ? "json"
      : (options.format ?? (Boolean(process.stdout && process.stdout.isTTY) ? "markdown" : "json"));
    let layers;
    if (Array.isArray(options.layerSpecs) && options.layerSpecs.length > 0) {
      layers = options.layerSpecs.map((raw, idx) => {
        const colonIdx = raw.indexOf(":");
        if (colonIdx <= 0 || colonIdx === raw.length - 1) {
          throw invalidParamsError(
            `--layer 参数 "${raw}" 格式错误；请使用 <scope>:<dir>（例如 project:./.codex/skills）`,
            { flag: "--layer", value: raw },
          );
        }
        const scope = raw.slice(0, colonIdx);
        const dir = raw.slice(colonIdx + 1);
        return { id: `${scope}-${idx + 1}`, scope, root: dir, label: `<${scope}-${idx + 1}>` };
      });
    }

    const report = await checkSkillShadowing({
      layers,
      root: options.projectRoot ?? options.root,
      pluginRoots: options.pluginRoots ?? [],
      userHome: options.userHome,
      hostId: options.hostId,
      hostsRoot: options.hostsRoot,
    });
    if (shadowingFormat === "markdown" || shadowingFormat === "text") {
      process.stdout.write(formatSkillShadowingReport(report));
    } else {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }
    return report.ok ? KIT_EXIT_CODES.ok : KIT_EXIT_CODES.findings;
  } catch (error) {
    printError(error);
    return KIT_EXIT_CODES.rejected;
  }
}

function parseNonNegativeIntOption(raw, flag, { max = 2147483647 } = {}) {
  if (raw === undefined) return undefined;
  if (!/^[0-9]+$/u.test(String(raw))) {
    throw invalidParamsError(`${flag} 必须是 0 至 ${max} 之间的非负整数`, { flag });
  }
  const num = Number(raw);
  if (!Number.isSafeInteger(num) || num < 0 || num > max) {
    throw invalidParamsError(`${flag} 必须是 0 至 ${max} 之间的非负整数`, { flag });
  }
  return num;
}

async function runMonitorSubAction(argv) {
  try {
    if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
      process.stdout.write(`${commandHelp("check")}\n`);
      return KIT_EXIT_CODES.ok;
    }
    const action = argv[0];
    if (!["serve", "ensure", "register", "snapshot"].includes(action)) {
      throw invalidParamsError(
        `未知的 check monitor 子动作 "${action}"；支持动作：serve、ensure、register、snapshot`,
        { action },
      );
    }
    const specKey = `check monitor ${action}`;
    const options = parseOptions(argv.slice(1), {
      command: specKey,
      flags: COMMAND_SPECS[specKey].flags,
    });
    if (options.help) {
      process.stdout.write(`${commandHelp("check")}\n`);
      return KIT_EXIT_CODES.ok;
    }

    const root = options.root ?? ".";
    const explicitRegistryPath = options.registryPath;
    const explicitLockWarnMs = options.lockWarnMs !== undefined
      ? parseNonNegativeIntOption(options.lockWarnMs, "--lock-warn-ms")
      : undefined;
    const registryPath = explicitRegistryPath ?? DEFAULT_REGISTRY_PATH;
    const lockWarnMs = explicitLockWarnMs ?? DEFAULT_LOCK_WARN_MS;
    const port = parseNonNegativeIntOption(options.port, "--port", { max: 65535 }) ?? DEFAULT_MONITOR_PORT;
    const timeoutMs = parseNonNegativeIntOption(options.timeoutMs, "--timeout-ms", { max: 120000 }) ?? 6000;
    const allowedRoots = Array.isArray(options.allowedRoots) && options.allowedRoots.length > 0
      ? options.allowedRoots
      : undefined;

    if (action === "snapshot") {
      const snapshot = await collectMonitorSnapshot({
        root,
        registryPath,
        lockWarnMs,
        targetFilter: options.targetFilter ?? null,
        allowedRoots,
      });
      process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
      return KIT_EXIT_CODES.ok;
    }

    if (action === "register") {
      if (!options.id || !options.title) {
        throw invalidParamsError(
          "monitor register 需要同时提供 --id <任务唯一标识> 与 --title <显示名称>",
          { reason: "missing-required-option" },
        );
      }
      const targetPayload = {
        id: options.id,
        title: options.title,
        badge: options.badge,
        description: options.description,
        stateDir: options.stateDir,
        planPath: options.planPath,
        runsDir: options.runsDir,
        lockPaths: options.lockPaths,
      };
      if (options.port !== undefined && port > 0) {
        const health = await probeRuntimeMonitorHealth(port);
        if (health.online) {
          const ensured = await ensureRuntimeMonitor({
            root,
            port,
            registryPath,
            lockWarnMs,
            target: targetPayload,
            spawnIfOffline: false,
            allowedRoots,
          });
          process.stdout.write(`${JSON.stringify({ ok: true, command: "register", mode: "http", url: ensured.url, entry: ensured.registered, registryPath }, null, 2)}\n`);
          return KIT_EXIT_CODES.ok;
        }
      }
      const result = await registerMonitorTarget(root, targetPayload, registryPath, { allowedRoots });
      process.stdout.write(`${JSON.stringify({ ok: true, command: "register", mode: "local", entry: result.entry, registryPath }, null, 2)}\n`);
      return KIT_EXIT_CODES.ok;
    }

    if (action === "ensure") {
      const targetPayload = options.id
        ? {
          id: options.id,
          title: options.title ?? options.id,
          badge: options.badge,
          description: options.description,
          stateDir: options.stateDir,
          planPath: options.planPath,
          runsDir: options.runsDir,
          lockPaths: options.lockPaths,
        }
        : null;
      const ensured = await ensureRuntimeMonitor({
        root,
        port,
        ...(explicitRegistryPath !== undefined ? { registryPath: explicitRegistryPath } : {}),
        ...(explicitLockWarnMs !== undefined ? { lockWarnMs: explicitLockWarnMs } : {}),
        target: targetPayload,
        spawnIfOffline: options.noSpawn !== true,
        timeoutMs,
        allowedRoots,
      });
      if (ensured.status === "studio-unavailable-headless-fallback" && ensured.message) {
        process.stderr.write(`[monitor] ${ensured.message}\n`);
      }
      process.stdout.write(`${JSON.stringify({ ...ensured, command: "ensure", registryPath }, null, 2)}\n`);
      return KIT_EXIT_CODES.ok;
    }

    const served = await serveRuntimeMonitorViaStudio({
      root,
      port,
      ...(explicitRegistryPath !== undefined ? { registryPath: explicitRegistryPath } : {}),
      ...(explicitLockWarnMs !== undefined ? { lockWarnMs: explicitLockWarnMs } : {}),
      allowedRoots,
      workbenchUrl: options.workbenchUrl ?? null,
    });
    if (!served.delegated) {
      if (served.message) process.stderr.write(`[monitor] ${served.message}\n`);
      process.stdout.write(`${JSON.stringify({ ...served, command: "serve" }, null, 2)}\n`);
      return KIT_EXIT_CODES.ok;
    }
    return served.exitCode === 0 ? KIT_EXIT_CODES.ok : KIT_EXIT_CODES.rejected;
  } catch (error) {
    printError(error);
    return KIT_EXIT_CODES.rejected;
  }
}

function resolveOutputFormat(options, { isTTY = Boolean(process.stdout && process.stdout.isTTY) } = {}) {
  if (options.format !== undefined && options.format !== "json" && options.format !== "text") {
    throw invalidParamsError(
      `--format 仅支持 json 或 text（收到 "${String(options.format)}"）`,
      { flag: "--format" },
    );
  }
  if (options.json === true) return "json";
  if (options.format !== undefined) return options.format;
  return isTTY ? "text" : "json";
}

async function runAdoptApplySubAction(argv) {
  try {
    const options = parseOptions(argv, {
      command: "adopt-plan apply",
      flags: COMMAND_SPECS["adopt-plan apply"].flags,
    });
    if (options.help) {
      process.stdout.write(`${commandHelp("adopt-plan")}\n`);
      return KIT_EXIT_CODES.ok;
    }
    const format = resolveOutputFormat(options);
    const report = await applyAdoption({
      root: options.root ?? ".",
      projectId: options.projectId,
      projectName: options.projectName,
      profileId: options.profileId,
      licensingProfile: options.licensingProfile,
      licensingVariant: options.licensingVariant,
      profilesRoot: options.profilesRoot ?? bundledProfilesRoot(),
      capabilities: options.capabilities ?? [],
      allowGitSpawn: !options.noGitSpawn,
      dryRun: options.dryRun === true,
      updateManifest: options.updateManifest === true,
    });
    if (format === "text") {
      process.stdout.write(formatAdoptApplyReport(report));
    } else {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }
    return KIT_EXIT_CODES.ok;
  } catch (error) {
    printError(error);
    return KIT_EXIT_CODES.rejected;
  }
}

async function runCapabilitySubAction(parentCommand, argv) {
  try {
    if (parentCommand === "check") {
      if (argv.length > 0 && (argv[0] === "--help" || argv[0] === "-h")) {
        process.stdout.write(`${commandHelp("check")}\n`);
        return KIT_EXIT_CODES.ok;
      }
      const first = argv[0];
      const hasAction = first !== undefined && !first.startsWith("-");
      const action = hasAction ? first : "list";
      const flagArgs = hasAction ? argv.slice(1) : argv;
      if (action === "add" || action === "remove") {
        throw invalidParamsError(
          `check capability 仅支持只读 list 查询；如需修改能力清单，请改用 skill-family-kit adopt-plan capability ${action} ...`,
          { action, suggestedCommand: `adopt-plan capability ${action}` },
        );
      }
      if (action !== "list") {
        throw invalidParamsError(
          `未知的 check capability 子动作 "${action}"；只读模式仅支持 list（修改请用 adopt-plan capability add|remove）`,
          { action },
        );
      }
      const options = parseOptions(flagArgs, {
        command: "check capability",
        flags: COMMAND_SPECS["check capability"].flags,
      });
      if (options.help) {
        process.stdout.write(`${commandHelp("check")}\n`);
        return KIT_EXIT_CODES.ok;
      }
      const format = resolveOutputFormat(options);
      const report = await listAdoptedCapabilities({ root: options.root ?? "." });
      if (format === "text") {
        process.stdout.write(formatCapabilityReport(report));
      } else {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      }
      return KIT_EXIT_CODES.ok;
    }

    if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
      process.stdout.write(`${commandHelp("adopt-plan")}\n`);
      return KIT_EXIT_CODES.ok;
    }
    const action = argv[0];
    if (!["list", "add", "remove"].includes(action)) {
      throw invalidParamsError(
        `未知的 adopt-plan capability 子动作 "${action}"；支持动作：list、add、remove`,
        { action },
      );
    }
    const specKey = `adopt-plan capability ${action}`;
    const options = parseOptions(argv.slice(1), {
      command: specKey,
      flags: COMMAND_SPECS[specKey].flags,
    });
    if (options.help) {
      process.stdout.write(`${commandHelp("adopt-plan")}\n`);
      return KIT_EXIT_CODES.ok;
    }
    const format = resolveOutputFormat(options);
    let report;
    if (action === "list") {
      report = await listAdoptedCapabilities({ root: options.root ?? "." });
    } else if (action === "add") {
      report = await addAdoptedCapability({
        root: options.root ?? ".",
        id: options.id,
        dryRun: options.dryRun === true,
      });
    } else {
      report = await removeAdoptedCapability({
        root: options.root ?? ".",
        id: options.id,
        dryRun: options.dryRun === true,
      });
    }
    if (format === "text") {
      process.stdout.write(formatCapabilityReport(report));
    } else {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }
    return KIT_EXIT_CODES.ok;
  } catch (error) {
    printError(error);
    return KIT_EXIT_CODES.rejected;
  }
}

async function parseLatestVersionsOption(rawValue) {
  if (rawValue === undefined) return undefined;
  const trimmed = String(rawValue).trim();
  let jsonText = trimmed;
  if (!trimmed.startsWith("{")) {
    try {
      jsonText = await readFile(path.resolve(trimmed), "utf8");
    } catch (cause) {
      throw invalidParamsError(
        `无法读取 --latest-versions 文件 "${rawValue}"：${cause?.message ?? "读取失败"}`,
        { flag: "--latest-versions" },
      );
    }
  }
  try {
    return JSON.parse(jsonText);
  } catch {
    throw invalidParamsError(
      "--latest-versions 必须是合法的 JSON 对象或 JSON 文件路径",
      { flag: "--latest-versions" },
    );
  }
}

async function runCheckPrereqsSubAction(argv) {
  try {
    const options = parseOptions(argv, {
      command: "check prereqs",
      flags: COMMAND_SPECS["check prereqs"].flags,
    });
    if (options.help) {
      process.stdout.write(`${commandHelp("check")}\n`);
      return KIT_EXIT_CODES.ok;
    }
    const format = resolveOutputFormat(options);
    const latestVersions = await parseLatestVersionsOption(options.latestVersions);
    const report = await checkPrereqs({
      root: options.root ?? ".",
      requirePython: options.requirePython === true,
      requireEnv: options.requireEnv ?? [],
      skillFile: options.skillFile,
      loadedSha256: options.loadedSha256,
      latestVersions,
    });
    if (format === "text") {
      process.stdout.write(formatPrereqsReport(report));
    } else {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }
    return report.ok ? KIT_EXIT_CODES.ok : KIT_EXIT_CODES.findings;
  } catch (error) {
    printError(error);
    return KIT_EXIT_CODES.rejected;
  }
}

async function runHostSimSubAction(argv) {
  try {
    if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
      process.stdout.write(`${commandHelp("check")}\n`);
      return KIT_EXIT_CODES.ok;
    }
    const action = argv[0];
    if (!["run", "materialize-shims", "list-hosts"].includes(action)) {
      throw invalidParamsError(
        `未知的 check host-sim 子动作 "${action}"；支持动作：run、materialize-shims、list-hosts`,
        { action },
      );
    }
    const specKey = `check host-sim ${action}`;
    const options = parseOptions(argv.slice(1), {
      command: specKey,
      flags: COMMAND_SPECS[specKey].flags,
    });
    if (options.help) {
      process.stdout.write(`${commandHelp("check")}\n`);
      return KIT_EXIT_CODES.ok;
    }
    if (action === "list-hosts") {
      process.stdout.write(`${JSON.stringify(listSimulatedHosts(), null, 2)}\n`);
      return KIT_EXIT_CODES.ok;
    }
    if (action === "materialize-shims") {
      const shims = await materializeSimulatedHostShims({
        outputDir: options.outputDir,
        hosts: options.hosts ?? "all",
        hostsRoot: options.hostsRoot,
      });
      process.stdout.write(`${JSON.stringify(shims, null, 2)}\n`);
      return KIT_EXIT_CODES.ok;
    }
    const format = resolveOutputFormat(options);
    const report = await runSimulatedHostMatrix({
      root: options.root ?? ".",
      hosts: options.hosts ?? "all",
      output: options.output,
      prompt: options.prompt,
      hostsRoot: options.hostsRoot,
    });
    if (format === "text") {
      process.stdout.write(formatSimulatedHostReport(report));
    } else {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }
    return report.ok ? KIT_EXIT_CODES.ok : KIT_EXIT_CODES.findings;
  } catch (error) {
    printError(error);
    return KIT_EXIT_CODES.rejected;
  }
}

export async function cliMain(argv) {
  if (argv.length === 0) {
    process.stdout.write(HELP_TEXT);
    return KIT_EXIT_CODES.ok;
  }
  if (argv[0] === "--help" || argv[0] === "-h") {
    try {
      const options = parseOptions(argv, { command: "global", flags: {}, rejectDuplicates: true });
      if (options.help && Object.keys(options).length === 1) {
        process.stdout.write(HELP_TEXT);
        return KIT_EXIT_CODES.ok;
      }
      throw invalidParamsError("global help must be the only option", { reason: "invalid-option-combination" });
    } catch (error) {
      printError(error);
      return KIT_EXIT_CODES.rejected;
    }
  }
  const command = argv[0];
  if (!TOP_LEVEL_COMMANDS.includes(command)) {
    printError(unknownCommandError(command, argv.slice(1)));
    return KIT_EXIT_CODES.rejected;
  }

  // Positional report sub-actions (FND-ADR-005): `projection report` renders,
  // `check report` diagnoses. They hang under existing commands; the
  // four-command vocabulary and runCommand stay untouched.
  if ((command === "projection" || command === "check") && argv[1] === "report") {
    return runReportSubAction(command, argv.slice(2));
  }
  // Positional entry-contract sub-action (SG-34): `check entries` runs the
  // shared entry contract gate (SFA-ENTRY-003/004/005/007 + SFA-CONTEXT-001/002).
  // It hangs under the existing check command; no fifth command is created.
  if (command === "check" && argv[1] === "entries") {
    return runEntriesSubAction(argv.slice(2));
  }
  // Positional controlled-relock sub-action (SG-36): `check relock` runs the
  // fail-closed registration + lock-recompute transaction. It hangs under the
  // existing check command, parallel to `check entries`; no fifth command.
  if (command === "check" && argv[1] === "relock") {
    return runRelockSubAction(argv.slice(2));
  }
  if (command === "check" && argv[1] === "register-existing") {
    return runRegisterExistingSubAction(argv.slice(2));
  }
  if (command === "check" && argv[1] === "qualification") {
    return runQualificationSubAction(argv.slice(2));
  }
  if (command === "check" && argv[1] === "host-loading") {
    return runHostLoadingSubAction(argv.slice(2));
  }
  if (command === "check" && argv[1] === "proof-create") {
    return runProofCreateSubAction(argv.slice(2));
  }
  if (command === "check" && argv[1] === "proof") {
    return runProofSubAction(argv.slice(2));
  }
  if (command === "check" && argv[1] === "selected-artifacts") {
    return runSelectedArtifactsSubAction(argv.slice(2));
  }
  if (command === "check" && argv[1] === "branch-fields") {
    return runBranchFieldsSubAction(argv.slice(2));
  }
  if (command === "check" && argv[1] === "public-surface-bindings") {
    return runPublicSurfaceBindingsSubAction(argv.slice(2));
  }
  if (command === "check" && argv[1] === "native-entry-bindings") {
    return runBindingCheckSubAction(argv.slice(2));
  }
  if (command === "check" && argv[1] === "skill-surface-bindings") {
    return runBindingCheckSubAction(argv.slice(2), "check skill-surface-bindings", checkSkillSurfaceBindingsAction);
  }
  if (command === "check" && argv[1] === "native-projections") {
    return runBindingCheckSubAction(argv.slice(2), "check native-projections", checkNativeProjectionsAction);
  }
  if (command === "check" && argv[1] === "source-generated") {
    return runSourceGeneratedSubAction(argv.slice(2));
  }
  if (command === "check" && argv[1] === "deps") {
    return runDepsSubAction("check", argv.slice(2));
  }
  if (command === "check" && (argv[1] === "shadowing" || argv[1] === "check-shadowing")) {
    return runCheckShadowingSubAction(argv.slice(2));
  }
  if (command === "check" && argv[1] === "monitor") {
    return runMonitorSubAction(argv.slice(2));
  }
  if (command === "check" && (argv[1] === "prereqs" || argv[1] === "check-prereqs")) {
    return runCheckPrereqsSubAction(argv.slice(2));
  }
  if (command === "check" && argv[1] === "capability") {
    return runCapabilitySubAction("check", argv.slice(2));
  }
  if (command === "check" && argv[1] === "host-sim") {
    return runHostSimSubAction(argv.slice(2));
  }
  if (command === "check" && argv[1] === "adopt-apply") {
    printError(
      invalidParamsError(
        "check 命令严格保持只读，已移除 check adopt-apply 写入口；请改用 skill-family-kit adopt-plan apply ...",
        { suggestedCommand: "adopt-plan apply" },
      ),
    );
    return KIT_EXIT_CODES.rejected;
  }
  if (command === "adopt-plan" && argv[1] === "apply") {
    return runAdoptApplySubAction(argv.slice(2));
  }
  if (command === "adopt-plan" && argv[1] === "capability") {
    return runCapabilitySubAction("adopt-plan", argv.slice(2));
  }
  if (command === "adopt-plan" && argv[1] === "deps") {
    return runDepsSubAction("adopt-plan", argv.slice(2));
  }
  if (command === "scaffold" && argv[1] === "host-build") {
    return runHostSubAction(command, "host-build", argv.slice(2));
  }
  if (command === "adopt-plan" && ["host-describe", "host-probe", "host-plan", "host-apply"].includes(argv[1])) {
    return runHostSubAction(command, argv[1], argv.slice(2));
  }
  if ((command === "check" || command === "adopt-plan") && argv.length > 1 && !argv[1].startsWith("-")) {
    const subaction = argv[1];
    const message = command === "check"
      ? `未知的 check 子动作 "${subaction}"；支持子动作：deps、prereqs、shadowing、monitor、capability、host-sim、entries、relock、register-existing、qualification、host-loading、report、proof、proof-create、selected-artifacts、branch-fields、public-surface-bindings、native-entry-bindings、skill-surface-bindings、native-projections、source-generated（或运行 skill-family-kit check --help 查看完整用法）`
      : `未知的 adopt-plan 子动作 "${subaction}"；支持子动作：apply、capability、deps、host-describe、host-probe、host-plan、host-apply（或运行 skill-family-kit adopt-plan --help 查看完整用法）`;
    printError(invalidParamsError(message, { reason: "unknown-subaction", command, subaction }));
    return KIT_EXIT_CODES.rejected;
  }

  try {
    const listCapabilitiesRequested = command === "adopt-plan" && argv.slice(1).includes("--list-capabilities");
    const engineeringBaselineRequested = command === "adopt-plan"
      && argv.slice(1).some((arg) => arg === "--engineering-baseline" || arg === "--compare-skeleton");
    const options = parseOptions(argv.slice(1), {
      command,
      flags: COMMAND_SPECS[command].flags,
      rejectDuplicates: listCapabilitiesRequested || engineeringBaselineRequested || argv.slice(1).includes("--engineering") || COMMAND_SPECS[command].rejectDuplicates === true,
    });
    if (options.help) {
      process.stdout.write(`${commandHelp(command)}\n`);
      return KIT_EXIT_CODES.ok;
    }
    if (command === "adopt-plan" && options.listCapabilities === true) {
      return await runCapabilityList(options);
    }
    if (command === "adopt-plan" && argv.slice(1).some((arg) => ["--all", "--scope", "--locale", "--uses", "--filter", "--capability", "--limit"].includes(arg))) {
      throw invalidParamsError("capability query options require --list-capabilities", { reason: "invalid-option-combination" });
    }
    const hasEngineeringBaseline = options.engineeringBaselinePath !== undefined;
    const compareSkeleton = options.compareSkeleton === true;
    if (command === "adopt-plan" && hasEngineeringBaseline !== compareSkeleton) {
      throw invalidParamsError("--engineering-baseline and --compare-skeleton must be provided together", {
        reason: "invalid-option-combination",
      });
    }
    const engineeringBaseline = command === "adopt-plan" && hasEngineeringBaseline
      ? await readEngineeringBaselineJson(options.root ?? ".", options.engineeringBaselinePath)
      : undefined;
    let engineering;
    if (options.engineeringJson !== undefined) {
      try {
        engineering = JSON.parse(options.engineeringJson);
      } catch {
        throw invalidParamsError("--engineering must be a JSON engineering object", { flag: "--engineering" });
      }
    }
    if (options.validationTimeoutMs !== undefined) {
      if (!/^[0-9]+$/u.test(options.validationTimeoutMs) || !Number.isSafeInteger(Number(options.validationTimeoutMs)) ||
          Number(options.validationTimeoutMs) < 1 || Number(options.validationTimeoutMs) > 2147483647) {
        throw invalidParamsError("--validation-timeout-ms must be an integer from 1 to 2147483647", { flag: "--validation-timeout-ms" });
      }
      options.validationTimeoutMs = Number(options.validationTimeoutMs);
    }
    const conclusionOutput = command === "check" ? conclusionOutputFromOptions(options) : undefined;
    const { exitCode, output } = await runCommand(command, {
      root: options.root ?? ".",
      projectId: options.projectId,
      projectName: options.projectName,
      profileId: options.profileId,
      licensingProfile: options.licensingProfile,
      licensingVariant: options.licensingVariant,
      profilesRoot: options.profilesRoot ?? bundledProfilesRoot(),
      capabilities: options.capabilities,
      manifest: options.manifest,
      only: options.only,
      policy: options.policy,
      conclusionOutput,
      allowGitSpawn: !options.noGitSpawn,
      engineeringBaseline,
      engineering,
      ...(Object.hasOwn(options, "operationId") ? { operationId: options.operationId } : {}),
      ...(Object.hasOwn(options, "validationTimeoutMs") ? { validationTimeoutMs: options.validationTimeoutMs } : {}),
      ...(Object.hasOwn(options, "cooperativeWriters") ? { cooperativeWriters: options.cooperativeWriters } : {}),
      compareSkeleton: compareSkeleton ? true : undefined,
    });
    if (output !== undefined) {
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    }
    return exitCode;
  } catch (error) {
    printError(error);
    return KIT_EXIT_CODES.rejected;
  }
}

// Direct-execution detection must survive symlinked package bins (pnpm
// .bin shims): compare real paths, not the raw argv[1] URL.
function isDirectExecution() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isDirectExecution()) {
  cliMain(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
