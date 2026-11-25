---
name: release-docs
description: "Docs-only workflow profile: route confirms docs-only diff, style-guard gates (check-style.mjs file paths), render-public-site --check drift scan, docs refresh rehearsal → binder write, prepare --workflow docs (code-class gates trimmed), approve/publish/verify with consumer-verify preserved"
---

> **Antigravity 安装入口解析协议**：在调用 CLI 前，Agent 必须从宿主当前已加载技能的元数据中取得本 `SKILL.md` 的实际绝对路径，并将该字面量记为 `SKILL_FILE`。
> `SKILL_FILE` 不是环境变量；禁止从工作目录、可执行搜索路径、源码仓库或 shell 调用上下文猜测。若宿主未提供该绝对路径，立即停止并报告安装定位失败。
> 对 `SKILL_FILE` 执行 `realpath`，取其目录向上两级得到 `PLUGIN_ROOT`；校验真实技能路径匹配 `PLUGIN_ROOT/skills/*/SKILL.md` 且仍位于插件根内（路径包含检查）。
> 校验 `PLUGIN_ROOT/plugin.json` 是根内的普通文件，且名称为 `release-skill`；清单缺失或不一致时停止。Antigravity 不保证注入插件根变量。
> 令 `RELEASE_SKILL_ENTRY=PLUGIN_ROOT/bin/release-skill.mjs`，对入口执行 `realpath` containment、`lstat` 非符号链接且为普通文件校验。
> 每一次 shell 工具调用都必须在同一个调用中用上述已验证绝对值设置 `RELEASE_SKILL_ENTRY`，然后执行 `node "$RELEASE_SKILL_ENTRY" ...`；不得依赖前一次 shell 的变量。
>

# release-docs

## 触发

用户发起纯文档变更的发布流程，涉及 `docs/public/site/`、`README*`、`CHANGELOG`、`release-notes/` 等文件的修改，且无代码、配置或 marketplace 变更。

## 当前状态

`release-docs` 是工作流配置文件（§4）定义的独立工作流之一，专门处理仅文档变更场景。其遵循标准发布生命周期，但裁剪了代码类检查（如声明式 hooks、snapshot-verify gates、skill-resource-closure），保留文档质量与发布表面一致性检查。

文档生产仍由 `release-skill` 执行发布，因此 `prepare` 阶段必须通过现有来源权威检查，并冻结 `plan.sourceAuthority`（源码来源权威）。`publish`、`reconcile`、`verify` 阶段继续校验冻结绑定与远端一致性，**不可将来源权威视为代码类检查而裁掉**。配置场景 B 适用相同要求；场景 A 无发布动作，不生成该字段。marketplace 委托目标工作区发布的边界不变。

旧 production 计划若缺少 `sourceAuthority`，在外部写入前即被拒绝。未发生外部写入的旧计划必须重新 `prepare` 并批准新摘要，**不补字段、不迁移旧批准**。已有 `PARTIAL` 状态保留检查点，走匹配版本的恢复路径。

**机械实现**：`prepare --workflow docs` 在 `prepare` 阶段确定性地裁剪代码类门禁（H5），`plan` 记录 `workflowKind: 'docs'` 与 `workflowDecision`（绑定进 `plan digest`）。

**边界**：不合并仓库；不对代码类 gates（如 schema validation、contract verification）负责。

## 职责与边界

- **步骤① diff 分类确认**：调用 `release-skill route` 命令对工作树 diff 分类，确认仅含文档变更  
- **步骤② style-guard 三道门**：通过目标仓库已声明的文档风格钩子或已安装的公开 `skill-family-docs-style-guard` 命令执行事实性、可读性、风格检查（只传文件路径参数，exit 0/1/2）  
- **步骤③ 公开站点渲染检查**：通过目标仓库配置的渲染门禁或已安装的公开 `skill-family-doc-render` 入口执行渲染漂移扫描（泄漏扫描 + 树基线对比）  
- **步骤④ docs refresh**：执行 rehearsal → binder 写入（本地文档更新，不 commit/push）  
- **步骤⑤ prepare --workflow docs**：本地预检用 `--offline --workflow docs`；正式进入发布链（接 `approve → publish → verify`）必须运行 `prepare --online --production --workflow docs`（或 `ship`），裁剪代码类 gates，保留 docs freshness/public-surface/baseline/snapshots/plan freeze 与 `sourceAuthority`  
- **步骤⑥–⑧**：`release-skill approve` → `publish` → `verify`（consumer-verify 保留）

**授权边界**：命令调用本身即授权执行配置的 hooks/gates。本地文档写入授权仅覆盖声明的本地文档目标，**不等同于 Git commit/push/publish 或安装的授权**。

**接入选择**：进入本入口的新一轮生产准备前，按 `release-prepare` 同一完整流程核对 `testIntake`。若缺失，说明缺项并默认推动 `skill-family-test:skill-family-test-plan`，再在授权范围内调用 `skill-family-test:skill-family-test-run`，由 TEST 组织检查并交回结果。跳过须先明确征询，再依据本轮适用且范围匹配的明确同意决定。**沉默、拒绝、仅普通发布预授权、旧轮次、其他项目、版本或范围不匹配均不可跳过**。本轮匹配答复可复用。**不得把跳过写成测试已达标，也不得用跳过清除已声明的适用要求**。已冻结计划的批准、发布、对账与正式验证不回头追加接入义务。只读、非生产准备不新增接入义务。直接非交互 CLI 仍接受可选 `testIntake`，不新增选择参数。答复与适用范围记入既有任务或执行计划。

**阶段通过规则**：`status === 'VERIFIED'` 且 CLI exit code 为 0。`PARTIAL` 状态保留并跳过已成功的检查点，仅安全重试未完成的步骤。

