/**
 * 金丝雀分阶段灰度放量与一键版本回滚治理子命令（`CAP-P7-03`）。
 *
 * 硬性安全边界：
 * - 默认纯本地离线（`--offline` / `--dry-run`）生成结构化治理收据、渠道放量/回退执行手册与
 *   `skill-family-hub` 市场降级提案，绝不直接发起未获授权的远端 npm 或 GitHub 写操作；
 * - 显式传入 `--online` 时直接按安全门禁拒绝；
 * - 严格按 SemVer 2.0.0 序关系强制 `baselineVersion < targetVersion` 与 `fallbackVersion < targetVersion`，
 *   与下游 `skill-family-hub/scripts/proposal-inbox.mjs` 100% 对齐；
 * - 所有生成收据均通过 `canary-rollback.schema.json` 与 `lifecycle-advisory.schema.json`
 *   闭世界校验，且零本机绝对路径残留。
 *
 * @module commands/canary-rollback
 */
// @decision D-RS-002
// @decision D-RS-004
// @feature REL007
// @scenario S-008

import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
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
  PATH_UNSAFE,
  ReleaseError,
  STRUCTURE_INVALID,
} from '../core/errors.mjs';
import {
  buildLifecycleProposalDocument,
  lifecycleProposalFileName,
} from '../core/proposal-document.mjs';
import { readTrustedPackageResourceSync } from '../core/trusted-resource.mjs';
import { LIFECYCLE_SEVERITIES } from './deprecate.mjs';

export const CANARY_STAGES = Object.freeze(['canary', 'promote', 'abort']);
export const CANARY_CHANNELS = Object.freeze(['canary', 'next', 'latest']);

const STRICT_SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseStrictSemver(raw) {
  if (typeof raw !== 'string') return null;
  const m = STRICT_SEMVER_RE.exec(raw.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
  };
}

export function compareStrictSemver(a, b) {
  const pa = parseStrictSemver(a);
  const pb = parseStrictSemver(b);
  if (!pa || !pb) {
    throw new ReleaseError(CONFIG_INVALID, '非法的严格 SemVer 2.0.0 版本号', { reason: 'INVALID_STRICT_SEMVER' });
  }
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;

  const preA = pa.prerelease;
  const preB = pb.prerelease;
  if (preA.length === 0 && preB.length === 0) return 0;
  if (preA.length === 0) return 1;
  if (preB.length === 0) return -1;

  const len = Math.max(preA.length, preB.length);
  for (let i = 0; i < len; i++) {
    if (i >= preA.length) return -1;
    if (i >= preB.length) return 1;
    const idA = preA[i];
    const idB = preB[i];
    if (idA === idB) continue;
    const numA = /^(?:0|[1-9]\d*)$/.test(idA);
    const numB = /^(?:0|[1-9]\d*)$/.test(idB);
    if (numA && numB) return Number(idA) < Number(idB) ? -1 : 1;
    if (numA) return -1;
    if (numB) return 1;
    return idA < idB ? -1 : 1;
  }
  return 0;
}

const CANARY_ROLLBACK_SCHEMA = JSON.parse(
  readTrustedPackageResourceSync('schemas/canary-rollback.schema.json').toString('utf8'),
);
const ADVISORY_SCHEMA = JSON.parse(
  readTrustedPackageResourceSync('schemas/lifecycle-advisory.schema.json').toString('utf8'),
);

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(CANARY_ROLLBACK_SCHEMA);
ajv.addSchema(ADVISORY_SCHEMA);

const validateCanaryReceipt = ajv.compile({
  $ref: `${CANARY_ROLLBACK_SCHEMA.$id}#/definitions/canaryReceipt`,
});
const validateRollbackReceipt = ajv.compile({
  $ref: `${CANARY_ROLLBACK_SCHEMA.$id}#/definitions/rollbackReceipt`,
});
const validateHubProposal = ajv.compile({
  $ref: `${ADVISORY_SCHEMA.$id}#/definitions/hubLifecycleProposal`,
});

function toPosixRelative(fromRoot, targetAbs) {
  return relative(fromRoot, targetAbs).split(sep).join('/');
}

async function resolveSafeDirectoryRoot(rawDir, label = 'root') {
  try {
    const stat = await lstat(resolve(rawDir));
    if (!stat.isDirectory() && !stat.isSymbolicLink()) {
      throw new Error('not-directory');
    }
    return await realpath(resolve(rawDir));
  } catch {
    throw new ReleaseError(
      PATH_UNSAFE,
      `无法访问指定的 ${label} 目录（路径不存在或无读取权限）`,
      { reason: 'DIRECTORY_UNREADABLE', field: label },
    );
  }
}

