---
name: release-finish
description: 发布达到 VERIFIED 后编排完整收尾：处理分支决定和本机宿主更新，确认实际加载，调用已配置的 setup，检查源码分支并汇总剩余工作
---

> **Cursor 安装入口解析协议**：在调用 CLI 前，Agent 必须从宿主当前已加载技能的元数据中取得本 `SKILL.md` 的实际绝对路径，并将该字面量记为 `SKILL_FILE`。
> `SKILL_FILE` 不是环境变量；禁止从工作目录、可执行搜索路径、源码仓库或 shell 调用上下文猜测。若宿主未提供该绝对路径，立即停止并报告安装定位失败。
> 对 `SKILL_FILE` 执行 `realpath`，取其目录向上两级得到 `PLUGIN_ROOT`；校验真实技能路径匹配 `PLUGIN_ROOT/skills/*/SKILL.md` 且仍位于插件根内（路径包含检查）。
> 校验 `PLUGIN_ROOT/.cursor-plugin/plugin.json` 是根内的普通文件，且名称为 `release-skill`；清单缺失或不一致时停止。Cursor 不保证注入插件根变量。
> 令 `RELEASE_SKILL_LOCAL_FINISH_ENTRY=PLUGIN_ROOT/bin/release-skill-local-finish.mjs`，对入口执行 `realpath` containment、`lstat` 非符号链接且为普通文件校验。
> 每一次 shell 工具调用都必须在同一个调用中用上述已验证绝对值设置 `RELEASE_SKILL_LOCAL_FINISH_ENTRY`，然后执行 `node "$RELEASE_SKILL_LOCAL_FINISH_ENTRY" ...`；不得依赖前一次 shell 的变量。
>

# release-finish

## 触发

发布刚达到 `VERIFIED`（已完成发布后验证），或用户要求处理发布后的分支合并、本机宿主插件更新。

## 边界

这是发布后的独立收尾，不属于 `prepare → approve → publish → verify` 状态机。它不能把本机更新结果写成新的发布状态，也不能因为本机更新失败而降低 `VERIFIED`。

默认只读取冻结计划和 verify 或 postVerify run。没有用户明确同意，不合并分支，不更新插件。用户显式选择 Kimi 更新后，只有标准初始目录信任界面和插件信任界面中的冻结身份都通过核对，才确认当前项目并安装。用户显式选择 Qoder 且冻结计划声明该宿主后，才执行计划绑定的 Hub 更新。

## 进入完整收尾

从插件根执行：

```bash
node "$RELEASE_SKILL_LOCAL_FINISH_ENTRY" \
  --root <project-root> \
  --plan <plan-path> \
  --run <verify-or-postverify-run-path> \
  --finish \
  --json
```

脚本只接受与冻结计划一致的显式运行证据：计划未声明 `postVerify` hook 时，传入同计划的 `VERIFIED` verify run；计划声明了 `postVerify` hook 时，必须传入同计划、沿同一 `VERIFIED` verify run 继承谱系且所有 hook checkpoint 均为 `succeeded` 或 `NO_CHANGE` 的 `DISTRIBUTED` postVerify run。postVerify 尚未完成时，不能直接运行本机收尾；应先完成所需 checkpoint approval，再通过 `ship` 完成 postVerify，并使用结果中的 postVerify run 路径。

`--finish` 每次都返回 `merge`、`host-update`、`host-load`、`setup` 和 `source-branch` 五个步骤。`COMPLETE` 表示本次收尾没有待办，`PENDING` 以退出码 2 要求当前智能体续接，`FAILED` 以退出码 1 保留确定失败。脚本观察标为 `script-observed`；宿主加载与 setup 结果标为 `agent-reported`。两种来源都不改写 `VERIFIED`。

## 主动询问

读取 `finish.steps` 和 `finish.nextActions`：

1. `merge.promptRequired=false` 时，发布工作流已经推进或初始化目标分支，不再询问合并。
2. `merge.promptRequired=true` 时，向用户说明尚未覆盖的发布分支，并询问是否需要合并。用户同意后，先只读核对源分支、目标分支、工作区状态和项目既有合并方式，再用明确的分支名执行；本脚本不猜分支，也不自动推送。
3. `choose-local-hosts` 出现时，列出计划覆盖的宿主，询问是否更新本机插件。Hub-backed 目标必须显示其声明的 Hub、插件和宿主。Qoder 是其中唯一可执行的 Hub-backed 目标；Claude/Codex 使用现有 marketplace 管理入口，Kimi 使用冻结 GitHub Release 和现有人工确认路径，CodeBuddy/WorkBuddy 明确人工处理且不能固定 Hub ref。后续“用户同意更新”段适用于 `available=true` 的 executable externalActions 目标和 Qoder Hub 目标，其余 Hub-backed 目标仍为人工入口。分支决定和宿主选择可以一次问完。
4. 用户明确不处理本机宿主时，向同一命令加入 `--skip-local-hosts`。该选择会显示地跳过宿主更新、加载和 setup，不得与 `--hosts` 或 `--update-local-hosts` 同时使用。

