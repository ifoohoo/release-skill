/**
 * Kimi Code platform protocol (T2.2 step 2).
 *
 * Kimi Code protocol-gap modeling (BLOCKER-1 / MAJOR-1 / MAJOR-4 / MINOR-1).
 *
 * Kimi Code has NO scriptable plugin install/list CLI: plugin management is
 * interactive-only (`/plugins install <path-or-url>` in the TUI). There is no
 * `kimi plugins ...` subcommand and no `--json` output protocol. Therefore the
 * kimi-marketplace-install action is modeled as a protocol capability gap:
 *
 *   - execute NEVER execs a kimi CLI. It emits an actionable, version-pinned
 *     manual-install requirement bound to the frozen plan digest + identity.
 *   - observe consumes a structured human attestation (written after the
 *     operator runs the interactive install) plus read-only verification of
 *     the installed managed copy. Missing/expired/mismatched/escaping proof
 *     fails closed, so a kimi unit can never reach VERIFIED without it.
 *
 * 统一人工结果：收据仅需 platform, version, planDigest,
 * result(passed|failed), actor, confirmedAt 和可选 note。
 * 不再要求 consumer, plugin, conclusion, confirmedBy、隔离 HOME、
 * 安装路径证明、载荷摘要手填或 24 小时过期。
 *
 * This module is the kimi half of the platform registry's strategy table
 * (registry.mjs references these functions); the plugin-marketplace adapter
 * consumes the attestation path from here. The shared adapter primitives
 * (safe-id pattern, frozen-timeout validation, atomic evidence writes) live
 * in adapters/contract.mjs.
 *
 * T2.2 step 2 moved this closure verbatim out of plugin-marketplace.mjs:
 * every error message, field name, and file layout is byte-for-byte the
 * legacy behaviour (frozen by platform-golden.test.mjs and the BLOCKER-1
 * suite).
 *
 * @module platforms/kimi
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
import { computePlanDigest } from '../core/plan.mjs';
import { canonicalJson } from '../core/digest.mjs';

/** Structured manual-install requirement written by kimi execute. */
export const KIMI_REQUIREMENT_FILE = 'release-skill-kimi-manual-install.json';
/** Structured human attestation consumed by kimi observe. */
export const KIMI_ATTESTATION_FILE = 'release-skill-kimi-attestation.json';

/** 64-char lowercase hex plan/payload digest pattern. */
export const HEX_DIGEST_RE = /^[a-f0-9]{64}$/;

/**
 * Ordered authoritative kimi plugin manifest candidates.
 * `kimi.plugin.json` at the plugin root takes priority over
 * `.kimi-plugin/plugin.json` (official precedence). Single source for both
 * the readManifest strategy and the registry's manifestPaths descriptor.
 */
export const KIMI_MANIFEST_CANDIDATES = Object.freeze([
  'kimi.plugin.json',
  join('.kimi-plugin', 'plugin.json'),
]);

/**
 * Normalize a plan back to its frozen form for digest comparison.
 *
 * Only lifecycle status fields are reset: the top-level `status` returns to
 * "PREPARED" and every `externalActions[].status` returns to "PENDING". Every
 * other field is preserved verbatim. publish/reconcile/verify mutate exactly
 * these status fields in memory as the saga progresses, so normalizing them
 * recovers the frozen digest while leaving all security-relevant fields
 * (baseline, units, action parameters/expected, production config, …) intact.
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

/**
 * Resolve and verify the genuine frozen plan digest from the adapter context.
 *
 * The kimi manual-install requirement and attestation bind to the REAL frozen
 * plan digest (`context.plan.digest`) — never to `action.manifestDigest`, which
 * is only the snapshot payload digest.
 *
 * Integrity model: the carried `context.plan.digest` is recomputed from the
 * lifecycle-normalized plan and must match EXACTLY. Status transitions
 * (top-level status, per-action checkpoint status) are normalized away, but any
 * other field tamper changes the recomputed digest and fails closed. This
 * proves the attestation is bound to the genuine frozen plan, not to a spoofed
 * or mutated stand-in.
 *
 * @param {object} context - adapter context (must carry the frozen `plan`).
 * @returns {string} the verified frozen plan digest.
 * @throws {Error} when the plan is absent or the digest does not match.
 */
