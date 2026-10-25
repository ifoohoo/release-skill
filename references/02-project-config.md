# 02 -- 项目配置

本文档定义 `.release-skill/project.yaml` 的 schema 规范、hooks 参数约束、profile 归一化、overlay 限制和 waiver 边界。状态机见 `01-state-machine.md`，安全要求见 `04-supply-chain.md`，错误码见 `05-evidence-and-errors.md`。

---

## 1. 配置文件位置与格式

项目使用 `.release-skill/project.yaml` 声明发布事实。

- 格式：YAML 1.2，兼容 JSON。
- 编码：UTF-8，无 BOM。
- 不得包含 YAML alias（`*anchor`）或重复键。
- 不得包含 `<project-root>/...` 等本机绝对路径。
- 配置摘要（SHA-256）基于规范化 JSON 计算：递归排序对象键、保持数组顺序、序列化为 UTF-8 JSON。

---

## 2. 顶层 schema

```yaml
apiVersion: release-skill/v1
kind: ReleaseProject

project:
  name: <string>                 # 项目标识，必填
  defaultBranch: <string>        # workspace 远端默认分支，必填；不限定为 main
  sourceRepository: <owner/repo> # workspace 源仓库；生产发布必填

releaseFinish:                   # 可选；仅控制本地发布收尾
  sourceBranchCheck: remind      # remind（缺省）或 skip
  setupSkill: <plugin:skill>     # 可选；已加载目标插件提供的 setup 入口

testIntake:                      # 可选；生产 prepare 才接受。未声明则保持原路径
  requirementsFile: intake/requirements.json
  resultFile: intake/result.json

publicSourceAuthorityReceipt:    # 可选；把源码坐标与多个 npm tarball 绑定为公开 Release asset
  coordinatorUnitId: <release-unit-id>
  subjectUnitIds: [<release-unit-id>]

releaseUnits:               # 发布单元数组，至少 1 个
  - id: <string>            # 唯一标识
    source: <string>        # 源码相对路径（相对项目根目录）
    publicRepo: <string>    # 公开仓库 owner/repo
    production:
      githubHost: github.com
      branchTemplate: <string>
      branchStrategy: create-release-branch # 或 advance-existing-branch / initialize-default-branch
    version:
      source: <string>      # 版本来源，如 "package.json"
      tagTemplate: <string> # tag 模板，如 "artifact-graph-v{version}"
    distributions:          # 必填；分发渠道数组，也可显式设为 []
      - type: <string>      # "npm" | "claude-plugin" | "codex-plugin"
        package: <string>   # npm 包名（type 为 npm 时必填）
        # 插件渠道（claude-plugin/codex-plugin/kimi-plugin/codebuddy-plugin）
        # 另含 plugin/marketplace/entrySkill 与可选 timeoutMs。
        marketplaceRepo: <string>  # 可选；外部独立市场仓库 owner/name。仅
          # claude-plugin/codex-plugin 可声明，出现即启用外部市场形态：marketplace
          # 索引集中于该外部仓库，插件冻结快照只含 plugin 清单；prepare 在线冻结
          # 市场 HEAD（codex sha 冻 / claude 名冻）。kimi/codebuddy 声明会被 plan
          # 完整性与 prepare 失败关闭。详见 standards/06 §2.3/§2.4。
    publicFiles:            # 公开源码镜像的显式闭世界映射
      - from: <string>      # 项目根相对路径
        to: <string>        # 公开仓库中的发布单元相对路径
        mode: preserve      # 保留源内容和可执行位
    requiredPublicFiles:    # 本发布单元不可缺失的目标路径
      - <string>
    previousPublicBaseline: # 必填；每个 unit 独立声明
      mode: none            # none | bound
      # bound 时还必须提供 repo/ref/commit，可选 tree/manifestDigest
    releaseDocuments:       # 可选；结构化双语发布文档刷新，缺省保持既有行为
      notesSource: <string> # 说明源相对路径，仅允许 {version} 占位符与 .yaml/.yml/.json 后缀
      locales: [<string>]   # 非空唯一语种数组，如 [en, zh-CN]
      changelogs:           # 非空数组
        - path: <string>
          locale: <string>
      readmes:              # 非空数组
        - path: <string>
          locale: <string>
          regions: [<string>]  # 非空唯一受管区域 id
          versionMarkers:      # 可选；id 唯一
            - id: <string>
              pattern: <string> # 含 {version} 占位符的精确标记模式
    postPublish:            # 可选；发布单元级的发布后分发配置
      commitIdentity:
        name: <string>
        email: <string>
      targets:              # 可选；镜像或市场索引目标
        - id: <string>
          kind: payload-mirror # 或 marketplace-index
          remoteUrl: <string>  # file:// 或 https://；禁止 ssh
          visibility: public   # 或 private / internal
          branch: <string>
      hooks:                # 可选；命名 preset 或自定义 command hook
        - id: <string>
          command: [<executable>, <arg>]
          phase: distribute # 或 postVerify

verificationGates:         # 可选；定义会进入冻结计划摘要
  - id: <stable-id>
    phase: snapshot-verify # 或 consumer-verify
    scope:
      unit: <release-unit-id>
      # consumer-verify 还必须填写 distribution
    command: [<executable>, <arg>]
    cwd: .
    timeoutMs: 30000
    envAllowlist: []

hooks:                      # 可选，命令 hooks
  lint: <hook>
  docs: <hook>
  build: <hook>
  test: <hook>
  typecheck: <hook>

policy:                     # 可选，安全策略
  forbiddenPaths: [<string>]
  forbiddenContentPatterns: [<string>]
```

