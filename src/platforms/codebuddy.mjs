/**
 * CodeBuddy / WorkBuddy platform protocol (human attestation closed loop).
 *
 * CodeBuddy (desktop product WorkBuddy) ships a `codebuddy` CLI that is
 * structurally identical to claude-code, BUT its plugin install protocol cannot
 * pin a frozen ref: `plugin marketplace add <source>` and `plugin install
 * <plugin[@marketplace]>` have NO ref option, and the install tracks the
 * marketplace default branch / latest (verified against the real CLI and its
 * on-disk state model). An automated install checkpoint therefore cannot
 * guarantee the frozen artifact's identity, which this project's security model
 * requires. The install state DOES have a stable on-disk layout that serves as
 * verification evidence.
 *
 * 统一人工结果：收据仅需 platform, version, planDigest,
 * result(passed|failed), actor, confirmedAt 和可选 note。
 * 不再要求 consumer, plugin, conclusion, confirmedBy、隔离 HOME、
 * 安装路径证明、载荷摘要手填、24 小时过期、marketplace 或 installChannel。
 *
 * This module is the codebuddy half of the platform registry's strategy table
 * (registry.mjs references executeCodeBuddyManualRequirement /
 * readCodeBuddyManifest); the plugin-marketplace adapter consumes the
 * attestation path from here through a codebuddy-specific branch that mirrors
 * the kimi branch. The shared adapter primitives (safe-id pattern,
 * frozen-timeout validation, atomic evidence writes) live in
 * adapters/contract.mjs.
 *
 * NOTE on intentional duplication: the 64-hex digest pattern and the
 * lifecycle plan normalization below mirror kimi.mjs's pure helpers instead of
 * importing them. Importing from ./kimi.mjs would add a codebuddy -> kimi edge
 * that, combined with the kimi -> plan -> registry -> kimi cycle, deadlocks the
 * esbuild-generated module initializers in the self-contained bundle (the
 * `prepare` dynamic import never settles). Inlining these two tiny pure
 * functions keeps codebuddy's only cycle edge codebuddy -> plan -> registry
 * (the same shape kimi already ships with) and the bundle evaluating cleanly.
 *
 * @module platforms/codebuddy
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
// NOTE: computePlanDigest (../core/plan.mjs) is imported LAZILY inside
// resolveCodeBuddyBoundPlanDigest, NOT statically here. A static import would
// add a registry -> codebuddy -> plan -> registry cycle edge; combined with the
// existing kimi -> plan -> registry -> kimi cycle, that deadlocks esbuild's
// generated module initializers in the self-contained bundle (the `prepare`
// dynamic import never settles). kimi.mjs predates this constraint; codebuddy
// keeps the bundle graph acyclic by loading plan.mjs at call time (by then
// every module is initialized, so the lazy import resolves immediately).

/** 64-char lowercase hex plan/payload digest pattern (mirrors kimi.mjs). */
const HEX_DIGEST_RE = /^[a-f0-9]{64}$/;

/**
 * Normalize a plan back to its frozen form for digest comparison (mirrors the
 * pure helper in kimi.mjs; inlined here to avoid a codebuddy -> kimi import
 * edge — see the module note). Only lifecycle status fields are reset: the
 * top-level `status` returns to "PREPARED" and every `externalActions[].status`
 * returns to "PENDING"; every other field is preserved verbatim.
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

/** Structured manual-install requirement written by codebuddy execute. */
export const CODEBUDDY_REQUIREMENT_FILE = 'release-skill-codebuddy-manual-install.json';
/** Structured human attestation consumed by codebuddy observe/verify. */
export const CODEBUDDY_ATTESTATION_FILE = 'release-skill-codebuddy-attestation.json';

/**
 * Default unified marketplace the WorkBuddy desktop app and the codebuddy CLI
 * install from (verified fact). A distribution may override this by declaring
 * `marketplace` (see resolveCodeBuddyMarketplace); the install path is
 * validated against the resolved marketplace segment in both channels, and a
 * declared attestation `marketplace` field must equal the resolved name.
 */
