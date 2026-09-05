---
name: release-finish
description: 发布达到 VERIFIED 后处理发布收尾：确认 postVerify 提案送达边界，按发布分支策略决定是否询问合并，并在用户确认后更新本机 Claude、Codex、Kimi、CodeBuddy/WorkBuddy 插件
---

> **Codex 安装入口解析协议**：在调用 CLI 前，Agent 必须从宿主当前已加载技能的元数据中取得本 `SKILL.md` 的实际绝对路径，并将该字面量记为 `SKILL_FILE`。
> `SKILL_FILE` 不是环境变量；禁止从工作目录、可执行搜索路径、源码仓库或 shell 调用上下文猜测。若宿主未提供该绝对路径，立即停止并报告安装定位失败。
> 对 `SKILL_FILE` 执行 `realpath`，取其目录向上两级得到 `PLUGIN_ROOT`；校验真实技能路径匹配 `PLUGIN_ROOT/skills/*/SKILL.md` 且仍位于插件根内（路径包含检查）。
> 令 `RELEASE_SKILL_LOCAL_FINISH_ENTRY=PLUGIN_ROOT/bin/release-skill-local-finish.mjs`，对入口执行 `realpath` containment、`lstat` 非符号链接且为普通文件校验。
> 每一次 shell 工具调用都必须在同一个调用中用上述已验证绝对值设置 `RELEASE_SKILL_LOCAL_FINISH_ENTRY`，然后执行 `node "$RELEASE_SKILL_LOCAL_FINISH_ENTRY" ...`；不得依赖前一次 shell 的变量。
>

# release-finish

## 触发

发布刚达到 `VERIFIED`（已完成发布后验证），或用户要求处理发布后的分支合并、本机宿主插件更新。

## 边界

这是发布后的独立收尾，不属于 `prepare → approve → publish → verify` 状态机。它不能把本机更新结果写成新的发布状态，也不能因为本机更新失败而降低 `VERIFIED`。

默认只读取冻结计划和 verify 或 postVerify run。没有用户明确同意，不合并分支，不更新插件。Kimi 只在插件信任界面中的仓库和标签都与冻结目标一致时确认安装；目录信任不自动确认。

## 先生成收尾清单

从插件根执行：

```bash
node "$RELEASE_SKILL_LOCAL_FINISH_ENTRY" \
  --root <project-root> \
  --plan <plan-path> \
  --run <verify-or-postverify-run-path> \
  --json
```

脚本只接受与冻结计划一致的显式运行证据：计划未声明 `postVerify` hook 时，传入同计划的 `VERIFIED` verify run；计划声明了 `postVerify` hook 时，必须传入同计划、沿同一 `VERIFIED` verify run 继承谱系且所有 hook checkpoint 均为 `succeeded` 或 `NO_CHANGE` 的 `DISTRIBUTED` postVerify run。postVerify 尚未完成时，不能直接运行本机收尾；应先完成所需 checkpoint approval，再通过 `ship` 完成 postVerify，并使用结果中的 postVerify run 路径。

## 主动询问

读取返回的 `merge` 和 `localHostUpdate`：

1. `merge.promptRequired=false` 时，发布工作流已经推进或初始化目标分支，不再询问合并。
2. `merge.promptRequired=true` 时，向用户说明尚未覆盖的发布分支，并询问是否需要合并。用户同意后，先只读核对源分支、目标分支、工作区状态和项目既有合并方式，再用明确的分支名执行；本脚本不猜分支，也不自动推送。
3. `localHostUpdate.promptRequired=true` 时，列出计划覆盖的宿主，询问是否更新本机插件。Hub-backed 目标必须显示其声明的 Hub、插件和宿主，并明确这是人工安装/升级入口，不运行本机命令；Claude/Codex 使用现有 marketplace 管理入口，Kimi 使用冻结 GitHub Release 和现有人工确认路径，CodeBuddy/WorkBuddy 明确人工处理且不能固定 Hub ref。后续“用户同意更新”段仅适用于 `available=true` 的 executable externalActions 目标；Hub-backed 始终人工入口。两个问题可以一次问完。

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
  --update-local-hosts \
  --hosts claude,codex,kimi,codebuddy,workbuddy \
  --confirm-plan <planDigest> \
  --json
```

只传用户选择且计划声明的宿主。宿主 CLI 不存在时返回 `SKIPPED_NOT_INSTALLED`。各宿主按以下规则处理：

- Claude 或 Codex 只有在市场需要重绑时，才会在该宿主第一条写命令之前只读查询冻结的市场仓库、引用和提交。远端不可达、引用缺失或提交不一致时返回 `MANUAL_REQUIRED`，该宿主不执行市场或插件写入；其他已选宿主继续处理。精确当前安装仍核对真实载荷，但不强制联网。
- Kimi 的精确当前安装会在返回 `ALREADY_CURRENT` 前核对真实载荷；发生安装或迁移时，只在操作完成后核对结果。配置根依次取显式 `kimiHome`、`KIMI_CODE_HOME`、用户主目录下的 `.kimi-code`，TUI 与安装后观察使用同一根。release-finish 当前只采用并验证 Kimi Code 的受控终端交互界面（TUI）路径：清理 ANSI/OSC 控制序列和软换行后，在插件信任对话框内分别核对冻结仓库与标签，确认选中 `Trust and install` 后才提交，再重新加载。出现 `Trust this folder?`、未知界面、超时、提前退出，或无法确认身份和选中项时返回 `MANUAL_REQUIRED` 或失败结果，不确认目录信任，也不继续安装。包名、版本、发布标签、已安装修订号和受管安装根必须与冻结计划一致；`.git` 只提供附加诊断，不是通过条件。旧的本地路径安装会在同一 TUI 会话中先移除，再按发布标签安装。
- CodeBuddy/WorkBuddy 只处理同一 bundled-family 插件和市场。CodeBuddy 仅探测全局 `codebuddy`/`cbc`，由收尾脚本把 `CODEBUDDY_CONFIG_DIR` 固定为有效 `HOME`（环境未提供时取操作系统用户主目录）下名为 `.codebuddy` 的目录；WorkBuddy 仅在 macOS 探测 WorkBuddy 应用内嵌 CLI，由收尾脚本把 `CODEBUDDY_CONFIG_DIR` 与 `WORKBUDDY_CONFIG_DIR` 同时固定为有效 `HOME` 下名为 `.workbuddy` 的目录，绝不把两者互作回退。只有冻结标签与计划声明的可变分支都从同一远端解析到冻结提交时，才调用正式市场更新和插件更新命令；完成后重新读取安装列表，并精确核对唯一条目的市场、版本和修订号。目标未安装、来源不符、远端不可访问或身份不一致时返回 `MANUAL_REQUIRED`，不修改宿主。非 macOS 的 WorkBuddy 返回 `SKIPPED_UNSUPPORTED_PLATFORM`。

任何宿主失败都保留其他宿主的实际结果，不回滚，也不把失败冒充成功。

完成后报告每个宿主的状态，并提醒用户重启已更新的宿主。本机结果只记录收尾事实，不改变发布状态。

## 临时归属

本能力目前只服务发布后的本机收尾，因此保留在 release-skill。第二个技能族需要复用宿主更新或 TUI 驱动，或 Foundation 发布等价公共入口时，再把通用机制上收 Foundation并删除这里的通用部分。release-skill 只保留发布计划到宿主更新输入的领域映射。