export function resolveBoundPlanDigest(context) {
  const plan = context?.plan;
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new Error('context.plan is required to bind the kimi plan digest');
  }
  const carried = plan.digest;
  if (typeof carried !== 'string' || !HEX_DIGEST_RE.test(carried)) {
    throw new Error('context.plan.digest must be a 64-char lowercase hex frozen plan digest');
  }
  const normalized = normalizePlanForDigest(plan);
  if (computePlanDigest(normalized) !== carried) {
    throw new Error('context.plan.digest does not match the normalized frozen plan (a non-lifecycle field was tampered)');
  }
  return carried;
}

/**
 * Authoritative, cross-run attestation directory for a kimi install.
 *
 * Lives at a stable root-fixed location keyed by the verified frozen plan
 * digest and plugin id:
 *   <root>/.release-skill/kimi-attestations/<planDigest>/<plugin>/
 *
 * This survives the publish -> manual install -> reconcile -> verify chain,
 * where each command otherwise uses a fresh runDir (an attestation written to a
 * publish runDir would be invisible to reconcile/verify). Both the requirement
 * and the human attestation live here. The segments are pre-validated (planDigest
 * is 64-hex, plugin matches SAFE_ID_RE) and the resolved path is contained
 * within the authority base, so no path escape is possible.
 *
 * @param {object} context - adapter context (needs `root`).
 * @param {string} planDigest - verified frozen plan digest (64-hex).
 * @param {string} plugin - plugin id (SAFE_ID_RE).
 * @returns {string} absolute authority directory.
 */
export function kimiAuthorityDir(context, planDigest, plugin) {
  if (!context?.root) {
    throw new Error('context.root is required for the kimi attestation authority');
  }
  if (!HEX_DIGEST_RE.test(planDigest)) {
    throw new Error('kimi attestation authority requires a 64-hex plan digest');
  }
  if (!SAFE_ID_RE.test(plugin)) {
    throw new Error(`kimi attestation authority requires a safe plugin id: "${plugin}"`);
  }
  const base = resolve(context.root, '.release-skill', 'kimi-attestations');
  const dir = resolve(base, planDigest, plugin);
  const rel = relative(base, dir);
  const sep = process.platform === 'win32' ? '\\' : '/';
  if (
    rel === '' || rel === '..' || isAbsolute(rel) || rel.startsWith(`..${sep}`)
    || rel.split(sep).some((segment) => segment === '..' || segment === '')
  ) {
    throw new Error('kimi attestation authority path escapes its base');
  }
  return dir;
}

/**
 * Build the official, version-pinned install URL for a frozen Git ref.
 *
 * Prefers the GitHub release-tag URL (`/releases/tag/<ref>`), which pins the
 * exact published ref; `/tree/<ref>` is the documented equivalent. A bare
 * repository URL is NOT acceptable because it installs the latest release (or
 * default branch), which need not equal the frozen version.
 *
 * @param {string} repo - owner/repo
 * @param {string} ref - frozen Git ref (tag)
 * @returns {string}
 */
function buildKimiInstallUrl(repo, ref) {
  return `https://github.com/${repo}/releases/tag/${ref}`;
}

/**
 * 统一人工安装说明：面向 Kimi Code 的人工结果流程。
 *
 * @param {{installUrl:string, plugin:string, version:string, ref:string, attestationDir:string, requiresInstalledClosure:boolean, managedRoot:string|null}} p
 * @returns {string[]}
 */