export const CODEBUDDY_MARKETPLACE_NAME = 'artifact-skill-set';
/** Default marketplace source URL (used only when no marketplace override is declared). */
export const CODEBUDDY_MARKETPLACE_SOURCE = 'https://github.com/ifoohoo/artifact-skill-set';

/**
 * Resolve the unified marketplace name for a codebuddy action.
 *
 * Falls back to CODEBUDDY_MARKETPLACE_NAME when the action carries no
 * `marketplace` (legacy frozen plans, byte-identical behavior). A declared
 * marketplace must be a non-empty string; anything else fails closed.
 *
 * @param {object} [action] - expanded codebuddy action (may be undefined).
 * @returns {string} the resolved marketplace name.
 * @throws {Error} when a declared marketplace is not a non-empty string.
 */
export function resolveCodeBuddyMarketplace(action) {
  const marketplace = action?.marketplace ?? CODEBUDDY_MARKETPLACE_NAME;
  if (typeof marketplace !== 'string' || marketplace.length === 0) {
    throw new Error(`codebuddy marketplace must be a non-empty string when declared, got ${JSON.stringify(action?.marketplace)}`);
  }
  return marketplace;
}

/**
 * Resolve the marketplace source URL for a codebuddy action, when knowable.
 *
 * The default marketplace has a verified source constant; a configured
 * marketplace only has a source when the distribution declared
 * `marketplaceSource`. When neither applies, null is returned and callers
 * must NOT fabricate a URL.
 *
 * @param {object} [action] - expanded codebuddy action (may be undefined).
 * @returns {string|null} the source URL, or null when unknown.
 */
export function resolveCodeBuddyMarketplaceSource(action) {
  if (action?.marketplace === undefined || action?.marketplace === null) {
    return CODEBUDDY_MARKETPLACE_SOURCE;
  }
  return typeof action.marketplaceSource === 'string' && action.marketplaceSource.length > 0
    ? action.marketplaceSource
    : null;
}

/** Authoritative codebuddy plugin manifest (single candidate, no precedence). */
export const CODEBUDDY_PLUGIN_MANIFEST_RELATIVE = join('.codebuddy-plugin', 'plugin.json');

/**
 * Maximum validity window for a codebuddy human attestation (24 hours).
 * attestations with expiresAt exceeding this window from attestedAt are rejected.
 */
export const CODEBUDDY_MAX_ATTESTATION_VALIDITY_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve and verify the genuine frozen plan digest from the adapter context,
 * for the codebuddy closed loop.
 *
 * Mirrors kimi's resolveBoundPlanDigest byte-for-byte in LOGIC (it reuses the
 * same pure `normalizePlanForDigest`), but speaks in codebuddy terms so the
 * codebuddy requirement/attestation error messages are codebuddy-worded. The
 * carried `context.plan.digest` is recomputed from the lifecycle-normalized
 * plan and must match exactly; any non-lifecycle tamper fails closed.
 *
 * @param {object} context - adapter context (must carry the frozen `plan`).
 * @returns {Promise<string>} the verified frozen plan digest.
 * @throws {Error} when the plan is absent or the digest does not match.
 */
export async function resolveCodeBuddyBoundPlanDigest(context) {
  const plan = context?.plan;
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new Error('context.plan is required to bind the codebuddy plan digest');
  }
  const carried = plan.digest;
  if (typeof carried !== 'string' || !HEX_DIGEST_RE.test(carried)) {
    throw new Error('context.plan.digest must be a 64-char lowercase hex frozen plan digest');
  }
  // Lazy import keeps the static bundle graph acyclic (see module note).
  const { computePlanDigest } = await import('../core/plan.mjs');
  const normalized = normalizePlanForDigest(plan);
  if (computePlanDigest(normalized) !== carried) {
    throw new Error('context.plan.digest does not match the normalized frozen plan (a non-lifecycle field was tampered)');
  }
  return carried;
}