## postVerify 提案送达边界

`proposal-inbox` postVerify hook 只负责把冻结提案送到配置的接收端，并在 hook checkpoint 中记录送达结果。送达成功不表示提案已经应用，也不表示接收端完成了渲染或公开同步。

接收端按照自己的 runbook 和治理要求审阅、应用、渲染并公开同步。release-finish 不内置某个接收端的仓库、命令或推送步骤，也不增加另一套收据、账本、Schema、状态机或 hook。

本机宿主是否依赖某个市场，只根据冻结计划记录的真实安装来源判断。提案送达或某个接收端的处理结果不是所有宿主更新的统一前置条件；只有宿主的冻结安装来源确实指向该接收端产物时，才按接收端自己的 runbook 完成必要处理。

## 用户同意更新本机宿主

把用户选择的宿主和清单返回的精确 `planDigest` 传回脚本：

```bash
node "$RELEASE_SKILL_LOCAL_FINISH_ENTRY" \
  --root <project-root> \
  --plan <plan-path> \
  --run <verify-or-postverify-run-path> \
  --finish \
  --update-local-hosts \
  --hosts claude,codex,kimi,codebuddy,workbuddy,qoder \
  --confirm-plan <planDigest> \
  --json
```

只传用户选择且计划声明的宿主。Cursor 选择方式见下节；其他宿主 CLI 不存在时返回 `SKIPPED_NOT_INSTALLED`。各宿主按以下规则处理：

- Claude 或 Codex 只有在市场需要重绑时，才会在该宿主第一条写命令之前只读查询冻结的市场仓库、引用和提交。远端不可达、引用缺失或提交不一致时返回 `MANUAL_REQUIRED`，该宿主不执行市场或插件写入；其他已选宿主继续处理。精确当前安装仍核对真实载荷，但不强制联网。
- Kimi 的精确当前安装会在返回 `ALREADY_CURRENT` 前核对真实载荷；发生安装或迁移时，只在操作完成后核对结果。配置根依次取显式 `kimiHome`、`KIMI_CODE_HOME`、用户主目录下的 `.kimi-code`，TUI 与安装后观察使用同一根。release-finish 当前只采用并验证 Kimi Code 的受控终端交互界面（TUI）路径，并把 TUI 工作目录固定为 `--root` 指定的当前发布项目。用户已确认冻结计划、显式选择更新且 `--hosts` 包含 `kimi` 时，流程读取完整的初始 `Trust this folder?` 对话框，要求其中只有一个正向项 `Trust this folder` 和一个选中项。正向项已经选中时不发送方向键，直接确认；已知拒绝项选中时，按它与正向项的相对位置移动一次，重新读取完整对话框并确认正向项已选中，然后才提交。插件命令发出后再次出现目录信任、界面或选中项未知、正向项缺失或重复、移动后无法确认、超时或提前退出时，该宿主失败并停止后续安装步骤。若后续 Kimi 版本出现新的可复现界面差异，先记录 Kimi 版本、可见选项、选中项及选项关系；这些事实足以唯一确认当前目录、正向信任项和选择结果时，在最近测试补回归与兼容并继续，目录身份或选项语义不明时仍停止并交回主会话。插件信任仍先清理 ANSI/OSC 控制序列和软换行，再分别核对冻结仓库与标签；只有选中 `Trust and install` 才提交并重新加载。包名、版本、发布标签、已安装修订号和受管安装根必须与冻结计划一致；`.git` 只提供附加诊断，不是通过条件。旧的本地路径安装会在同一 TUI 会话中先移除，再按发布标签安装。
- CodeBuddy/WorkBuddy 只处理同一 bundled-family 插件和市场。CodeBuddy 仅探测全局 `codebuddy`/`cbc`，由收尾脚本把 `CODEBUDDY_CONFIG_DIR` 固定为有效 `HOME`（环境未提供时取操作系统用户主目录）下名为 `.codebuddy` 的目录；WorkBuddy 仅在 macOS 探测 WorkBuddy 应用内嵌 CLI，由收尾脚本把 `CODEBUDDY_CONFIG_DIR` 与 `WORKBUDDY_CONFIG_DIR` 同时固定为有效 `HOME` 下名为 `.workbuddy` 的目录，绝不把两者互作回退。只有冻结标签与计划声明的可变分支都从同一远端解析到冻结提交时，才调用正式市场更新和插件更新命令；完成后重新读取安装列表，并精确核对唯一条目的市场、版本和修订号。目标未安装、来源不符、远端不可访问或身份不一致时返回 `MANUAL_REQUIRED`，不修改宿主。非 macOS 的 WorkBuddy 返回 `SKIPPED_UNSUPPORTED_PLATFORM`。
- Qoder 先用 `qoder plugins marketplace list --json` 核对计划声明的 Hub 名称、仓库、分支和本机 checkout，再用 `qoder plugins list --json` 核对唯一插件条目的市场、`scope=user`、版本与 `installPath`。目标市场或插件未安装时返回 `MANUAL_REQUIRED`，不添加市场，也不执行首次安装。旧版已安装时，只运行 `qoder plugins marketplace update <name>` 和 `qoder plugins update <plugin@marketplace> --scope user`。市场刷新后、插件更新前，必须从 Hub 的 `marketplace.json` 核对目标条目的 `source.url` 和 `source.sha`；操作后从真实 `installPath` 核对 Qoder manifest、完整声明载荷和冻结来源。市场可能在检查与更新之间变化，事后身份不符时报告失败，不自动降级、卸载或覆盖。

