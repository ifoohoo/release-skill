---
name: release-config
description: "Config-only workflow profile: route confirms config-only diff, assess with schema validation, prepare --workflow config (code-class gates trimmed), workflowDecision records publish path (public bytes unchanged → no publish path; changed → lightchain prepare→approve→publish→verify)"
---

> **Codex 安装入口解析协议**：在调用 CLI 前，Agent 必须从宿主当前已加载技能的元数据中取得本 `SKILL.md` 的实际绝对路径，并将该字面量记为 `SKILL_FILE`。
> `SKILL_FILE` 不是环境变量；禁止从工作目录、可执行搜索路径、源码仓库或 shell 调用上下文猜测。若宿主未提供该绝对路径，立即停止并报告安装定位失败。
> 对 `SKILL_FILE` 执行 `realpath`，取其目录向上两级得到 `PLUGIN_ROOT`；校验真实技能路径匹配 `PLUGIN_ROOT/skills/*/SKILL.md` 且仍位于插件根内（路径包含检查）。
> 令 `RELEASE_SKILL_ENTRY=PLUGIN_ROOT/bin/release-skill.mjs`，对入口执行 `realpath` containment、`lstat` 非符号链接且为普通文件校验。
> 每一次 shell 工具调用都必须在同一个调用中用上述已验证绝对值设置 `RELEASE_SKILL_ENTRY`，然后执行 `node "$RELEASE_SKILL_ENTRY" ...`；不得依赖前一次 shell 的变量。
>

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

**边界**：裁剪代码类检查（declared hooks、snapshot-verify gates、skill-resource-closure），保留基线、快照、计划冻结和文档新鲜度检查。来源权威检查按发布分支决定，不能一并裁掉：

- 场景 A：公开字节未变，`externalActions=[]`，不生成 `plan.sourceAuthority`（冻结的源码来源权威），也不进入 approve/publish/verify。即使配置了公开来源收据，这一边界也不变。
- 场景 B：公开字节变化或不可判定，需要发布。production prepare 必须通过现有来源权威检查并冻结 `plan.sourceAuthority`；publish、reconcile、verify 继续校验冻结绑定和远端一致性，consumer-verify 保留。

旧 production 计划缺少 `sourceAuthority` 时，仍在外部写入前拒绝。未发生外部写入的旧计划必须重新 prepare 并批准新摘要，不补字段、不迁移旧批准。已有 `PARTIAL` 保留检查点，走匹配版本的恢复路径。docs production 同样要求来源权威；marketplace 委托目标工作区发布的边界不变。

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

1. 运行 `release-skill route --root <path> [--target-version <ver>] --json` 获取 diff 分类；已知目标版本时显式传入，route 只是工作流建议
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
# Step 1: Diff classification confirmation (config-only; pass the known target)
node "$RELEASE_SKILL_ENTRY" route --root <path> --json
node "$RELEASE_SKILL_ENTRY" route \
  --root <path> --target-version <version> --json

# Step 2: Assess with schema validation
node "$RELEASE_SKILL_ENTRY" assess --root <path> --offline --json

# Step 3: Prepare --workflow config (local freeze + publish-path decision)
node "$RELEASE_SKILL_ENTRY" prepare --offline \
  --workflow config --target-version <version> --json
# Output (JSON): { workflowKind: 'config',
#   workflowDecision: { decision: 'public-bytes-unchanged'|'public-bytes-changed'|'indeterminable',
#     publishPath: 'no-publish-needed'|'publish-needed', comparedPlan: '<digest>.json' } }

# Decision Branch A (no-publish-needed): plan frozen with zero externalActions;
# the decision is bound into the plan digest. No publish commands run.

# Decision Branch B (publish-needed): light chain execution
node "$RELEASE_SKILL_ENTRY" approve \
  --plan <path> --actor <person-name>
node "$RELEASE_SKILL_ENTRY" publish \
  --plan <path> --approval <path>
node "$RELEASE_SKILL_ENTRY" verify \
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
| remote conflict at publish | REMOTE_CONFLICT | 人工决策；不得 force override 或覆盖远端状态 |

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
│               │   │ indeterminable    │
│               │   │ (no prior plan)   │
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