/**
 * Authoritative, cross-run attestation directory for a codebuddy install.
 *
 * Lives at a stable root-fixed location keyed by the plugin id:
 *   <root>/.release-skill/codebuddy-attestations/<plugin>/
 *
 * This survives the publish -> manual install -> reconcile -> verify chain,
 * where each command otherwise uses a fresh runDir. Both the requirement and
 * the human attestation live here. The planDigest parameter is still received
 * and validated (it binds the attestation content), but the path itself is
 * stable across plan versions — new plan requirements can atomically replace
 * old ones in the same directory. Segments are pre-validated (planDigest is
 * 64-hex, plugin matches SAFE_ID_RE) and the resolved path is contained within
 * the authority base, so no path escape is possible. (Path-escape validation is
 * copied verbatim from kimiAuthorityDir, with codebuddy wording.)
 *
 * @param {object} context - adapter context (needs `root`).
 * @param {string} planDigest - verified frozen plan digest (64-hex).
 * @param {string} plugin - plugin id (SAFE_ID_RE).
 * @returns {string} absolute authority directory.
 */
export function codebuddyAuthorityDir(context, planDigest, plugin) {
  if (!context?.root) {
    throw new Error('context.root is required for the codebuddy attestation authority');
  }
  if (!HEX_DIGEST_RE.test(planDigest)) {
    throw new Error('codebuddy attestation authority requires a 64-hex plan digest');
  }
  if (!SAFE_ID_RE.test(plugin)) {
    throw new Error(`codebuddy attestation authority requires a safe plugin id: "${plugin}"`);
  }
  const base = resolve(context.root, '.release-skill', 'codebuddy-attestations');
  const dir = resolve(base, plugin);
  const rel = relative(base, dir);
  const sep = process.platform === 'win32' ? '\\' : '/';
  if (
    rel === '' || rel === '..' || isAbsolute(rel) || rel.startsWith(`..${sep}`)
    || rel.split(sep).some((segment) => segment === '..' || segment === '')
  ) {
    throw new Error('codebuddy attestation authority path escapes its base');
  }
  return dir;
}

/**
 * 统一人工安装说明：面向 CodeBuddy / WorkBuddy 的人工结果流程。
 *
 * @param {{plugin:string, version:string, ref:string, attestationDir:string, requiresInstalledClosure:boolean, marketplace:string, marketplaceSource:string|null}} p
 * @returns {string[]}
 */
function buildCodeBuddyManualInstructions({
  plugin,
  version,
  ref,
  attestationDir,
  requiresInstalledClosure,
  marketplace,
  marketplaceSource,
}) {
  return [
    `CodeBuddy/WorkBuddy 插件安装无法锁定冻结 ref（codebuddy CLI marketplace add/install 没有 ref 选项，跟踪默认分支），因此安装是需要人工结果证明的手动步骤。`,
    `1) publish 完成所有远端写入后进入 PUBLISHED 状态（自动化 Git 分支/标签、npm 和 GitHub Release 写入已完成）。此 codebuddy 检查点标记为需要人工安装。`,
    `2) 从统一市场 "${marketplace}"${marketplaceSource ? ` (${marketplaceSource})` : ''} 安装 ${plugin}。确认安装的插件版本等于冻结版本 ${version}。`,
    `3) 将人工结果 JSON 写入: ${attestationDir}/${CODEBUDDY_ATTESTATION_FILE}`,
    `   必填字段: platform="codebuddy", version, planDigest（冻结计划摘要）, result("passed" 或 "failed"), actor（确认人）, confirmedAt（ISO 8601 时间戳）${requiresInstalledClosure ? '，installChannel("desktop" 或 "cli")，installPath（实际安装后的插件目录）' : ''}`,
    `   可选字段: note（备注）`,
    `4) 运行 release-skill verify（从同一个计划摘要索引的权威目录读取结果，成功后 -> VERIFIED）。`,
  ];
}