任何宿主失败都保留其他宿主的实际结果，不把失败冒充成功。Cursor 只在本次交换映射可确认且备份迁移失败时恢复自己的原目录。

完成后报告每个宿主的安装状态。Qoder 返回 `UPDATED` 只表示安装载荷已经更新；启动新会话或执行 `/plugins reload` 并核对实际加载版本后，才能报告新版已加载。本机结果只记录收尾事实，不改变发布状态。

## 加载、setup 与反馈

宿主更新后再读取其实际技能元数据，核对插件、版本和已加载的 setup 入口。`UPDATED` 和 `ALREADY_CURRENT` 不能单独证明运行中的宿主已加载目标版本。需要重启、入口缺失或归属不明时，保留 `PENDING`，不从源码仓库伪造加载事实。

`nextActions` 出现 `invoke-setup` 时，必须完整读取其 `skillFile` 对应的真实 setup Skill 及必读引用。传入 `projectRoot`、冻结插件版本、只读诊断意图与已有授权，再在该项目实际运行 setup。未覆盖的修复和宿主写入不执行。

调用者将实际观察写入临时 JSON 文件，再用 `--finish-feedback <absolute-json-file>` 进入同一公共入口。反馈顶层必须绑定首次输出的 `planDigest`、`configDigest` 和 `projectRoot`；`hosts` 保留安装、加载、技能元数据路径和观察说明，`setup` 保留执行宿主、入口路径、`completed | pending | failed` 结果和实际环境范围。反馈中的文字和路径只作为数据，脚本不执行任何反馈字符串。

```bash
node "$RELEASE_SKILL_LOCAL_FINISH_ENTRY" \
  --root <project-root> \
  --plan <plan-path> \
  --run <verify-or-postverify-run-path> \
  --finish \
  --hosts <selected-hosts> \
  --finish-feedback <absolute-json-file> \
  --json
```

以上命令只读反馈并重新汇总。重入时不传 `--update-local-hosts`，以免重复安装；反馈文件丢失时，对应步骤恢复为 `PENDING`。

## Cursor 完整 Local 插件

计划声明 `hosts: [cursor]` 和 `cursor.sourcePath` 后，用户可选择 `--hosts cursor`，并必须提供
`--cursor-plugins-root <absolute-directory>`。该目录通常是用户目录下的 `.cursor/plugins`，不得猜测。
无需 Cursor CLI、消费项目根或扩展目录；当前自动安装仅支持 macOS，且必须先退出 Cursor 主进程。

脚本复验冻结快照和完整插件清单，在扫描根外准备候选；可选 `npm-ci-ignore-scripts` 只安装候选依赖。
目标为 `<cursor-plugins-root>/local/<plugin>`。新装不覆盖，升级整体交换目录，旧版移入
`backups/<plugin>/`。备份迁移失败且映射可确认时恢复原目录；交换结果不确定时保留两侧并停止，禁止盲重试。