`distributions: []` 表示该发布单元不生成 npm 或插件市场动作，不表示跳过公开发布。

### 2.0 显式测试接入

`testIntake` 为可选配置项，仅包含两个项目相对普通文件路径字段：`requirementsFile` 与 `resultFile`。路径经归一化后必须互异；`a/./b` 与 `a/b` 视为同一路径。配置加载时拒绝以下内容：
- 未知字段；
- 绝对路径；
- 包含 `..` 路径组件的路径；
- 以斜杠结尾的路径。

未声明 `testIntake` 的项目维持原有 hook 机制、完整门控、缓存策略与发布路径，不引入 TEST、Graph 或 Registry 依赖。

`--test-selection incremental` 在 `prepare` 或冻结过程中均被拒绝，不得在任何准备阶段启用。该拒绝行为不延迟至冻结完成后。

#### 交互式 Skill 的接入职责

生产准备前，Skill 必须核对接入状态。若未声明 `testIntake`，系统默认触发公开 TEST 0.1.0 的 `skill-family-test:skill-family-test-plan`，随后在授权范围内调用 `skill-family-test:skill-family-test-run`。

跳过接入须满足以下条件：
- 基于本轮适用且范围匹配的明确同意；
- 必须先明确征询再作决定；
- 沉默、拒绝、仅普通发布预授权、旧轮次、其他项目、版本或范围不匹配均不可跳过；
- 本轮匹配的答复可复用。

不得将跳过表述为测试已达标，亦不得以跳过清除已声明的适用要求。

以下请求不新增接入义务：
- 只读请求；
- 非生产路径；
- marketplace-only 委托发布。
- 已冻结计划的批准、发布、对账与正式验证不追加接入义务。

直接非交互 CLI 支持可选 `testIntake`，不新增选择参数、同意文件 Schema 或身份认证。选择责任由实际交互的 Skill 承担，答复记入既有任务或执行计划。

#### 声明后的命令与要求适用范围

声明 `testIntake` 后，仅允许执行生产 `prepare` 命令。非生产 `prepare` 返回 `CONFIG_INVALID`，错误码为 `TEST_INTAKE_NON_PRODUCTION`。

`assess` 等其他命令仍可加载该配置。

轻量工作流（如 docs、config、marketplace）、`selectedUnits` 与无需发布的配置分支不免除项目级要求：未选中单元的单元级要求可不进入本轮，但项目级要求始终适用。

#### 核收原件与失败条件

`release` 仅核收原件，要求如下：
- 预冻结项必须存在一条可核验结果；
- 结果状态必须为 `executed`、`reused` 或由 owner 确认的 `not-applicable`；
- 结论必须为 `passed`；
- `acceptedBy` 与声明的 acceptor 一致；`not-applicable` 时与 owner 一致；
- 引用文件可读且摘要一致；
- 结果中的 `subjectDigest` 与 `requirementsSha256` 均必须绑定当前对象。

以下情况均不通过核收：
- 退出码为 0；
- 全局 PASS；
- 空证据；
- 状态为 `failed`、`incomplete`、`uncovered`；
- 未知字段；
- 提前将后续阶段项标记为完成；
- 未知失败原因（保持 `unknown`）。

安装、加载与业务证据须分开保存，不得合并为单一类别。

核收依据 `schemas/test-intake.schema.json` 定义的字段结构。

#### 首次生产 prepare、候选续接和输入漂移

首次生产 `prepare` 执行后，生成适用快照与 tarball，仅保存一份非正式候选：
- 路径：`.release-skill/runs/<run>/test-candidate.json`；
- 返回状态：`NEEDS_INPUT`（`GATE_FAILED`，退出码 13）；
- 附带字段：`candidatePath`、`candidateSha256` 与 `subjectDigest`。

此时不写正式计划，也不进入 `PREPARED` 或 `FROZEN` 状态。

后续使用 `prepare --candidate <path>` 续接：
- 创建新运行目录；
- 不覆盖旧运行目录、旧证据或旧候选；
- 结果补齐并核验通过后，才写入正式计划。

当对象、配置、权威要求或其他实质输入发生变更时，返回 `TEST_CANDIDATE_REPREPARE`，原候选字节保持不变。

**仅当向仍绑定原对象的 `resultFile` 补入有效结果内容时，不视为输入漂移。**

首次候选、有效结果、正式计划与正式业务接受为不同阶段，不得将 `NEEDS_INPUT` 或工具成功改写为通过。

#### 后续计划与批准绑定

候选不可传给 `approve` 或 `publish`，亦不可将 `PARTIAL`、`PUBLISHED`、`VERIFIED` 或任何已成功的外部检查点修改为完成状态。

`ship` 在接受前保持持久状态 `NEW` 与 `testCandidate`，不重建候选。无 `testCandidate` 的 `NEW` 记录仍沿用原有准备路径。

正式计划中的可选字段 `testAcceptance` 进入当前计划版本的绑定摘要，记录层剥离不移除该字段。

替换结果、准则、范围或允许的限制将改变 plan digest，原批准不再适用。未改变这些原件的注释不会使批准失效。

无 `testAcceptance` 的计划保持原摘要路径。

`approve`、`publish` 与 `reconcile` 在执行前复核绑定原件；原件缺失或被改写时，动作失败并关闭，不重新批准，也不重放已成功的外部检查点。

### 2.1 本地发布收尾

