# 安装指南

[English](INSTALL.md)

<!-- release-skill:release-version: 0.7.5 -->
## 前置条件

- Node.js 22.0.0 或更高版本
- Git 2.30 或更高版本

## 从 npm 安装（推荐）

公开版本只有在不可变生产计划经过批准、发布并达到 `VERIFIED` 后才算完整。对于尚未公开发布的源码版本，只有当 `npm view release-skill version` 返回该精确版本后才使用 npm 安装；在此之前请使用下文的源码检出方式。

```bash
npm install -g release-skill
CLI=(release-skill)
```

也可以不安装，直接运行：

```bash
npx release-skill help
```

验证安装：

```bash
release-skill --version
release-skill help
```

输出中应包含版本号和可用命令列表。

## 安装为插件（bundled-family 市场——推荐）

Claude Code、CodeBuddy、WorkBuddy 和 Codex 从 bundled-family 市场
[ifoohoo/release-skill](https://github.com/ifoohoo/release-skill)
安装 release-skill。插件仓库自身携带市场清单
（`.claude-plugin/marketplace.json`），无需外部市场。Kimi Code 没有市场安装
接口——见 [Kimi Code 小节](#安装为-kimi-code-插件)。先添加一次市场，再安装
插件：

> **前置条件：GitHub 访问。** `owner/repo` 简写会让 Claude Code 通过
> `git@github.com:...`（SSH）克隆，需要本机配置 GitHub 公钥。如不使用 SSH，
> 可传完整 HTTPS 地址——`/plugin marketplace add https://github.com/ifoohoo/release-skill`——
> 或设置 `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1`。

**Claude Code**（交互会话中）：

```
/plugin marketplace add ifoohoo/release-skill
/plugin install release-skill@release-skill
```

**CodeBuddy / WorkBuddy：**

```bash
codebuddy plugin marketplace add ifoohoo/release-skill
codebuddy plugin install release-skill@release-skill
```

WorkBuddy 桌面端只能通过已注册的市场安装：执行上面的 `marketplace add`
之后，在插件面板中安装 `release-skill`。

**OpenAI Codex：**

```bash
codex plugin marketplace add ifoohoo/release-skill
```

然后在交互式 `/plugins` 浏览器中安装 `release-skill`。

**Kimi Code**（交互会话中）：

Kimi Code 没有市场安装接口，发布后需手动安装并钉死到特定 release tag。
release-skill 会返回待办，但不核验其完成结果。

### 备选：直接从仓库安装（进阶）

上面的统一市场是受支持的主路径。直接从发布仓库安装仍可用于进阶场景：

- Claude Code：`/plugin marketplace add ifoohoo/release-skill`，然后
  `/plugin install release-skill@release-skill`。
- Kimi Code：下文 [Kimi Code 小节](#安装为-kimi-code-插件)中版本钉死的
  `/plugins install <release-tag URL>`。
- CodeBuddy：源码检出后通过 `--plugin-dir <path>/adapters/workbuddy`
  单会话使用（见
  [CodeBuddy/WorkBuddy 小节](#安装为-codebuddyworkbuddy-插件)）。

## 安装为 Kimi Code 插件

Kimi Code 是与 Claude Code 和 Codex 并列的受支持插件宿主。Kimi Code 插件
清单位于 `.kimi-plugin/plugin.json`，与 `.claude-plugin/plugin.json`、
`.codex-plugin/plugin.json` 对应；包内同时提供 `adapters/kimi/`，与
`adapters/claude/`、`adapters/codex/` 并列。

Kimi Code 有交互式插件市场，但**没有可脚本化的非交互安装接口**。因此
新发布计划中，`publish` 完成自动化远端写入后返回非阻塞的
`manualFollowUps`，其中含钉死的安装 URL；`verify` 不安装也不检查 Kimi，返回
`verifiedBySystem: false`，该待办不阻塞 `VERIFIED`。

发布完成后，维护者可启动 Kimi Code，从钉死到精确版本的 release tag 安装
（切勿使用裸仓库地址，它会安装最新 release 或默认分支），确认信任提示后重新加载：

   ```
   /plugins install https://github.com/ifoohoo/release-skill/releases/tag/release-skill-v0.7.5
   /plugins reload
   ```

新计划无需收据或人工证明。`attest` 命令仅兼容缺少
`humanConsumersStrategy: manualFollowUps` 标记的旧冻结计划。

## 安装为 CodeBuddy/WorkBuddy 插件

CodeBuddy（桌面端产品 WorkBuddy）是与 Claude Code、Codex、Kimi Code 并列的受支持
插件宿主。本包随 `adapters/claude/`、`adapters/codex/`、`adapters/kimi/` 一并提供
生成的自包含 CodeBuddy/WorkBuddy 适配器 `adapters/workbuddy/`。其清单位于
`.codebuddy-plugin/plugin.json`（组件——`skills/`、`bin/`、`schemas/`、
`native/`——按 CodeBuddy 插件规范位于插件根目录），技能通过
`${CODEBUDDY_PLUGIN_ROOT}` 解析 CLI 入口；CodeBuddy 会像 Claude Code 展开
`${CLAUDE_PLUGIN_ROOT}` 一样内联展开该变量。build adapter 目录名为 `workbuddy`，
而平台 / 分发 id 为 `codebuddy`，两个名字指向同一目标。

codebuddy CLI 可以添加市场并安装插件，但 **`plugin marketplace add` 与
`plugin install` 均无 ref 选项**——安装会跟踪市场默认分支 / latest。因此自动化
安装检查点无法保证冻结产物的同一性，release-skill 把 CodeBuddy 安装建模为
发布后的非阻塞团队待办。`publish` 在 `manualFollowUps` 中返回任务；`verify`
不检查安装并返回 `verifiedBySystem: false`。发布后从 bundled-family 市场
`ifoohoo/release-skill` 安装即可。新计划无需收据或人工证明；`attest` 只兼容旧冻结计划。

源码检出后也可以用 `--plugin-dir <path>/adapters/workbuddy` 把 CodeBuddy 指向
生成的插件目录做单会话使用；适配器不引用自身目录之外的任何文件。

## 消费端安装验证边界

**何时执行验证。** 消费端安装验证仅在安装契约关键文件相对已确认公开基线发生变化时执行；
关键文件未变化时结果为 `NOT_REQUIRED_UNCHANGED`，不得追加重复安装验证。

**市场来源选择。** 每个平台、每次发布只能选择一种市场来源：
`bundled-family`（技能族自带市场文件）或 `standalone-index`（独立市场索引），不能同时使用。

**Codex 自动验证优先。** Codex 优先自动验证；仅当 CLI/接口、运行环境或传输通道不可用时，
才允许降级为人工判定。身份、版本、载荷、市场来源或安装契约不一致属于失败，不能人工覆盖。

## 开发安装（本地源码）

用于开发或尚未公开发布的源码候选：

```bash
export RELEASE_SKILL_HOME=/absolute/path/to/release-skill
cd "$RELEASE_SKILL_HOME"
npm exec --yes pnpm@10.17.1 -- install --frozen-lockfile
```

通过以下数组调用命令行工具：

```bash
CLI=(node "$RELEASE_SKILL_HOME/packages/release-skill/bin/release-skill.mjs")
"${CLI[@]}" help
```

当 `npm view release-skill version` 已确认目标版本公开并安装后，等价的 npm 入口是 `CLI=(release-skill)`。同一次运行不要混用 npm 与源码入口。

## 首次运行

最安全的首条命令始终是 `help`。它完全在本地运行，不写入文件：

```bash
"${CLI[@]}" help
```

如果项目尚无 `.release-skill/project.yaml`，把完整只读报告写入临时文件，只查看其中确定性的 `compactSummary`（紧凑摘要）：

```bash
PROJECT=/path/to/your/project
SETUP_SESSION="$(mktemp -d "${TMPDIR:-/tmp}/release-setup.XXXXXX")"
REPORT="$SETUP_SESSION/discovery.json"
ANSWERS="$SETUP_SESSION/answers.json"
BOUND_REPORT="$SETUP_SESSION/bound.json"
printf 'SETUP_SESSION=%s\nPROJECT=%s\n' "$SETUP_SESSION" "$PROJECT"

"${CLI[@]}" setup --root "$PROJECT" --json > "$REPORT" || test "$?" -eq 2
node -e 'const fs=require("node:fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!r.compactSummary){console.error("compactSummary missing");process.exit(2)}process.stdout.write(JSON.stringify(r.compactSummary,null,2)+"\n")' "$REPORT"
```

紧凑摘要只是审阅视图，不是授权；`setupDigest` 仍绑定完整事实、候选和 answers。若 `proposalConflicts` 非空，必须由人工修正冲突的仓库/映射权威事实后重跑 setup，不能猜测选边。没有冲突时，机械提取机器提案：

```bash
SETUP_SESSION='/上一步打印的会话目录绝对路径'
PROJECT='/上一步打印的项目绝对路径'
REPORT="$SETUP_SESSION/discovery.json"
ANSWERS="$SETUP_SESSION/answers.json"
BOUND_REPORT="$SETUP_SESSION/bound.json"
node -e 'const fs=require("node:fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if((r.proposalConflicts??[]).length){console.error("proposal conflicts require human resolution");process.exit(2)}if(!r.recommendedAnswers){console.error("recommendedAnswers missing");process.exit(2)}fs.writeFileSync(process.argv[2],JSON.stringify(r.recommendedAnswers,null,2)+"\n",{flag:"wx",mode:0o600})' "$REPORT" "$ANSWERS"

"${CLI[@]}" setup --root "$PROJECT" --answers "$ANSWERS" --json > "$BOUND_REPORT"
node -e 'const fs=require("node:fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!r.compactSummary||!r.setupDigest){console.error("bound setup report incomplete");process.exit(2)}process.stdout.write(JSON.stringify({compactSummary:r.compactSummary,setupDigest:r.setupDigest},null,2)+"\n")' "$BOUND_REPORT"
printf 'SETUP_SESSION=%s\nPROJECT=%s\n' "$SETUP_SESSION" "$PROJECT"
```

人工只确认一次绑定摘要和精确摘要值，然后使用已确认字面量首次创建。结果必须是 `CONFIG_CREATED`；第二次 setup 必须是 `ALREADY_CONFIGURED`，随后运行 assess。

```bash
SETUP_SESSION=<上一步打印的会话目录绝对路径>
PROJECT=<上一步打印的项目绝对路径>
ANSWERS="$SETUP_SESSION/answers.json"
CREATED_REPORT="$SETUP_SESSION/created.json"
POST_REPORT="$SETUP_SESSION/post-setup.json"
ASSESS_REPORT="$SETUP_SESSION/assess.json"
"${CLI[@]}" setup --root "$PROJECT" --answers "$ANSWERS" \
  --write --confirm-setup <已确认的 setupDigest> --json > "$CREATED_REPORT"
"${CLI[@]}" setup --root "$PROJECT" --json > "$POST_REPORT"
set +e
"${CLI[@]}" assess --root "$PROJECT" --offline --json > "$ASSESS_REPORT"
ASSESS_EXIT=$?
set -e
[ "$ASSESS_EXIT" -eq 0 ] || [ "$ASSESS_EXIT" -eq 1 ] || exit "$ASSESS_EXIT"
node -e 'const fs=require("node:fs");const [c,p,a]=process.argv.slice(1).map(x=>JSON.parse(fs.readFileSync(x,"utf8")));if(c.status!=="CONFIG_CREATED"||p.status!=="ALREADY_CONFIGURED"||!["ASSESSED","NEEDS_INPUT","BLOCKED"].includes(a.status)){process.exit(2)}process.stdout.write(JSON.stringify({created:c.status,postSetup:p.status,assessment:{status:a.status,summary:a.summary,gapCount:(a.gaps??[]).length,blockingCodes:(a.gaps??[]).filter(g=>g.severity==="error").map(g=>g.code)}},null,2)+"\n")' "$CREATED_REPORT" "$POST_REPORT" "$ASSESS_REPORT"
node -e 'require("node:fs").rmSync(process.argv[1],{recursive:true,force:false})' "$SETUP_SESSION"
```

解释器/包管理器间接脚本以 `SIDE_EFFECTS_UNPROVEN` 排除且默认不选。项目特有 hook/gate 只能经人工审阅后增量注册：hook 编辑 `projectConfig.hooks`；gate 编辑 `verificationGates` 并将同一 id 加入 `selectedGateIds`，然后重跑绑定 dry-run。人工文件使用 `mode: preserve`；显式跨单元共享源使用 `sourceScope: workspace`。

### 进阶 schema 参考——不是首次运行主路径

下面的外壳只说明 schema。正常 setup 不应手写，而应机械提取 `recommendedAnswers`。

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
        "type": "npm",
        "package": "my-project",
        "access": "public",
        "provenance": false,
        "tag": "latest",
        "registry": "https://registry.npmjs.org",
        "publisher": "my-npm-username"
      }],
      "publicFiles": [
        { "from": "README.md", "to": "README.md", "mode": "preserve" },
        { "from": "package.json", "to": "package.json", "mode": "preserve" }
      ],
      "requiredPublicFiles": ["README.md", "package.json"],
      "previousPublicBaseline": { "mode": "none" },
      "production": {
        "branchTemplate": "release/{tag}",
        "branchStrategy": "create-release-branch"
      }
    }]
  },
  "selectedGateIds": []
}
```

这个外壳仅供参考。正常 setup 必须使用机器提案；只有确认不存在历史公开版本时才可使用 `mode: none`。

已有配置永远不会被重新生成或覆盖。无法发现 GitHub/npm 渠道的项目返回 `LOCAL_ONLY_DETECTED`，不会冒充生产就绪。

自动 create-once 写入使用 v0.1.3 随包提供、带摘要登记的 `darwin-arm64` 原生预构建。其他平台以 `SAFE_WRITE_UNAVAILABLE` 失败关闭；此时保留只读报告，由人工首次创建经审阅的文件，不得启用不安全的路径写入兜底。

### 增量 postPublish hook 提案（已有配置）

已完成配置的项目不会重跑 create-once setup。setup 另外提供严格只读的下游发现与仅追加的 hook 提案模式。发现阶段报告 git 远端镜像候选、工作区及其直接邻居中的 marketplace 与 docs 线索、`artifact-graph.config.yaml` 存在性以及 foundation profile 元信息，全程不写入：

```bash
PROJECT=/path/to/your/project
"${CLI[@]}" setup --root "$PROJECT" --discover-downstream --json
```

提案 dry-run 渲染合法的 postPublish hook 声明草案与候选证据，并把现有配置字节、发现事实与选择集合绑定进 `setupDigest`：

```bash
PROJECT=/path/to/your/project
PROPOSAL_REPORT="$(mktemp "${TMPDIR:-/tmp}/release-hooks-proposal.XXXXXX")"
"${CLI[@]}" setup --root "$PROJECT" --propose-hooks --json > "$PROPOSAL_REPORT"
node -e 'const fs=require("node:fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!r.setupDigest){console.error("setupDigest missing");process.exit(2)}process.stdout.write(JSON.stringify({status:r.status,targetUnitId:r.targetUnitId,appendableHookIds:r.appendableHookIds,conflicts:r.conflicts,setupDigest:r.setupDigest},null,2)+"\n")' "$PROPOSAL_REPORT"
```

`--select-hooks <ids>` 将选择收窄到列出的提案 id；`--foundation-profile <path>` 追加显式 foundation profile（仅作为提案输入，绝不自动应用）；当多个发布单元声明了 postPublish 基础时，`--unit <id>` 选定目标发布单元。人工审阅草案一次之后，精确确认的摘要授权一次仅追加 `releaseUnits[<target>].postPublish.hooks` 的写入；该模式绝不触碰 create-once 边界：

```bash
"${CLI[@]}" setup --root "$PROJECT" --propose-hooks \
  --write --confirm-setup <已确认的 setupDigest> --json