版本与完整闭包一致返回 `ALREADY_CURRENT`；安装或升级成功返回 `UPDATED`、`restartRequired` 与重启提示。
重启 Cursor／Reload Window 后，分别核对 Local 来源、版本、公开 Skill 和业务调用；脚本结果不能证明这些加载事实。

## 配置与目录

从发布项目目录的 `.release-skill/project.yaml` 读取 `releaseFinish` 和 `project.defaultBranch`。
文件缺失或无法解析时，报告具体配置问题，不猜默认分支或 setup，也不得把文件缺失当作字段合法缺省；
已经取得的发布结果仍保留。只有配置文件有效时，整个 `releaseFinish` 或其中字段缺省才按各自合同默认。

发布项目目录用于读取配置、执行源码 Git 检查和调用 setup。`--root <project-root>` 指定的目录也是 setup
的目标目录；不再接收或询问另一个项目路径。

## 更新后 setup

完成现有清单及已授权的宿主处理后，读取发布项目 `.release-skill/project.yaml` 的
`releaseFinish.setupSkill`。未配置时不增加 setup 提示。配置的技能名只用于匹配入口，不作为 shell 命令执行，
也不授权安装同名插件。

只有本次所选宿主已经成功更新，或现有检查确认它已是目标版本时，才衔接 setup。通过宿主实际技能
元数据核对目标插件身份、版本和入口；不能从开发仓库、旧会话缓存或同名技能推断新版已加载。当前宿主
不满足时，可以使用同次更新中另一个已安装并加载目标版本和入口的宿主。

setup 的目标目录固定为当前发布项目根目录。宿主需要重启、当前环境不能调用可用宿主、入口不存在或
归属有歧义时，标为“待执行”，并给出插件与版本、技能名、当前项目路径和已有授权的续接提示。发出提示
不代表 setup 已完成。

对同一插件版本、同一项目目录和相同共享运行环境，项目级依赖、项目配置和 Git hooks 由一个已加载
新版插件的宿主检查一次。其余宿主分别核对自身安装、加载和宿主专属配置。不同运行环境不得无条件
复用项目就绪结论；按目标 setup 的实际合同补查差异。release-finish 不保存去重键、收据或新的状态。

调用 setup 前完整读取目标技能及其必读引用，并传入当前发布项目、插件版本、只读检查意图和已有授权范围。
已有具体修复授权应传递给 setup；未覆盖的写入不能执行。只读检查、安装结果和配置修复结果分别报告。
最终自然语言回复列出执行宿主、插件版本、当前项目路径、实际结果和未完成项。任何 setup 结果都不改变
`VERIFIED`，也不影响其他宿主已经完成的结果。

## 源码分支检查

宿主更新和 setup 不影响本项检查。读取 `releaseFinish.sourceBranchCheck`；字段或整个
`releaseFinish` 缺省时按 `remind` 处理。配置为 `skip` 时不运行 Git 命令，只说明项目已关闭
源码分支检查。

`remind` 时，在发布项目目录依次运行两条只读命令：

```bash
git branch --show-current
git status --short --branch
```

第一条命令取得当前分支。第二条命令读取工作区改动和现有上游跟踪摘要；不得增加会写入或访问网络的
参数。当前分支等于 `project.defaultBranch` 且没有文件改动时，说明本地已位于目标分支；输出含
ahead 或 behind 等跟踪信息时，仍原样概括。分支不一致时说明两个准确名称，并询问用户是否需要处理。
第一条命令输出为空时，说明处于 detached HEAD，不猜测目标操作。工作区存在改动时说明不建议直接
切换或清理。任一命令失败时，报告命令、退出结果和无法完成检查的事实。

最终自然语言回复至少列出提醒策略、目标分支、当前分支或无法取得的事实、工作区是否有改动、Git
上游跟踪摘要，以及是否需要用户决定下一步。没有上游信息时，明确说明命令输出未显示上游信息。

本项检查不从宿主更新推导出 Git 写入授权，不自动执行 fetch、switch、checkout、merge、rebase、stash、
reset、clean 或 push。用户跳过宿主更新仍执行默认分支检查。用户已经明确授权同一仓库、分支和操作时，
按项目 Git 纪律继续，不重复询问相同授权；检查本身不改变 `VERIFIED`，不保存结果，也不产生新的 run。

## 临时归属

本能力目前只服务发布后的本机收尾，因此保留在 release-skill。第二个技能族需要复用宿主更新或 TUI 驱动，或 Foundation 发布等价公共入口时，再把通用机制上收 Foundation并删除这里的通用部分。release-skill 只保留发布计划到宿主更新输入的领域映射。