function buildKimiManualInstructions({
  installUrl,
  plugin,
  version,
  ref,
  attestationDir,
  requiresInstalledClosure,
  managedRoot,
}) {
  return [
    `Kimi Code 没有可脚本化的插件安装命令行工具；安装是手动交互步骤。`,
    `1) publish 完成所有远端写入后进入 PUBLISHED 状态（自动化 Git 分支/标签、npm 和 GitHub Release 写入已完成）。此 kimi 检查点标记为需要人工安装。`,
    `2) ${requiresInstalledClosure ? `以 KIMI_CODE_HOME="${resolve(managedRoot, '..', '..')}" 启动 Kimi Code，然后` : '在 Kimi Code 中'}运行: /plugins install ${installUrl}（锁定到冻结 ref "${ref}"，版本 ${version}）。确认插件 "${plugin}" 的信任提示，然后运行 /plugins reload（或 /new）。`,
    `3) 将人工结果 JSON 写入: ${attestationDir}/${KIMI_ATTESTATION_FILE}`,
    `   必填字段: platform="kimi", version, planDigest（冻结计划摘要）, result("passed" 或 "failed"), actor（确认人）, confirmedAt（ISO 8601 时间戳）${requiresInstalledClosure ? '，installPath（实际安装后的插件目录，必须位于该证明目录的 kimi-home/plugins/managed/ 内）' : ''}`,
    `   可选字段: note（备注）`,
    `4) 运行 release-skill reconcile（对账远端状态并跳过已完成步骤），然后 release-skill verify（从同一个计划摘要索引的权威目录读取结果，成功后 -> VERIFIED）。`,
  ];
}

/**
 * Read the authoritative Kimi plugin manifest from a verified plugin root.
 *
 * `kimi.plugin.json` at the root takes priority over `.kimi-plugin/plugin.json`
 * when both exist (official precedence). Returns the parsed manifest and the
 * root-relative manifest path. Throws when no valid manifest is present.
 *
 * @param {string} pluginRootReal - realpath of the verified plugin root.
 * @returns {Promise<{manifest:object, manifestRelative:string}>}
 */
export async function readKimiManifest(pluginRootReal) {
  for (const manifestRelative of KIMI_MANIFEST_CANDIDATES) {
    const manifestPath = resolve(pluginRootReal, manifestRelative);
    let content;
    try {
      content = await readFile(manifestPath, 'utf8');
    } catch {
      continue;
    }
    let manifest;
    try {
      manifest = JSON.parse(content);
    } catch {
      throw new Error(`kimi plugin manifest ${manifestRelative} is not valid JSON`);
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new Error(`kimi plugin manifest ${manifestRelative} is not an object`);
    }
    return { manifest, manifestRelative };
  }
  throw new Error('no kimi plugin manifest found (expected kimi.plugin.json or .kimi-plugin/plugin.json)');
}

/**
 * 统一人工结果验证：验证 kimi 人工结果是否匹配冻结计划。
 *
 * 统一后的结果只需：
 * - 必填：platform, version, planDigest, result(passed|failed), actor, confirmedAt
 * - 可选：note
 *
 * 旧格式兼容（0.2.3 及更早）：
 * - consumer → platform (必须是 'kimi')
 * - attestedBy → actor
 * - attestedAt → confirmedAt
 * - payloadDigest → 载荷绑定验证（如果存在）
 *
 * 绑定验证（任何不匹配都失败）：
 * - planDigest 绑定到真正的冻结计划摘要（boundPlanDigest）
 * - version 静态一致性检查
 * - result 只接受 passed 或 failed
 *
 * @param {object} attestation - 解析后的人工结果 JSON。
 * @param {object} action - 展开的 kimi 动作（顶层字段）。
 * @param {string} isoNow - 当前 ISO 时间戳（保留签名兼容，不再用于过期检查）。
 * @param {string} boundPlanDigest - 验证过的冻结计划摘要。
 * @returns {{valid:boolean, error:string|null, normalized:object|null}}
 */