`releaseFinish` 只控制 `release-finish` 的本地收尾，不改写冻结计划、发布状态或宿主范围。
`sourceBranchCheck` 缺省为 `remind`。该值要求收尾时读取当前分支和工作区摘要；设为 `skip`
时关闭这项提醒。`setupSkill` 可省略；填写时必须是技能入口名，例如 `release-setup` 或
`skill-family-docs:skill-family-docs-setup`。它只用于匹配已安装并加载的目标插件入口，不能作为
shell 命令执行。

`releaseFinish` 保持闭合。未知字段、`sourceBranchCheck` 的其他值，以及空值、路径、带参数或
shell 语法的 `setupSkill` 都是配置错误。两个字段彼此独立：关闭分支提醒不会关闭已配置的 setup。

release-finish 在 `--root` 指定的当前发布项目根目录调用 `setupSkill`。该流程不再接收另一个项目目录，
也不要求维护者额外指定 setup 目标。

完整收尾使用 `release-skill post-release --finish`。脚本固定汇总分支决定、宿主更新、实际加载、setup 和源码分支检查：全部完成时退出 0，存在待办时退出 2，确定失败时退出 1。`--finish-feedback` 只读取调用者保存的绝对 JSON 文件，并严格绑定当前 `planDigest`、`configDigest` 和规范项目根目录。反馈中的路径和说明只作为智能体报告数据，不会被执行，也不能提供新的写入授权。

`--skip-local-hosts` 显示跳过本轮宿主更新、加载和 setup；它不得与 `--hosts` 或 `--update-local-hosts` 同时使用。没有该参数且尚未选择宿主时，收尾保持待决定，不自动选择全部宿主。

生产模式的 `prepare` 仍会冻结 GitHub 快照，并生成 `push-snapshot`、`create-tag` 和
`github-release`。该单元的 `postPublish` 声明保持独立生效，其中 phase 为
`postVerify` 的 hook 也不受影响。因此纯插件可以先验证公开 GitHub Release，再向中央
Hub 投递登记提案。

`publicSourceAuthorityReceipt` 只适用于 production prepare。`coordinatorUnitId`
指定承载该文件的 GitHub Release；`subjectUnitIds` 必须引用现有 release unit，且每个
unit 恰好声明一个 npm distribution。prepare 等所有 subject tarball 冻结后生成
`source-authority-receipt.json`，其公开结构固定为：

```json
{"schemaVersion":1,"kind":"skill-family.source-authority-receipt","sourceRepository":"owner/workspace","sourceBaseCommit":"<full-commit>","subjects":[{"packageName":"@scope/package","version":"1.2.3","filename":"scope-package-1.2.3.tgz","sha256":"<sha256>"}]}
```

该文件使用 canonical JSON，不带自摘要，也不包含 release-skill 的计划、运行或批准字段。
冻结计划记录文件 SHA-256；publish 将相同字节上传到 coordinator GitHub Release，verify
重新下载远端字节并核对 SHA-256。离线消费者只需该文件和其中 subjects 对应的精确 tarball，便可
核对包名、版本、文件名、tarball SHA-256、源码仓库与源码基线提交。

### 2.1 显式发布范围（v0.9.4）

发布范围不增加配置字段。`releaseUnits[]` 继续声明项目可发布的全部单元；操作者可以在
`prepare` 或新建 `ship` 状态时重复传入 `--unit <id>`，从中选择本轮范围。未传参数时
选择全部单元。显式参数至少包含一个已声明的唯一 ID，计划顺序始终按
`releaseUnits[]` 的声明顺序确定，不受命令行顺序影响。

选择只裁剪按单元绑定的工作，包括版本与发布文档检查、公开文件快照、分发合同、
`verificationGates[].scope.unit` 对应的验证门和发布后声明。配置 Schema、单元 ID
唯一性、生成物新鲜度和顶层 `hooks` 仍覆盖完整项目。顶层 Hook 没有单元作用域，
不得根据命令、路径或输出猜测归属。

`publicSourceAuthorityReceipt` 是现有的附加依赖闭包。显式范围只要包含 coordinator
或任一 subject，就必须同时包含该收据声明涉及的全部单元。prepare 不会自动扩大范围；
范围不完整时会在 Hook、快照和计划写入前停止，并返回缺少的单元和精确重试参数。

冻结计划只包含选中单元及其派生门、动作和发布后声明。`plan.units` 是冻结后的唯一
发布范围权威，完整配置摘要仍进入计划绑定。延期单元不写回项目配置，也不形成状态、
豁免或待办记录。`publish`、`reconcile`、`verify` 和 `distribute` 不接受单元选择参数。

`postPublish` 只能位于某个 `releaseUnits[]` 条目内。下面的完整结构样例会由 schema 契约测试直接读取并校验，避免文档层级再次漂移：

```yaml
# schema-example: postpublish-release-unit
apiVersion: release-skill/v1
kind: ReleaseProject
project:
  name: postpublish-example
  defaultBranch: main
releaseUnits:
  - id: postpublish-example
    source: .
    publicRepo: example/postpublish-example
    version:
      source: package.json
      tagTemplate: v{version}
    distributions:
      - type: npm
        package: postpublish-example
        registry: https://registry.npmjs.org
        publisher: example
    publicFiles:
      - from: README.md
        to: README.md
        mode: preserve
    requiredPublicFiles: [README.md]
    previousPublicBaseline:
      mode: none
    postPublish:
      commitIdentity:
        name: release-bot
        email: release-bot@example.com
      hooks:
        - id: notify-downstream
          command: [node, scripts/notify-downstream.mjs]
          phase: postVerify
      localHostUpdate:
        plugin: postpublish-example
        hosts: [claude, codex, kimi, codebuddy, workbuddy, qoder]
        hub:
          name: example-hub
          githubHost: github.com
          repo: example/example-hub
          ref: refs/heads/main
```

