---
name: release-marketplace
description: "Marketplace-only workflow profile: route confirms marketplace-only diff (plugins.mjs/public-snapshot), update plugins.mjs entry (manual review), regenerate public-snapshot via workspace generator, prepare --workflow marketplace (code-class gates trimmed), then delegate publish to the target workspace's own marketplace release skill"
---

> **Cursor 安装入口解析协议**：在调用 CLI 前，Agent 必须从宿主当前已加载技能的元数据中取得本 `SKILL.md` 的实际绝对路径，并将该字面量记为 `SKILL_FILE`。
> `SKILL_FILE` 不是环境变量；禁止从工作目录、可执行搜索路径、源码仓库或 shell 调用上下文猜测。若宿主未提供该绝对路径，立即停止并报告安装定位失败。
> 对 `SKILL_FILE` 执行 `realpath`，取其目录向上两级得到 `PLUGIN_ROOT`；校验真实技能路径匹配 `PLUGIN_ROOT/skills/*/SKILL.md` 且仍位于插件根内（路径包含检查）。
> 校验 `PLUGIN_ROOT/.cursor-plugin/plugin.json` 是根内的普通文件，且名称为 `release-skill`；清单缺失或不一致时停止。Cursor 不保证注入插件根变量。
> 令 `RELEASE_SKILL_ENTRY=PLUGIN_ROOT/bin/release-skill.mjs`，对入口执行 `realpath` containment、`lstat` 非符号链接且为普通文件校验。
> 每一次 shell 工具调用都必须在同一个调用中用上述已验证绝对值设置 `RELEASE_SKILL_ENTRY`，然后执行 `node "$RELEASE_SKILL_ENTRY" ...`；不得依赖前一次 shell 的变量。
>

# release-marketplace

## 触发

用户发起仅 marketplace 索引变更的发布流程，涉及 `plugins.mjs` 入口文件或 `public-snapshot/` 制品目录的修改，且无代码、文档或配置类变更。

## 当前状态

`release-marketplace` 是工作流配置文件（§4）定义的独立工作流之一，专门处理仅 marketplace 索引变更的场景。

**机械实现**：`prepare --workflow marketplace` 确定性地裁剪代码类门禁（H5），记录 `workflowKind: 'marketplace'` 与 `workflowDecision`。**本工作流不执行发布**：发布动作委托给目标 workspace 的专属发布技能（如 `publish-marketplace`，具体路径依 workspace 而定，如 `artifact-skill-set-workspace`、`glaf4-skill-set-workspace`、`skill-family-hub-workspace` 等）。`release-skill` CLI 无 `sync` 命令，也无 `exclusive-release.mjs` 接口——这些接口不存在，不得调用。

**边界**：插件源码未被修改（plugin source unmodified）。市场索引一致性、快照字节、平台清单（platform manifest）是核心校验门禁，由目标 workspace 自身的生成器与 `generate-platform-manifest.mjs --check` 机械保证。

## 职责与边界

- **步骤① diff 确认 marketplace-only**：调用 `release-skill route` 命令确认变更仅限 marketplace 类（`plugins.mjs` / `public-snapshot/`）
- **步骤② workspace plugins.mjs 更新**：手动审查并更新入口文件（entry 是唯一 truth source，`plugins.mjs` 属 marketplace 类而非 code 类）
- **步骤③ 再生成 public-snapshot**：调用目标 workspace 自有的快照生成器重新生成 `public-snapshot/`
- **步骤④ 一致性验证**：运行 `generate-platform-manifest.mjs --check` 验证平台清单与快照字节无漂移
- **步骤⑤ prepare --workflow marketplace**：冻结计划，记录 workflow 裁剪决策
- **步骤⑥ 委托发布**：调用目标 workspace 的专属 `publish-marketplace` 技能执行发布

**授权边界**：
- Step② 需人工确认（entry 是唯一 truth source）
- Step③–④ 自动验证，不允许不一致状态通过
- Step⑥ 依赖外部 workspace 的发布技能，不直接控制其执行

**接入选择**：仅当本入口新建一轮生产准备时，按 `release-prepare` 同一完整流程核对 `testIntake`。缺失则说明缺项并默认推动 `skill-family-test:skill-family-test-plan`，再在授权范围内调用 `skill-family-test:skill-family-test-run`，由 TEST 组织检查并交回结果。跳过须先明确征询，再依据本轮适用且范围匹配的明确同意决定。**沉默、拒绝、仅普通发布预授权、旧轮次、其他项目、版本或范围不匹配均不可跳过**。本轮匹配答复可复用。**不得把跳过写成测试已达标，也不得用跳过清除已声明的适用要求**。已冻结计划与委托给目标工作区的 marketplace-only 发布不回头追加接入义务。只读、非生产准备不新增接入义务。直接非交互 CLI 仍接受可选 `testIntake`，不新增选择参数。答复与适用范围记入既有任务或执行计划。

