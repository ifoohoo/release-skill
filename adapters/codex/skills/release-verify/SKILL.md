---
name: release-verify
description: Post-publish verification including remote state recheck, exact npm installation smoke, and consumer plugin install verification
---

> **Codex 安装入口解析协议**：在调用 CLI 前，Agent 必须从宿主当前已加载技能的元数据中取得本 `SKILL.md` 的实际绝对路径，并将该字面量记为 `SKILL_FILE`。
> `SKILL_FILE` 不是环境变量；禁止从工作目录、可执行搜索路径、源码仓库或 shell 调用上下文猜测。若宿主未提供该绝对路径，立即停止并报告安装定位失败。
> 对 `SKILL_FILE` 执行 `realpath`，取其目录向上两级得到 `PLUGIN_ROOT`；校验真实技能路径匹配 `PLUGIN_ROOT/skills/*/SKILL.md` 且仍位于插件根内（路径包含检查）。
> 令 `RELEASE_SKILL_ENTRY=PLUGIN_ROOT/bin/release-skill.mjs`，对入口执行 `realpath` containment、`lstat` 非符号链接且为普通文件校验。
> 每一次 shell 工具调用都必须在同一个调用中用上述已验证绝对值设置 `RELEASE_SKILL_ENTRY`，然后执行 `node "$RELEASE_SKILL_ENTRY" ...`；不得依赖前一次 shell 的变量。
>

# release-verify

## 触发

用户请求验证发布结果完整性，或发布流程自动进入 verify 阶段。

## 当前状态

verify 是发布流程的最终验证阶段，是唯一能将状态提升到 `VERIFIED` 的命令。
它执行远端状态重检、精确 npm 安装烟雾测试和消费者插件安装验证。
verify 只接受 `PUBLISHED` 状态的源 run；`VERIFIED` 是终态，不会再次派生运行。

**注意**: distribute gate (W1) 已经实现并集成在标准 verify 流程中。verify 现在会检查 postPublish 分发状态（git mirror + marketplace index），只有当所有外部动作都完成并通过验证时才达到 VERIFIED。

**工作流兼容性**: 
- `docs-only`: consumer-verify preserved (步骤⑧)
- `config-only`: scene B completes full chain including verify  
- `marketplace-only`: delegates to workspace's exclusive skill for final verification
- `full-happy-end`: standard complete path with all gates

所有工作流 profile 最终都路由到此 verify 命令作为终态验证门。

## 职责与边界

验证远端所有自动化 action 的实际状态与冻结计划一致。执行精确 `<package>@<version>` npm 安装到隔离目录，验证包名、版本、静态入口闭包，并在配置时验证 bin 路径安全和 CLI 烟雾输出。对 Claude/Codex marketplace distribution 执行全新隔离消费者安装验证。新计划中的 Kimi/CodeBuddy 安装只返回 `manualFollowUps`，明确标记 `verifiedBySystem: false`，不阻塞 `VERIFIED`；缺少该策略字段的旧冻结计划继续走历史 attestation 兼容路径。

**attestation 证明力边界**: `attest` 命令记录的旧计划兼容人工证明（`humanConfirmed: true` → `PASSED_MANUAL`）是本地自声明收据，不是签名见证：`--actor` 仅做非空字符串校验，无外部签名或身份核验，任何能运行 CLI 的进程都能自称任意 actor；伪造收据需写 `.release-skill` authority 目录，与直接改写收据文件属同一信任边界。因此旧兼容路径的人工证明只用于旧冻结计划收尾，不构成独立可审计的人工见证。新计划的 Kimi/CodeBuddy 安装一律走 `manualFollowUps`（`verifiedBySystem: false`），不参与 `VERIFIED` 终态判定。

**阶段通过规则**: 只有 CLI exit code 0 和结构化状态码 `VERIFIED` 才是完整终态。

**源 run 要求**: `--run` 必需；源 run 的所有 checkpoint 必须为 succeeded 或 skipped。

**不确定性停止**: 任何验证失败立即停止，不进行部分降级。

## 正向执行路径

1. 确认有 `--run` 路径（必需），且源 run 状态为 PUBLISHED
2. 使用插件根相对路径运行 CLI；命令调用本身即授权执行已配置的 verification gate 和 smoke process
3. 检查 exit code 和结构化状态：`VERIFIED`（全部通过）/ 失败（具体错误）
4. 只有 `VERIFIED` 才是 happy end

## 确定性脚本调用

```bash
# 从插件根运行
node "$RELEASE_SKILL_ENTRY" verify --root <path> --plan <plan-path> --run <run-path> --json
```

## 验证步骤

1. 加载并验证 release plan schema 和 digest
2. 加载源 run，验证 planDigest 匹配和 checkpoint 完整性
3. 对每个 plan action 执行 adapter.verify()（远端状态重检）
4. 对每个 npm distribution 执行隔离安装烟雾测试
5. 对 Claude/Codex marketplace distribution 执行全新隔离消费者安装验证；收集 Kimi/CodeBuddy 的非阻塞 `manualFollowUps`
6. 全部通过 → `VERIFIED`

## 烟雾测试

- 在 `os.tmpdir()` 创建隔离目录
- 执行 `npm install <package>@<version>` 带安全标志
- 验证安装的 `package.json` name 和 version 精确匹配
- 无条件静态验证已安装包中具体 `bin`/`main`/`module`/`types`/`typings`/`exports`
  目标是普通文件；失败时不得写入 `VERIFIED`
- 若配置了 `smokeBin`：验证 bin 路径安全（无逃逸、无 symlink），从精确安装根、隔离 HOME 和最小环境执行并验证输出；这会运行已安装代码，必须显式授权
- 若未配置 `smokeBin`：跳过运行代码，但静态入口闭包检查仍然强制执行

## 常见错误

| 场景 | 状态 | 处理 |
|------|------|------|
| 源 run 非 PUBLISHED | GATE_FAILED | 拒绝执行；VERIFIED 是终态 |
| 源 run 有 incomplete checkpoint | GATE_FAILED | 拒绝执行 |
| 远端状态不匹配 | POST_PUBLISH_VERIFY_FAILED | 停止 |
| npm 安装失败 | POST_PUBLISH_VERIFY_FAILED | 停止 |
| CLI 烟雾输出不匹配 | POST_PUBLISH_VERIFY_FAILED | 停止 |
| consumer gate / smokeBin 执行失败 | GATE_FAILED | 检查失败原因，修复后重试 |
