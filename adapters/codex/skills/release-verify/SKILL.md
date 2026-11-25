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

`release-verify` 是发布流水线的终态核验门，也是唯一能将状态推进到 `VERIFIED` 的入口：它重新核对远端分支/标签/Release 状态，并在全新隔离环境中完成精确版本的 npm 安装烟雾检查与插件市场消费者安装核验。`verify` 只接收 `PUBLISHED` 状态的源运行记录（`--run`）；达成 `VERIFIED` 后状态即封口，不再派生后续发布运行。

若冻结计划声明了 `postVerify` 钩子，则在 `VERIFIED` 之后由独立的 `postverify` 命令承接执行：传入该 `VERIFIED` 运行记录、同一计划批准记录，以及逐项绑定的检查点批准记录（`--hook-approval`），生成独立的 `postverify` 运行目录，绝不读写 `ship` 状态文件；任何检查点批准缺失、不匹配或过期，都会在启动钩子前失败关闭。

`distribute` 门禁已集成在标准核验链中：`verify` 会同步校验 `postPublish` 分发目标（Git 镜像仓库与市场索引）的完成状态，所有外部动作均落定并通过核验后才写入 `VERIFIED`。若已达 `VERIFIED` 的历史版本事后发现严重回归风险，应使用 `release-skill deprecate`（单版本回退引导）或 `release-skill retire`（整族退役下架）离线生成通告收据、迁移说明与市场提案，绝不篡改既有 `VERIFIED` 记录。

**各工作流终态衔接**：
- `docs-only`：保留消费者安装核验（步骤⑧）
- `config-only`：公开字节有变化的场景 B 走完包含 `verify` 的完整链条
- `marketplace-only`：委托目标市场工作区自有发布技能完成最终核验
- `full-happy-end`：运行全套门禁的标准路径

## 职责与边界

验证远端所有自动化 action 的实际状态与冻结计划一致。执行精确 `<package>@<version>` npm 安装到隔离目录，验证包名、版本、静态入口闭包，并在配置时验证 bin 路径安全和 CLI 烟雾输出。对 Claude/Codex marketplace distribution 执行全新隔离消费者安装验证。新计划中的 Kimi/CodeBuddy 安装只返回 `manualFollowUps`，明确标记 `verifiedBySystem: false`，不阻塞 `VERIFIED`；缺少该策略字段的旧冻结计划继续走历史 attestation 兼容路径。

0.9.3 的稳定隔离安装树记录只消费宿主命令退出后的隔离树观察：宿主附加 link 记录自身但不跟随，声明载荷 symlink 失败关闭，legacy 全树语义保持不变。该观察属于安装树事实，不替代远端状态、发布计划或 `VERIFIED` 判断。

**attestation 证明力边界**: `attest` 命令记录的旧计划兼容人工证明（`humanConfirmed: true` → `PASSED_MANUAL`）是本地自声明收据，不是签名见证：`--actor` 仅做非空字符串校验，无外部签名或身份核验，任何能运行 CLI 的进程都能自称任意 actor；伪造收据需写 `.release-skill` authority 目录，与直接改写收据文件属同一信任边界。因此旧兼容路径的人工证明只用于旧冻结计划收尾，不构成独立可审计的人工见证。新计划的 Kimi/CodeBuddy 安装一律走 `manualFollowUps`（`verifiedBySystem: false`），不参与 `VERIFIED` 终态判定。

本阶段核对已发布渠道的实际载荷。漏失必需文件、禁路径误入、npm 实际遗漏保持失败。`requiredPublicFiles` 是快照目标路径；`forbiddenPaths` 按快照目标核对，不能把源目录名直接当作重命名后的禁路径。未使用渠道不得写成已完成。`VERIFIED`、`PUBLISHED`、配置通过与 `PREPARED` 分别记录，不重写历史结果。分类文字不会机械识别全部私有内容。

**阶段通过规则**: 只有 CLI exit code 0 和结构化状态码 `VERIFIED` 才是完整终态。

**源 run 要求**: `--run` 必需；源 run 的所有 checkpoint 必须为 succeeded 或 skipped。

**不确定性停止**: 任何验证失败立即停止，不进行部分降级。

## 正向执行路径

1. 确认有 `--run` 路径（必需），且源 run 状态为 PUBLISHED
2. 使用插件根相对路径运行 CLI；命令调用本身即授权执行已配置的 verification gate 和 smoke process
3. 检查 exit code 和结构化状态：`VERIFIED`（全部通过）/ 失败（具体错误）
4. 只有 `VERIFIED` 才是发布 happy end
5. 达到 `VERIFIED` 后先检查计划是否声明 `postVerify` hook：直接收尾使用独立的 `postverify --plan --approval --run --hook-approval`，由该命令产生 `DISTRIBUTED` postVerify run；若仍由持久化 ship state 承担编排，则使用 `ship --hook-approval` 完成同一阶段，再把最终 run 路径交给 `release-finish`。没有 postVerify hook 时，把当前 verify run 路径交给 `release-finish`。随后执行返回的 `post-release --finish` 命令，按 `nextActions` 补齐分支决定、宿主加载与真实 setup 结果；发布策略已包含分支动作时略过合并询问

## 确定性脚本调用

```bash
# 从插件根运行
node "$RELEASE_SKILL_ENTRY" verify --root <path> --plan <plan-path> --run <run-path> --json
# 独立执行已 VERIFIED 计划的 postVerify hook；每个 requiresApproval hook 单独传入批准记录
node "$RELEASE_SKILL_ENTRY" postverify --root <path> \
  --plan <plan-path> --approval <approval-path> --run <verified-run-path> \
  --hook-approval <immutable-hook-approval-path> --json
```

## 验证步骤

1. 加载并验证 release plan schema 和 digest
2. 加载源 run，验证 planDigest 匹配和 checkpoint 完整性
3. 对每个 plan action 执行 adapter.verify()（远端状态重检）
4. 对每个 npm distribution 执行隔离安装烟雾测试
5. 对 Claude/Codex marketplace distribution 执行全新隔离消费者安装验证；收集 Kimi/CodeBuddy 的非阻塞 `manualFollowUps`
6. 全部通过 → `VERIFIED`

`postverify` 不属于上述远端验证步骤。它只处理已经达到 `VERIFIED` 的计划，并把
`postVerify` 阶段的执行结果写入独立 run。

## 发布后收尾

`VERIFIED` 不代表要自动修改开发分支或本机宿主。进入 `release-finish` 后，只有用户明确同意，才执行对应的本地动作。`post-release --finish` 退出 0 需要所有适用步骤完成或明确跳过；单纯的宿主 `UPDATED` 不代表新入口已加载，也不代表 setup 已执行。本机插件更新失败不会改变发布终态。
核心 prepare、publish、verify 流程跨平台；WorkBuddy 的本机收尾探测和更新仅支持 macOS。

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

## 人类最终回复

纯问询或转交时短答：写明实际回答、适用范围或理由、必要限制和下一步。建议保持为建议。

执行路径说明本轮实际阶段、范围、退出码和结构化结果，引用计划、源 run 与 verify 或 postverify 产物位置。保留失败、未完成检查点和人工后续。仅当退出码为 0 且状态为 `VERIFIED` 时，把发布终态写为已验证。本机宿主更新和 `release-finish` 结果单独成文，不改写发布状态。已有 run 文件按原合同呈现。栏目只收录当前命令已经返回的事实。