async function prepareSafeContainedOutputDir(realRoot, customOutputDir, defaultRelDir) {
  let candidate;
  if (typeof customOutputDir === 'string' && customOutputDir.trim().length > 0) {
    const trimmed = customOutputDir.trim();
    if (isAbsolute(trimmed) || trimmed.includes('\\')) {
      throw new ReleaseError(
        PATH_UNSAFE,
        '--output-dir 必须为项目根目录内的 POSIX 相对路径，禁止传入本机绝对路径',
        { reason: 'OUTPUT_DIR_UNSAFE' },
      );
    }
    candidate = resolve(realRoot, trimmed);
    const rel = relative(realRoot, candidate);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new ReleaseError(
        PATH_UNSAFE,
        '--output-dir 不得逃逸出项目根目录',
        { reason: 'OUTPUT_DIR_ESCAPE' },
      );
    }
  } else {
    candidate = resolve(realRoot, defaultRelDir);
  }

  const relSegments = relative(realRoot, candidate).split(sep).filter(Boolean);
  let cursor = realRoot;
  for (const seg of relSegments) {
    cursor = resolve(cursor, seg);
    let st = null;
    try {
      st = await lstat(cursor);
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      throw new ReleaseError(PATH_UNSAFE, '输出目录状态检查失败', { reason: 'OUTPUT_DIR_STAT_FAILED' });
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new ReleaseError(
        PATH_UNSAFE,
        '输出目录包含符号链接或非目录祖先，已拒绝写入以防止路径逃逸',
        { reason: 'OUTPUT_DIR_SYMLINK_ANCESTOR' },
      );
    }
    const curReal = await realpath(cursor);
    const checkRel = relative(realRoot, curReal);
    if (checkRel === '..' || checkRel.startsWith(`..${sep}`) || isAbsolute(checkRel)) {
      throw new ReleaseError(
        PATH_UNSAFE,
        '输出目录真实路径逃逸出受检仓库根，已拒绝写入',
        { reason: 'OUTPUT_DIR_REALPATH_ESCAPE' },
      );
    }
  }
  return candidate;
}

function selectReleaseUnit(config, requestedUnitId, commandLabel) {
  const units = config.releaseUnits ?? [];
  if (typeof requestedUnitId === 'string' && requestedUnitId.trim().length > 0) {
    const unit = units.find((entry) => entry.id === requestedUnitId.trim()) ?? null;
    if (!unit) {
      throw new ReleaseError(
        CONFIG_INVALID,
        `未在项目配置中找到发布单元 "${requestedUnitId}"；可选单元：${units.map((u) => u.id).join(', ')}`,
        { unitId: requestedUnitId, availableUnits: units.map((u) => u.id) },
      );
    }
    return unit;
  }
  if (units.length === 1) return units[0];
  throw new ReleaseError(
    MISSING_PARAMETERS,
    `${commandLabel} 在多单元项目中须通过 --unit <id> 显式指定目标单元（可选：${units.map((u) => u.id).join(', ')}）`,
    { availableUnits: units.map((u) => u.id) },
  );
}

function buildCanaryChannelSteps(unit, { stage, channel, trafficPercent, targetVersion, baselineVersion }) {
  const steps = [];
  const npmDists = (unit.distributions ?? []).filter((d) => d.type === 'npm');
  for (const dist of npmDists) {
    const pkg = dist.package;
    if (stage === 'canary') {
      steps.push({
        channelType: 'npm-dist-tag',
        identifier: pkg,
        commandPreview: `npm dist-tag add ${pkg}@${targetVersion} ${channel}`,
        purpose: `将候选版本 ${targetVersion} 挂载至 ${channel} 灰度标签（目标灰度流量 ${trafficPercent}%），保持 latest 仍指向稳定基线 ${baselineVersion}。`,
      });
    } else if (stage === 'promote') {
      steps.push({
        channelType: 'npm-dist-tag',
        identifier: pkg,
        commandPreview: `npm dist-tag add ${pkg}@${targetVersion} latest`,
        purpose: `观察窗口零阻断异常后，将已验证的 ${targetVersion} 正式全量切换至 latest 默认标签（100% 流量）。`,
      });
    } else {
      steps.push({
        channelType: 'npm-dist-tag',
        identifier: pkg,
        commandPreview: `npm dist-tag add ${pkg}@${baselineVersion} latest && npm dist-tag rm ${pkg} ${channel}`,
        purpose: `紧急中止 ${targetVersion} 灰度放量（流量归零），确保默认标签锚定安全基线 ${baselineVersion} 并移除灰度标签。`,
      });
    }
  }

  steps.push({
    channelType: 'github-release-channel',
    identifier: unit.publicRepo,
    commandPreview: stage === 'promote'
      ? `gh release edit ${unit.version?.tagTemplate?.replace('{version}', targetVersion) ?? `v${targetVersion}`} --repo ${unit.publicRepo} --prerelease=false --latest`
      : stage === 'canary'
        ? `gh release edit ${unit.version?.tagTemplate?.replace('{version}', targetVersion) ?? `v${targetVersion}`} --repo ${unit.publicRepo} --prerelease=true`
        : `gh release edit ${unit.version?.tagTemplate?.replace('{version}', baselineVersion) ?? `v${baselineVersion}`} --repo ${unit.publicRepo} --latest`,
    purpose: stage === 'promote'
      ? '将 GitHub Release 标记为正式 Latest 版本。'
      : stage === 'canary'
        ? '将候选版本维持在 Pre-release 灰度可见态，不覆盖默认正式版。'
        : `中止灰度并将 GitHub Latest 标记恢复指向稳定基线 ${baselineVersion}。`,
  });

  return steps;
}