## 正向执行路径

1. 运行 `release-skill route --root <path> [--target-version <ver>] --json` 获取 diff 分类和工作流建议；已知目标版本时显式传入，`route` 不承担发布授权  
2. 若推荐 `workflowKind === 'docs-only'`，则使用本技能  
3. 执行步骤②：运行目标仓库在 `.release-skill/project.yaml` 中声明的文档风格钩子（`release-skill hooks --root <path> --hook docs --json`）或已安装的公开 `skill-family-docs-style-guard` 入口，对 `<doc-path>...` 执行事实/可读性/风格检查  
4. 执行步骤③：运行目标仓库配置门禁或已安装的公开 `skill-family-doc-render` 漂移检查入口，验证渲染无漂移  
5. 执行步骤④：运行 `release-skill docs refresh --unit <id> --write --confirm-refresh <digest> --ack-local-document-write`  
6. 进入本入口新一轮生产准备前完成接入选择：按 `release-prepare` 同一完整流程核对 `testIntake`，默认推动 `skill-family-test:skill-family-test-plan` 与授权范围内的 `skill-family-test:skill-family-test-run`。跳过须先明确征询再依据本轮匹配答复决定。未完成接入且无有效跳过时，不进入下一步 `prepare`  
7. 执行步骤⑤：
   - 仅本地预检（不接 `publish`）：`release-skill prepare --offline --workflow docs --target-version <ver>`
   - 正式进入发布链（接 `approve -> publish -> verify`）：`release-skill prepare --online --production --workflow docs --target-version <ver>`（或使用 `release-skill ship --target-version <ver>`）  
8. 执行步骤⑥：人工审阅第 7 步生产的正式计划后，运行 `release-skill approve --plan <path> --actor <name>`  
9. 执行步骤⑦：运行 `release-skill publish --plan <path> --approval <path>`  
10. 执行步骤⑧：运行 `release-skill verify --plan <path> --run <path>`

## 确定性脚本调用

```bash
# Step 1: Diff classification (from release-skill route; pass the known target)
node "$RELEASE_SKILL_ENTRY" route --root <path> --json
node "$RELEASE_SKILL_ENTRY" route \
  --root <path> --target-version <version> --json

# Step 2 & 3: Project-declared docs gates / installed public docs check commands
# (run configured hooks in target repo rather than hardcoded machine paths)
node "$RELEASE_SKILL_ENTRY" hooks --root <path> --hook docs --json
# Or invoke the installed public skill-family-docs-style-guard / skill-family-doc-render commands
# against <doc-path-1> <doc-path-2>

# Step 4: Docs refresh with rehearsal
node "$RELEASE_SKILL_ENTRY" docs refresh --unit <id> --json
# Then confirm and write:
node "$RELEASE_SKILL_ENTRY" docs refresh --unit <id> \
  --write --confirm-refresh <refreshDigest> --ack-local-document-write --json

# Step 5a: Local preflight only (does not proceed to publish)
node "$RELEASE_SKILL_ENTRY" prepare --offline \
  --workflow docs --target-version <version> --json

# Step 5b: Production prepare --workflow docs (required before approve -> publish -> verify)
node "$RELEASE_SKILL_ENTRY" prepare --online --production \
  --workflow docs --target-version <version> --json

# Step 6: Approval (on Step 5b production plan)
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
| style-guard 检查失败 | exit 1（style-guard 检查门） | 修正文档问题后重试 step② |
| style-guard 运行参数错误 | exit 2 | 检查参数（只接受文件路径）与文件存在性 |
| render-site 漂移或配置失效 | `CONFIG_INVALID` / 渲染基线漂移 | 重新渲染并提交基线后重试 step③ |
| prepare 检测到未刷新文档 | `RELEASE_DOCS_STALE` | 重新执行 step④ → 提交 → 重新 prepare |
| 配置校验失败 | `CONFIG_INVALID` | 修正 `.release-skill/project.yaml` 文档映射后重试 |
| 基线漂移阻断 | `BASELINE_CHANGED` | 核对基线提交与远端状态后重新 `prepare` |
| 非 VERIFIED 终态 | NEEDS_INPUT / BLOCKED | 根据错误码诊断具体问题 |

## 与其他工作流的关系

- **config-only**：仅配置变更时使用 `release-config`  
- **marketplace-only**：仅 marketplace 变更时使用独立工作流  
- **full-happy-end**：混合变更（code+docs）时降级到此完整路径

## 关联技能

- `release-skill route`：快速入门决策路由（§4.3）  
- `release-assess`：项目发布就绪度评估  
- `release-prepare`：冻结发布计划（`--workflow docs` 裁剪代码类门禁）  
- `release-publish`：发布 GitHub/npm 制品  
- `release-verify`：消费者验证和远程状态重检  
- `skill-family-docs-style-guard`（skill-family-docs adapter）：`check-style.mjs` 文档质量三道门  
- `render-public-site`（skill-family-doc-render）：站点渲染漂移与泄漏扫描

## 人类最终回复

纯问询或转交时短答：写明实际回答、适用范围或理由、必要限制和下一步。建议保持为建议。

执行路径说明实际分支、已完成步骤、未执行步骤，以及演练或写入产物和限制。**本地文档写入仅在 `--write --confirm-refresh --ack-local-document-write` 三项绑定已实际执行后报告**。发布链只报告已经跑完的 `prepare`、`approve`、`publish`、`verify`；**仅当退出码为 0 且状态为 `VERIFIED` 时，把发布终态写为已验证**。已有文件输出按原合同呈现。栏目只收录当前命令或分支已经返回的事实。