/**
 * Read the authoritative CodeBuddy plugin manifest from a verified plugin root.
 *
 * Single candidate `.codebuddy-plugin/plugin.json` (no precedence chain, unlike
 * kimi). Returns the parsed manifest and the root-relative manifest path.
 * Throws when the manifest is absent, not valid JSON, or not an object.
 *
 * @param {string} pluginRootReal - realpath of the verified plugin root.
 * @returns {Promise<{manifest:object, manifestRelative:string}>}
 */
export async function readCodeBuddyManifest(pluginRootReal) {
  const manifestRelative = CODEBUDDY_PLUGIN_MANIFEST_RELATIVE;
  const manifestPath = resolve(pluginRootReal, manifestRelative);
  let content;
  try {
    content = await readFile(manifestPath, 'utf8');
  } catch {
    throw new Error(`no codebuddy plugin manifest found (expected ${manifestRelative})`);
  }
  let manifest;
  try {
    manifest = JSON.parse(content);
  } catch {
    throw new Error(`codebuddy plugin manifest ${manifestRelative} is not valid JSON`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`codebuddy plugin manifest ${manifestRelative} is not an object`);
  }
  return { manifest, manifestRelative };
}

/**
 * 统一人工结果验证：验证 codebuddy 人工结果是否匹配冻结计划。
 *
 * 统一后的结果只需：
 * - 必填：platform, version, planDigest, result(passed|failed), actor, confirmedAt
 * - 可选：note
 *
 * 旧格式兼容（0.2.3 及更早）：
 * - consumer → platform (必须是 'codebuddy')
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
 * @param {object} action - 展开的 codebuddy 动作（顶层字段）。
 * @param {string} isoNow - 当前 ISO 时间戳（保留签名兼容，不再用于过期检查）。
 * @param {string} boundPlanDigest - 验证过的冻结计划摘要。
 * @returns {{valid:boolean, error:string|null, normalized:object|null}}
 */