`localHostUpdate` 只声明 `postVerify` 完成后的本机更新候选。`plugin` 必须与冻结公开快照中的插件 manifest 身份一致。`hosts` 只能使用六个 local-finish 宿主 ID：`claude`、`codex`、`kimi`、`codebuddy`、`workbuddy`、`qoder`。

`hub.repo` 使用 `owner/repo`，`hub.ref` 必须是完整的 `refs/heads/...` 引用。声明该字段时，同一 `postPublish` 块至少要有一个 `phase: postVerify` Hook。prepare 只校验冻结声明和插件身份，不访问 Hub，也不要求 Hub 预先存在目标版本。

Qoder 保持 build-only 分发边界，不新增发布计划内的 distribution 或安装检查点。本机收尾更新 Qoder 有四个前提：冻结计划已声明、用户显式选择、Hub 来源匹配、既有用户范围安装核对通过。流程不添加市场或执行首次安装。更新完成仅表示安装载荷已变更，不表示当前会话已加载新版，后续仍须重新加载或新开会话，并完成一次真实的只读业务调用。

在已核对的市场安装根内，分别读取 `marketplace.json` 的 `url` 来源与 `.claude-plugin/marketplace.json` 的 `github` 来源；至少一个存在，且所有存在候选都须有效并绑定同一冻结目标。根目录来源核对 `source.url/source.sha`；兼容来源沿现有 Claude 断言核对仓库、冻结标签、提交和版本。任一损坏或冲突均拒绝，不猜测优先级。

冻结与安装两侧均核验原生 `.qoder-plugin/plugin.json` 与 Claude 兼容 `.claude-plugin/plugin.json`：原生清单缺失时方可启用兼容清单，原生清单存在但无效时不得回退；两清单同时存在时，均须可解析为有效对象，以原生清单为优先。每个已存在候选（包括未选候选）都须核对目标 `name/version`；其 `skills` 必须为非空字符串，经 `Foundation 0.25.0` 的 `resolveContained` 解析为根内真实目录。跨候选只比较 `name/version`，允许各自合法 `skills` 不同；原生正常不能遮蔽兼容无效。安装侧结果须与冻结侧选定的相对清单路径及 `skills` 一致，不得忽略额外出现的损坏或冲突清单。写入前复验冻结快照摘要，安装后须完整比较声明载荷与冻结来源，现有 `external-marketplace-v1` 合同允许宿主额外文件，因此完整载荷比较不得替代双清单的独立核验。

0.9.21 起，同一声明也能执行 Claude、Codex、Kimi、CodeBuddy 和 WorkBuddy 的本机更新，无需恢复旧宿主 distribution。插件仓库、标签、提交和快照摘要必须来自冻结 unit 与对应标签动作。Claude、Codex 和 CodeBuddy 家族使用已有同源 Hub 市场；刷新前后分别核对宿主专用条目，安装后比较完整冻结载荷。CodeBuddy/WorkBuddy 只升级已有插件，并在插件写入前再次确认 Hub 分支未漂移。Kimi 直接使用冻结 GitHub Release 和终端交互，其只有仓库 URL 的 Hub 文件不承担标签或提交证明。启动进程保留三个代理变量 `http_proxy`、`https_proxy`、`all_proxy`。

---

## 3. 公开源码镜像与分发包

`releaseUnits[].publicFiles` 定义 GitHub 公开源码镜像的显式、闭世界 allowlist。每个映射都必须可审阅；未列出的文件不会因为目录扫描、模板重生成或历史惯例而被自动加入。`sourceScope` 默认为 `unit`，此时 `from` 必须位于 `releaseUnits[].source` 内；只有历史共享许可证、公共文档或工作流等明确的工作空间级来源才可写 `sourceScope: workspace`，其路径仍必须受工作空间根目录的词法、realpath 和无符号链接校验约束。`releaseUnits[].requiredPublicFiles` 只约束同一发布单元，不能借用其他单元的目标路径。

公开源码镜像与 distribution pack 是两条不同边界：前者决定公开仓库快照，后者由 npm `files`、插件 manifest 等渠道合同决定安装内容。发布前必须分别冻结、比较并验证两条边界；distribution pack 中的必需路径必须由该发布单元的公开映射覆盖。

持续发布只复制已批准 mapping 指向的冻结源快照，不生成 README、slogan 或其他人工内容，也不以模板重新覆盖它们。人工修改一旦进入权威源，就作为下一轮迭代的输入保留。若公开目标仓库与冻结计划出现差异，系统停止写入并等待人工选择 merge、adopt 或 reject；不得静默采用任一侧，也不得从头生成文件。

### 3.1 前序公开基线与人工权威源

每个 `releaseUnits[]` 必须显式声明 `previousPublicBaseline`：

- 确认从未发布过公开版本时使用 `mode: none`。它不是跳过冲突检查的开关；publish
  仍会在任何 execute 前检查目标 branch、tag、GitHub Release 和 npm version 唯一性。
