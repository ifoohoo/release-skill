/**
 * 纯函数下游提案投影模块：由运行时传输层、冻结 postVerify 钩子与离线生命周期治理命令共享。
 * 保持零第三方依赖，确保分离出的公开标签工作树无需 node_modules 即可加载。
 *
 * @module core/proposal-document
 */
// @decision D-RS-002

import { ReleaseError, GATE_FAILED } from './errors.mjs';

/** 提案文档协议身份常量。 */
export const PROPOSAL_SCHEMA_VERSION = 1;
export const PROPOSAL_KIND = 'release-skill/update-proposal';
export const DEPRECATION_PROPOSAL_KIND = 'release-skill/deprecation-proposal';
export const RETIREMENT_PROPOSAL_KIND = 'release-skill/retirement-proposal';
export const LIFECYCLE_PROPOSAL_KIND = DEPRECATION_PROPOSAL_KIND;

const HUB_UNIT_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const HUB_PLUGIN_AT_MARKET_RE = /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)@[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const CANONICAL_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const STRICT_SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** 下游常规版本更新提案的目标相对路径。 */
export function proposalFileName(unitId, version) {
  if (typeof unitId !== 'string' || unitId.length === 0
    || typeof version !== 'string' || version.length === 0) {
    throw new ReleaseError(GATE_FAILED, 'proposal file name requires unitId and version', { unitId, version });
  }
  return `incoming/${unitId}-${version}.json`;
}

/**
 * 从发布后上下文确定性构建下游市场更新提案（严禁携带本机路径）。
 */
export function buildProposalDocument(context) {
  const required = ['unitId', 'version', 'tag', 'commit', 'planDigest', 'runId'];
  for (const field of required) {
    if (typeof context?.[field] !== 'string' || context[field].length === 0) {
      throw new ReleaseError(GATE_FAILED, `proposal document requires context field "${field}"`, { field });
    }
  }
  const { unitId, version, tag, commit, tree, manifestDigest, planDigest, runId, publishedAt, verifyEvidence } = context;
  return {
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    kind: PROPOSAL_KIND,
    unitId,
    version,
    tag,
    sha: commit,
    commit,
    ...(typeof tree === 'string' && tree.length > 0 ? { tree } : {}),
    ...(typeof manifestDigest === 'string' && manifestDigest.length > 0 ? { manifestDigest } : {}),
    planDigest,
    runId,
    ...(publishedAt !== undefined ? { publishedAt } : {}),
    ...(verifyEvidence !== undefined ? { verifyEvidence } : {}),
    changeSummary: `release ${unitId} ${version} (tag ${tag}, commit ${commit})`,
  };
}

/**
 * 将 `<plugin>@<marketplace>` 或纯插件标识归一化为 `skill-family-hub` 插件 ID。
 * 若传入 npm scoped 包名（如 `@scope/pkg`）则返回 `undefined`，仅保留在通告正文中。
 */
export function normalizeHubSupersededPluginId(rawTarget) {
  if (rawTarget === undefined || rawTarget === null) return rawTarget;
  if (typeof rawTarget !== 'string' || rawTarget.trim().length === 0) return undefined;
  const trimmed = rawTarget.trim();
  if (trimmed.startsWith('@')) return undefined;
  const marketMatch = HUB_PLUGIN_AT_MARKET_RE.exec(trimmed);
  if (marketMatch) return marketMatch[1];
  if (HUB_UNIT_RE.test(trimmed)) return trimmed;
  throw new ReleaseError(
    GATE_FAILED,
    `Hub 替代插件标识 "${trimmed}" 非法；须为小写连字符插件名（如 next-gen-skill 或 next-gen-skill@skill-family-hub）`,
    { supersededBy: trimmed },
  );
}

/**
 * 版本降级或整族退役提案在 `skill-family-hub` 中的受控投递路径（`US-073`、`US-077`、`US-078`）。
 * 与 `skill-family-hub/scripts/proposal-inbox.mjs` 约定的文件名规则严格对齐：
 * - deprecate -> `incoming/<unitId>-deprecation-<version>.json`
 * - retire    -> `incoming/<unitId>-retirement-<version>.json`
 */
export function lifecycleProposalFileName(unitId, version, lifecycleAction = 'deprecate') {
  if (
    typeof unitId !== 'string' || !HUB_UNIT_RE.test(unitId)
    || typeof version !== 'string' || !STRICT_SEMVER_RE.test(version)
    || (lifecycleAction !== 'deprecate' && lifecycleAction !== 'retire')
  ) {
    throw new ReleaseError(
      GATE_FAILED,
      'lifecycle proposal file name requires valid unitId, strict SemVer version, and valid lifecycleAction',
      { unitId, version, lifecycleAction },
    );
  }
  const mode = lifecycleAction === 'retire' ? 'retirement' : 'deprecation';
  return `incoming/${unitId}-${mode}-${version}.json`;
}

/**
 * 构建与 `skill-family-hub/scripts/proposal-inbox.mjs` 闭世界字段白名单 100% 对齐的
 * 版本降级或整族退役提案文档（不含任何本地路径或未登记扩展字段）。
 */
export function buildLifecycleProposalDocument(context) {
  const {
    unitId,
    version,
    lifecycleAction,
    fallbackVersion,
    supersededBy,
    deprecationNotice,
    issuedAt,
    changeSummary,
    reason,
  } = context ?? {};

  if (lifecycleAction !== 'deprecate' && lifecycleAction !== 'retire') {
    throw new ReleaseError(GATE_FAILED, `unsupported lifecycleAction "${lifecycleAction}"`, { lifecycleAction });
  }
  if (typeof unitId !== 'string' || !HUB_UNIT_RE.test(unitId)) {
    throw new ReleaseError(GATE_FAILED, 'lifecycle proposal requires valid kebab-case unitId', { field: 'unitId', unitId });
  }
  if (typeof version !== 'string' || !STRICT_SEMVER_RE.test(version)) {
    throw new ReleaseError(GATE_FAILED, 'lifecycle proposal requires strict SemVer "version"', { field: 'version', version });
  }
  if (typeof deprecationNotice !== 'string' || deprecationNotice.trim().length === 0) {
    throw new ReleaseError(GATE_FAILED, 'lifecycle proposal requires non-empty "deprecationNotice"', { field: 'deprecationNotice' });
  }
  if (
    typeof issuedAt !== 'string'
    || !CANONICAL_ISO_RE.test(issuedAt)
    || Number.isNaN(Date.parse(issuedAt))
    || new Date(issuedAt).toISOString() !== issuedAt
  ) {
    throw new ReleaseError(
      GATE_FAILED,
      'lifecycle proposal requires canonical millisecond ISO-8601 "issuedAt" (YYYY-MM-DDTHH:mm:ss.sssZ)',
      { field: 'issuedAt', issuedAt },
    );
  }
  if (fallbackVersion !== undefined && fallbackVersion !== '') {
    if (typeof fallbackVersion !== 'string' || !STRICT_SEMVER_RE.test(fallbackVersion)) {
      throw new ReleaseError(GATE_FAILED, 'lifecycle proposal "fallbackVersion" must be strict SemVer', { field: 'fallbackVersion', fallbackVersion });
    }
  }

  const resolvedSuperseded = normalizeHubSupersededPluginId(supersededBy);
  if (resolvedSuperseded === unitId) {
    throw new ReleaseError(GATE_FAILED, `lifecycle proposal supersededBy ("${unitId}") cannot point to itself`, { unitId });
  }

  const rawSummary = typeof changeSummary === 'string' && changeSummary.trim().length > 0
    ? changeSummary.trim()
    : (typeof reason === 'string' && reason.trim().length > 0
      ? `${lifecycleAction} ${unitId} ${version}: ${reason.trim()}`
      : '');
  if (!rawSummary) {
    throw new ReleaseError(GATE_FAILED, 'lifecycle proposal requires non-empty "changeSummary"', { field: 'changeSummary' });
  }

  return {
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    kind: lifecycleAction === 'retire' ? RETIREMENT_PROPOSAL_KIND : DEPRECATION_PROPOSAL_KIND,
    unitId,
    version,
    ...(typeof fallbackVersion === 'string' && fallbackVersion.length > 0 ? { fallbackVersion } : {}),
    ...(resolvedSuperseded !== undefined ? { supersededBy: resolvedSuperseded } : {}),
    deprecationNotice: deprecationNotice.trim(),
    issuedAt,
    changeSummary: rawSummary,
  };
}
