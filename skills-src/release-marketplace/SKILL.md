---
name: release-marketplace
description: "Marketplace-only workflow profile: route confirms marketplace-only diff (plugins.mjs/public-snapshot), update plugins.mjs entry (manual review), regenerate public-snapshot via workspace generator, prepare --workflow marketplace (code-class gates trimmed), then delegate publish to the target workspace's own marketplace release skill"
---

# release-marketplace

## 触发

用户询问或执行纯 marketplace 变更的发布流程。包含 `plugins.mjs` 入口文件、`public-snapshot/` 制品目录的修改，且无代码、文档或配置变更。

## 当前状态

`release-marketplace` 是工作流配置文件 (§4) 定义的独立工作流之一，专门处理仅 marketplace 索引变更的场景。

**机械实现**: `prepare --workflow marketplace` 确定性地裁剪代码类门禁（H5），plan
记录 `workflowKind: 'marketplace'` 与 `workflowDecision`。**本工作流不执行发布**：
发布委托给目标 workspace 的**专属发布技能**（各 marketplace workspace 有独立的
`publish-marketplace` 流程，如 artifact-skill-set-workspace、glaf4-skill-set-workspace
等）。release-skill 的 CLI 没有 `sync` 命令，也没有 `exclusive-release.mjs`——
这些接口不存在，不得调用。

**边界**: plugin source unmodified（不修改 plugin 源码）。市场索引一致性、snapshot
byte、platform manifest 是核心 gate，由 workspace 自己的生成器与
`generate-platform-manifest.mjs --check` 机械保证。

## 职责与边界

- **步骤① diff 确认 marketplace-only**: 调用 `release-skill route` command 确认仅有 marketplace 变更（`plugins.mjs` / `public-snapshot/` 归 marketplace 类）
- **步骤② workspace plugins.mjs 更新**: 手动审查更新入口文件（entry 是唯一 truth source，`plugins.mjs` 属 marketplace 类而非 code 类）
- **步骤③ 再生成 public-snapshot**: 调用 workspace 自己的快照生成器
- **步骤④ 一致性验证**: 快照字节 + `generate-platform-manifest.mjs --check`（平台清单漂移检测）
- **步骤⑤ prepare --workflow marketplace**: 冻结计划，记录 workflow 裁剪决策
- **步骤⑥ 委托发布**: 调用目标 workspace 的专属 `publish-marketplace` 技能执行发布

**授权边界**:
- Step②需要人工确认（entry 是唯一 truth source）
- Step③–④自动验证，不允许不一致状态通过
- Step⑥依赖外部 workspace 的发布技能，不直接控制其执行

**阶段通过规则**:
- Steps①–⑤完成且一致：plan `workflowKind === 'marketplace'` 冻结
- Step⑥成功：以目标 workspace 的发布技能验收标准为准（通常 `status === 'VERIFIED'`）

## 正向执行路径

1. 运行 `release-skill route --root <path> --json` 获取 diff 分类
2. 若推荐 `workflowKind === 'marketplace-only'`，则使用本技能
3. 执行步骤②：手动审查并更新 `plugins.mjs`（唯一 truth source）
4. 执行步骤③：调用 workspace 自己的生成器再生成 `public-snapshot/`
5. 执行步骤④：运行 `generate-platform-manifest.mjs --check` 验证平台清单与快照字节无漂移
6. 执行步骤⑤：运行 `release-skill prepare --offline --workflow marketplace --target-version <ver>` 冻结计划
7. 执行步骤⑥：调用目标 workspace 的专属发布技能（如 `publish-marketplace`）执行发布
8. (Step⑥续) 汇总目标 workspace 流程的最终状态

## 确定性脚本调用

