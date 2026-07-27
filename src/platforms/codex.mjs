/**
 * Codex platform human-attestation fallback strategy.
 *
 * Codex is primarily an automatable platform (structured-cli), but its
 * degradationPolicy is 'human-attestation-with-fallback': when the CLI
 * interface, environment, or transport is unavailable, the system falls back
 * to a human attestation path. Explicit mismatches (identity, version,
 * payload, marketplace entry) are hard failures and never trigger fallback.
 *
 * 统一人工结果：收据仅需 platform, version, planDigest,
 * result(passed|failed), actor, confirmedAt 和可选 note。
 * 不再要求 consumer, plugin, conclusion, confirmedBy、隔离 HOME、
 * 安装路径证明、载荷摘要手填或 24 小时过期。
 *
 * @module platforms/codex
 */

import { readFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';

import {
  ActionType,
  ActionStatus,
  createResult,
  resolveTimeoutMs,
  SAFE_ID_RE,
  writeEvidenceAtomic,
} from '../adapters/contract.mjs';
import { canonicalJson } from '../core/digest.mjs';

/** 64-char lowercase hex plan/payload digest pattern. */
const HEX_DIGEST_RE = /^[a-f0-9]{64}$/;

/**
 * Normalize a plan back to its frozen form for digest comparison.
 * Only lifecycle status fields are reset: the top-level `status` returns to
 * "PREPARED" and every `externalActions[].status` returns to "PENDING".
 *
 * @param {object} plan
 * @returns {object} the lifecycle-normalized plan
 */
function normalizePlanForDigest(plan) {
  const normalized = { ...plan, status: 'PREPARED' };
  if (Array.isArray(plan.externalActions)) {
    normalized.externalActions = plan.externalActions.map((action) => (
      action && typeof action === 'object' && !Array.isArray(action)
        ? { ...action, status: 'PENDING' }
        : action
    ));
  }
  return normalized;
}

/** Structured manual-install requirement written by codex fallback execute. */
export const CODEX_REQUIREMENT_FILE = 'release-skill-codex-manual-install.json';
/** Structured human attestation consumed by codex fallback observe. */
export const CODEX_ATTESTATION_FILE = 'release-skill-codex-attestation.json';

/**
 * Resolve and verify the genuine frozen plan digest from the adapter context,
 * for the codex human-attestation fallback path.
 *
 * @param {object} context - adapter context (must carry the frozen `plan`).
 * @returns {Promise<string>} the verified frozen plan digest.
 * @throws {Error} when the plan is absent or the digest does not match.
 */
export async function resolveCodexBoundPlanDigest(context) {
  const plan = context?.plan;
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new Error('context.plan is required to bind the codex plan digest');
  }
  const carried = plan.digest;
  if (typeof carried !== 'string' || !HEX_DIGEST_RE.test(carried)) {
    throw new Error('context.plan.digest must be a 64-char lowercase hex frozen plan digest');
  }
  // Lazy import keeps the static bundle graph acyclic.
  const { computePlanDigest } = await import('../core/plan.mjs');
  const normalized = normalizePlanForDigest(plan);
  if (computePlanDigest(normalized) !== carried) {
    throw new Error('context.plan.digest does not match the normalized frozen plan (a non-lifecycle field was tampered)');
  }
  return carried;
}

/**
 * Authoritative, cross-run attestation directory for a codex fallback install.
 *
 * Lives at a stable root-fixed location keyed by the verified frozen plan
 * digest and plugin id:
 *   <root>/.release-skill/codex-attestations/<planDigest>/<plugin>/
 *
 * @param {object} context - adapter context (needs `root`).
 * @param {string} planDigest - verified frozen plan digest (64-hex).
 * @param {string} plugin - plugin id (SAFE_ID_RE).
 * @returns {string} absolute authority directory.
 */
export function codexAuthorityDir(context, planDigest, plugin) {
  if (!context?.root) {
    throw new Error('context.root is required for the codex attestation authority');
  }
  if (!HEX_DIGEST_RE.test(planDigest)) {
    throw new Error('codex attestation authority requires a 64-hex plan digest');
  }
  if (!SAFE_ID_RE.test(plugin)) {
    throw new Error(`codex attestation authority requires a safe plugin id: "${plugin}"`);
  }
  const base = resolve(context.root, '.release-skill', 'codex-attestations');
  const dir = resolve(base, planDigest, plugin);
  const rel = relative(base, dir);
  const sep = process.platform === 'win32' ? '\\' : '/';
  if (
    rel === '' || rel === '..' || isAbsolute(rel) || rel.startsWith(`..${sep}`)
    || rel.split(sep).some((segment) => segment === '..' || segment === '')
  ) {
    throw new Error('codex attestation authority path escapes its base');
  }
  return dir;
}