- 已有公开版本时使用 `mode: bound`，并填写精确的 `repo`、不可变 `ref` 和
  `commit`。生产 prepare 必须使用 `--online --production`，逐 unit 观察
  ref→commit mapping；offline production 不得冻结未观察的 bound 基线。

发布到达 `VERIFIED` 后，`verify` 会把每个 `mode: bound` unit 的
`previousPublicBaseline` 自动推进到本次已发布并验证通过的提交（commit、tree、
manifestDigest），数值一律取自冻结计划里该 unit 的 `push-snapshot` 绑定，绝不从
工作区状态重新计算，从而保证推进值与公开仓库一致。该推进只写本地 `project.yaml`，
不产生任何远端写入；写回后会重新走一遍配置校验，校验失败则原样还原。若写回前该
文件在工作区中是干净的，`verify` 会用单独一次提交只包含该文件的改动；否则只落盘、
留给人工提交，绝不把在途改动卷进自动提交。推进失败不会降级 `VERIFIED`，只在证据
中记录并提示人工处理。

本地 human-owned 文件是下一轮发布内容的权威源；前序公开基线是冲突检测输入；
冻结 snapshot 是本轮审批和发布的唯一字节来源。默认 Git observer 只调用
`git ls-remote` 取得 ref→commit 映射，因此 commit 不一致时可提供 mapping diff，
但没有下载远端文件，必须把 content diff 明确标记为 unavailable，不能声称已经比较内容。

出现漂移时由人工选择：`merge`（合并双方修改）、`adopt`（采用远端修改）或
`reject`（拒绝远端修改）。无论选择 merge 还是 adopt，决定采用的内容都必须先合并回
human-owned 权威源，然后重新 prepare、审阅并 approve；后续环节只复制和冻结这些
字节，不重新生成或覆盖 README、slogan 及其他人工修改。

旧的 `policy.requiredPublicFiles` 已不支持。加载器必须返回 `CONFIG_INVALID`，并引导迁移到各自的 `releaseUnits[].requiredPublicFiles`。

### 3.1.1 Workspace 源码权威内容闭包

`project.sourceRepository` 标识承载当前 workspace 人工源文件的 GitHub
`owner/repo`，它与各发布单元的 `publicRepo` 不是同一概念；多个发布单元可以投影到不同
公开仓库，但它们仍可共享一个 workspace 源仓库。`project.defaultBranch` 表示该源仓库的
真实远端默认分支，可以是 `main`、`master`、`develop`、`trunk` 或其他明确名称。
setup 只在 workspace Git remotes 唯一一致时提出候选；缺失或冲突时要求人工裁决，不保存
`auto`。

生产 prepare 在 hooks 完成后，从所有 `publicFiles.from`（目录递归展开）和每个 unit 的
`version.source` 计算源码输入闭包，冻结 workspace 相对路径、内容 SHA-256 和 Git mode。
只有闭包内 staged、unstaged 或 untracked 的文件会阻断 prepare；无关 dirty 文件不阻断。
离线 prepare 明确记录 `unobserved-offline`，远端内容的强制比较留在 publish。

production publish 在任何 adapter `execute` 前，从
`sourceRepository/defaultBranch` 读取冻结路径集合，先确认配置分支仍是远端实际默认分支，
再比较内容和 mode。判定只依赖内容闭包，不依赖 commit ancestry，因此普通 merge、
squash、rebase 和默认分支上的无关后续提交可以通过；冲突解决或 revert 丢失 README、
版本源或其他公开输入会按具体路径失败关闭。系统不会自动 merge、rebase、切分支、push
或创建 PR。

通过后，publish 写入与 plan digest 绑定的源码权威收据；PARTIAL 经 reconcile 恢复时继承
并重新校验该收据。verify 只消费这份冻结收据，不在发布完成后用可变默认分支重新判定历史
发布。

### 3.2 公开分支策略

- `create-release-branch`：目标分支必须不存在；创建独立 release 分支，冻结提交没有父提交。
- `advance-existing-branch`：目标分支必须与 `previousPublicBaseline` 的精确提交一致；冻结提交以它为唯一父提交，publish 仅允许普通 fast-forward push。并发漂移或非快进时失败关闭，不使用 force。
- `initialize-default-branch`：目标标准分支必须不存在，冻结提交以当前公开基线为父提交；只有同时声明 `setAsDefaultBranch: true` 和 `expectedCurrentDefaultBranch` 时，计划才会增加显式 `set-default-branch` action。切换失败进入 PARTIAL，可由 reconcile 依据旧/新/第三方状态恢复或转人工。

已有公开仓不得使用 `mode: none` 伪装成首次发布。示例中的 commit 只是校准时点证据；每轮 production prepare 都必须在线重观测。

### 3.3 发布文档刷新（releaseDocuments）

`releaseUnits[].releaseDocuments` 可选；未配置时保持既有行为。配置后，一份结构化说明源确定性刷新 README 受管区域、唯一版本标记的机器值和 CHANGELOG 当前版本受管条目；区域外字节、旧版本条目、前言、链接定义和人工说明逐字保留。核心命令不联网、不调用大模型、不自动翻译。