```

写入返回 `HOOKS_APPENDED`；没有可追加内容时返回 `HOOKS_NO_CHANGE` 且零写入。错误或过期的摘要以 `SETUP_DIGEST_MISMATCH` 失败关闭；重跑 dry-run 并重新审阅新的摘要。增量追加要求目标发布单元已声明 postPublish 的 materialize/commitIdentity 分发基础，且写入前会重新校验合并后的声明。

配置存在后，检查发布就绪度：

```bash
"${CLI[@]}" assess --root /path/to/your/project --offline --json
```

该命令只读地检查项目结构、配置、文档和供应链；未显式传入 `--output` 时不写报告，也不运行项目 hook。

`prepare` 不同：它在目标项目的 `.release-skill/` 下写入发布工件，并可能运行已配置 hook。hook 是无沙箱的任意进程，可能写到项目外、访问凭据、使用网络或执行远端写入。`prepare` 命令调用本身即授权执行已配置的 hook 和 gate，无需额外授权参数。

Git 仓库应保留人工配置，同时忽略生成的权威文件和证据：

```gitignore
.release-skill/*
!.release-skill/project.yaml
```

## 项目配置

在项目根目录创建 `.release-skill/project.yaml`。以下是单包项目的最小示例：

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
    distributions:
      - type: npm
        package: my-project
        access: public
        provenance: false
        tag: latest
        registry: https://registry.npmjs.org
        publisher: my-npm-username
    publicFiles:
      - from: README.md
        to: README.md
        mode: preserve
      - from: package.json
        to: package.json
        mode: preserve
      - from: LICENSE
        to: LICENSE
        mode: preserve
    requiredPublicFiles: [README.md, package.json, LICENSE]
    previousPublicBaseline:
      mode: none # 仅限已确认不存在历史公开版本
```

### 进阶：hook（可选）

hook 是可选的任意本地进程。`prepare` 命令调用本身即授权执行已配置的 hook：

```yaml
hooks:
  build:
    command: [npm, run, build]
  test:
    command:
      - node
      - -e
      - "const p=require('./package.json'); if (!p.name) process.exit(1)"
```

参数约束和安全要求见[完整 README](README.zh-CN.md)。

### 进阶：验证 gate（可选）

`snapshot-verify` 用于冻结公开快照的一次性可写副本；`consumer-verify` 用于精确且隔离安装后的 npm/Claude/Codex/Kimi Code 根目录。gate 使用可执行文件数组而不是 shell 字符串，并声明 unit、必要时的 distribution、cwd、超时和环境变量白名单。

```yaml
verificationGates:
  - id: package-contract
    phase: snapshot-verify
    scope: { unit: my-project }
    command: [node, -e, "const p=require('./package.json');if(!p.name)process.exit(1)"]
    cwd: .
    timeoutMs: 30000
    envAllowlist: []
```

这个自包含示例只读取已映射的公开文件。若替换成项目脚本，该脚本及全部依赖必须存在于冻结公开快照；gate 不能借用父工作空间中的测试、开发依赖或 `node_modules`。

`prepare` 和 `verify` 命令调用本身即授权执行已配置的 gate，无需额外授权参数。hook/gate 都是无网络沙箱的项目进程；release-skill 约束其输入与证据，但无法保证自定义命令不修改文件或不访问网络。禁止把 Git push、tag、默认分支修改、GitHub Release 或 npm publish 注册为 hook/gate，它们只能由受控的计划动作完成。

### 进阶：发布文档刷新（可选）

发布单元可以声明 `releaseDocuments`，用一份结构化说明源确定性刷新 README 受管区域和 CHANGELOG 当前版本条目。该命令离线运行：不联网、不调用大模型、不自动翻译；只改写声明过的受管区域、唯一版本标记的机器值和 CHANGELOG 当前版本受管条目，其他字节全部保留。`prepare` 只检查新鲜度，不写工作树。

```yaml
# .release-skill/project.yaml 的发布单元片段
releaseUnits:
  - id: my-project
    source: .
    releaseDocuments:
      notesSource: release-notes/{version}.yaml
      locales: [en, zh-CN]
      changelogs:
        - path: CHANGELOG.md
          locale: en
      readmes:
        - path: README.md
          locale: en
          regions: [latest-release]
          versionMarkers:
            - id: current-version
              pattern: '<!-- release-skill:version -->v{version}<!-- /release-skill:version -->'
        - path: README.zh-CN.md
          locale: zh-CN
          regions: [latest-release]
```

先只读演练，确认后再带三项绑定写入：

```bash
"${CLI[@]}" docs refresh --root <your-project> --unit my-project --json
"${CLI[@]}" docs refresh --root <your-project> --unit my-project \
  --write --confirm-refresh <refreshDigest> --ack-local-document-write --json
```

`refreshDigest` 绑定规范说明对象、配置投影和按路径排序的逐文件新旧摘要，不绑定时间、绝对路径或展示文本。摘要不匹配以 `RELEASE_DOCS_REFRESH_STALE` 失败关闭且零写入；候选无变化时返回 `clean` 同样零写入。该授权只覆盖声明的本地文档目标，不是 hook、提交、push、publish 或安装的授权。完整契约见 README 的发布文档刷新章节。

### 生产分支策略

每个生产发布单元显式选择一种策略：

- `create-release-branch`：创建此前不存在且不可变的 release 分支；
- `advance-existing-branch`：从精确绑定的公开基线用普通非 force push 快进已有分支；
- `initialize-default-branch`：创建不存在的标准分支；只有同时审阅 `setAsDefaultBranch` 与 `expectedCurrentDefaultBranch` 后，计划才可增加显式默认分支动作。

远端漂移、非快进或默认分支不符合预期时必须停止并由人工介入。所有策略都禁止覆盖远端历史。新建 ref 仅使用 `--force-with-lease=<ref>:` 作为“目标必须不存在”的原子断言；推进已有分支使用普通非 force push。

```yaml
# create-release-branch：目标分支必须不存在
previousPublicBaseline: { mode: none } # 仅限真正的首次公开发布
production:
  branchTemplate: release/{tag}
  branchStrategy: create-release-branch
```

```yaml
# advance-existing-branch：ref 必须精确等于 refs/heads/<目标分支>
previousPublicBaseline:
  mode: bound
  repo: owner/my-project
  ref: refs/heads/main
  commit: 0123456789abcdef0123456789abcdef01234567
production:
  branchTemplate: main
  branchStrategy: advance-existing-branch
```

```yaml
# initialize-default-branch：main 必须不存在，当前默认分支必须符合预期
previousPublicBaseline:
  mode: bound
  repo: owner/my-project
  ref: refs/heads/old-public-branch
  commit: 0123456789abcdef0123456789abcdef01234567
production:
  branchTemplate: main
  branchStrategy: initialize-default-branch
  setAsDefaultBranch: true
  expectedCurrentDefaultBranch: old-public-branch
```

后两种策略必须在线执行 production prepare。任何不一致都应停止并审阅；只有检查真实远端状态后才能人工更新权威配置，禁止 force push 或弱化基线。

### Workspace 源码权威

`project.sourceRepository` 是承载人工源文件的 workspace GitHub
`owner/repo`，可以与各 release unit 的 `publicRepo` 不同。
`project.defaultBranch` 是该仓库真实的远端默认分支，不假设一定为 `main`。

生产 prepare 冻结所有 `publicFiles.from` 展开输入和各 unit
`version.source` 的内容与 Git mode，只拒绝这个闭包内的未提交变化。publish 在任何
adapter execute 前从远端默认分支比较同一闭包。判定不依赖 commit ancestry，因此
merge、squash、rebase 后字节仍一致即可通过；README 被 revert 或冲突解决丢失时按路径
阻断。差异必须由人工处理并把接受内容放入默认分支；release-skill 不自动 merge、切分支、
push 或创建 PR。

## 保护人工维护内容

README 文案、slogan、示例、排版及其他人工源文件始终是权威。release-skill 只按 `publicFiles` 映射做快照，不重新生成或覆盖源 README。每次人工编辑后重新 prepare，并批准新的不可变计划；不得编辑冻结快照或复用旧批准绕过变化。

如果已有公开副本发生漂移，显式选择：

- **merge（合并）**：比较真实远端内容，把接受的改动合并回人工源文件，然后把 `previousPublicBaseline` 绑定到精确不可变的 `repo`/`ref`/`commit`，再 prepare；
- **adopt（采纳）**：接受远端为新的事实来源，先带回人工源文件，再更新同一基线绑定；
- **reject（拒绝）**：停止并调查。不得改成 `mode: none` 绕过漂移或唯一性检查。

## 下一步

- 阅读[完整中文 README](README.zh-CN.md)了解整个工作流。
- 缺少配置时运行 `"${CLI[@]}" setup --root <your-project> --json`，在人工决策完成前保持默认 dry-run。
- 运行 `"${CLI[@]}" assess --root <your-project> --offline` 检查发布就绪度。
- 运行 `"${CLI[@]}" prepare --root <your-project> --offline` 生成发布计划；release-skill 自身只做本地写入，但项目 hook 可能执行远端操作。
- 生产前为每个 unit 配置 `previousPublicBaseline`。已有公开版本必须使用 `mode: bound`，
  绑定精确 `repo`、`ref` 和 `commit`；同时配置 workspace 的
  `project.sourceRepository` 与真实 `project.defaultBranch`，再运行
  `"${CLI[@]}" prepare --root <your-project> --online --production`。prepare 不下载源码
  内容；publish 会在任何 execute 前检查源码权威闭包与目标唯一性。
- 生产命令只使用 `prepare --json` 返回的不可变 `planPath`，以及 `approve --json` 返回的不可变 `approvalPath`。