function renderCanaryRunbookMarkdown(receipt) {
  const stageLabels = {
    canary: '灰度放量观察（canary）',
    promote: '灰度转正全量（promote）',
    abort: '灰度紧急中止（abort）',
  };
  const lines = [
    `# 金丝雀发布治理执行手册：${receipt.unitId}@${receipt.targetVersion}`,
    '',
    `> **当前阶段**：${stageLabels[receipt.stage] ?? receipt.stage} ｜ **渠道标签**：\`${receipt.channel}\` ｜ **放量比例**：\`${receipt.trafficPercent}%\``,
    '',
    '## 一、灰度决策摘要',
    '',
    '| 字段 | 内容 |',
    '| --- | --- |',
    `| 所属项目 / 单元 | \`${receipt.projectName}\` / \`${receipt.unitId}\`（\`${receipt.publicRepo}\`） |`,
    `| 候选版本 | \`${receipt.targetVersion}\` |`,
    `| 稳定基线版本 | \`${receipt.baselineVersion}\` |`,
    `| 观察窗口与熔断阈值 | 观察至少 \`${receipt.guardrails.observationWindowMinutes}\` 分钟；错误率上限 \`${receipt.guardrails.maxErrorRateBp}\` Bp（超限自动回切 \`${receipt.guardrails.autoRollbackTarget}\`） |`,
    `| 签发责任人 | \`${receipt.actor}\` |`,
    `| 签发时间 | \`${receipt.createdAt}\` |`,
    `| 收据摘要（SHA-256） | \`${receipt.canaryDigest}\` |`,
    '',
    '## 二、受控渠道执行步骤（需经人工复核后独立执行）',
    '',
  ];
  for (const [idx, step] of receipt.channelSteps.entries()) {
    lines.push(`${idx + 1}. **${step.channelType}**（\`${step.identifier}\`）：${step.purpose}`);
    lines.push('   ```bash');
    lines.push(`   ${step.commandPreview}`);
    lines.push('   ```');
  }
  lines.push('');
  return lines.join('\n');
}

export function formatCanarySummary(result) {
  const modeLabel = result.executionMode === 'dry-run' ? '仅预览（dry-run，未写入磁盘）' : '本地离线灰度收据已生成（零远端写入）';
  const lines = [
    `金丝雀发布治理：${result.stage}（${result.status}）`,
    `执行模式：${modeLabel}`,
    `目标单元：${result.unitId}（候选：${result.targetVersion}，基线：${result.baselineVersion}，渠道：${result.channel}，流量：${result.trafficPercent}%）`,
    `签发责任人：${result.actor}`,
    `收据摘要：${result.canaryDigest}`,
  ];
  if (result.executionMode !== 'dry-run') {
    lines.push(`灰度收据：${result.receipt.artifacts.receiptFile}`);
    lines.push(`执行手册：${result.receipt.artifacts.runbookFile}`);
  }
  return lines.join('\n');
}