- `notesSource` 与各目标路径均为发布单元根相对安全路径，不得为绝对路径，不得包含 `..`、反斜杠、空段或 NUL；`notesSource` 只允许 `{version}` 占位符与 `.yaml`、`.yml`、`.json` 后缀。
- `locales` 非空且唯一；每个目标语种必须属于 `locales`，目标规范路径不得重复或发生大小写/Unicode 碰撞。
- 说明源的 `version` 必须与 `version.source` 解析结果精确一致，`date` 为 `YYYY-MM-DD`；每个配置语种恰好出现一次，`summary` 和变更项去除首尾空白后非空，`security`/`breaking`/`added`/`changed`/`deprecated`/`removed`/`fixed` 至少一个类别含条目。重复键、YAML alias/anchor、合并键、自定义标签、未知字段、缺少或多余语种、语种回退均失败关闭。
- README 受管区域以 `<!-- release-skill:managed:start id=<region> -->` 与对应结束标记做字节偏移替换；版本标记必须唯一匹配且只替换机器值，零次或多次匹配拒绝写入。CHANGELOG 当前版本受管条目由含 `baseline` 摘要的注释包围，基线不符、非受管同版本条目或标记损坏返回冲突。
- `docs refresh --unit <id>` 默认只读演练，输出逐文件相对路径、语种、新旧摘要和 `refreshDigest`；写入必须同时提供 `--write`、精确 `--confirm-refresh <refreshDigest>` 和 `--ack-local-document-write`，全部目标作为一个事务提交。该授权只覆盖声明的本地文档目标，不包含 hook、提交、推送、发布或安装。
- `prepare` 在 hook、基线、快照、远端检查和计划冻结前执行同一只读规划器：`clean` 继续，`changes` 以 `RELEASE_DOCS_STALE` 失败关闭并给出精确演练/写入参数。`prepare`、`publish`、`reconcile` 永不隐式刷新文档；刷新后重新 prepare 会自然改变快照与 plan digest（文档进入发布产物时），使旧批准失效。

---

## 4. Hooks 参数约束

每个 hook 必须是对象，包含以下属性：

| 属性 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `command` | 字符串数组 | 是 | 至少 1 个元素；每个元素为字符串；第一个元素为可执行文件路径或名称；**不接受 shell 字符串** |
| `cwd` | 字符串 | 否 | 相对路径，不得以 `/` 开头，不得包含 `..` |
| `timeoutMs` | 整数 | 否 | 最小 1000，最大 7200000（2 小时） |
| `envAllowlist` | 字符串数组 | 否 | 每个元素匹配 `^[A-Z_][A-Z0-9_]*$`；无重复元素 |
| `cacheable` | 布尔 | 否 | `true` 时启用增量结果缓存：`cacheInputs` 指纹未变且上次运行成功时，prepare 回放缓存结果而不重跑；缺省（或 `false`）恒为全量执行。`cacheable: true` 必须同时声明非空 `cacheInputs`（运行时强制，见 `src/core/hooks.mjs`） |
| `cacheInputs` | 字符串数组 | 否 | 根相对 glob，声明 hook 的完整输入集（源码、脚本、配置、锁文件等）。缓存键对每个匹配文件的内容取指纹；任何 glob 匹配不到文件时拒绝缓存（fail closed）。必须覆盖全部输入，否则缓存可能返回假命中。输入完整性只能由项目自己声明并证明，工具不会代猜或代写 |
| `testSelection` | 枚举 | 否 | 仅对 test hook 有意义：`full`（缺省同义）表示运行完整测试套件，prepare 的内置全量测试冻结门要求计算计划摘要前必须是全量；`incremental` 保留给未来 preflight 模式，冻结时拒绝（`incremental selection is not allowed at freeze time`）。内置门，项目 overlay 不能禁用 |

缓存回放只表示"上次成功结果的复用"，`cached: true` 的 hook 事件不构成真实执行成本；接入评估只从受信 producer 的 started/completed 事件对推导实际耗时，从不把 `timeoutMs` 当作实际成本，也从不替项目补写 `cacheable`/`cacheInputs`。

hook 执行顺序固定为 `lint → docs → build → test → typecheck`，优先运行成本最低的检查。执行规则如下：

- 使用 `execFile`，不使用 `exec` 或 `{ shell: true }`。
- 通过 `realpath` 解析 cwd，拒绝逃逸到项目根目录之外。
- 超时后杀死子进程，返回 `HOOK_TIMEOUT` 错误码。
- 进程环境仅包含 `PATH`、平台必需进程变量和 allowlist 中声明的变量。

示例：

```yaml
hooks:
  test:
    command: [pnpm, test]
    cwd: .
    timeoutMs: 300000
    envAllowlist: [CI]
```

### 4.1 分阶段验证 gate

`verificationGates` 是项目个性化校验的受控扩展点，不是另一套发布流程：

| 字段 | 约束 |
|---|---|
| `id` | 全局唯一、稳定，匹配 `^[a-z0-9][a-z0-9._-]*$` |
| `phase` | `snapshot-verify` 或 `consumer-verify` |
| `scope.unit` | 必须引用现有发布单元 |
| `scope.distribution` | consumer 阶段必填，且必须是该单元真实声明的渠道 |
| `command` | `execFile` 风格字符串数组；禁止 shell 字符串 |
| `cwd` | 相对执行根，不允许路径逃逸或符号链接分量 |
| `timeoutMs` | 1000 至 7200000 |
| `envAllowlist` | 仅显式变量；其他凭证和环境变量不转发 |
| `expectedJson` | 可选；stdout 必须为 JSON 且递归包含这些字段 |

`snapshot-verify` 获得冻结公开快照的一次性可写副本；副本销毁后重新摘要原快照，失败时还没有远端写入。`consumer-verify` 只在精确 npm 或 Claude/Codex 隔离安装成功后，从安装根执行；结果摘要进入 verify run，失败不得达到 VERIFIED。

