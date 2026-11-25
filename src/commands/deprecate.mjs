/**
 * 受控生命周期治理子命令：版本风险退出、消费端回退指引与整族退役提案
 * （`US-073`、`US-077`、`US-078`）。
 *
 * 硬性边界：
 * - 仅在本地离线生成结构化收据、消费者迁移说明 Markdown 与 `skill-family-hub`
 *   市场提案 JSON（`--offline` / `--dry-run`），绝不发起任何真实远端 npm 或
 *   GitHub 写请求；
 * - 显式传入 `--online` 时直接按安全门禁拒绝（`LIFECYCLE_REMOTE_WRITE_DISABLED`）；
 * - 生成收据与市场提案全部经 `lifecycle-advisory.schema.json` 闭世界校验，且不
 *   携带本机绝对路径。
 *
 * @module commands/deprecate
 */
// @decision D-RS-002

import { randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, posix as pathPosix, relative, resolve, sep } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { writeFileAtomic } from 'skill-family-harness-node';

import { acquireProjectLock } from '../artifacts/project-lock.mjs';
import { loadProjectConfig } from '../core/config.mjs';
import { canonicalJson, sha256Hex } from '../core/digest.mjs';
import {
  CONFIG_INVALID,
  GATE_FAILED,
  MISSING_PARAMETERS,
  ReleaseError,
} from '../core/errors.mjs';
import { createEvidenceWriter } from '../core/evidence.mjs';
import {
  buildLifecycleProposalDocument,
  lifecycleProposalFileName,
  normalizeHubSupersededPluginId,
} from '../core/proposal-document.mjs';
import { readTrustedPackageResourceSync } from '../core/trusted-resource.mjs';
import { parseSemverVersion } from './assess.mjs';
import { resolveUnitVersion } from './prepare.mjs';

export const LIFECYCLE_SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low']);

const SEVERITY_LABELS = Object.freeze({
  critical: '紧急高危（critical）',
  high: '高风险（high）',
  medium: '中风险（medium）',
  low: '常规维护退出（low）',
});

const ADVISORY_SCHEMA = JSON.parse(
  readTrustedPackageResourceSync('schemas/lifecycle-advisory.schema.json').toString('utf8'),
);
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(ADVISORY_SCHEMA);
const validateReceiptSchema = ajv.compile({
  $ref: `${ADVISORY_SCHEMA.$id}#/definitions/advisoryReceipt`,
});
const validateProposalSchema = ajv.compile({
  $ref: `${ADVISORY_SCHEMA.$id}#/definitions/hubLifecycleProposal`,
});

function toPosixRelative(fromRoot, targetAbs) {
  return relative(fromRoot, targetAbs).split(sep).join('/');
}

function buildDistributionConsumerActions(unit, safeExit, lifecycleAction) {
  const results = [];
  for (const dist of unit.distributions ?? []) {
    if (dist.type === 'npm') {
      const pkg = dist.package;
      let consumerAction;
      if (safeExit.strategy === 'rollback-version') {
        consumerAction = `npm install ${pkg}@${safeExit.fallbackVersion}`;
      } else if (safeExit.strategy === 'replacement-plugin') {
        consumerAction = `npm uninstall ${pkg} && npm install ${safeExit.supersededBy}`;
      } else {
        consumerAction = `npm uninstall ${pkg}`;
      }
      results.push({ type: 'npm', identifier: pkg, consumerAction });
      continue;
    }
    const pluginId = dist.plugin ?? unit.id;
    const marketSuffix = dist.marketplace ? `@${dist.marketplace}` : '';
    const fullRef = `${pluginId}${marketSuffix}`;
    let consumerAction;
    if (lifecycleAction === 'deprecate' && safeExit.strategy === 'rollback-version') {
      consumerAction = `卸载当前受影响版本，重新安装固定标签或回退至 ${pluginId}@${safeExit.fallbackVersion}`;
    } else if (safeExit.strategy === 'replacement-plugin') {
      consumerAction = `卸载 ${fullRef}，改为安装替代插件 ${safeExit.supersededBy}`;
    } else {
      consumerAction = `从宿主环境卸载已退役插件 ${fullRef}`;
    }
    results.push({ type: dist.type, identifier: fullRef, consumerAction });
  }
  if (results.length === 0) {
    const fallbackHint = safeExit.strategy === 'rollback-version'
      ? `将对 ${unit.publicRepo} 的引用回退至安全版本 ${safeExit.fallbackVersion}`
      : safeExit.strategy === 'replacement-plugin'
        ? `停止使用 ${unit.publicRepo}，迁移至 ${safeExit.supersededBy}`
        : `移除对已退役仓库 ${unit.publicRepo} 的依赖`;
    results.push({ type: 'github-snapshot', identifier: unit.publicRepo, consumerAction: fallbackHint });
  }
  return results;
}