export async function planCanaryRollout(options = {}) {
  const {
    root = process.cwd(),
    unitId: requestedUnitId,
    stage = 'canary',
    channel: requestedChannel,
    trafficPercent: rawTrafficPercent,
    targetVersion,
    baselineVersion,
    observationWindowMinutes = 60,
    maxErrorRateBp = 50,
    reason,
    actor,
    outputDir: customOutputDir,
    dryRun = false,
    online = false,
    clock = () => new Date().toISOString(),
  } = options;

  if (online === true) {
    throw new ReleaseError(
      GATE_FAILED,
      'canary 灰度治理命令仅支持本地离线生成收据与放量清单（--offline / --dry-run），禁止未授权直接修改远端渠道标签。',
      {
        reason: 'CANARY_REMOTE_WRITE_DISABLED',
        nextSteps: [{
          code: 'USE_OFFLINE_CANARY',
          message: '移除 --online，使用默认的 --offline 或 --dry-run 生成灰度收据与执行手册',
          argv: ['release-skill', 'canary', '--offline'],
        }],
      },
    );
  }

  if (!CANARY_STAGES.includes(stage)) {
    throw new ReleaseError(
      CONFIG_INVALID,
      `不支持的金丝雀阶段 "${stage}"（仅支持 canary | promote | abort）`,
      { field: 'stage', supported: CANARY_STAGES },
    );
  }

  if (typeof actor !== 'string' || actor.trim().length === 0) {
    throw new ReleaseError(MISSING_PARAMETERS, 'canary 需要提供 --actor <签发责任人>', { field: 'actor' });
  }
  if (typeof targetVersion !== 'string' || !parseStrictSemver(targetVersion.trim())) {
    throw new ReleaseError(MISSING_PARAMETERS, 'canary 需要提供合法严格 SemVer 2.0.0 的 --target-version <候选版本>', { field: 'targetVersion' });
  }
  if (typeof baselineVersion !== 'string' || !parseStrictSemver(baselineVersion.trim())) {
    throw new ReleaseError(MISSING_PARAMETERS, 'canary 需要提供合法严格 SemVer 2.0.0 的 --baseline-version <稳定基线版本>', { field: 'baselineVersion' });
  }

  const cleanTarget = targetVersion.trim();
  const cleanBaseline = baselineVersion.trim();
  const cmp = compareStrictSemver(cleanBaseline, cleanTarget);
  if (cmp === 0) {
    throw new ReleaseError(
      CONFIG_INVALID,
      `金丝雀候选版本 (${cleanTarget}) 不能与稳定基线版本 (${cleanBaseline}) 相同`,
      { reason: 'CANARY_VERSIONS_IDENTICAL', targetVersion: cleanTarget, baselineVersion: cleanBaseline },
    );
  }
  if (cmp > 0) {
    throw new ReleaseError(
      CONFIG_INVALID,
      `稳定基线版本 (${cleanBaseline}) 必须严格低于金丝雀候选版本 (${cleanTarget})`,
      { reason: 'BASELINE_NOT_LOWER_THAN_TARGET', targetVersion: cleanTarget, baselineVersion: cleanBaseline },
    );
  }

  let effectiveChannel;
  let effectiveTraffic;
  if (stage === 'promote') {
    effectiveChannel = requestedChannel ? requestedChannel.trim() : 'latest';
    if (effectiveChannel !== 'latest') {
      throw new ReleaseError(
        CONFIG_INVALID,
        'promote 全量转正阶段的 --channel 必须为 latest',
        { reason: 'PROMOTE_REQUIRES_LATEST_CHANNEL', channel: effectiveChannel },
      );
    }
    effectiveTraffic = rawTrafficPercent !== undefined ? Number(rawTrafficPercent) : 100;
    if (!Number.isInteger(effectiveTraffic) || effectiveTraffic !== 100) {
      throw new ReleaseError(
        CONFIG_INVALID,
        'promote 全量转正阶段的流量比例必须为 100',
        { reason: 'PROMOTE_REQUIRES_FULL_TRAFFIC', trafficPercent: effectiveTraffic },
      );
    }
  } else if (stage === 'abort') {
    effectiveChannel = requestedChannel ? requestedChannel.trim() : 'canary';
    if (effectiveChannel !== 'canary' && effectiveChannel !== 'next') {
      throw new ReleaseError(
        CONFIG_INVALID,
        `abort 灰度中止阶段的 --channel 必须为被中止的灰度标签（canary 或 next），收到 "${effectiveChannel}"`,
        { reason: 'ABORT_INVALID_CHANNEL', channel: effectiveChannel },
      );
    }
    effectiveTraffic = rawTrafficPercent !== undefined ? Number(rawTrafficPercent) : 0;
    if (!Number.isInteger(effectiveTraffic) || effectiveTraffic !== 0) {
      throw new ReleaseError(
        CONFIG_INVALID,
        'abort 灰度中止阶段的流量比例必须为 0',
        { reason: 'ABORT_REQUIRES_ZERO_TRAFFIC', trafficPercent: rawTrafficPercent },
      );
    }
  } else {
    effectiveChannel = requestedChannel ? requestedChannel.trim() : 'canary';
    if (!CANARY_CHANNELS.includes(effectiveChannel)) {
      throw new ReleaseError(CONFIG_INVALID, `非法的灰度渠道 "${effectiveChannel}"（仅支持 canary | next | latest）`, { field: 'channel' });
    }
    if (effectiveChannel === 'latest') {
      throw new ReleaseError(
        GATE_FAILED,
        'canary 灰度观察阶段严禁将候选版本直接挂载至 latest 默认渠道；请使用 --channel canary 或 --channel next（全量转正请用 --stage promote）。',
        { reason: 'CANARY_LATEST_CHANNEL_FORBIDDEN', channel: effectiveChannel },
      );
    }
    effectiveTraffic = rawTrafficPercent !== undefined ? Number(rawTrafficPercent) : 10;
    if (!Number.isInteger(effectiveTraffic) || effectiveTraffic < 1 || effectiveTraffic > 99) {
      throw new ReleaseError(
        CONFIG_INVALID,
        'canary 灰度观察阶段的 --traffic-percent 必须为 1..99 之间的整数（全量转正请使用 --stage promote）',
        { reason: 'INVALID_CANARY_TRAFFIC_PERCENT', trafficPercent: rawTrafficPercent },
      );
    }
  }

  const winMin = Number(observationWindowMinutes);
  const errBp = Number(maxErrorRateBp);
  if (!Number.isInteger(winMin) || winMin < 5 || winMin > 10080) {
    throw new ReleaseError(CONFIG_INVALID, '--observation-window-minutes 须为 5..10080 之间的整数', { observationWindowMinutes });
  }
  if (!Number.isInteger(errBp) || errBp < 1 || errBp > 5000) {
    throw new ReleaseError(CONFIG_INVALID, '--max-error-rate-bp 须为 1..5000 之间的整数', { maxErrorRateBp });
  }

  const realRoot = await resolveSafeDirectoryRoot(root, 'root');
  const { config } = await loadProjectConfig({ root: realRoot });
  const unit = selectReleaseUnit(config, requestedUnitId, 'canary');

  const outDirAbs = await prepareSafeContainedOutputDir(
    realRoot,
    customOutputDir,
    `.release-skill/canary/${unit.id}-${cleanTarget}-${stage}`,
  );
  const outRel = toPosixRelative(realRoot, outDirAbs);
  const artifacts = {
    receiptFile: `${outRel}/canary-receipt.json`,
    runbookFile: `${outRel}/canary-runbook.md`,
  };

  const createdAt = new Date(Date.parse(clock())).toISOString();
  const channelSteps = buildCanaryChannelSteps(unit, {
    stage,
    channel: effectiveChannel,
    trafficPercent: effectiveTraffic,
    targetVersion: cleanTarget,
    baselineVersion: cleanBaseline,
  });

  const receiptBody = {
    schemaVersion: 1,
    kind: 'release-skill/canary-rollout-receipt',
    stage,
    executionMode: dryRun ? 'dry-run' : 'offline',
    remoteWritesPerformed: false,
    projectName: config.project.name,
    unitId: unit.id,
    publicRepo: unit.publicRepo,
    targetVersion: cleanTarget,
    baselineVersion: cleanBaseline,
    channel: effectiveChannel,
    trafficPercent: effectiveTraffic,
    ...(typeof reason === 'string' && reason.trim().length > 0 ? { reason: reason.trim() } : {}),
    guardrails: {
      observationWindowMinutes: winMin,
      maxErrorRateBp: errBp,
      autoRollbackTarget: cleanBaseline,
    },
    actor: actor.trim(),
    createdAt,
    channelSteps,
    artifacts,
  };

  const canaryDigest = sha256Hex(canonicalJson(receiptBody));
  const receipt = { ...receiptBody, canaryDigest };
  if (!validateCanaryReceipt(receipt)) {
    throw new ReleaseError(
      STRUCTURE_INVALID,
      `生成的金丝雀收据未通过 Schema 校验：${ajv.errorsText(validateCanaryReceipt.errors)}`,
      { errors: validateCanaryReceipt.errors },
    );
  }

  const runbookMarkdown = renderCanaryRunbookMarkdown(receipt);

  if (!dryRun) {
    const lock = await acquireProjectLock({ root: realRoot, command: 'canary', mode: 'exclusive' });
    try {
      await mkdir(outDirAbs, { recursive: true });
      await prepareSafeContainedOutputDir(realRoot, customOutputDir, `.release-skill/canary/${unit.id}-${cleanTarget}-${stage}`);
      await writeFileAtomic(outDirAbs, 'canary-receipt.json', `${JSON.stringify(receipt, null, 2)}\n`);
      await writeFileAtomic(outDirAbs, 'canary-runbook.md', runbookMarkdown);
    } finally {
      await lock.release();
    }
  }

  const result = {
    command: 'canary',
    status: dryRun ? 'DRY_RUN_READY' : 'CANARY_RECORDED',
    stage,
    executionMode: receipt.executionMode,
    remoteWritesPerformed: false,
    unitId: unit.id,
    targetVersion: cleanTarget,
    baselineVersion: cleanBaseline,
    channel: effectiveChannel,
    trafficPercent: effectiveTraffic,
    actor: receipt.actor,
    canaryDigest,
    receipt,
    runbookMarkdown,
  };
  result.summary = formatCanarySummary(result);
  return result;
}

