---
name: release-publish
description: "从已批准的生产计划发布冻结 Git branch/tag、npm tarball 与 GitHub Release，并执行已配置的 Claude/Codex marketplace 隔离消费者安装检查以达到 PUBLISHED；随后必须路由 release-verify 才可能达到 VERIFIED；遇到冲突或不确定远端状态时失败关闭并要求人工介入"
---

# release-publish

## 生产边界

冻结 Git branch/tag、GitHub Release、npm tarball 路径已通过本地生产等价沙箱（协议级 fake）验证，测试未提供 OS 级网络隔离。插件市场消费者安装验证通过本地协议沙箱完成；真实生产 canary 仅在用户明确授权目标后执行。不得将沙箱结果描述为真实发布成功。

仅发布 `prepare --production` 封存的 Git object 和 npm tarball，不从活动工作区重新打包，不生成或覆盖 README，也永不隐式刷新工作树中的发布文档。遇到 `RELEASE_DOCS_STALE` 或文档陈旧时，必须返回 `docs refresh` → 人工审阅 → 提交 → 重新 `prepare`。远端 branch/tag/Release/npm version 已存在、查询不确定、认证失败或摘要漂移时，在全局预检阶段停止并交由人工介入。禁止覆盖、删除和自动回滚；新建 ref 的 `create-only CAS`（`--force-with-lease=<ref>:`）仅断言目标不存在，不授权覆盖。

## 前置条件：工作流选择

当调用方持有合法、未过期且绑定当前 production plan 的 approval record 时，`release-publish` 直接执行自身的计划、批准、冻结制品身份和远端预检。`route` 仅提供工作流建议，非已批准 production plan 的授权门。

尚未形成计划时，可先使用 `release-skill route --root <path> --json` 确定变更类型。已知目标版本时一并传入 `--target-version <version>`，使恢复建议仅读取与该目标绑定的完整运行血缘。未传目标时，`route` 仍按 diff/baseline 选择工作流；历史 diagnostics 仅作报告，不得覆盖当前建议。

根据推荐的 `workflowKind` 选择对应路径：

- `docs-only` → 先执行 `release-docs` 完整流程  
- `config-only` → 先执行 `release-config`，仅在 public surface 变化时进入 publish  
- `marketplace-only` → 先执行 `release-marketplace`，然后由 workspace exclusive skill 接管  
- `full-happy-end` → 直接进入标准完整流程：`prepare → approve → publish → verify`  
- `reconcile` → 先执行 `release-reconcile` 恢复 PARTIAL 状态  
- `help` → 无变更，无需 publish  

> **注意**：`release-publish` 是标准工作流中的第⑦步，必须在以下步骤之后执行：  
> - 步骤⑤：`release-prepare`（或轻量级 prepare）  
> - 步骤⑥：`release-approve`（非过期 approval record）

接收已有冻结计划时沿原合同执行，不回头追加接入义务。仅当本入口转入新一轮生产准备时，才按 `release-prepare` 同一完整流程核对 `testIntake`：若缺失，则说明缺项并默认推动 `skill-family-test:skill-family-test-plan`，再在授权范围内调用 `skill-family-test:skill-family-test-run`，由 TEST 组织检查并交回结果。跳过须先明确征询，再依据本轮适用且范围匹配的明确同意决定。沉默、拒绝、仅普通发布预授权、旧轮次、其他项目、版本或范围不匹配均不可跳过。本轮匹配答复可复用。不得把跳过写成测试已达标，也不得用跳过清除已声明的适用要求。只读、非生产准备不新增接入义务。直接非交互 CLI 仍接受可选 `testIntake`，不新增选择参数。答复与适用范围记入既有任务或执行计划。未完成接入且无有效跳过时，不进入新一轮正式 prepare。

决策表链接：参见 [`release-help`](../release-help/SKILL.md) 的 Routing Suggestions 章节。

## 触发

用户明确要求执行已人工审阅的 GitHub + npm 生产计划。

## 授权门

1. 读取本次批准所绑定的不可变计划，按其中实际存在的 `units`、`externalActions`、`waivers` 和 `postPublish` 整理并展示人可读批准摘要。版本、公开仓库、分支策略、branch/tag、npm 与 GitHub Release 目标、全部 actions、例外，以及需要独立 checkpoint 批准的 postPublish hook，仅展示计划中已写入的值；未出现字段保持缺失，不猜测。  
2. 必须存在未过期且由系统绑定同一内部 digest 的 approval record；批准后不再要求用户复制摘要做二次确认。  
3. 只有 CLI exit code 0 且结构化状态为 `PUBLISHED` 才算外写阶段通过；随后必须运行 `release-verify`，只有 `VERIFIED` 才是完整终态。

冻结计划批准是正常发布级流程的唯一批准门。它包含计划内的外部动作和验证门禁，不包含有效 `requiresApproval: true` 的 postPublish checkpoint。此类 hook 仍须使用绑定 `(planDigest, hookId)` 且最长有效 24 小时的独立批准记录。

## 确定性执行

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/release-skill.mjs" publish --root <path> --plan <plan-path> \
  --approval <approval-path> --json
```

执行顺序：全局只读预检 → 配置的公开分支（按三种 `branchStrategy` 执行）→ 必要时单独切换默认分支 → tag → npm tarball → GitHub Release → Claude/Codex marketplace 隔离安装。每步 execute 后立即 observe；默认分支 action 同时绑定名称和目标精确 commit；末尾再次核对分支/默认分支一致性。失败停止后续动作并记录 `PARTIAL`。`PUBLISHED` 后运行 `verify` 复核全新消费者安装。

## 故障路由

| 结果 | 处理 |
|------|------|
| `BASELINE_CHANGED` | 保留人工修改，重新 `prepare`、审阅和 `approve`；不得覆盖修改。 |
| 摘要/制品不匹配 | 停止；重新 `prepare`，不修补冻结目录。 |
| 远端对象已存在 | 人工判断版本或远端状态；不得覆盖。`create-only CAS` 也必须失败关闭。 |
| 认证/网络/未知查询错误 | 失败关闭，修复环境后基于同一证据判断是否 `reconcile`。 |
| `PARTIAL` | 检查 `release-run.json`，不重跑整套发布、不删除成功对象。 |

发布成功后必须运行 `release-verify`；`PARTIAL` 仅在人工确认远端状态后进入 `release-reconcile`。

## 人类最终回复

纯问询或转交时短答：写明实际回答、适用范围或理由、必要限制和下一步。建议保持为建议。

执行路径说明本轮实际阶段、范围、退出码和结构化结果，引用已批准计划、approval 与 run 产物位置。保留预检阻断、`PARTIAL` 和人工后续。仅当退出码为 0 且状态为 `PUBLISHED` 时，把外写阶段写为已发布；随后仍须 `release-verify`。`PUBLISHED`、本机更新与 `VERIFIED` 按各自既有通过条件分别报告。已有 run 文件按原合同呈现。栏目只收录当前命令已经返回的事实。