export function validateCodeBuddyAttestation(attestation, action, isoNow, boundPlanDigest) {
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) {
    return { valid: false, error: 'codebuddy attestation is not an object', normalized: null };
  }

  // 旧格式归一化：将旧字段映射到新字段
  const normalized = { ...attestation };

  // 旧格式识别：完整旧标识组（consumer, attestedBy, attestedAt）全部存在，
  // 且新格式字段组（result, actor, confirmedAt）未混入。
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
      return { valid: false, error: `codebuddy attestation missing required field "${field}"`, normalized: null };
    }
  }
  if (normalized.platform !== 'codebuddy') {
    return { valid: false, error: `codebuddy attestation platform "${normalized.platform}" must be "codebuddy"`, normalized: null };
  }

  // installPath 路径安全校验：CLI 通道必须在预期目录内
  if (normalized.installPath !== undefined) {
    if (typeof normalized.installPath !== 'string' || normalized.installPath.length === 0) {
      return { valid: false, error: 'codebuddy attestation installPath must be a non-empty string when present', normalized: null };
    }
    if (normalized.installPath.includes('..')) {
      return { valid: false, error: 'codebuddy attestation installPath must not contain path traversal ("..")', normalized: null };
    }
    // CLI 通道：installPath 必须以预期后缀结尾（市场名解析自冻结动作，
    // 未声明时回落到默认统一市场常量）
    if (normalized.installChannel === 'cli') {
      let resolvedMarketplace;
      try {
        resolvedMarketplace = resolveCodeBuddyMarketplace(action);
      } catch (resolveErr) {
        return { valid: false, error: resolveErr.message, normalized: null };
      }
      const expectedSuffix = `.workbuddy/plugins/marketplaces/${resolvedMarketplace}/plugins/${action.plugin}`;
      if (!normalized.installPath.endsWith(expectedSuffix)) {
        return { valid: false, error: `codebuddy CLI attestation installPath must end with "${expectedSuffix}", got "${normalized.installPath}"`, normalized: null };
      }
    }
  }

  // 可选 marketplace 字段：一旦声明必须等于冻结动作解析出的市场名
  if (normalized.marketplace !== undefined) {
    let resolvedMarketplace;
    try {
      resolvedMarketplace = resolveCodeBuddyMarketplace(action);
    } catch (resolveErr) {
      return { valid: false, error: resolveErr.message, normalized: null };
    }
    if (normalized.marketplace !== resolvedMarketplace) {
      return { valid: false, error: `codebuddy attestation marketplace "${normalized.marketplace}" does not match the resolved marketplace "${resolvedMarketplace}"`, normalized: null };
    }
  }

  // result 只接受 passed 或 failed
  if (normalized.result !== 'passed' && normalized.result !== 'failed') {
    return { valid: false, error: `codebuddy attestation result "${normalized.result}" must be "passed" or "failed"`, normalized: null };
  }
  // planDigest 绑定验证
  if (!HEX_DIGEST_RE.test(normalized.planDigest)) {
    return { valid: false, error: 'codebuddy attestation planDigest must be a 64-char lowercase hex digest', normalized: null };
  }
  if (normalized.planDigest !== boundPlanDigest) {
    return { valid: false, error: 'codebuddy attestation planDigest does not match the frozen plan digest', normalized: null };
  }
  // version 静态一致性检查
  if (normalized.version !== action.version) {
    return { valid: false, error: `codebuddy attestation version "${normalized.version}" does not match action version "${action.version}"`, normalized: null };
  }

  // 旧格式额外绑定字段校验：plugin, repo, ref, entrySkill, payloadDigest
  if (isOldFormat) {
    if (normalized.plugin !== action.plugin) {
      return { valid: false, error: `codebuddy attestation plugin "${normalized.plugin}" does not match action plugin "${action.plugin}"`, normalized: null };
    }
    if (normalized.repo !== action.repo) {
      return { valid: false, error: `codebuddy attestation repo "${normalized.repo}" does not match action repo "${action.repo}"`, normalized: null };
    }
    const expectedRef = action.ref ?? `v${action.version}`;
    if (normalized.ref !== expectedRef) {
      return { valid: false, error: `codebuddy attestation ref "${normalized.ref}" does not match action ref "${expectedRef}"`, normalized: null };
    }
    if (normalized.entrySkill !== action.entrySkill) {
      return { valid: false, error: `codebuddy attestation entrySkill "${normalized.entrySkill}" does not match action entrySkill "${action.entrySkill}"`, normalized: null };
    }
    // payloadDigest 旧格式必填、格式合法且等于冻结动作 manifestDigest
    if (typeof normalized.payloadDigest !== 'string' || normalized.payloadDigest.length === 0) {
      return { valid: false, error: 'codebuddy attestation payloadDigest is required for old-format receipts', normalized: null };
    }
    if (!HEX_DIGEST_RE.test(normalized.payloadDigest)) {
      return { valid: false, error: 'codebuddy attestation payloadDigest must be a 64-char lowercase hex digest', normalized: null };
    }
    if (action.manifestDigest && normalized.payloadDigest !== action.manifestDigest) {
      return { valid: false, error: 'codebuddy attestation payloadDigest does not match the frozen manifest digest', normalized: null };
    }
  } else {
    // 新格式 payloadDigest 可选，但如果存在则必须合法
    if (normalized.payloadDigest !== undefined) {
      if (!HEX_DIGEST_RE.test(normalized.payloadDigest)) {
        return { valid: false, error: 'codebuddy attestation payloadDigest must be a 64-char lowercase hex digest when present', normalized: null };
      }
      if (action.manifestDigest && normalized.payloadDigest !== action.manifestDigest) {
        return { valid: false, error: 'codebuddy attestation payloadDigest does not match the frozen manifest digest', normalized: null };
      }
    }
  }

  // confirmedAt 必须是有效的时间戳
  const confirmedMs = Date.parse(normalized.confirmedAt);
  if (!Number.isFinite(confirmedMs)) {
    return { valid: false, error: 'codebuddy attestation confirmedAt must be a valid ISO timestamp', normalized: null };
  }
  // confirmedAt 不得在未来
  const nowMs = Date.parse(isoNow);
  if (Number.isFinite(nowMs) && confirmedMs > nowMs) {
    return { valid: false, error: 'codebuddy attestation confirmedAt must not be in the future', normalized: null };
  }
  // expiresAt 校验（可选字段）
  if (normalized.expiresAt !== undefined) {
    const expiresMs = Date.parse(normalized.expiresAt);
    if (!Number.isFinite(expiresMs)) {
      return { valid: false, error: 'codebuddy attestation expiresAt must be a valid ISO timestamp', normalized: null };
    }
    // 已过期
    if (Number.isFinite(nowMs) && expiresMs < nowMs) {
      return { valid: false, error: 'codebuddy attestation has expired', normalized: null };
    }
    // 有效期不得超过 24 小时
    if (expiresMs - confirmedMs > CODEBUDDY_MAX_ATTESTATION_VALIDITY_MS) {
      return { valid: false, error: 'codebuddy attestation validity exceeds 24 hours', normalized: null };
    }
  }
  // 可选字段 note 如果存在必须是字符串
  if (normalized.note !== undefined && typeof normalized.note !== 'string') {
    return { valid: false, error: 'codebuddy attestation note must be a string when present', normalized: null };
  }
  return { valid: true, error: null, normalized };
}

