---
name: release-finish
description: 发布达到 VERIFIED 后处理可选的本地收尾：按发布分支策略决定是否询问合并，并在用户确认后更新本机 Claude、Codex、Kimi、CodeBuddy/WorkBuddy 插件
---

# release-finish

## 触发

发布刚达到 `VERIFIED`（已完成发布后验证），或用户要求处理发布后的分支合并、本机宿主插件更新。

## 边界

这是发布后的独立收尾，不属于 `prepare → approve → publish → verify` 状态机。它不能把本机更新结果写成新的发布状态，也不能因为本机更新失败而降低 `VERIFIED`。

默认只读取冻结计划和 verify run。没有用户明确同意，不合并分支，不更新插件，不接受 Kimi 的安装信任提示。

## 先生成收尾清单

从插件根执行：

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/release-skill-local-finish.mjs" \
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
node "${CLAUDE_PLUGIN_ROOT}/bin/release-skill-local-finish.mjs" \
  --plan <plan-path> \
  --run <verified-run-path> \
  --update-local-hosts \
  --hosts claude,codex,kimi,codebuddy,workbuddy \
  --confirm-plan <planDigest> \
  --json
```

只传用户选择且计划声明的宿主。宿主 CLI 不存在时返回 `SKIPPED_NOT_INSTALLED`。各宿主按以下规则处理：

- Claude、Codex 绑定冻结的 Git 引用，并在安装后核对插件、市场、版本和市场检出提交。
- Kimi 先核对发布标签对应的提交，再通过受控的终端交互界面（TUI）安装，并读取本机安装根的版本、标签与修订号。
- CodeBuddy/WorkBuddy 的 CLI 不能精确绑定 Git 引用。本机已是目标提交时返回 `ALREADY_CURRENT`，否则返回 `MANUAL_REQUIRED`，不执行“更新到最新”。

任何宿主失败都保留其他宿主的实际结果，不回滚，也不把失败冒充成功。

完成后报告每个宿主的状态，并提醒用户重启已更新的宿主。

## 临时归属

本能力目前只服务发布后的本机收尾，因此保留在 release-skill。第二个技能族需要复用宿主更新或 TUI 驱动，或 Foundation 发布等价公共入口时，再把通用机制上收 Foundation并删除这里的通用部分。release-skill 只保留发布计划到宿主更新输入的领域映射。