/**
 * 统一人工结果验证：验证 codex 人工结果是否匹配冻结计划。
 *
 * 统一后的结果只需：
 * - 必填：platform, version, planDigest, result(passed|failed), actor, confirmedAt
 * - 可选：note
 *
 * 绑定验证（任何不匹配都失败）：
 * - planDigest 绑定到真正的冻结计划摘要（boundPlanDigest）
 * - version 静态一致性检查
 * - result 只接受 passed 或 failed
 *
 * @param {object} attestation - 解析后的人工结果 JSON。
 * @param {object} action - 展开的 codex 动作（顶层字段）。
 * @param {string} isoNow - 当前 ISO 时间戳（保留签名兼容，不再用于过期检查）。
 * @param {string} boundPlanDigest - 验证过的冻结计划摘要。
 * @returns {{valid:boolean, error:string|null}}
 */
export function validateCodexAttestation(attestation, action, isoNow, boundPlanDigest) {
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) {
    return { valid: false, error: 'codex attestation is not an object' };
  }
  // 统一必填字段
  const requiredStrings = ['platform', 'version', 'planDigest', 'result', 'actor', 'confirmedAt'];
  for (const field of requiredStrings) {
    if (typeof attestation[field] !== 'string' || attestation[field].length === 0) {
      return { valid: false, error: `codex attestation missing required field "${field}"` };
    }
  }
  if (attestation.platform !== 'codex') {
    return { valid: false, error: `codex attestation platform "${attestation.platform}" must be "codex"` };
  }
  // result 只接受 passed 或 failed
  if (attestation.result !== 'passed' && attestation.result !== 'failed') {
    return { valid: false, error: `codex attestation result "${attestation.result}" must be "passed" or "failed"` };
  }
  // planDigest 绑定验证
  if (!HEX_DIGEST_RE.test(attestation.planDigest)) {
    return { valid: false, error: 'codex attestation planDigest must be a 64-char lowercase hex digest' };
  }
  if (attestation.planDigest !== boundPlanDigest) {
    return { valid: false, error: 'codex attestation planDigest does not match the frozen plan digest' };
  }
  // version 静态一致性检查
  if (attestation.version !== action.version) {
    return { valid: false, error: `codex attestation version "${attestation.version}" does not match action version "${action.version}"` };
  }
  // confirmedAt 必须是有效的时间戳
  const confirmedMs = Date.parse(attestation.confirmedAt);
  if (!Number.isFinite(confirmedMs)) {
    return { valid: false, error: 'codex attestation confirmedAt must be a valid ISO timestamp' };
  }
  // 可选字段 note 如果存在必须是字符串
  if (attestation.note !== undefined && typeof attestation.note !== 'string') {
    return { valid: false, error: 'codex attestation note must be a string when present' };
  }
  return { valid: true, error: null };
}

/**
 * Read the authoritative Codex plugin manifest from a verified plugin root.
 *
 * Single candidate `.codex-plugin/plugin.json`. Returns the parsed manifest
 * and the root-relative manifest path. Throws when the manifest is absent,
 * not valid JSON, or not an object.
 *
 * @param {string} pluginRootReal - realpath of the verified plugin root.
 * @returns {Promise<{manifest:object, manifestRelative:string}>}
 */
export async function readCodexManifest(pluginRootReal) {
  const manifestRelative = join('.codex-plugin', 'plugin.json');
  const manifestPath = resolve(pluginRootReal, manifestRelative);
  let content;
  try {
    content = await readFile(manifestPath, 'utf8');
  } catch {
    throw new Error(`no codex plugin manifest found (expected ${manifestRelative})`);
  }
  let manifest;
  try {
    manifest = JSON.parse(content);
  } catch {
    throw new Error(`codex plugin manifest ${manifestRelative} is not valid JSON`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`codex plugin manifest ${manifestRelative} is not an object`);
  }
  return { manifest, manifestRelative };
}

/**
 * Codex human-attestation fallback: when the CLI interface, environment, or
 * transport is unavailable, emit a manual-install requirement bound to the
 * real frozen plan digest + identity. Explicit mismatches (identity, version,
 * payload, marketplace entry) are hard failures and never reach this path.
 *
 * @param {object} action - expanded codex action (validated params already).
 * @param {object} context - adapter context (root, runDir, plan).
 * @returns {Promise<import('../adapters/contract.mjs').AdapterResult>}
 */