**阶段通过规则**：
- Steps①–⑤ 完成且一致：plan 中 `workflowKind === 'marketplace'` 冻结
- Step⑥ 成功：以目标 workspace 的发布技能验收标准为准（通常 `status === 'VERIFIED'`）

## 正向执行路径

1. 运行 `release-skill route --root <workspace-root> [--target-version <version>] --json` 获取 diff 分类；已知目标版本时显式传入，`route` 仅作工作流建议
2. 若推荐 `workflowKind === 'marketplace-only'`，则使用本技能
3. 执行步骤②：手动审查并更新 `plugins.mjs`（唯一 truth source）
4. 执行步骤③：调用 workspace 自有生成器重新生成 `public-snapshot/`
5. 执行步骤④：运行 `generate-platform-manifest.mjs --check` 验证平台清单与快照字节无漂移
6. 仅当本入口新建一轮生产准备时完成接入选择：按 `release-prepare` 同一完整流程核对 `testIntake`，默认推动 `skill-family-test:skill-family-test-plan` 与授权范围内的 `skill-family-test:skill-family-test-run`。跳过须先明确征询再依据本轮匹配答复决定。未完成接入且无有效跳过时，不进入下一步 `prepare`
7. 执行步骤⑤：运行 `release-skill prepare --offline --workflow marketplace --target-version <version>` 冻结本地工作流计划
8. 执行步骤⑥：调用目标 workspace 的专属发布技能（如 `publish-marketplace`）执行发布
9. （Step⑥续）汇总目标 workspace 流程的最终状态

## 确定性脚本调用

```bash
# Step 1: Diff classification confirmation (marketplace-only)
node "$RELEASE_SKILL_ENTRY" route \
  --root <workspace-root> --json
node "$RELEASE_SKILL_ENTRY" route \
  --root <workspace-root> --target-version <version> --json

# Step 2: Manual review and update plugins.mjs
# Human-in-the-loop: entry is the sole truth source
# Edit: <workspace>/plugins.mjs (add/remove/update plugin entries)

# Step 3: Regenerate public-snapshot (workspace's own generator)
cd <workspace-root>
node <workspace-root>/scripts/regenerate-public-snapshot.mjs

# Step 4: Consistency check (snapshot bytes + platform manifest drift)
node <workspace-root>/scripts/generate-platform-manifest.mjs --check

# Step 5: Freeze the marketplace workflow plan
node "$RELEASE_SKILL_ENTRY" prepare --offline \
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

## 一致性验证（Step 4）

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

- **docs-only**：若 marketplace 更新伴随文档变更，使用 `marketplace-docs` 组合推荐
- **config-only**：若同时修改 `project.yaml`，使用 `marketplace-config` 组合推荐
- **full-happy-end**：多类型混合变更（code+marketplace）时降级到此路径

## 关联技能

- `release-skill route`：快速入门决策路由（§4.3）
- `release-prepare`：冻结计划（`--workflow marketplace`）
- 各 workspace 的专属发布技能（`publish-marketplace`，如 `artifact-skill-set-workspace`、`glaf4-skill-set-workspace`、`skill-family-hub-workspace` 等）
- `generate-platform-manifest.mjs`：平台清单漂移检测（`--check`）

## Workspace Coordination Notes

每个 workspace 管理自己的 marketplace 入口和制品，并通过其专属发布技能发布：
- `artifact-skill-set-workspace`：`plugins.mjs` 是条目唯一事实源，`publish-marketplace` 技能执行发布
- `glaf4-skill-set-workspace`：同上，项目专属 `publish-marketplace` 技能
- `skill-family-hub-workspace`：`plugins.mjs` 只记录已满足公开收录条件的插件

本技能作为协调器，确认 route 分类并冻结 marketplace 工作流计划，但发布动作必须委托给目标 workspace 自己的发布技能执行，`release-skill` 不直接操作其他 workspace 的代码库。

## 人类最终回复

纯问询或转交时短答：写明实际回答、适用范围或理由、必要限制和下一步。建议保持为建议。

执行路径说明实际分支、已完成步骤、未执行步骤，以及 route 或 prepare 产物和限制。发布按原合同委托目标工作区专属发布技能；本入口只报告本入口实际完成的步骤，以及委托结果里已经返回的事实。已有文件输出按原合同呈现。栏目只收录当前命令或分支已经返回的事实。