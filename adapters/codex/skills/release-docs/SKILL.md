---
name: release-docs
description: "Docs-only workflow profile: route confirms docs-only diff, style-guard gates (check-style.mjs file paths), render-public-site --check drift scan, docs refresh rehearsal → binder write, prepare --workflow docs (code-class gates trimmed), approve/publish/verify with consumer-verify preserved"
---

> **Codex 安装入口解析协议**：在调用 CLI 前，Agent 必须从宿主当前已加载技能的元数据中取得本 `SKILL.md` 的实际绝对路径，并将该字面量记为 `SKILL_FILE`。
> `SKILL_FILE` 不是环境变量；禁止从工作目录、可执行搜索路径、源码仓库或 shell 调用上下文猜测。若宿主未提供该绝对路径，立即停止并报告安装定位失败。
> 对 `SKILL_FILE` 执行 `realpath`，取其目录向上两级得到 `PLUGIN_ROOT`；校验真实技能路径匹配 `PLUGIN_ROOT/skills/*/SKILL.md`。
> 令 `RELEASE_SKILL_ENTRY=PLUGIN_ROOT/bin/release-skill.mjs`，对入口执行 `realpath` containment、`lstat` 非符号链接且为普通文件校验。
> 每一次 shell 工具调用都必须在同一个调用中用上述已验证绝对值设置 `RELEASE_SKILL_ENTRY`，然后执行 `node "$RELEASE_SKILL_ENTRY" ...`；不得依赖前一次 shell 的变量。
>

# release-docs

## 触发

用户询问或执行纯文档变更的发布流程。包含 `docs/public/site/`, `README*`, `CHANGELOG`, `release-notes/` 等文件的修改，且无代码、配置或 marketplace 变更。

## 当前状态

`release-docs` 是工作流配置文件 (§4) 定义的独立工作流之一，专门处理仅文档变更的场景。它遵循标准发布生命周期，但跳过代码类检查门（声明式 hooks、snapshot-verify gates、source-authority closure、skill-resource-closure），专注于文档质量 gate。

**机械实现**: `prepare --workflow docs` 在 prepare 内确定性地裁剪代码类门禁（H5），
plan 记录 `workflowKind: 'docs'` 与 `workflowDecision`（绑定进 plan digest）。
**边界**: NOT merging repos；不对代码类 gates（如 schema validation、contract verification）负责。

## 职责与边界

- **步骤① diff 分类确认**: 调用 `release-skill route` command 对工作树 diff 分类，确认仅有文档变更
- **步骤② style-guard 三道门**: 调用 `check-style.mjs`（只接受文件路径参数，exit 0/1/2）执行事实性/可读性/风格检查
- **步骤③ render-public-site --check**: 调用 `render-public-site.mjs --check [--repo <name>]` 做渲染漂移扫描（内存泄漏扫描 + 树基线对比）
- **步骤④ docs refresh**: 执行 rehearsal → binder 写入（本地文档更新，不 commit/push）
- **步骤⑤ prepare --workflow docs**: 轻量 freeze（裁剪代码类 gates，保留 docs freshness/public-surface/baseline/snapshots/plan freeze）
- **步骤⑥–⑧**: approve → publish → verify（consumer-verify 保留）

**授权边界**: 命令调用本身即授权执行配置的 hooks/gates。本地文档写入授权只覆盖声明的本地文档目标，不是 Git commit/push/publish 或安装的授权。

**阶段通过规则**: `status === 'VERIFIED'` 且 CLI exit code 为 0。`PARTIAL` 状态允许安全重试已完成的 checkpoint。

## 正向执行路径

1. 运行 `release-skill route --root <path> [--target-version <ver>] --json` 获取 diff 分类和工作流推荐
2. 若推荐 `workflowKind === 'docs-only'`，则使用本技能
3. 执行步骤②：调用 `check-style.mjs <doc-path>...` 执行事实/可读性/风格检查
4. 执行步骤③：调用 `render-public-site.mjs --check [--repo <name>]` 验证渲染无漂移
5. 执行步骤④：运行 `release-skill docs refresh --unit <id> --write --confirm-refresh <digest> --ack-local-document-write`
6. 执行步骤⑤：运行 `release-skill prepare --offline --workflow docs --target-version <ver>`
7. 执行步骤⑥：人工审阅后运行 `release-skill approve --plan <path> --actor <name>`
8. 执行步骤⑦：运行 `release-skill publish --plan <path> --approval <path>`
9. 执行步骤⑧：运行 `release-skill verify --plan <path> --run <path>`

## 确定性脚本调用

```bash
# Step 1: Diff classification (from release-skill route)
node "$RELEASE_SKILL_ENTRY" route --root <path> --json

# Step 2: Style-guard three gates (check-style.mjs takes file paths only)
node "${WORKBUDDY_ROOT}/adapters/workbuddy/skills/skill-family-docs-style-guard/scripts/check-style.mjs" \
  <doc-path-1> <doc-path-2>

# Step 3: Render site check (drift + leak scan against committed baseline)
node "${DOC_RENDER_ROOT}/packages/skill-family-doc-render/scripts/render-public-site.mjs" --check [--repo <repo-name>] # source-only

# Step 4: Docs refresh with rehearsal
node "$RELEASE_SKILL_ENTRY" docs refresh --unit <id> --json
# Then confirm and write:
node "$RELEASE_SKILL_ENTRY" docs refresh --unit <id> \
  --write --confirm-refresh <refreshDigest> --ack-local-document-write --json

# Step 5: Lightweight prepare --workflow docs
node "$RELEASE_SKILL_ENTRY" prepare --offline \
  --workflow docs --target-version <version> --json

# Step 6: Approval
node "$RELEASE_SKILL_ENTRY" approve \
  --plan <path> --actor <person-name>

# Step 7: Publish
node "$RELEASE_SKILL_ENTRY" publish \
  --plan <path> --approval <path>

# Step 8: Verify (consumer-verify preserved)
node "$RELEASE_SKILL_ENTRY" verify \
  --plan <path> --run <path> --json
```

## 故障路由

| 场景 | 状态 | 处理 |
|------|------|------|
| 非纯文档变更（mixed=true） | full-happy-end | 路由到 `release-skill ship` 完整工作流 |
| style-guard 检查失败 | exit 1（check-style.mjs） | 修正文档问题后重试 step② |
| check-style.mjs 运行错误 | exit 2 | 检查参数（只接受文件路径）与文件存在性 |
| render-site 漂移 | RENDER_SITE_DRIFT | 重新渲染并提交基线后重试 step③ |
| prepare 检测到未刷新文档 | PREPARE_STALE_DOCS | 重新执行 step④ → 提交 → 重新 prepare |
| 非 VERIFIED 终态 | NEEDS_INPUT / BLOCKED | 根据错误码诊断具体问题 |

## 与其他工作流的关系

- **config-only**: 仅配置变更时使用 `release-config`
- **marketplace-only**: 仅 marketplace 变更时使用独立工作流
- **full-happy-end**: 混合变更（code+docs）时降级到此完整路径

## 关联技能

- `release-skill route`: 快速入门决策路由（§4.3）
- `release-assess`: 项目发布就绪度评估
- `release-prepare`: 冻结发布计划（`--workflow docs` 裁剪代码类门禁）
- `release-publish`: 发布 GitHub/npm 制品
- `release-verify`: 消费者验证和远程状态重检
- `skill-family-docs-style-guard`（skill-family-docs adapter）: `check-style.mjs` 文档质量三道门
- `render-public-site`（skill-family-doc-render）: 站点渲染漂移与泄漏扫描