function buildRollbackChannelAndConsumerSteps(unit, targetVersion, fallbackVersion, reason) {
  const channelSteps = [];
  const consumerActions = [];

  for (const dist of unit.distributions ?? []) {
    if (dist.type === 'npm') {
      const pkg = dist.package;
      channelSteps.push(
        {
          channelType: 'npm-dist-tag-repoint',
          identifier: pkg,
          commandPreview: `npm dist-tag add ${pkg}@${fallbackVersion} latest`,
          purpose: `立即将 npm 默认安装标签 latest 重指回已验证安全基线版本 ${fallbackVersion}。`,
        },
        {
          channelType: 'npm-deprecate-affected',
          identifier: pkg,
          commandPreview: `npm deprecate ${pkg}@${targetVersion} ${JSON.stringify(`Rolled back to ${fallbackVersion}: ${reason}`)}`,
          purpose: `对受影响版本 ${targetVersion} 写入弃用风险提示，引导增量安装者回退至 ${fallbackVersion}。`,
        },
      );
      consumerActions.push({
        type: 'npm',
        identifier: pkg,
        consumerAction: `npm install ${pkg}@${fallbackVersion}`,
      });
      continue;
    }

    const pluginId = dist.plugin ?? unit.id;
    const marketSuffix = dist.marketplace ? `@${dist.marketplace}` : '';
    const fullRef = `${pluginId}${marketSuffix}`;
    consumerActions.push({
      type: dist.type,
      identifier: fullRef,
      consumerAction: `卸载受影响版本 ${targetVersion}，固定重装安全回退版本 ${pluginId}@${fallbackVersion}`,
    });
  }

  const fallbackTag = unit.version?.tagTemplate?.replace('{version}', fallbackVersion) ?? `v${fallbackVersion}`;
  channelSteps.push({
    channelType: 'github-release-repoint',
    identifier: unit.publicRepo,
    commandPreview: `gh release edit ${fallbackTag} --repo ${unit.publicRepo} --latest`,
    purpose: `将 GitHub 仓库 ${unit.publicRepo} 的 Latest Release 指针恢复至安全标签 ${fallbackTag}（保留历史问题标签供审计，严禁强推删签）。`,
  });

  if (consumerActions.length === 0) {
    consumerActions.push({
      type: 'github-snapshot',
      identifier: unit.publicRepo,
      consumerAction: `将对 ${unit.publicRepo} 的版本引用切换回安全标签 ${fallbackTag}`,
    });
  }

  return { channelSteps, consumerActions };
}