export function validateKimiAttestation(attestation, action, isoNow, boundPlanDigest) {
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) {
    return { valid: false, error: 'kimi attestation is not an object', normalized: null };
  }

  // 旧格式归一化：将旧字段映射到新字段
  const normalized = { ...attestation };

  // 旧格式识别：完整旧标识组（consumer, attestedBy, attestedAt）全部存在，
  // 且新格式字段组（result, actor, confirmedAt）未混入。
  // 不能通过随意添加一个旧标识字段绕过新格式 result 必填。
  const hasCompleteOldMarkers = !!(normalized.consumer && normalized.attestedBy && normalized.attestedAt);
  const hasNewFormatFields = !!(normalized.result || normalized.actor || normalized.confirmedAt);
  const isOldFormat = hasCompleteOldMarkers && !hasNewFormatFields;

  // 新格式严格要求 result 字段；仅当确认为旧格式时才允许缺省
  if (!normalized.result && isOldFormat) {
    normalized.result = 'passed';
  }

  // consumer → platform (旧格式使用 consumer)
  if (!normalized.platform && normalized.consumer) {
    normalized.platform = normalized.consumer;
  }
  // attestedBy → actor (旧格式使用 attestedBy)
  if (!normalized.actor && normalized.attestedBy) {
    normalized.actor = normalized.attestedBy;
  }
  // attestedAt → confirmedAt (旧格式使用 attestedAt)
  if (!normalized.confirmedAt && normalized.attestedAt) {
    normalized.confirmedAt = normalized.attestedAt;
  }

  // 统一必填字段
  const requiredStrings = ['platform', 'version', 'planDigest', 'result', 'actor', 'confirmedAt'];
  for (const field of requiredStrings) {
    if (typeof normalized[field] !== 'string' || normalized[field].length === 0) {
      return { valid: false, error: `kimi attestation missing required field "${field}"`, normalized: null };
    }
  }
  if (normalized.platform !== 'kimi') {
    return { valid: false, error: `kimi attestation platform "${normalized.platform}" must be "kimi"`, normalized: null };
  }
  // result 只接受 passed 或 failed
  if (normalized.result !== 'passed' && normalized.result !== 'failed') {
    return { valid: false, error: `kimi attestation result "${normalized.result}" must be "passed" or "failed"`, normalized: null };
  }
  // planDigest 绑定验证
  if (!HEX_DIGEST_RE.test(normalized.planDigest)) {
    return { valid: false, error: 'kimi attestation planDigest must be a 64-char lowercase hex digest', normalized: null };
  }
  if (normalized.planDigest !== boundPlanDigest) {
    return { valid: false, error: 'kimi attestation planDigest does not match the frozen plan digest', normalized: null };
  }
  // version 静态一致性检查
  if (normalized.version !== action.version) {
    return { valid: false, error: `kimi attestation version "${normalized.version}" does not match action version "${action.version}"`, normalized: null };
  }

  // 旧格式额外绑定字段校验：plugin, repo, ref, entrySkill, payloadDigest, installPath
  // 旧格式必须包含完整旧字段组；缺任一旧必填字段失败。
  if (isOldFormat) {
    // plugin 必须匹配
    if (normalized.plugin !== action.plugin) {
      return { valid: false, error: `kimi attestation plugin "${normalized.plugin}" does not match action plugin "${action.plugin}"`, normalized: null };
    }
    // repo 必须匹配
    if (normalized.repo !== action.repo) {
      return { valid: false, error: `kimi attestation repo "${normalized.repo}" does not match action repo "${action.repo}"`, normalized: null };
    }
    // ref 必须匹配
    const expectedRef = action.ref ?? `v${action.version}`;
    if (normalized.ref !== expectedRef) {
      return { valid: false, error: `kimi attestation ref "${normalized.ref}" does not match action ref "${expectedRef}"`, normalized: null };
    }
    // entrySkill 必须匹配
    if (normalized.entrySkill !== action.entrySkill) {
      return { valid: false, error: `kimi attestation entrySkill "${normalized.entrySkill}" does not match action entrySkill "${action.entrySkill}"`, normalized: null };
    }
    // payloadDigest 旧格式必填、格式合法且等于冻结动作 manifestDigest
    if (typeof normalized.payloadDigest !== 'string' || normalized.payloadDigest.length === 0) {
      return { valid: false, error: 'kimi attestation payloadDigest is required for old-format receipts', normalized: null };
    }
    // installPath 旧格式必填：旧格式用 installPath 证明实际安装
    if (typeof normalized.installPath !== 'string' || normalized.installPath.length === 0) {
      return { valid: false, error: 'kimi attestation installPath is required for old-format receipts', normalized: null };
    }
    if (!HEX_DIGEST_RE.test(normalized.payloadDigest)) {
      return { valid: false, error: 'kimi attestation payloadDigest must be a 64-char lowercase hex digest', normalized: null };
    }
    if (action.manifestDigest && normalized.payloadDigest !== action.manifestDigest) {
      return { valid: false, error: 'kimi attestation payloadDigest does not match the frozen manifest digest', normalized: null };
    }
  } else {
    // 新格式 payloadDigest 可选，但如果存在则必须合法
    if (normalized.payloadDigest !== undefined) {
      if (!HEX_DIGEST_RE.test(normalized.payloadDigest)) {
        return { valid: false, error: 'kimi attestation payloadDigest must be a 64-char lowercase hex digest when present', normalized: null };
      }
      if (action.manifestDigest && normalized.payloadDigest !== action.manifestDigest) {
        return { valid: false, error: 'kimi attestation payloadDigest does not match the frozen manifest digest', normalized: null };
      }
    }
  }

  // confirmedAt 必须是有效的时间戳
  const confirmedMs = Date.parse(normalized.confirmedAt);
  if (!Number.isFinite(confirmedMs)) {
    return { valid: false, error: 'kimi attestation confirmedAt must be a valid ISO timestamp', normalized: null };
  }
  // 可选字段 note 如果存在必须是字符串
  if (normalized.note !== undefined && typeof normalized.note !== 'string') {
    return { valid: false, error: 'kimi attestation note must be a string when present', normalized: null };
  }
  return { valid: true, error: null, normalized };
}