gate 与 legacy hook 都是没有网络沙箱的本地进程。在 `.release-skill/project.yaml` 中配置命令即完成授权，调用对应命令时直接执行，不再增加触发前确认点。旧参数 `--acknowledge-hook-side-effects` 和 `--acknowledge-gate-side-effects` 只作为无效果的兼容输入保留。release-skill 会限制环境、路径、超时和证据输出，但不能替项目保证命令不会写文件或访问网络。恢复触发前强制确认门属于后续设计变更，0.7.6 不提供该确认门。Git push、tag、默认分支、GitHub Release 和 npm publish 只能是冻结计划里的 adapter action，不能注册为 hook/gate。

### 4.2 首次接入 setup

`release-skill setup --root <path> --json` 默认只读，扫描工作区、包与插件 manifest、逐单元 Git 权威、旧版 `public-release.json` 和脚本，输出候选、完整 `recommendedAnswers`、结构化冲突/假设和 `setupDigest`。旧配置只作为不可信迁移事实，其中的 `snapshotCommands` 只成为未授权 gate 候选；它不会把脚本存在解释成用户选择，也不会读取 README 中的自然语言作为命令。报告可能包含大量精确映射，Agent 应先把完整 JSON 落到系统临时文件，只读取紧凑摘要，并机械提取 `recommendedAnswers`，不得在上下文中重新生成。

写入要求人工提供完整 answers JSON，再次 dry-run，并使用同一摘要执行 `--write --confirm-setup <setupDigest>`。写入只允许首次原子创建 `.release-skill/project.yaml`；已有配置返回 `ALREADY_CONFIGURED`/`CONFIG_EXISTS`，由人工增量编辑。事实漂移返回 `SETUP_DIGEST_MISMATCH`。没有远端渠道的项目返回 `LOCAL_ONLY_DETECTED`，不得宣称 production-ready。

---

## 5. Profile（规划中）

> **当前状态：** Profile 尚未实现，`project.yaml` 不支持 `profile` 字段。
> 以下为设计规划，不可写入当前配置文件。

profile 是预设的默认配置模板，提供常见发布拓扑的开箱配置。

### 5.1 首版 profile 列表

| profile | 适用场景 |
|---|---|
| `skill-plugin` | 纯 Claude/Codex 插件发布 |
| `npm-package` | 纯 npm 包发布 |
| `split-public-repos` | 父工程 + 多公开子仓库 |
| `hybrid-plugin-npm` | 插件与 npm 包混合发布 |

### 5.2 归一化规则

- profile 只提供默认配置值。
- 最终必须归一化为同一 schema，不能包含另一套发布流程。
- 项目显式声明的字段覆盖 profile 默认值。
- 归一化后的配置摘要必须稳定：相同的项目声明和 profile 组合产生相同的摘要。

---

## 6. Overlay 限制（规划中）

> **当前状态：** Overlay 尚未实现，`project.yaml` 不支持 `overlay` 字段。
> 以下为设计规划，不可写入当前配置文件。

项目 overlay 可以收紧通用规则（增加更严格的要求），但不能：

- 关闭 secret 扫描。
- 关闭发布计划摘要校验。
- 关闭显式授权门。
- 关闭发布后验证。
- 使 hook 接受 shell 字符串。
- 使用本机绝对路径。

违反上述限制的 overlay 在配置加载时拒绝，返回 `CONFIG_INVALID` 错误码。

---

## 7. Waiver 边界（规划中）

> **当前状态：** Waiver 尚未实现，`project.yaml` 不支持 `waiver` 字段。
> 以下为设计规划，不可写入当前配置文件。

当需要绕过某项安全门时，必须使用 waiver 机制：

### 7.1 Waiver 必填字段

| 字段 | 说明 |
|---|---|
| `rule` | 被豁免的规则标识 |
| `reason` | 豁免理由，不得为空 |
| `responsible` | 责任人，不得为空 |
| `expiresAt` | 失效日期，不得为空，不得晚于 30 天 |

### 7.2 展示要求

- Waiver 在批准界面必须显著展示。
- 过期的 waiver 自动失效，对应的规则恢复强制执行。
- Waiver 不适用于以下不可豁免项：secret 扫描、计划摘要校验、显式授权、发布后验证。

---

## 8. 配置验证

配置加载时执行以下验证：

1. YAML 语法正确，无 alias 和重复键。
2. `apiVersion` 为 `release-skill/v1`。
3. `kind` 为 `ReleaseProject`。
4. `project.name` 非空。
5. `releaseUnits` 至少包含 1 个元素。
6. 每个 `releaseUnit.id` 全局唯一。
7. 每个 `releaseUnit.source` 路径在项目中存在。
8. 所有 hook/gate 的 `command` 为数组且第一个元素非空。
9. 所有 hook/gate 的 `cwd` 不包含绝对路径前缀和 `..`。
10. gate id 唯一，unit/distribution scope 引用真实配置。
11. 分支推进策略使用 bound 基线；默认分支初始化具备显式旧/新分支断言。
12. 所有路径字段不包含 `<project-root>/` 前缀。

验证失败返回 `CONFIG_INVALID` 错误码，附带具体失败原因。

---

## 9. 跨标准引用

- 状态机中的状态定义和转换规则见 `01-state-machine.md`。
- 供应链安全中的最小权限和 Action 固定要求见 `04-supply-chain.md`。
- 错误码定义见 `05-evidence-and-errors.md`。
- Adapter 接口见 `06-adapter-contract.md`。

