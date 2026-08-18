---
name: release-publish
description: "从已批准的生产计划发布冻结 Git branch/tag、npm tarball 与 GitHub Release，并执行已配置的 Claude/Codex marketplace 隔离消费者安装检查以达到 PUBLISHED；随后必须路由 release-verify 才可能达到 VERIFIED；遇到冲突或不确定远端状态时失败关闭并要求人工介入"
---

> **Codex 安装入口解析协议**：在调用 CLI 前，Agent 必须从宿主当前已加载技能的元数据中取得本 `SKILL.md` 的实际绝对路径，并将该字面量记为 `SKILL_FILE`。
> `SKILL_FILE` 不是环境变量；禁止从工作目录、可执行搜索路径、源码仓库或 shell 调用上下文猜测。若宿主未提供该绝对路径，立即停止并报告安装定位失败。
> 对 `SKILL_FILE` 执行 `realpath`，取其目录向上两级得到 `PLUGIN_ROOT`；校验真实技能路径匹配 `PLUGIN_ROOT/skills/*/SKILL.md`。
> 令 `RELEASE_SKILL_ENTRY=PLUGIN_ROOT/bin/release-skill.mjs`，对入口执行 `realpath` containment、`lstat` 非符号链接且为普通文件校验。
> 每一次 shell 工具调用都必须在同一个调用中用上述已验证绝对值设置 `RELEASE_SKILL_ENTRY`，然后执行 `node "$RELEASE_SKILL_ENTRY" ...`；不得依赖前一次 shell 的变量。
>

# release-publish

## 生产边界

冻结 Git branch/tag、GitHub Release、npm tarball 路径已通过本地生产等价沙箱（协议级 fake），
测试没有提供 OS 级网络隔离。
插件市场消费者安装验证通过本地协议沙箱完成；真实生产 canary 只能在用户明确授权目标后执行。
不得把沙箱通过描述成真实发布成功。

只发布 `prepare --production` 封存的 Git object 和 npm tarball，不从活动工作区重新
打包，不生成或覆盖 README，也永不隐式刷新工作树中的发布文档；
遇到 `RELEASE_DOCS_STALE` 或文档陈旧只能回到 `docs refresh` → 人工审阅 → 提交 →
重新 prepare。远端 branch/tag/Release/npm version 已存在、查询不确定、
认证失败或摘要漂移时，在全局预检阶段停止并交给人工。禁止覆盖、删除和自动回滚；
新建 ref 的 create-only CAS（`--force-with-lease=<ref>:`）只断言目标不存在，不授权覆盖。

## 前置条件：工作流选择

在运行 `release-publish` 之前，必须先完成快速入门决策路由（§4.3 Workflow Profile Support）：

1. 使用 `release-skill route --root <path> --json` 确定变更类型
2. 根据推荐的 `workflowKind` 选择对应路径：
   - `docs-only` → 先执行 `release-docs` 完整流程
   - `config-only` → 先执行 `release-config`，仅在 public surface 变化时进入 publish
   - `marketplace-only` → 先执行 `release-marketplace`，然后由 workspace exclusive skill 接管
   - `full-happy-end` → 直接进入标准完整流程：`prepare → approve → publish → verify`
   - `reconcile` → 先执行 `release-reconcile` 恢复 PARTIAL 状态
   - `help` → 无变更，无需 publish

**注意**: `release-publish` 是标准工作流中的第⑦步，必须在以下步骤之后：
- 步骤⑤: `release-prepare` (或轻量级 prepare)
- 步骤⑥: `release-approve` (非过期 approval record)

决策表链接：参见 [`release-help`](../release-help/SKILL.md) 的 Routing Suggestions 章节。

## 触发

用户明确要求执行已经人工审阅的 GitHub+npm 生产计划。

## 授权门

1. 展示可读的 `approvalSummary`：版本、仓库/包名、branch/tag、全部 actions 和例外。
2. 必须存在未过期且由系统绑定同一内部 digest 的 approval record；批准后不再要求用户复制摘要做二次确认。
3. 只有 CLI exit code 0 且结构化状态为 `PUBLISHED` 才算外写阶段通过；随后必须运行 verify，只有 `VERIFIED` 才是完整终态。

## 确定性执行

```bash
node "$RELEASE_SKILL_ENTRY" publish --root <path> --plan <plan-path> \
  --approval <approval-path> --json
```

执行顺序：全局只读预检 → 配置的公开分支（按三种 `branchStrategy` 执行）→ 必要时
单独切换默认分支 → tag → npm tarball →
GitHub Release → Claude/Codex marketplace 隔离安装。每步 execute 后立即 observe；
默认分支 action 同时绑定名称和目标精确 commit；末尾再次核对分支/默认分支一致性。
失败停止后续动作并记录 PARTIAL。PUBLISHED 后运行 verify 复核全新消费者安装。

## 故障路由

| 结果 | 处理 |
|---|---|
| `BASELINE_CHANGED` | 保留人工修改，重新 prepare、审阅和 approve；不要覆盖修改。 |
| 摘要/制品不匹配 | 停止；重新 prepare，不修补冻结目录。 |
| 远端对象已存在 | 人工判断版本或远端状态；不得覆盖。create-only CAS 也必须失败关闭。 |
| 认证/网络/未知查询错误 | 失败关闭，修复环境后基于同一证据判断是否 reconcile。 |
| `PARTIAL` | 检查 `release-run.json`，不重跑整套发布、不删除成功对象。 |

发布成功后必须运行 `release-verify`；PARTIAL 仅在人工确认远端状态后进入
`release-reconcile`。