function renderMigrationGuideMarkdown({
  receipt,
  deprecationNotice,
}) {
  const isRetire = receipt.lifecycleAction === 'retire';
  const heading = isRetire
    ? `# 技能族退役与迁移通告：${receipt.unitId}`
    : `# 版本风险退出与回退通告：${receipt.unitId}@${receipt.affectedVersion}`;

  const exitSummary = receipt.safeExit.strategy === 'rollback-version'
    ? `立即停止安装或升级 \`${receipt.unitId}@${receipt.affectedVersion}\`，回退至已验证安全版本 \`${receipt.safeExit.fallbackVersion}\`。`
    : receipt.safeExit.strategy === 'replacement-plugin'
      ? `停止继续使用 \`${receipt.unitId}\`${isRetire ? '' : `（受影响版本 \`${receipt.affectedVersion}\`）`}，迁移至替代方案 \`${receipt.safeExit.supersededBy}\`。`
      : `发布单元 \`${receipt.unitId}\` 已正式归档停止维护：${receipt.safeExit.archiveNotice}`;

  const lines = [
    heading,
    '',
    `> **核心结论**：${exitSummary}`,
    '',
    '## 一、通告摘要',
    '',
    '| 字段 | 内容 |',
    '| --- | --- |',
    `| 治理动作 | \`${receipt.lifecycleAction}\`（${isRetire ? '整族退役下架' : '问题版本风险退出'}） |`,
    `| 所属项目 / 单元 | \`${receipt.projectName}\` / \`${receipt.unitId}\`（\`${receipt.publicRepo}\`） |`,
    `| 受影响版本 | \`${receipt.affectedVersion}\` |`,
    `| 严重级别 | ${SEVERITY_LABELS[receipt.severity] ?? receipt.severity} |`,
    `| 签发责任人 | \`${receipt.actor}\` |`,
    `| 签发时间 | \`${receipt.createdAt}\` |`,
    `| 收据摘要（SHA-256） | \`${receipt.advisoryDigest}\` |`,
    `| 远端写入状态 | 本地离线收据（未直接修改 npm 或 GitHub 远端） |`,
    '',
    '## 二、原因与影响说明',
    '',
    receipt.reason,
    '',
    '## 三、消费者回退与迁移步骤',
    '',
  ];

  for (const dist of receipt.distributions) {
    lines.push(`- **${dist.type}**（\`${dist.identifier ?? receipt.unitId}\`）：${dist.consumerAction}`);
  }

  lines.push(
    '',
    '## 四、下游市场与治理衔接',
    '',
    `- 市场状态通告文案：${deprecationNotice}`,
    `- 下游 \`skill-family-hub\` 提案文件：\`${receipt.artifacts.hubProposalFile}\`（目标投递路径：\`${receipt.artifacts.hubProposalTargetPath}\`）`,
    '- 审阅无误后，将上述提案提交至市场仓库的 `incoming/` 目录，由市场流水线更新版本状态或下架条目。',
    '',
  );
  return lines.join('\n');
}

/**
 * 渲染面向终端操作者的人类可读摘要（第 4 层通告模板）。
 */
export function formatLifecycleAdvisorySummary(result) {
  const actionLabel = result.lifecycleAction === 'retire' ? '整族退役提案' : '版本风险退出与回退通告';
  const modeLabel = result.executionMode === 'dry-run' ? '仅预览（dry-run，未写入磁盘）' : '本地离线收据已生成（未执行远端写入）';
  const lines = [
    `生命周期治理：${actionLabel}（${result.status}）`,
    `执行模式：${modeLabel}`,
    `目标单元：${result.unitId}（版本：${result.affectedVersion}，严重级别：${result.severity}）`,
    `签发责任人：${result.actor}`,
    `收据摘要：${result.advisoryDigest}`,
    `回退/迁移方案：${result.deprecationNotice}`,
  ];
  if (result.executionMode !== 'dry-run' && result.outputDir) {
    lines.push(`通告收据：${result.receipt.artifacts.receiptFile}`);
    lines.push(`迁移指南：${result.receipt.artifacts.migrationGuideFile}`);
    lines.push(`市场提案：${result.receipt.artifacts.hubProposalFile} -> ${result.receipt.artifacts.hubProposalTargetPath}`);
  }
  return lines.join('\n');
}