/**
 * Kimi Code protocol capability gap (BLOCKER-1): there is NO scriptable
 * `kimi plugins install/list` CLI and no `--json` protocol. execute NEVER execs
 * a kimi command. Instead it emits an actionable, version-pinned manual-install
 * requirement bound to the real frozen plan digest + identity, and leaves
 * success to observe, which consumes only a trusted human attestation plus
 * read-only verification. Without that proof the checkpoint fails closed and can
 * never reach VERIFIED.
 *
 * 统一人工判定：不再创建隔离目录，不再要求隔离 HOME。
 * 人工结果只需 platform, version, planDigest, result, actor, confirmedAt。
 *
 * Referenced from the registry as the kimi strategy.buildManualRequirement —
 * the automatable=false manual-requirement path.
 *
 * @param {object} action - expanded kimi action (validated params already).
 * @param {object} context - adapter context (root, runDir, plan).
 * @returns {Promise<import('../adapters/contract.mjs').AdapterResult>}
 */
export async function executeKimiManualRequirement(action, context) {
  const actionType = ActionType.KIMI_MARKETPLACE_INSTALL;

  // (A) Bind to the REAL frozen plan digest via strict normalized recompute.
  let planDigest;
  try {
    planDigest = resolveBoundPlanDigest(context);
  } catch (planErr) {
    return createResult({
      actionType,
      status: ActionStatus.EXECUTE_FAILED,
      error: `cannot bind kimi requirement to the frozen plan: ${planErr.message}`,
    });
  }

  // Validate the frozen timeout. Kimi execs no CLI, but the frozen-timeout
  // fail-closed invariant still holds for every marketplace action.
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
  const installUrl = buildKimiInstallUrl(action.repo, ref);

  // (B) Stable, plan-digest-keyed authority dir, shared across
  // publish/reconcile/verify run dirs.
  let attestationDir;
  try {
    attestationDir = kimiAuthorityDir(context, planDigest, action.plugin);
  } catch (dirErr) {
    return createResult({
      actionType,
      status: ActionStatus.EXECUTE_FAILED,
      error: dirErr.message,
    });
  }

  const requiresInstalledClosure = Boolean(context.plan?.skillResourceClosure);
  const managedRoot = requiresInstalledClosure
    ? resolve(attestationDir, 'kimi-home', 'plugins', 'managed')
    : null;
  const instructions = buildKimiManualInstructions({
    installUrl,
    plugin: action.plugin,
    version: action.version,
    ref,
    attestationDir,
    requiresInstalledClosure,
    managedRoot,
  });

  // 统一 requirement 结构：不再包含隔离目录信息
  const requirement = {
    kind: 'kimi-manual-install-requirement',
    platform: 'kimi',
    plugin: action.plugin,
    version: action.version,
    repo: action.repo,
    ref,
    entrySkill: action.entrySkill,
    installUrl,
    planDigest,
    attestationDir,
    attestationFile: KIMI_ATTESTATION_FILE,
    attestationTemplate: {
      platform: 'kimi',
      version: action.version,
      planDigest,
      result: '<"passed" or "failed">',
      actor: '<person who confirmed the install>',
      confirmedAt: '<ISO 8601 timestamp>',
      ...(requiresInstalledClosure
        ? { installPath: resolve(managedRoot, action.plugin) }
        : {}),
      note: '<optional note>',
    },
    instructions,
  };

  // Ensure the authority directory exists (no isolated home creation needed).
  const { mkdir } = await import('node:fs/promises');
  try {
    await mkdir(attestationDir, { recursive: true, mode: 0o700 });
  } catch (mkdirErr) {
    // EEXIST is fine; other errors are fatal.
    if (mkdirErr?.code !== 'EEXIST') {
      return createResult({
        actionType,
        status: ActionStatus.EXECUTE_FAILED,
        error: `cannot create kimi attestation directory: ${mkdirErr.message}`,
      });
    }
  }

  // New closure plans must scan an actual installed consumer tree. Create only
  // the isolated KIMI_CODE_HOME container; the interactive host remains the
  // sole owner of managed/<plugin>. Legacy plans retain the previous no-home
  // behavior byte-for-byte.
  if (requiresInstalledClosure) {
    try {
      await mkdir(managedRoot, { recursive: true, mode: 0o700 });
    } catch (mkdirErr) {
      return createResult({
        actionType,
        status: ActionStatus.EXECUTE_FAILED,
        error: `cannot create kimi resource-closure managed root: ${mkdirErr.message}`,
      });
    }
  }

  // Idempotent requirement write: an identical existing requirement is left
  // untouched; a divergent existing requirement fails closed (never silently
  // overwritten). `createdAt` is volatile and excluded from the comparison.
  const requirementPath = resolve(attestationDir, KIMI_REQUIREMENT_FILE);
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
        error: `existing kimi manual-install requirement is invalid JSON; refusing to overwrite: ${parseErr.message}`,
      });
    }
  } catch (readErr) {
    if (readErr?.code === 'ENOENT') {
      requirementMissing = true;
    } else {
      return createResult({
        actionType,
        status: ActionStatus.EXECUTE_FAILED,
        error: `existing kimi manual-install requirement cannot be read; refusing to overwrite: ${readErr.message}`,
      });
    }
  }
  if (!requirementMissing) {
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      return createResult({
        actionType,
        status: ActionStatus.EXECUTE_FAILED,
        error: 'existing kimi manual-install requirement is not an object; refusing to overwrite',
      });
    }
    const { createdAt: _existingCreatedAt, ...existingBody } = existing;
    if (canonicalJson(existingBody) !== canonicalJson(requirement)) {
      return createResult({
        actionType,
        status: ActionStatus.EXECUTE_FAILED,
        error: 'existing kimi manual-install requirement conflicts with the current frozen action; refusing to overwrite',
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
      consumer: 'kimi',
      plugin: action.plugin,
      version: action.version,
      ref,
      installUrl,
      planDigest,
      attestationDir,
      instructions,
    },
  });
}