```bash
# Step 1: Diff classification confirmation (marketplace-only)
node "${CLAUDE_PLUGIN_ROOT}/bin/release-skill.mjs" route \
  --root <workspace-root> --json

# Step 2: Manual review and update plugins.mjs
# Human-in-the-loop: entry is the sole truth source
# Edit: <workspace>/plugins.mjs (add/remove/update plugin entries)

# Step 3: Regenerate public-snapshot (workspace's own generator)
cd <workspace-root>
node <workspace-root>/scripts/regenerate-public-snapshot.mjs

# Step 4: Consistency check (snapshot bytes + platform manifest drift)
node <workspace-root>/scripts/generate-platform-manifest.mjs --check

# Step 5: Freeze the marketplace workflow plan
node "${CLAUDE_PLUGIN_ROOT}/bin/release-skill.mjs" prepare --offline \
  --workflow marketplace --target-version <version> --json

# Step 6: Delegate publish to the target workspace's own marketplace release
# skill (each marketplace workspace ships its own publish-marketplace flow;
# release-skill does NOT publish marketplace indexes itself)
```

## 故障路由

| 场景 | 状态 | 处理 |
|------|------|------|
| 非纯 marketplace 变更 | full-happy-end | 路由到 `release-skill ship` 完整工作流 |
| plugins.mjs 语法错误 | MARKETPLACE_INDEX_INVALID | 修正语法后重试 step② |
| plugins.mjs 重复 entry | MARKETPLACE_DUPLICATE_ENTRY | 删除重复项后重试 step② |
| plugins.mjs entry 缺少必需字段 | MARKETPLACE_ENTRY_INVALID | 补充 required fields（id/name/version）后重试 step② |
| snapshot byte 不一致 | SNAPSHOT_BYTE_MISMATCH | 重新执行 step③ 再生成快照 |
| platform manifest 漂移 | PLATFORM_MANIFEST_DRIFT | 重新生成 platform manifest 后重试 step④ |
| snapshot ≠ manifest | SNAPSHOT_MANIFEST_CONFLICT | 人工决策：以哪个为准后继续 |
| workspace 发布技能不可用 | WORKSPACE_SKILL_NOT_FOUND | 检查 workspace 发布流程路径，不绕过其安全门禁 |

## 一致性验证 (Step 4)

```
┌──────────────────────────────────────┐
│ regenerate public-snapshot completed │
└──────────────┬───────────────────────┘
               │
       ┌───────┴────────┐
       │                  │
       ▼                  ▼
┌──────────────┐   ┌──────────────────┐
│ snapshot     │   │ platform         │
│ byte hash    │   │ manifest digest  │
└──────┬───────┘   └────────┬─────────┘
       │                    │
       └────────┬───────────┘
                │
        ┌───────┴────────┐
        │                  │
        ▼                  ▼
   ══ CONSISTENT ══   ══ MISMATCH ══
        │                  │
        ▼                  ▼
   Continue → Step 5    Retry Step 3 or
                 human decision
```

## 与其他工作流的关系

- **docs-only**: 若 marketplace 更新伴随文档变更，使用 `marketplace-docs` 组合推荐
- **config-only**: 若同时修改 project.yaml，使用 `marketplace-config` 组合推荐
- **full-happy-end**: 多类型混合变更（code+marketplace）时降级到此路径

## 关联技能

- `release-skill route`: 快速入门决策路由（§4.3）
- `release-prepare`: 冻结计划（`--workflow marketplace`）
- 各 workspace 的专属发布技能（`publish-marketplace`，如 artifact-skill-set-workspace、
  glaf4-skill-set-workspace、skill-family-hub-workspace 等）
- `generate-platform-manifest.mjs`: 平台清单漂移检测（--check）

## Workspace Coordination Notes

每个 workspace 管理自己的 marketplace 入口和制品，并通过其专属发布技能发布：
- `artifact-skill-set-workspace`: `plugins.mjs` 是条目唯一事实源，`publish-marketplace`
  技能执行发布
- `glaf4-skill-set-workspace`: 同上，项目专属 `publish-marketplace` 技能
- `skill-family-hub-workspace`: `plugins.mjs` 只记录已满足公开收录条件的插件

本技能作为协调器，确认 route 分类并冻结 marketplace 工作流计划，但发布动作必须
委托给目标 workspace 自己的发布技能执行，release-skill 不直接操作其他 workspace
的代码库。
