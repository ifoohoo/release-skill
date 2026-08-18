---
name: release-config
description: "Config-only workflow profile: route confirms config-only diff, assess with schema validation, prepare --workflow config (code-class gates trimmed), workflowDecision records publish path (public bytes unchanged → no publish path; changed → lightchain prepare→approve→publish→verify)"
---

# release-config

## 触发

用户询问或执行纯配置变更的发布流程。包含 `.release-skill/project.yaml`、配置 schema 等配置文件的修改，且无代码、文档或 marketplace 变更。

## 当前状态

`release-config` 是工作流配置文件 (§4) 定义的独立工作流之一，专门处理仅配置变更的场景。它遵循简化生命周期，专注于配置验证和发布路径决策分支。

**机械实现**: `prepare --workflow config` 确定性地裁剪代码类门禁（H5），并比较当前
per-unit `snapshotDigest` 与最新冻结 plan——公开字节未变 → `publishPath:
'no-publish-needed'`（externalActions 被移除，无 publish 路径）；字节变化或无对比
plan → `publishPath: 'publish-needed'`（fail-safe）。决策以 `workflowDecision` 绑定
进 plan digest，不可篡改。**不存在** `NO_PUBLISH_NEEDED`/`REPORTED` 虚构状态：
prepare 的真实输出是 plan 内的 `workflowDecision`。

**边界**: 跳过代码类 gates（declared hooks、snapshot-verify gates、source-authority
closure、skill-resource-closure）。保留 baseline/snapshots/plan freeze/docs
freshness。consumer-verify 仅在触发生效发布时参与。

## 职责与边界

- **步骤① diff 确认 config-only**: 调用 `release-skill route` command 确认仅有配置变更
- **步骤② assess with schema validation**: 执行配置结构验证、schema 检查、contract 一致性
- **步骤③ prepare --workflow config**: 本地 freeze 检查，生成只读计划；输出 `workflowDecision`
- **步骤④ decision branch**（来自 plan.workflowDecision）:
  - 场景 A：`publishPath === 'no-publish-needed'`（公开字节未变化）→ 记录决策并结束，
    无 publish 路径，不运行 approve/publish/verify
  - 场景 B：`publishPath === 'publish-needed'`（公开 surface 变化或不可判定）→ 运行
    轻链 (approve→publish→verify)

**授权边界**: 命令调用本身即授权执行配置的 hooks/gates。config-only 工作流的远程写操作受标准 approval 机制约束，不 bypass 安全 gate。

**阶段通过规则**:
- 场景 A: prepare 输出 `workflowDecision.decision === 'public-bytes-unchanged'`（无 publish 路径）
- 场景 B: `status === 'VERIFIED'` + CLI exit code 0

## 正向执行路径

1. 运行 `release-skill route --root <path> --json` 获取 diff 分类
2. 若推荐 `workflowKind === 'config-only'`，则使用本技能
3. 执行步骤②：运行 `release-skill assess --root <path> --offline --json` 进行 schema validation
4. 执行步骤③：运行 `release-skill prepare --offline --workflow config --target-version <ver> --json`
5. 读取输出中的 `workflowDecision`：
   - **A**: `publishPath === 'no-publish-needed'` → 记录决策（plan 已冻结，无
     externalActions），结束。无需 approve/publish/verify
   - **B**: `publishPath === 'publish-needed'` → 继续 approve → publish → verify 链条
6. (场景 B 续) 执行步骤⑥：运行 `release-skill approve --plan <path> --actor <name>`
7. (场景 B 续) 执行步骤⑦：运行 `release-skill publish --plan <path> --approval <path>`
8. (场景 B 续) 执行步骤⑧：运行 `release-skill verify --plan <path> --run <path>`

## 确定性脚本调用

```bash
# Step 1: Diff classification confirmation (config-only)
node "${CLAUDE_PLUGIN_ROOT}/bin/release-skill.mjs" route --root <path> --json

# Step 2: Assess with schema validation
node "${CLAUDE_PLUGIN_ROOT}/bin/release-skill.mjs" assess --root <path> --offline --json

# Step 3: Prepare --workflow config (local freeze + publish-path decision)
node "${CLAUDE_PLUGIN_ROOT}/bin/release-skill.mjs" prepare --offline \
  --workflow config --target-version <version> --json
# Output (JSON): { workflowKind: 'config',
#   workflowDecision: { decision: 'public-bytes-unchanged'|'public-bytes-changed'|'indeterminable',
#     publishPath: 'no-publish-needed'|'publish-needed', comparedPlan: '<digest>.json' } }

# Decision Branch A (no-publish-needed): plan frozen with zero externalActions;
# the decision is bound into the plan digest. No publish commands run.

# Decision Branch B (publish-needed): light chain execution
node "${CLAUDE_PLUGIN_ROOT}/bin/release-skill.mjs" approve \
  --plan <path> --actor <person-name>
node "${CLAUDE_PLUGIN_ROOT}/bin/release-skill.mjs" publish \
  --plan <path> --approval <path>
node "${CLAUDE_PLUGIN_ROOT}/bin/release-skill.mjs" verify \
  --plan <path> --run <path> --json
```

## 故障路由

| 场景 | 状态 | 处理 |
|------|------|------|
| 非纯配置变更（mixed=true） | full-happy-end | 路由到 `release-skill ship` 完整工作流 |
| schema validation 失败 | CONFIG_SCHEMA_INVALID | 修正 project.yaml 或 schemas 结构错误后重试 step② |
| contract verification 失败 | CONFIG_CONFLICT | 解决配置冲突后重试 step② |
| prepare 检测到基线漂移 | BASELINE_DRIFT_DETECTED | 人工审查 drift 后决定是否继续或回滚 |
| workflowDecision 不可判定（无对比 plan） | indeterminable | fail-safe 到 publish-needed，走场景 B |
| approval expired | APPROVAL_EXPIRED | 重新执行 approve，digest 必须匹配 |
| remote conflict at publish | REMOTE_CONFLICT | 人工决策：force override 或 cancel |

## 决策树 (Step 4)

```
┌─────────────────────────────────────────┐
│  prepare --workflow config completed    │
└──────────────────┬──────────────────────┘
                   │
        ┌──────────┴──────────┐
        │                     │
        ▼                     ▼
┌───────────────┐   ┌───────────────────┐
│ public bytes  │   │ public bytes      │
│ unchanged     │   │ changed /         │
│ (or no plan   │   │ indeterminable    │
│  → fail-safe  │   │                   │
│  → publish    │   │                   │
│  needed)      │   │                   │
└───────┬───────┘   └────────┬──────────┘
        │                    │
        ▼                    ▼
┌───────────────┐   ┌───────────────────┐
│ no-publish    │   │ light chain       │
│ needed:       │   │ approve→publish   │
│ decision      │   │ →verify           │
│ recorded in   │   │                   │
│ plan digest   │   │                   │
└───────────────┘   └───────────────────┘
```

## 与其他工作流的关系

- **docs-only**: 纯文档变更时使用 `release-docs`
- **marketplace-only**: 仅 marketplace 变更时使用独立工作流
- **full-happy-end**: 混合变更（code+config+docs）时降级到此完整路径

## 关联技能

- `release-skill route`: 快速入门决策路由（§4.3）
- `release-assess`: 配置 schema/contract 验证入口
- `release-prepare`: 离线冻结检查（`--workflow config` 输出 publish-path 决策）
- `release-approve`: Plan approval（仅场景 B）
- `release-publish`: 制品发布（仅在 public surface 变化时执行）
- `release-verify`: 消费者验证（场景 B 的最终验证门）