/**
 * CodeBuddy protocol capability gap: the codebuddy CLI cannot pin a frozen ref,
 * so there is NO trustworthy automated install checkpoint. execute NEVER execs a
 * codebuddy command. Instead it emits an actionable manual-install requirement
 * bound to the real frozen plan digest + identity, and leaves success to
 * observe/verify, which consume only a trusted human attestation plus read-only
 * verification. Without that proof the checkpoint fails closed and can never
 * reach VERIFIED.
 *
 * 统一人工判定：不再创建隔离目录，不再要求隔离 HOME。
 * 人工结果只需 platform, version, planDigest, result, actor, confirmedAt。
 *
 * Referenced from the registry as the codebuddy strategy.buildManualRequirement
 * — the automatable=false manual-requirement path.
 *
 * @param {object} action - expanded codebuddy action (validated params already).
 * @param {object} context - adapter context (root, runDir, plan).
 * @returns {Promise<import('../adapters/contract.mjs').AdapterResult>}
 */
export async function executeCodeBuddyManualRequirement(action, context) {
  const actionType = ActionType.CODEBUDDY_MARKETPLACE_INSTALL;

  // (A) Bind to the REAL frozen plan digest via strict normalized recompute.
  let planDigest;
  try {
    planDigest = await resolveCodeBuddyBoundPlanDigest(context);
  } catch (planErr) {
    return createResult({
      actionType,
      status: ActionStatus.EXECUTE_FAILED,
      error: `cannot bind codebuddy requirement to the frozen plan: ${planErr.message}`,
    });
  }

  // Validate the frozen timeout. CodeBuddy execs no CLI, but the frozen-timeout
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

  // Unified marketplace identity: resolved from the frozen action (declared
  // `marketplace`/`marketplaceSource`), falling back to the default constants
  // for legacy plans. A fabricated source URL is never emitted for a
  // configured marketplace without a declared marketplaceSource.
  let marketplace;
  try {
    marketplace = resolveCodeBuddyMarketplace(action);
  } catch (marketplaceErr) {
    return createResult({
      actionType,
      status: ActionStatus.EXECUTE_FAILED,
      error: marketplaceErr.message,
    });
  }
  const marketplaceSource = resolveCodeBuddyMarketplaceSource(action);

  // (B) Stable plugin-level authority dir, shared across
  // publish/reconcile/verify run dirs.
  let attestationDir;
  try {
    attestationDir = codebuddyAuthorityDir(context, planDigest, action.plugin);
  } catch (dirErr) {
    return createResult({
      actionType,
      status: ActionStatus.EXECUTE_FAILED,
      error: dirErr.message,
    });
  }

  const instructions = buildCodeBuddyManualInstructions({
    plugin: action.plugin,
    version: action.version,
    ref,
    attestationDir,
    requiresInstalledClosure: Boolean(context.plan?.skillResourceClosure),
    marketplace,
    marketplaceSource,
  });

  // 统一 requirement 结构：不再包含隔离目录信息
  const requirement = {
    kind: 'codebuddy-manual-install-requirement',
    platform: 'codebuddy',
    plugin: action.plugin,
    version: action.version,
    repo: action.repo,
    ref,
    entrySkill: action.entrySkill,
    marketplace,
    ...(marketplaceSource ? { marketplaceSource } : {}),
    planDigest,
    attestationDir,
    attestationFile: CODEBUDDY_ATTESTATION_FILE,
    attestationTemplate: {
      platform: 'codebuddy',
      version: action.version,
      planDigest,
      result: '<"passed" or "failed">',
      actor: '<person who confirmed the install>',
      confirmedAt: '<ISO 8601 timestamp>',
      ...(context.plan?.skillResourceClosure
        ? {
            installChannel: '<"desktop" or "cli">',
            installPath: `<actual .workbuddy/plugins/marketplaces/${marketplace}/plugins/${action.plugin} directory>`,
          }
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
        error: `cannot create codebuddy attestation directory: ${mkdirErr.message}`,
      });
    }
  }

  // Idempotent requirement write: an identical existing requirement is left
  // untouched; a divergent existing requirement fails closed (never silently
  // overwritten). `createdAt` is volatile and excluded from the comparison.
  const requirementPath = resolve(attestationDir, CODEBUDDY_REQUIREMENT_FILE);
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
        error: `existing codebuddy manual-install requirement is invalid JSON; refusing to overwrite: ${parseErr.message}`,
      });
    }
  } catch (readErr) {
    if (readErr?.code === 'ENOENT') {
      requirementMissing = true;
    } else {
      return createResult({
        actionType,
        status: ActionStatus.EXECUTE_FAILED,
        error: `existing codebuddy manual-install requirement cannot be read; refusing to overwrite: ${readErr.message}`,
      });
    }
  }
  if (!requirementMissing) {
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      return createResult({
        actionType,
        status: ActionStatus.EXECUTE_FAILED,
        error: 'existing codebuddy manual-install requirement is not an object; refusing to overwrite',
      });
    }
    const { createdAt: _existingCreatedAt, ...existingBody } = existing;
    if (canonicalJson(existingBody) !== canonicalJson(requirement)) {
      // 旧 plan 的 requirement 与新 plan 不同：允许原子替换（路径不再含 planDigest）。
      // 但如果 planDigest 相同而内容不同，说明同一 plan 内的冻结动作不一致，仍失败关闭。
      if (existing.planDigest === planDigest) {
        return createResult({
          actionType,
          status: ActionStatus.EXECUTE_FAILED,
          error: 'existing codebuddy manual-install requirement conflicts with the current frozen action (same planDigest); refusing to overwrite',
        });
      }
      // 不同 planDigest：原子替换旧 plan 的 requirement
      await writeEvidenceAtomic(requirementPath, { ...requirement, createdAt: new Date().toISOString() });
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
      platform: 'codebuddy',
      plugin: action.plugin,
      version: action.version,
      ref,
      planDigest,
      attestationDir,
      instructions,
    },
  });
}
