---
name: release-finish
description: 发布达到 VERIFIED 后处理可选的本地收尾：按发布分支策略决定是否询问合并，并在用户确认后更新本机 Claude、Codex、Kimi、CodeBuddy/WorkBuddy 插件
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

默认只读取冻结计划和 verify run。没有用户明确同意，不合并分支，不更新插件，不接受 Kimi 的安装信任提示。

## 先生成收尾清单

从插件根执行：

```bash
node "$RELEASE_SKILL_LOCAL_FINISH_ENTRY" \
  --plan <plan-path> \
  --run <verified-run-path> \
  --json
```

脚本只接受状态为 `VERIFIED`、且 `planDigest` 与冻结计划一致的 verify run。

## 主动询问

读取返回的 `merge` 和 `localHostUpdate`：

1. `merge.promptRequired=false` 时，发布工作流已经推进或初始化目标分支，不再询问合并。
2. `merge.promptRequired=true` 时，向用户说明尚未覆盖的发布分支，并询问是否需要合并。用户同意后，先只读核对源分支、目标分支、工作区状态和项目既有合并方式，再用明确的分支名执行；本脚本不猜分支，也不自动推送。
3. `localHostUpdate.promptRequired=true` 时，列出计划覆盖的宿主，询问是否更新本机插件。两个问题可以一次问完。

## 用户同意更新本机宿主

把用户选择的宿主和清单返回的精确 `planDigest` 传回脚本：

```bash
node "$RELEASE_SKILL_LOCAL_FINISH_ENTRY" \
  --plan <plan-path> \
  --run <verified-run-path> \
  --update-local-hosts \
  --hosts claude,codex,kimi,codebuddy,workbuddy \
  --confirm-plan <planDigest> \
  --json
```

只传用户选择且计划声明的宿主。宿主 CLI 不存在时返回 `SKIPPED_NOT_INSTALLED`。各宿主按以下规则处理：

- Claude 先重新绑定冻结市场，再重新观察安装状态；旧插件若仍存在，才调用正式更新命令。Codex 继续按正式市场协议移除并安装冻结的 Git 引用。两者都在安装后核对插件、市场、版本和市场检出提交。
- Kimi 的精确当前安装会在返回 `ALREADY_CURRENT` 前核对真实载荷；发生安装或迁移时，只在操作完成后核对结果。包名、版本、发布标签、已安装修订号和受管安装根必须与冻结计划一致；`.git` 只提供附加诊断，不是通过条件。旧的本地路径安装会在同一个受控终端交互界面（TUI）会话中先移除，再按发布标签安装、确认信任并重新加载。
- CodeBuddy/WorkBuddy 只处理同一 bundled-family 插件和市场。只有冻结标签与计划声明的可变分支都从同一远端解析到冻结提交时，才调用正式市场更新和插件更新命令；完成后重新读取安装列表，并精确核对唯一条目的市场、版本和修订号。目标未安装、来源不符、远端不可访问或身份不一致时返回 `MANUAL_REQUIRED`，不修改宿主。

任何宿主失败都保留其他宿主的实际结果，不回滚，也不把失败冒充成功。

完成后报告每个宿主的状态，并提醒用户重启已更新的宿主。本机结果只记录收尾事实，不改变发布状态。

## 临时归属

本能力目前只服务发布后的本机收尾，因此保留在 release-skill。第二个技能族需要复用宿主更新或 TUI 驱动，或 Foundation 发布等价公共入口时，再把通用机制上收 Foundation并删除这里的通用部分。release-skill 只保留发布计划到宿主更新输入的领域映射。