function renderRollbackRunbookMarkdown({ receipt, deprecationNotice }) {
  const lines = [
    `# 一键版本回滚执行手册：${receipt.unitId}（${receipt.targetVersion} -> ${receipt.fallbackVersion}）`,
    '',
    `> **核心回滚指令**：立即将 \`${receipt.unitId}\` 从问题版本 \`${receipt.targetVersion}\` 回切至已验证安全版本 \`${receipt.fallbackVersion}\`（严重级别：\`${receipt.severity}\`）。`,
    '',
    '## 一、回滚决策与溯源核验摘要',
    '',
    '| 字段 | 内容 |',
    '| --- | --- |',
    `| 所属项目 / 单元 | \`${receipt.projectName}\` / \`${receipt.unitId}\`（\`${receipt.publicRepo}\`） |`,
    `| 问题版本（下线目标） | \`${receipt.targetVersion}\` |`,
    `| 安全回退基线版本 | \`${receipt.fallbackVersion}\` |`,
    `| 基线密码学溯源核验 | ${receipt.fallbackProvenanceVerified ? `已离线验签通过（\`sha256:${receipt.fallbackProvenanceDigestSha256}\`）` : '未提供基线溯源证明文件（按显式指定基线生成）'} |`,
    `| 签发责任人 | \`${receipt.actor}\` |`,
    `| 签发时间 | \`${receipt.createdAt}\` |`,
    `| 回滚收据摘要（SHA-256） | \`${receipt.rollbackDigest}\` |`,
    '',
    '## 二、回滚原因说明',
    '',
    receipt.reason,
    '',
    '## 三、发布端渠道一键切换命令（严禁删除历史 Git Tag 或覆盖构建）',
    '',
  ];

  for (const [idx, step] of receipt.channelSteps.entries()) {
    lines.push(`${idx + 1}. **${step.channelType}**（\`${step.identifier}\`）：${step.purpose}`);
    lines.push('   ```bash');
    lines.push(`   ${step.commandPreview}`);
    lines.push('   ```');
  }

  lines.push(
    '',
    '## 四、消费端回退动作与市场提案投递',
    '',
  );
  for (const item of receipt.consumerActions) {
    lines.push(`- **${item.type}**（\`${item.identifier ?? receipt.unitId}\`）：${item.consumerAction}`);
  }
  lines.push(
    '',
    `- 市场回滚通告：${deprecationNotice}`,
    `- 下游 \`skill-family-hub\` 降级提案文件：\`${receipt.artifacts.hubProposalFile}\` -> 投递目标路径 \`${receipt.artifacts.hubProposalTargetPath}\``,
    '',
  );
  return lines.join('\n');
}