/**
 * 校验参数并确定性生成本地版本风险退出/回退通告收据、消费者迁移指南 Markdown
 * 与下游 `skill-family-hub` 提案 JSON。
 */
export async function generateLifecycleAdvisory(options = {}) {
  const {
    root = process.cwd(),
    lifecycleAction = 'deprecate',
    unitId: requestedUnitId,
    targetVersion,
    severity,
    reason,
    fallbackVersion,
    supersededBy,
    archiveNotice,
    actor,
    outputDir: customOutputDir,
    dryRun = false,
    online = false,
    clock = () => new Date().toISOString(),
  } = options;

  if (online === true) {
    throw new ReleaseError(
      GATE_FAILED,
      '生命周期退出与退役命令仅支持本地离线生成收据与市场提案（--offline / --dry-run），本阶段禁止直接发起 npm 或 GitHub 远端写操作。',
      {
        reason: 'LIFECYCLE_REMOTE_WRITE_DISABLED',
        nextSteps: [{
          code: 'USE_OFFLINE_LIFECYCLE_ADVISORY',
          message: '移除 --online，使用默认的 --offline 或 --dry-run 生成本地通告收据与市场提案',
          argv: ['release-skill', lifecycleAction, '--offline'],
        }],
      },
    );
  }

  if (lifecycleAction !== 'deprecate' && lifecycleAction !== 'retire') {
    throw new ReleaseError(
      CONFIG_INVALID,
      `不支持的生命周期治理动作 "${lifecycleAction}"（仅支持 deprecate 或 retire）`,
      { lifecycleAction },
    );
  }

  if (typeof actor !== 'string' || actor.trim().length === 0) {
    throw new ReleaseError(MISSING_PARAMETERS, `${lifecycleAction} 需要提供 --actor <签发人标识>`, { field: 'actor' });
  }
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new ReleaseError(MISSING_PARAMETERS, `${lifecycleAction} 需要提供 --reason <退出或退役原因>`, { field: 'reason' });
  }
  if (typeof severity !== 'string' || !LIFECYCLE_SEVERITIES.includes(severity)) {
    throw new ReleaseError(
      MISSING_PARAMETERS,
      `${lifecycleAction} 需要提供有效的 --severity <critical|high|medium|low>`,
      { field: 'severity', supported: LIFECYCLE_SEVERITIES },
    );
  }

  const realRoot = await realpath(resolve(root));
  const { config } = await loadProjectConfig({ root: realRoot });
  const units = config.releaseUnits ?? [];
  let unit = null;
  if (typeof requestedUnitId === 'string' && requestedUnitId.trim().length > 0) {
    unit = units.find((entry) => entry.id === requestedUnitId.trim()) ?? null;
    if (!unit) {
      throw new ReleaseError(
        CONFIG_INVALID,
        `未在项目配置中找到发布单元 "${requestedUnitId}"；可选单元：${units.map((u) => u.id).join(', ')}`,
        { unitId: requestedUnitId, availableUnits: units.map((u) => u.id) },
      );
    }
  } else if (units.length === 1) {
    unit = units[0];
  } else {
    throw new ReleaseError(
      MISSING_PARAMETERS,
      `项目包含多个发布单元（${units.map((u) => u.id).join(', ')}），请使用 --unit <id> 显式指定目标单元`,
      { availableUnits: units.map((u) => u.id) },
    );
  }

  let affectedVersion;
  let hubVersion;
  if (lifecycleAction === 'deprecate') {
    if (typeof targetVersion !== 'string' || targetVersion.trim().length === 0) {
      throw new ReleaseError(
        MISSING_PARAMETERS,
        'deprecate 需要通过 --target-version <semver> 指定要退出的已发布版本',
        { field: 'targetVersion' },
      );
    }
    if (!parseSemverVersion(targetVersion.trim())) {
      throw new ReleaseError(
        CONFIG_INVALID,
        `--target-version "${targetVersion}" 不是合法的 SemVer 版本号`,
        { field: 'targetVersion', targetVersion },
      );
    }
    affectedVersion = targetVersion.trim();
    hubVersion = affectedVersion;
  } else if (typeof targetVersion === 'string' && targetVersion.trim().length > 0) {
    const trimmed = targetVersion.trim();
    if (trimmed !== 'all' && !parseSemverVersion(trimmed)) {
      throw new ReleaseError(
        CONFIG_INVALID,
        `retire 的 --target-version "${targetVersion}" 须为合法 SemVer 或 "all"`,
        { field: 'targetVersion', targetVersion },
      );
    }
    affectedVersion = trimmed;
    if (trimmed === 'all') {
      let resolvedCurrent = '';
      try {
        resolvedCurrent = await resolveUnitVersion(unit, realRoot);
      } catch {
        resolvedCurrent = '';
      }
      if (!resolvedCurrent || !parseSemverVersion(resolvedCurrent)) {
        throw new ReleaseError(
          CONFIG_INVALID,
          `retire 指定 --target-version all 时，无法从发布单元 "${unit.id}" 的版本源解析当前 SemVer 版本号；请修复版本源或显式传入 --target-version <当前市场登记版本>`,
          { field: 'targetVersion', unitId: unit.id },
        );
      }
      hubVersion = resolvedCurrent;
    } else {
      hubVersion = trimmed;
    }
  } else {
    let resolvedCurrent = '';
    try {
      resolvedCurrent = await resolveUnitVersion(unit, realRoot);
    } catch {
      resolvedCurrent = '';
    }
    if (!resolvedCurrent || !parseSemverVersion(resolvedCurrent)) {
      throw new ReleaseError(
        CONFIG_INVALID,
        `无法从发布单元 "${unit.id}" 的版本源解析当前 SemVer 版本号；请通过 --target-version <semver> 显式指定当前市场登记版本`,
        { field: 'targetVersion', unitId: unit.id },
      );
    }
    affectedVersion = resolvedCurrent;
    hubVersion = resolvedCurrent;
  }

  const trimmedFallback = typeof fallbackVersion === 'string' ? fallbackVersion.trim() : '';
  const trimmedSuperseded = typeof supersededBy === 'string' ? supersededBy.trim() : '';
  const trimmedArchive = typeof archiveNotice === 'string' ? archiveNotice.trim() : '';

  if (trimmedSuperseded) {
    let normalizedPluginId;
    try {
      normalizedPluginId = normalizeHubSupersededPluginId(trimmedSuperseded);
    } catch (err) {
      throw new ReleaseError(CONFIG_INVALID, err.message, { field: 'supersededBy', supersededBy: trimmedSuperseded });
    }
    if (normalizedPluginId === unit.id) {
      throw new ReleaseError(
        CONFIG_INVALID,
        `替代目标 --superseded-by ("${trimmedSuperseded}") 不能指向当前发布单元自身 ("${unit.id}")`,
        { reason: 'SUPERSEDED_EQUALS_UNIT', unitId: unit.id, supersededBy: trimmedSuperseded },
      );
    }
  }

  let safeExit;
  let deprecationNotice;
  if (lifecycleAction === 'deprecate') {
    if (!trimmedFallback && !trimmedSuperseded) {
      throw new ReleaseError(
        MISSING_PARAMETERS,
        '版本风险退出必须指明安全去向：请提供 --fallback-version <安全回退版本> 或 --superseded-by <替代包/插件>',
        { reason: 'SAFE_EXIT_TARGET_REQUIRED' },
      );
    }
    if (trimmedFallback) {
      if (!parseSemverVersion(trimmedFallback)) {
        throw new ReleaseError(
          CONFIG_INVALID,
          `--fallback-version "${trimmedFallback}" 不是合法的 SemVer 版本号`,
          { field: 'fallbackVersion', fallbackVersion: trimmedFallback },
        );
      }
      if (trimmedFallback === affectedVersion) {
        throw new ReleaseError(
          CONFIG_INVALID,
          `安全回退版本 --fallback-version (${trimmedFallback}) 不能与问题版本 (${affectedVersion}) 相同`,
          { reason: 'FALLBACK_EQUALS_TARGET', affectedVersion, fallbackVersion: trimmedFallback },
        );
      }
      safeExit = {
        strategy: 'rollback-version',
        fallbackVersion: trimmedFallback,
        ...(trimmedSuperseded ? { supersededBy: trimmedSuperseded } : {}),
      };
      deprecationNotice = `${unit.id}@${affectedVersion} 已标记风险退出（${reason.trim()}），请立即回退至安全版本 ${trimmedFallback}。`;
    } else {
      safeExit = { strategy: 'replacement-plugin', supersededBy: trimmedSuperseded };
      deprecationNotice = `${unit.id}@${affectedVersion} 已停止推荐使用（${reason.trim()}），请迁移至 ${trimmedSuperseded}。`;
    }
  } else {
    if (trimmedFallback && !trimmedSuperseded && !trimmedArchive) {
      throw new ReleaseError(
        CONFIG_INVALID,
        '整族退役（retire）表示下架整个发布单元，不能仅指定同单元的 --fallback-version；请提供 --superseded-by <替代插件> 或 --archive-notice <归档停服说明>',
        { reason: 'RETIRE_REQUIRES_REPLACEMENT_OR_ARCHIVE' },
      );
    }
    if (!trimmedSuperseded && !trimmedArchive) {
      throw new ReleaseError(
        MISSING_PARAMETERS,
        '整族退役（retire）必须提供 --superseded-by <替代插件> 或 --archive-notice <归档停服说明>',
        { reason: 'RETIRE_REQUIRES_REPLACEMENT_OR_ARCHIVE' },
      );
    }
    if (trimmedSuperseded) {
      safeExit = {
        strategy: 'replacement-plugin',
        supersededBy: trimmedSuperseded,
        ...(trimmedArchive ? { archiveNotice: trimmedArchive } : {}),
      };
      deprecationNotice = `${unit.id} 已正式退役（${reason.trim()}），请迁移至替代方案 ${trimmedSuperseded}${trimmedArchive ? `（${trimmedArchive}）` : ''}。`;
    } else {
      safeExit = { strategy: 'archived-end-of-life', archiveNotice: trimmedArchive };
      deprecationNotice = `${unit.id} 已正式退役归档（${reason.trim()}）：${trimmedArchive}`;
    }
  }

  const defaultRelDir = pathPosix.join(
    '.release-skill',
    'advisories',
    `${unit.id}-${affectedVersion}-${lifecycleAction}`,
  );
  const resolvedOutDir = customOutputDir
    ? resolve(realRoot, customOutputDir)
    : resolve(realRoot, defaultRelDir);
  const relOutDir = toPosixRelative(realRoot, resolvedOutDir);
  if (!relOutDir || relOutDir === '..' || relOutDir.startsWith('../') || isAbsolute(relOutDir)) {
    throw new ReleaseError(
      CONFIG_INVALID,
      `输出目录必须位于项目根目录之内，不能越界写入：${customOutputDir}`,
      { reason: 'ADVISORY_OUTPUT_ESCAPE' },
    );
  }

  const hubProposalTargetPath = lifecycleProposalFileName(unit.id, hubVersion, lifecycleAction);
  const artifacts = {
    receiptFile: pathPosix.join(relOutDir, 'advisory-receipt.json'),
    migrationGuideFile: pathPosix.join(relOutDir, 'migration-guide.md'),
    hubProposalFile: pathPosix.join(relOutDir, 'hub-proposal.json'),
    hubProposalTargetPath,
  };

  const rawClock = clock();
  const parsedClockMs = typeof rawClock === 'string' ? Date.parse(rawClock) : Number.NaN;
  if (Number.isNaN(parsedClockMs)) {
    throw new ReleaseError(
      CONFIG_INVALID,
      `签发时间 "${rawClock}" 非法；须为合法的 ISO 8601 时间字符串`,
      { field: 'createdAt', createdAt: rawClock },
    );
  }
  const createdAt = new Date(parsedClockMs).toISOString();
  const executionMode = dryRun ? 'dry-run' : 'offline';
  const distributions = buildDistributionConsumerActions(unit, safeExit, lifecycleAction);
  const unsignedReceipt = {
    schemaVersion: 1,
    kind: 'release-skill/lifecycle-advisory',
    lifecycleAction,
    executionMode,
    remoteWritesPerformed: false,
    projectName: config.project.name,
    unitId: unit.id,
    publicRepo: unit.publicRepo,
    affectedVersion,
    severity,
    reason: reason.trim(),
    actor: actor.trim(),
    createdAt,
    safeExit,
    distributions,
    artifacts,
  };
  const advisoryDigest = sha256Hex(canonicalJson(unsignedReceipt));
  const receipt = { ...unsignedReceipt, advisoryDigest };

  if (!validateReceiptSchema(receipt)) {
    throw new ReleaseError(
      GATE_FAILED,
      `生命周期通告收据未通过 Schema 校验：${(validateReceiptSchema.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ')}`,
      { reason: 'ADVISORY_SCHEMA_INVALID' },
    );
  }

  const changeSummary = lifecycleAction === 'retire'
    ? `retire ${unit.id} ${hubVersion}: ${reason.trim()}`
    : `deprecate ${unit.id} ${hubVersion}${safeExit.fallbackVersion ? ` -> fallback ${safeExit.fallbackVersion}` : ''}: ${reason.trim()}`;

  const hubProposal = buildLifecycleProposalDocument({
    unitId: unit.id,
    version: hubVersion,
    lifecycleAction,
    fallbackVersion: safeExit.fallbackVersion,
    supersededBy: safeExit.supersededBy,
    deprecationNotice,
    issuedAt: createdAt,
    changeSummary,
    reason: reason.trim(),
  });

  if (!validateProposalSchema(hubProposal)) {
    throw new ReleaseError(
      GATE_FAILED,
      `下游市场提案未通过 Schema 校验：${(validateProposalSchema.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ')}`,
      { reason: 'PROPOSAL_SCHEMA_INVALID' },
    );
  }

  const migrationGuideMarkdown = renderMigrationGuideMarkdown({
    receipt,
    deprecationNotice,
  });

  let evidenceDir = null;
  if (!dryRun) {
    const lock = await acquireProjectLock({ root: realRoot, command: lifecycleAction, mode: 'exclusive' });
    try {
      const runDir = resolve(
        realRoot,
        '.release-skill',
        'runs',
        `${lifecycleAction}-${Date.now()}-${randomUUID().slice(0, 8)}`,
      );
      await mkdir(runDir, { recursive: true });
      const evidence = createEvidenceWriter({ runDir, command: lifecycleAction, clock });
      await evidence.append({
        phase: 'lifecycle-advisory',
        status: 'started',
        unitId: unit.id,
        lifecycleAction,
        affectedVersion,
      });
      await mkdir(resolvedOutDir, { recursive: true });
      await writeFileAtomic(resolvedOutDir, 'advisory-receipt.json', `${JSON.stringify(receipt, null, 2)}\n`);
      await writeFileAtomic(resolvedOutDir, 'migration-guide.md', migrationGuideMarkdown);
      await writeFileAtomic(resolvedOutDir, 'hub-proposal.json', `${JSON.stringify(hubProposal, null, 2)}\n`);
      await evidence.append({
        phase: 'lifecycle-advisory',
        status: 'completed',
        unitId: unit.id,
        advisoryDigest,
      });
      await evidence.finish({
        status: lifecycleAction === 'retire' ? 'RETIREMENT_PREPARED' : 'ADVISORY_PREPARED',
        unitId: unit.id,
        affectedVersion,
        advisoryDigest,
        completedAt: clock(),
      });
      evidenceDir = runDir;
    } finally {
      await lock.release();
    }
  }

  const status = dryRun
    ? 'DRY_RUN'
    : lifecycleAction === 'retire'
      ? 'RETIREMENT_PREPARED'
      : 'ADVISORY_PREPARED';

  const result = {
    command: lifecycleAction,
    status,
    lifecycleAction,
    executionMode,
    remoteWritesPerformed: false,
    unitId: unit.id,
    affectedVersion,
    severity,
    actor: actor.trim(),
    deprecationNotice,
    advisoryDigest,
    outputDir: dryRun ? null : resolvedOutDir,
    evidenceDir,
    receipt,
    hubProposal,
    migrationGuideMarkdown,
  };
  return {
    ...result,
    summary: formatLifecycleAdvisorySummary(result),
  };
}