export async function executeCodexManualRequirement(action, context) {
  const actionType = ActionType.CODEX_MARKETPLACE_INSTALL;

  // Bind to the REAL frozen plan digest via strict normalized recompute.
  let planDigest;
  try {
    planDigest = await resolveCodexBoundPlanDigest(context);
  } catch (planErr) {
    return createResult({
      actionType,
      status: ActionStatus.EXECUTE_FAILED,
      error: `cannot bind codex requirement to the frozen plan: ${planErr.message}`,
    });
  }

  // Validate the frozen timeout.
  try {
    resolveTimeoutMs(action);
  } catch (timeoutErr) {
    return createResult({
      actionType,
      status: ActionStatus.EXECUTE_FAILED,
      error: timeoutErr.message,
    });
  }

  const ref = action.ref ?? `v${action.version}`;

  // Stable, plan-digest-keyed authority dir.
  let attestationDir;
  try {
    attestationDir = codexAuthorityDir(context, planDigest, action.plugin);
  } catch (dirErr) {
    return createResult({
      actionType,
      status: ActionStatus.EXECUTE_FAILED,
      error: dirErr.message,
    });
  }

  const instructions = [
    `Codex CLI 不可用（接口、环境或传输问题），降级为人工结果路径。`,
    `1) publish 完成所有远端写入后进入 PUBLISHED 状态（自动化 Git 分支/标签、npm 和 GitHub Release 写入已完成）。此 codex 检查点标记为需要人工安装。`,
    `2) 手动安装插件 "${action.plugin}" 版本 ${action.version}（ref: ${ref}）。`,
    `3) 将人工结果 JSON 写入: ${attestationDir}/${CODEX_ATTESTATION_FILE}`,
    `   必填字段: platform="codex", version, planDigest（冻结计划摘要）, result("passed" 或 "failed"), actor（确认人）, confirmedAt（ISO 8601 时间戳）`,
    `   可选字段: note（备注）`,
    `4) 运行 release-skill verify（从同一个计划摘要索引的权威目录读取结果，成功后 -> VERIFIED）。`,
  ];

  // 统一 requirement 结构
  const requirement = {
    kind: 'codex-manual-install-requirement',
    platform: 'codex',
    plugin: action.plugin,
    version: action.version,
    repo: action.repo,
    ref,
    entrySkill: action.entrySkill,
    planDigest,
    attestationDir,
    attestationFile: CODEX_ATTESTATION_FILE,
    attestationTemplate: {
      platform: 'codex',
      version: action.version,
      planDigest,
      result: '<"passed" or "failed">',
      actor: '<person who confirmed the install>',
      confirmedAt: '<ISO 8601 timestamp>',
      note: '<optional note>',
    },
    instructions,
  };

  // Ensure the authority directory exists.
  const { mkdir } = await import('node:fs/promises');
  try {
    await mkdir(attestationDir, { recursive: true, mode: 0o700 });
  } catch (mkdirErr) {
    if (mkdirErr?.code !== 'EEXIST') {
      return createResult({
        actionType,
        status: ActionStatus.EXECUTE_FAILED,
        error: `cannot create codex attestation directory: ${mkdirErr.message}`,
      });
    }
  }

  // Idempotent requirement write.
  const requirementPath = resolve(attestationDir, CODEX_REQUIREMENT_FILE);
  let existing = null;
  let requirementMissing = false;
  try {
    const existingRaw = await readFile(requirementPath, 'utf8');
    try {
      existing = JSON.parse(existingRaw);
    } catch (parseErr) {
      return createResult({
        actionType,
        status: ActionStatus.EXECUTE_FAILED,
        error: `existing codex manual-install requirement is invalid JSON; refusing to overwrite: ${parseErr.message}`,
      });
    }
  } catch (readErr) {
    if (readErr?.code === 'ENOENT') {
      requirementMissing = true;
    } else {
      return createResult({
        actionType,
        status: ActionStatus.EXECUTE_FAILED,
        error: `existing codex manual-install requirement cannot be read; refusing to overwrite: ${readErr.message}`,
      });
    }
  }
  if (!requirementMissing) {
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      return createResult({
        actionType,
        status: ActionStatus.EXECUTE_FAILED,
        error: 'existing codex manual-install requirement is not an object; refusing to overwrite',
      });
    }
    const { createdAt: _existingCreatedAt, ...existingBody } = existing;
    if (canonicalJson(existingBody) !== canonicalJson(requirement)) {
      return createResult({
        actionType,
        status: ActionStatus.EXECUTE_FAILED,
        error: 'existing codex manual-install requirement conflicts with the current frozen action; refusing to overwrite',
      });
    }
  } else {
    await writeEvidenceAtomic(requirementPath, { ...requirement, createdAt: new Date().toISOString() });
  }

  return createResult({
    actionType,
    status: ActionStatus.EXECUTED,
    observation: {
      installed: false,
      manualInstallRequired: true,
      platform: 'codex',
      plugin: action.plugin,
      version: action.version,
      ref,
      planDigest,
      attestationDir,
      instructions,
    },
  });
}