export function formatRollbackSummary(result) {
  const modeLabel = result.executionMode === 'dry-run' ? '仅预览（dry-run，未写入磁盘）' : '本地离线回滚收据与市场提案已生成（零远端写入）';
  const lines = [
    `版本一键回滚治理：${result.unitId} ${result.targetVersion} -> ${result.fallbackVersion}（${result.status}）`,
    `执行模式：${modeLabel}`,
    `严重级别：${result.severity} ｜ 签发责任人：${result.actor}`,
    `基线溯源验签：${result.receipt.fallbackProvenanceVerified ? 'PASS' : 'SKIPPED'}`,
    `回滚收据摘要：${result.rollbackDigest}`,
  ];
  if (result.executionMode !== 'dry-run') {
    lines.push(`回滚收据：${result.receipt.artifacts.receiptFile}`);
    lines.push(`回滚手册：${result.receipt.artifacts.runbookFile}`);
    lines.push(`市场提案：${result.receipt.artifacts.hubProposalFile} -> ${result.receipt.artifacts.hubProposalTargetPath}`);
  }
  return lines.join('\n');
}

export async function executeVersionRollback(options = {}) {
  const {
    root = process.cwd(),
    unitId: requestedUnitId,
    targetVersion,
    fallbackVersion,
    severity = 'high',
    reason,
    actor,
    fallbackProvenancePath,
    expectedKeyFingerprint,
    outputDir: customOutputDir,
    dryRun = false,
    online = false,
    clock = () => new Date().toISOString(),
  } = options;

  if (online === true) {
    throw new ReleaseError(
      GATE_FAILED,
      'rollback 版本回滚命令仅支持本地离线生成回滚收据、操作手册与市场提案（--offline / --dry-run），禁止未授权直接修改远端注册表。',
      {
        reason: 'ROLLBACK_REMOTE_WRITE_DISABLED',
        nextSteps: [{
          code: 'USE_OFFLINE_ROLLBACK',
          message: '移除 --online，使用默认的 --offline 或 --dry-run 生成回滚套件',
          argv: ['release-skill', 'rollback', '--offline'],
        }],
      },
    );
  }

  if (typeof actor !== 'string' || actor.trim().length === 0) {
    throw new ReleaseError(MISSING_PARAMETERS, 'rollback 需要提供 --actor <签发责任人>', { field: 'actor' });
  }
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new ReleaseError(MISSING_PARAMETERS, 'rollback 需要提供 --reason <回滚原因>', { field: 'reason' });
  }
  if (typeof severity !== 'string' || !LIFECYCLE_SEVERITIES.includes(severity)) {
    throw new ReleaseError(
      MISSING_PARAMETERS,
      'rollback 需要提供合法的 --severity <critical|high|medium|low>',
      { field: 'severity', supported: LIFECYCLE_SEVERITIES },
    );
  }
  if (typeof targetVersion !== 'string' || !parseStrictSemver(targetVersion.trim())) {
    throw new ReleaseError(MISSING_PARAMETERS, 'rollback 需要提供合法严格 SemVer 2.0.0 的 --target-version <问题版本>', { field: 'targetVersion' });
  }
  if (typeof fallbackVersion !== 'string' || !parseStrictSemver(fallbackVersion.trim())) {
    throw new ReleaseError(MISSING_PARAMETERS, 'rollback 需要提供合法严格 SemVer 2.0.0 的 --fallback-version <安全回退版本>', { field: 'fallbackVersion' });
  }

  const cleanTarget = targetVersion.trim();
  const cleanFallback = fallbackVersion.trim();
  const cmp = compareStrictSemver(cleanFallback, cleanTarget);
  if (cmp === 0) {
    throw new ReleaseError(
      CONFIG_INVALID,
      `回滚目标安全版本 (${cleanFallback}) 不能与待回滚的问题版本 (${cleanTarget}) 相同`,
      { reason: 'ROLLBACK_VERSIONS_IDENTICAL', targetVersion: cleanTarget, fallbackVersion: cleanFallback },
    );
  }
  if (cmp > 0) {
    throw new ReleaseError(
      CONFIG_INVALID,
      `安全回退版本 --fallback-version (${cleanFallback}) 必须严格低于待回滚的问题版本 (${cleanTarget})`,
      { reason: 'FALLBACK_NOT_LOWER_THAN_TARGET', targetVersion: cleanTarget, fallbackVersion: cleanFallback },
    );
  }

  const realRoot = await resolveSafeDirectoryRoot(root, 'root');
  const { config } = await loadProjectConfig({ root: realRoot });
  const unit = selectReleaseUnit(config, requestedUnitId, 'rollback');

  let fallbackProvenanceVerified = false;
  let fallbackProvenanceDigestSha256 = null;
  if (typeof fallbackProvenancePath === 'string' && fallbackProvenancePath.trim().length > 0) {
    const { verifyReleaseProvenance } = await import('./provenance.mjs');
    const verified = await verifyReleaseProvenance({
      attestationPath: resolve(realRoot, fallbackProvenancePath.trim()),
      unitId: unit.id,
      targetVersion: cleanFallback,
      expectedKeyFingerprint,
      online: false,
    });
    fallbackProvenanceVerified = verified.status === 'VERIFIED';
    fallbackProvenanceDigestSha256 = verified.statementDigestSha256;
  }

  const outDirAbs = await prepareSafeContainedOutputDir(
    realRoot,
    customOutputDir,
    `.release-skill/rollbacks/${unit.id}-${cleanTarget}-to-${cleanFallback}`,
  );
  const outRel = toPosixRelative(realRoot, outDirAbs);
  const hubProposalTargetPath = lifecycleProposalFileName(unit.id, cleanTarget, 'deprecate');
  const artifacts = {
    receiptFile: `${outRel}/rollback-receipt.json`,
    runbookFile: `${outRel}/rollback-runbook.md`,
    hubProposalFile: `${outRel}/hub-proposal.json`,
    hubProposalTargetPath,
  };

  const createdAt = new Date(Date.parse(clock())).toISOString();
  const deprecationNotice = `${unit.id}@${cleanTarget} 已触发紧急版本回滚（${reason.trim()}），默认推荐版本切回 ${cleanFallback}。`;
  const hubProposal = buildLifecycleProposalDocument({
    unitId: unit.id,
    version: cleanTarget,
    lifecycleAction: 'deprecate',
    fallbackVersion: cleanFallback,
    deprecationNotice,
    issuedAt: createdAt,
    changeSummary: `rollback ${unit.id} ${cleanTarget} -> ${cleanFallback}: ${reason.trim()}`,
  });
  if (!validateHubProposal(hubProposal)) {
    throw new ReleaseError(
      STRUCTURE_INVALID,
      `生成的 Hub 回滚提案未通过 Schema 校验：${ajv.errorsText(validateHubProposal.errors)}`,
      { errors: validateHubProposal.errors },
    );
  }

  const { channelSteps, consumerActions } = buildRollbackChannelAndConsumerSteps(
    unit,
    cleanTarget,
    cleanFallback,
    reason.trim(),
  );

  const receiptBody = {
    schemaVersion: 1,
    kind: 'release-skill/version-rollback-receipt',
    executionMode: dryRun ? 'dry-run' : 'offline',
    remoteWritesPerformed: false,
    projectName: config.project.name,
    unitId: unit.id,
    publicRepo: unit.publicRepo,
    targetVersion: cleanTarget,
    fallbackVersion: cleanFallback,
    severity,
    reason: reason.trim(),
    actor: actor.trim(),
    createdAt,
    fallbackProvenanceVerified,
    fallbackProvenanceDigestSha256,
    channelSteps,
    consumerActions,
    artifacts,
  };

  const rollbackDigest = sha256Hex(canonicalJson(receiptBody));
  const receipt = { ...receiptBody, rollbackDigest };
  if (!validateRollbackReceipt(receipt)) {
    throw new ReleaseError(
      STRUCTURE_INVALID,
      `生成的版本回滚收据未通过 Schema 校验：${ajv.errorsText(validateRollbackReceipt.errors)}`,
      { errors: validateRollbackReceipt.errors },
    );
  }

  const runbookMarkdown = renderRollbackRunbookMarkdown({ receipt, deprecationNotice });

  if (!dryRun) {
    const lock = await acquireProjectLock({ root: realRoot, command: 'rollback', mode: 'exclusive' });
    try {
      await mkdir(outDirAbs, { recursive: true });
      await prepareSafeContainedOutputDir(realRoot, customOutputDir, `.release-skill/rollbacks/${unit.id}-${cleanTarget}-to-${cleanFallback}`);
      await writeFileAtomic(outDirAbs, 'rollback-receipt.json', `${JSON.stringify(receipt, null, 2)}\n`);
      await writeFileAtomic(outDirAbs, 'rollback-runbook.md', runbookMarkdown);
      await writeFileAtomic(outDirAbs, 'hub-proposal.json', `${JSON.stringify(hubProposal, null, 2)}\n`);
    } finally {
      await lock.release();
    }
  }

  const result = {
    command: 'rollback',
    status: dryRun ? 'DRY_RUN_READY' : 'ROLLBACK_RECORDED',
    executionMode: receipt.executionMode,
    remoteWritesPerformed: false,
    unitId: unit.id,
    targetVersion: cleanTarget,
    fallbackVersion: cleanFallback,
    severity,
    actor: receipt.actor,
    rollbackDigest,
    receipt,
    hubProposal,
    runbookMarkdown,
  };
  result.summary = formatRollbackSummary(result);
  return result;
}