## 0.9.38：替代未发布计划

本功能适用于同一项目、相同发布单元ID集合、目标版本及外部目标下，旧正式计划处于 `PREPARED` 状态且未产生任何发布运行权威的场景。仅在生产环境的 `testIntake` 入口启用，用于显式替代尚未发布的正式计划。已有首个运行状态，或处于 `PARTIAL`、`PUBLISHED`、`VERIFIED` 的计划，不属于这一例外。替代不代表发布成功或独立验收。

替代操作必须预先配置另一个固定 `resultFile`，保留旧要求、判据、结果、候选及引用原件在原路径、原摘要下可核验；新结果不能覆盖旧结果，也不能根据尚未形成的 `subjectDigest` 命名配置造成循环依赖。旧原件缺失或变化即拒绝，不从新文件重建旧依据。0.9.38 必须重新生成本版候选，不豁免 0.9.37 的 `writerVersion` 检查。原接受方需重新判断适用性；字节相同不自动通过。

执行替代需在首次 `prepare` 阶段显式指定 `--replace-unpublished-plan <path>`，其中 `<path>` 必须指向当前项目 `.release-skill/plans/<digest>.json` 中的不可变旧正式计划。该参数仅接受与当前项目、单元、版本和外部目标完全一致的旧计划，禁止用于切换仓库、分支、npm包或发布渠道。首次保存的新候选将在 `prepared` 根部携带可选字段 `replacesPlanDigest`，其值为旧正式计划摘要，并沿用原 `computePlanDigest` 机制进入对象、计划与批准绑定层。若未设置该字段，则保持原有摘要与行为逻辑，候选版本及计划版本不另起协议。后续使用 `--candidate <path>` 续接，前驱已在候选中冻结，不可事后补写；若重复提供选择参数，必须与冻结前驱一致，否则拒绝。

替代生效的唯一条件是：有效新正式计划成功排他原子写入原 `plans/<digest>.json`。写入前失败则不生效；写入后，即使最新计划指针、FROZEN 标记或证据封口失败，也不能恢复旧计划的可发布状态，必须保留失败记录并沿原幂等路径续接核对新权威。新批准仅绑定新计划，旧批准不可跨用。`approve`、`publish` 及其 `ship` 调用均不得继续处理已替代计划，`reconcile` 仍需具备原 `PARTIAL` 源和完整运行谱系，不能将无权威诊断视为恢复输入。

发布零外写诊断须独立于目标归属判断。仅当已核实 producer 版本为 0.9.3、0.9.14、0.9.17、0.9.33、0.9.37 或本版 0.9.38 时，且满足单一版本、完整连续事件、相符封口、完整必要前置门禁顺序，同时无 `release-run.json`、任何 `state` 权威、执行或检查点活动，方可作为零外写诊断依据。三类失败情形在满足上述完整条件时仍可作为诊断：来源门禁失败；0.9.17 在只读 `global-preflight` 仲裁后直接失败；0.9.33 在 `approval-load` 后 `DIAGNOSE` 且无独立 `gate-failed` 事件。诊断不取得计划、恢复、替代、发布或 `TEST` 权威，不基于目录结构、时间戳、错误文本或非权威状态推断归属。

针对 reconcile 失败，仅核实 0.9.22 与 0.9.27 两个 writer 的两条旧记录，分别归属于 0.22.0 与 0.25.0 目标；其 `sourceRunId` 与 `sourceRunDigest` 必须与当前项目原父运行一致，子事件流须符合已审 writer 的完整必要前缀，且 `source-run-load passed` 与 `reconcile started` 必须指向同一父运行，每个 `actionId`/`actionType` 必须对应父计划原动作。仅在完整核验后，方可确认其真实目标并排除替代阻断，失败状态本身不构成零外写，也不赋予恢复、替代或 TEST 权威。

针对 verify 失败，仅 0.9.7 与 0.9.12 两条记录可被用于核实真实目标归属，其唯一父引用取自真实 `source-run-load passed` 的 `sourceRunId`，不接受补造 `sourceRunDigest`，仅接受已核实 writer 的完整有限前后缀。通过当前项目原 `runs` 内父文件，复用 `loadRun`、现行计划 Schema、不可变计划路径、完整谱系与检查点映射，确认父运行 `PUBLISHED`，再根据父计划核实其为 `foundation-adoption-review@0.1.0`，与 0.28.0 不同。每个动作身份必须对应父计划；同目标、不完整父权威、未知阶段、关系冲突或矛盾仍拒。其中 0.9.7 实际执行过隔离消费者安装，包含 `execute` 及本地写入，不能声称“零 execute”或“零本地写入”，亦不得由此授予发布外写权限。verify 失败不构成 publish 零外写证明，不赋予发布、恢复、替代或 TEST 权威。

所有未知、损坏、矛盾、不连续、封口不符或关系冲突的历史记录一律不可用。原件不得删除、搬移、补字段或重建。自引用、环、多有效后继或坏后继均不得使旧计划复活。

替代操作不放宽来源提交与远端 main 的精确相等要求、`TEST` 状态、远端冲突或批准门限制。继续精确执行 Foundation 0.25.0 机制，目标归属由 Release Skill 领域责任判断，不依赖目录名、时间或错误文本推断。本轮未删除或重命名产品能力，替代仅作用于符合条件的运行计划。未发布候选或本地自测不代表发布成功，亦不构成独立验收。所有操作均基于 0.9.38 支持入口，不能撤销任意旧软件或绕过现有协议。
