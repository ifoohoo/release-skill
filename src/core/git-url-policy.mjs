/**
 * 发布领域远端 Git / npm 源地址安全策略与凭证隔离边界（F-05 / US-060）。
 *
 * 职责边界：
 * - 作为发布配置、发布后分发目标（postPublish）与 npm 分发源地址的统一运行时守门人；
 * - 默认公开模式（mode: "public"）严格锁定 github.com 与 https://registry.npmjs.org，零放宽；
 * - 显式受控私有源模式（mode: "controlled-private"）仅放行列入 allowedGitHosts 与
 *   allowedNpmRegistries 白名单的企业内部 GitLab / Gitea / 私有 npm 注册表，并阻断私有单元
 *   混入公开分发目标；
 * - 任何携带内嵌明文账号、密码或令牌的 URL（如 https://user:token@host/...）一律立即失败关闭，
 *   且错误提示与证据详情绝不回显原始 URL 或敏感凭据。
 *
 * @module core/git-url-policy
 */
// @decision D-RS-001
// @feature REL006
// @scenario S-007

import {
  redactUrlCredentials,
  REDACTED_URL_PLACEHOLDER,
} from 'skill-family-harness-node';
import { CONFIG_INVALID, ReleaseError } from './errors.mjs';

export const GIT_REMOTE_PROTOCOLS = Object.freeze(['http:', 'https:', 'file:']);

export const GIT_REMOTE_WRITE_GRADES = Object.freeze({
  'http:': 'remote-write',
  'https:': 'remote-write',
  'file:': 'test-transport',
});

export const DEFAULT_PUBLIC_GIT_HOSTS = Object.freeze(['github.com']);
export const DEFAULT_PUBLIC_NPM_REGISTRIES = Object.freeze(['https://registry.npmjs.org']);
export const SOURCE_POLICY_MODES = Object.freeze(['public', 'controlled-private']);
export const DEFAULT_PUBLIC_SOURCE_POLICY = Object.freeze({
  mode: 'public',
  allowedGitHosts: DEFAULT_PUBLIC_GIT_HOSTS,
  allowedNpmRegistries: DEFAULT_PUBLIC_NPM_REGISTRIES,
});

export const GIT_REMOTE_URL_REASONS = Object.freeze({
  NOT_A_STRING: 'not-a-string',
  CONTROL_CHARACTERS: 'control-characters',
  UNPARSEABLE: 'unparseable',
  PROTOCOL_NOT_ALLOWED: 'protocol-not-allowed',
  INSECURE_HTTP_NOT_ALLOWED: 'insecure-http-not-allowed',
  MISSING_HOST: 'missing-host',
  CREDENTIALS_PRESENT: 'credentials-present',
  QUERY_OR_FRAGMENT_REJECTED: 'query-or-fragment-rejected',
  NOT_A_GIT_PATH: 'not-a-git-path',
  HOST_NOT_ALLOWED: 'host-not-allowed',
});

export const NPM_REGISTRY_URL_REASONS = Object.freeze({
  NOT_A_STRING: 'not-a-string',
  CONTROL_CHARACTERS: 'control-characters',
  UNPARSEABLE: 'unparseable',
  PROTOCOL_NOT_ALLOWED: 'protocol-not-allowed',
  MISSING_HOST: 'missing-host',
  CREDENTIALS_PRESENT: 'credentials-present',
  QUERY_OR_FRAGMENT_REJECTED: 'query-or-fragment-rejected',
  REGISTRY_NOT_ALLOWED: 'registry-not-allowed',
});

const FAILURE_TEXT = Object.freeze({
  [GIT_REMOTE_URL_REASONS.NOT_A_STRING]: 'must be a non-empty string',
  [GIT_REMOTE_URL_REASONS.CONTROL_CHARACTERS]: 'contains control characters',
  [GIT_REMOTE_URL_REASONS.UNPARSEABLE]:
    'must be an absolute URL parseable by the standard URL parser',
  [GIT_REMOTE_URL_REASONS.PROTOCOL_NOT_ALLOWED]:
    'protocol must be http:, https:, or file: (file: is the test transport)',
  [GIT_REMOTE_URL_REASONS.INSECURE_HTTP_NOT_ALLOWED]:
    'protocol must be https: under controlled source policy (plain http: is rejected)',
  [GIT_REMOTE_URL_REASONS.MISSING_HOST]: 'http(s) URLs must carry a host',
  [GIT_REMOTE_URL_REASONS.CREDENTIALS_PRESENT]:
    'must never carry embedded credentials (username/password) — credentials belong to the host git credential helper, never to the URL',
  [GIT_REMOTE_URL_REASONS.QUERY_OR_FRAGMENT_REJECTED]:
    'must carry no query or fragment',
  [GIT_REMOTE_URL_REASONS.NOT_A_GIT_PATH]: 'pathname must end in .git',
  [GIT_REMOTE_URL_REASONS.HOST_NOT_ALLOWED]:
    'host is not in the configured allowedGitHosts source policy allowlist',
});

const NPM_FAILURE_TEXT = Object.freeze({
  [NPM_REGISTRY_URL_REASONS.NOT_A_STRING]: 'must be a non-empty string',
  [NPM_REGISTRY_URL_REASONS.CONTROL_CHARACTERS]: 'contains control characters',
  [NPM_REGISTRY_URL_REASONS.UNPARSEABLE]:
    'must be an absolute HTTPS URL parseable by the standard URL parser',
  [NPM_REGISTRY_URL_REASONS.PROTOCOL_NOT_ALLOWED]:
    'protocol must be https: (plain http: or non-HTTP schemes are rejected)',
  [NPM_REGISTRY_URL_REASONS.MISSING_HOST]: 'registry URL must carry a host',
  [NPM_REGISTRY_URL_REASONS.CREDENTIALS_PRESENT]:
    'must never carry embedded credentials (username/token) — supply npm tokens via host environment or .npmrc, never inside the URL',
  [NPM_REGISTRY_URL_REASONS.QUERY_OR_FRAGMENT_REJECTED]:
    'must carry no query or fragment',
  [NPM_REGISTRY_URL_REASONS.REGISTRY_NOT_ALLOWED]:
    'registry is not in the configured allowedNpmRegistries source policy allowlist',
});

const HOST_ENTRY_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[1-9][0-9]{0,4})?$/;

export function describeGitRemoteUrlFailure(reason) {
  return FAILURE_TEXT[reason] ?? 'is not an allowed Git remote URL';
}

export function describeNpmRegistryUrlFailure(reason) {
  return NPM_FAILURE_TEXT[reason] ?? 'is not an allowed npm registry URL';
}

/**
 * 检测字符串中是否内嵌 URL userinfo 凭据（含无法完整解析的畸形 authority 形态）。
 *
 * @param {*} value
 * @returns {boolean}
 */
export function hasEmbeddedUrlCredentials(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const parsed = new URL(value);
    if (parsed.username !== '' || parsed.password !== '') return true;
  } catch {
    // 畸形 URL 仍继续检查原始 authority 段是否带有 @
  }
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s'"<>`]*@/.test(value.trim());
}

export function normalizeGitHostEntry(rawHost) {
  if (typeof rawHost !== 'string' || rawHost.trim().length === 0) return null;
  if (/[\x00-\x1f\x7f]/.test(rawHost)) return null;
  const lowered = rawHost.trim().toLowerCase();
  if (lowered.includes('://') || lowered.includes('@') || lowered.includes('/') || lowered.includes('..')) {
    return null;
  }
  if (!HOST_ENTRY_RE.test(lowered)) return null;
  return lowered;
}

function isGitHostPermitted(url, allowedGitHosts) {
  const hostWithPort = url.host.toLowerCase();
  const bareHostname = url.hostname.toLowerCase();
  for (const rawAllowed of allowedGitHosts) {
    const normalized = normalizeGitHostEntry(rawAllowed);
    if (!normalized) continue;
    if (normalized.includes(':')) {
      if (hostWithPort === normalized) return true;
    } else if (bareHostname === normalized && url.port === '') {
      return true;
    }
  }
  return false;
}

/**
 * 校验单个远端 Git URL 的协议、路径形状、凭证隔离与可选主机白名单边界。
 *
 * @param {*} remoteUrl
 * @param {object} [options]
 * @param {'public'|'controlled-private'} [options.mode]
 * @param {string[]} [options.allowedGitHosts]
 * @param {boolean} [options.allowInsecureHttp=true]
 * @param {boolean} [options.allowFileTransport=true]
 * @returns {{ ok: true, protocol: string, host: string, grade: string } | { ok: false, reason: string }}
 */
export function checkGitRemoteUrl(remoteUrl, options = {}) {
  if (typeof remoteUrl !== 'string' || remoteUrl.length === 0) {
    return { ok: false, reason: GIT_REMOTE_URL_REASONS.NOT_A_STRING };
  }
  if (/[\x00-\x1f\x7f]/.test(remoteUrl)) {
    return { ok: false, reason: GIT_REMOTE_URL_REASONS.CONTROL_CHARACTERS };
  }
  let url;
  try {
    url = new URL(remoteUrl);
  } catch {
    if (hasEmbeddedUrlCredentials(remoteUrl)) {
      return { ok: false, reason: GIT_REMOTE_URL_REASONS.CREDENTIALS_PRESENT };
    }
    return { ok: false, reason: GIT_REMOTE_URL_REASONS.UNPARSEABLE };
  }
  if (!GIT_REMOTE_PROTOCOLS.includes(url.protocol)) {
    return { ok: false, reason: GIT_REMOTE_URL_REASONS.PROTOCOL_NOT_ALLOWED };
  }
  if (url.protocol === 'file:' && options.allowFileTransport === false) {
    return { ok: false, reason: GIT_REMOTE_URL_REASONS.PROTOCOL_NOT_ALLOWED };
  }
  if (url.protocol === 'http:' && options.allowInsecureHttp === false) {
    return { ok: false, reason: GIT_REMOTE_URL_REASONS.INSECURE_HTTP_NOT_ALLOWED };
  }
  if (url.protocol !== 'file:' && url.hostname === '') {
    return { ok: false, reason: GIT_REMOTE_URL_REASONS.MISSING_HOST };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: GIT_REMOTE_URL_REASONS.CREDENTIALS_PRESENT };
  }
  if (url.search !== '' || url.hash !== '') {
    return { ok: false, reason: GIT_REMOTE_URL_REASONS.QUERY_OR_FRAGMENT_REJECTED };
  }
  if (!url.pathname.endsWith('.git')) {
    return { ok: false, reason: GIT_REMOTE_URL_REASONS.NOT_A_GIT_PATH };
  }
  if (url.protocol !== 'file:') {
    const effectiveHosts = Array.isArray(options.allowedGitHosts)
      ? options.allowedGitHosts
      : (options.mode === 'public' ? DEFAULT_PUBLIC_GIT_HOSTS : null);
    if (effectiveHosts !== null && !isGitHostPermitted(url, effectiveHosts)) {
      return { ok: false, reason: GIT_REMOTE_URL_REASONS.HOST_NOT_ALLOWED };
    }
  }
  return {
    ok: true,
    protocol: url.protocol,
    host: url.host.toLowerCase(),
    grade: GIT_REMOTE_WRITE_GRADES[url.protocol],
  };
}

export function isAllowedGitRemoteUrl(remoteUrl, options = {}) {
  return checkGitRemoteUrl(remoteUrl, options).ok === true;
}

export function resolveGitRemoteWriteGrade(remoteUrl, options = {}) {
  const verdict = checkGitRemoteUrl(remoteUrl, options);
  return verdict.ok ? verdict.grade : null;
}

function canonicalizeRegistryUrlObject(parsed) {
  const copy = new URL(parsed.toString());
  copy.pathname = copy.pathname.replace(/\/+$/, '');
  return copy.toString().replace(/\/$/, '');
}

/**
 * 校验 npm 注册表 URL 的 HTTPS 协议、零内嵌凭证与可选注册表白名单边界。
 *
 * @param {*} registryUrl
 * @param {object} [options]
 * @param {'public'|'controlled-private'} [options.mode]
 * @param {string[]} [options.allowedNpmRegistries]
 * @param {boolean} [options.allowInsecureHttp=false]
 * @returns {{ ok: true, normalizedRegistry: string } | { ok: false, reason: string }}
 */
export function checkNpmRegistryUrl(registryUrl, options = {}) {
  if (typeof registryUrl !== 'string' || registryUrl.trim().length === 0) {
    return { ok: false, reason: NPM_REGISTRY_URL_REASONS.NOT_A_STRING };
  }
  if (/[\x00-\x1f\x7f]/.test(registryUrl)) {
    return { ok: false, reason: NPM_REGISTRY_URL_REASONS.CONTROL_CHARACTERS };
  }
  let url;
  try {
    url = new URL(registryUrl.trim());
  } catch {
    if (hasEmbeddedUrlCredentials(registryUrl)) {
      return { ok: false, reason: NPM_REGISTRY_URL_REASONS.CREDENTIALS_PRESENT };
    }
    return { ok: false, reason: NPM_REGISTRY_URL_REASONS.UNPARSEABLE };
  }
  const allowedProtocols = options.allowInsecureHttp === true ? ['https:', 'http:'] : ['https:'];
  if (!allowedProtocols.includes(url.protocol)) {
    return { ok: false, reason: NPM_REGISTRY_URL_REASONS.PROTOCOL_NOT_ALLOWED };
  }
  if (url.hostname === '') {
    return { ok: false, reason: NPM_REGISTRY_URL_REASONS.MISSING_HOST };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: NPM_REGISTRY_URL_REASONS.CREDENTIALS_PRESENT };
  }
  if (url.search !== '' || url.hash !== '') {
    return { ok: false, reason: NPM_REGISTRY_URL_REASONS.QUERY_OR_FRAGMENT_REJECTED };
  }
  const normalizedRegistry = canonicalizeRegistryUrlObject(url);
  const effectiveRegistries = Array.isArray(options.allowedNpmRegistries)
    ? options.allowedNpmRegistries
    : (options.mode === 'public' ? DEFAULT_PUBLIC_NPM_REGISTRIES : null);
  if (effectiveRegistries !== null) {
    const normalizedAllowlist = new Set();
    for (const entry of effectiveRegistries) {
      const checked = checkNpmRegistryUrl(entry);
      if (checked.ok) normalizedAllowlist.add(checked.normalizedRegistry);
    }
    if (!normalizedAllowlist.has(normalizedRegistry)) {
      return { ok: false, reason: NPM_REGISTRY_URL_REASONS.REGISTRY_NOT_ALLOWED };
    }
  }
  return { ok: true, normalizedRegistry };
}

/**
 * 校验并归一化 policy.sourcePolicy 声明对象（公开模式零放宽，受控私有模式强制显式白名单）。
 *
 * @param {object|undefined|null} sourcePolicy
 * @returns {{ mode: 'public'|'controlled-private', allowedGitHosts: string[], allowedNpmRegistries: string[] }}
 */
export function validateSourcePolicyDeclaration(sourcePolicy) {
  if (!sourcePolicy || typeof sourcePolicy !== 'object' || Array.isArray(sourcePolicy)) {
    throw new ReleaseError(CONFIG_INVALID, 'policy.sourcePolicy 必须是非空对象');
  }
  const mode = sourcePolicy.mode ?? 'public';
  if (!SOURCE_POLICY_MODES.includes(mode)) {
    throw new ReleaseError(
      CONFIG_INVALID,
      'policy.sourcePolicy.mode 必须为 "public" 或 "controlled-private"',
      { field: 'policy.sourcePolicy.mode' },
    );
  }
  const rawGitHosts = sourcePolicy.allowedGitHosts ?? [...DEFAULT_PUBLIC_GIT_HOSTS];
  if (!Array.isArray(rawGitHosts) || rawGitHosts.length === 0) {
    throw new ReleaseError(CONFIG_INVALID, 'policy.sourcePolicy.allowedGitHosts 必须是非空域名数组', {
      field: 'policy.sourcePolicy.allowedGitHosts',
    });
  }
  const allowedGitHosts = [];
  for (const rawHost of rawGitHosts) {
    if (hasEmbeddedUrlCredentials(rawHost) || (typeof rawHost === 'string' && rawHost.includes('@'))) {
      throw new ReleaseError(
        CONFIG_INVALID,
        'policy.sourcePolicy.allowedGitHosts 严禁包含账号或令牌凭据（@）',
        { field: 'policy.sourcePolicy.allowedGitHosts', reason: GIT_REMOTE_URL_REASONS.CREDENTIALS_PRESENT },
      );
    }
    const normalized = normalizeGitHostEntry(rawHost);
    if (!normalized) {
      throw new ReleaseError(
        CONFIG_INVALID,
        'policy.sourcePolicy.allowedGitHosts 条目必须是合法主机名（禁止带协议前缀或路径）',
        { field: 'policy.sourcePolicy.allowedGitHosts' },
      );
    }
    if (!allowedGitHosts.includes(normalized)) allowedGitHosts.push(normalized);
  }

  const rawNpmRegistries = sourcePolicy.allowedNpmRegistries ?? [...DEFAULT_PUBLIC_NPM_REGISTRIES];
  if (!Array.isArray(rawNpmRegistries) || rawNpmRegistries.length === 0) {
    throw new ReleaseError(CONFIG_INVALID, 'policy.sourcePolicy.allowedNpmRegistries 必须是非空 HTTPS 地址数组', {
      field: 'policy.sourcePolicy.allowedNpmRegistries',
    });
  }
  const allowedNpmRegistries = [];
  for (const rawReg of rawNpmRegistries) {
    const verdict = checkNpmRegistryUrl(rawReg);
    if (!verdict.ok) {
      throw new ReleaseError(
        CONFIG_INVALID,
        `policy.sourcePolicy.allowedNpmRegistries 条目非法：${describeNpmRegistryUrlFailure(verdict.reason)}`,
        { field: 'policy.sourcePolicy.allowedNpmRegistries', reason: verdict.reason },
      );
    }
    if (!allowedNpmRegistries.includes(verdict.normalizedRegistry)) {
      allowedNpmRegistries.push(verdict.normalizedRegistry);
    }
  }

  if (mode === 'public') {
    if (allowedGitHosts.length !== 1 || allowedGitHosts[0] !== 'github.com') {
      throw new ReleaseError(
        CONFIG_INVALID,
        '公开模式（policy.sourcePolicy.mode: "public"）仅允许 github.com，严禁放宽私有 Git 域名',
        { field: 'policy.sourcePolicy.allowedGitHosts', reason: GIT_REMOTE_URL_REASONS.HOST_NOT_ALLOWED },
      );
    }
    if (allowedNpmRegistries.length !== 1 || allowedNpmRegistries[0] !== 'https://registry.npmjs.org') {
      throw new ReleaseError(
        CONFIG_INVALID,
        '公开模式（policy.sourcePolicy.mode: "public"）仅允许 https://registry.npmjs.org，严禁放宽私有 npm 注册表',
        { field: 'policy.sourcePolicy.allowedNpmRegistries', reason: NPM_REGISTRY_URL_REASONS.REGISTRY_NOT_ALLOWED },
      );
    }
  }

  return Object.freeze({
    mode,
    allowedGitHosts: Object.freeze(allowedGitHosts),
    allowedNpmRegistries: Object.freeze(allowedNpmRegistries),
  });
}

/**
 * 对项目配置执行全量凭证隔离与源地址策略校验：
 * 未显式配置 policy.sourcePolicy 时默认采用严格公开策略（github.com + https://registry.npmjs.org），
 * 严禁因省略 sourcePolicy 而旁路 Git 主机或 npm 注册表白名单校验。
 *
 * @param {object} config
 * @returns {{ enforced: boolean, mode: string, allowedGitHosts: readonly string[], allowedNpmRegistries: readonly string[] }}
 */
export function enforceProjectSourcePolicy(config) {
  const hasExplicitPolicy = Boolean(config?.policy?.sourcePolicy);
  const policy = hasExplicitPolicy
    ? validateSourcePolicyDeclaration(config.policy.sourcePolicy)
    : DEFAULT_PUBLIC_SOURCE_POLICY;

  for (const unit of config?.releaseUnits ?? []) {
    if (!unit || typeof unit !== 'object') continue;
    const unitVisibility = unit.visibility ?? 'public';

    if (unitVisibility === 'private' && policy.mode !== 'controlled-private') {
      throw new ReleaseError(
        CONFIG_INVALID,
        `发布单元 "${unit.id}" 标记为 private，必须同时显式配置 policy.sourcePolicy.mode: "controlled-private" 以防混入默认公开管道`,
        { unitId: unit.id, field: 'releaseUnits[].visibility', reason: 'PRIVATE_UNIT_IN_PUBLIC_MODE' },
      );
    }

    for (const dist of unit.distributions ?? []) {
      if (!dist || typeof dist !== 'object') continue;
      if (typeof dist.marketplaceSource === 'string' && hasEmbeddedUrlCredentials(dist.marketplaceSource)) {
        throw new ReleaseError(
          CONFIG_INVALID,
          `发布单元 "${unit.id}" 的 marketplaceSource 严禁内嵌账号或密码凭据`,
          { unitId: unit.id, field: 'distributions[].marketplaceSource', reason: GIT_REMOTE_URL_REASONS.CREDENTIALS_PRESENT },
        );
      }
      if (dist.type === 'npm' && typeof dist.registry === 'string') {
        if (hasEmbeddedUrlCredentials(dist.registry)) {
          throw new ReleaseError(
            CONFIG_INVALID,
            `发布单元 "${unit.id}" 的 npm registry ${describeNpmRegistryUrlFailure(NPM_REGISTRY_URL_REASONS.CREDENTIALS_PRESENT)}`,
            { unitId: unit.id, field: 'distributions[].registry', reason: NPM_REGISTRY_URL_REASONS.CREDENTIALS_PRESENT },
          );
        }
        if (unitVisibility === 'private' && dist.access === 'public') {
          throw new ReleaseError(
            CONFIG_INVALID,
            `私有发布单元 "${unit.id}" 禁止将 npm 分发声明为 access: "public"`,
            { unitId: unit.id, field: 'distributions[].access', reason: 'PRIVATE_UNIT_PUBLIC_NPM_ACCESS' },
          );
        }
        const regVerdict = checkNpmRegistryUrl(dist.registry, {
          mode: policy.mode,
          allowedNpmRegistries: policy.allowedNpmRegistries,
        });
        if (!regVerdict.ok) {
          throw new ReleaseError(
            CONFIG_INVALID,
            `发布单元 "${unit.id}" 的 npm registry 未通过源策略校验：${describeNpmRegistryUrlFailure(regVerdict.reason)}`,
            { unitId: unit.id, field: 'distributions[].registry', reason: regVerdict.reason },
          );
        }
      }
    }

    for (const target of unit.postPublish?.targets ?? []) {
      if (!target || typeof target !== 'object') continue;
      if (typeof target.remoteUrl === 'string' && hasEmbeddedUrlCredentials(target.remoteUrl)) {
        throw new ReleaseError(
          CONFIG_INVALID,
          `发布单元 "${unit.id}" 的 postPublish.targets "${target.id}" remoteUrl ${describeGitRemoteUrlFailure(GIT_REMOTE_URL_REASONS.CREDENTIALS_PRESENT)}`,
          { unitId: unit.id, field: 'postPublish.targets[].remoteUrl', reason: GIT_REMOTE_URL_REASONS.CREDENTIALS_PRESENT },
        );
      }
      if (unitVisibility === 'private' && target.visibility === 'public') {
        throw new ReleaseError(
          CONFIG_INVALID,
          `私有发布单元 "${unit.id}" 严禁分发至 visibility: "public" 的公开目标 "${target.id}"`,
          { unitId: unit.id, targetId: target.id, reason: 'PRIVATE_UNIT_PUBLIC_TARGET' },
        );
      }
      if (typeof target.remoteUrl === 'string') {
        const targetAllowedHosts = target.visibility === 'public'
          ? DEFAULT_PUBLIC_GIT_HOSTS
          : policy.allowedGitHosts;
        const urlVerdict = checkGitRemoteUrl(target.remoteUrl, {
          mode: policy.mode,
          allowedGitHosts: targetAllowedHosts,
        });
        if (!urlVerdict.ok) {
          throw new ReleaseError(
            CONFIG_INVALID,
            `发布单元 "${unit.id}" 的分发目标 "${target.id}" 未通过源策略校验：${describeGitRemoteUrlFailure(urlVerdict.reason)}`,
            { unitId: unit.id, targetId: target.id, reason: urlVerdict.reason },
          );
        }
      }
    }

    const hostFields = [
      ['production.githubHost', unit.production?.githubHost ?? 'github.com'],
      ['previousPublicBaseline.githubHost', unit.previousPublicBaseline?.githubHost],
      ['postPublish.localHostUpdate.hub.githubHost', unit.postPublish?.localHostUpdate?.hub?.githubHost],
    ];
    for (const [fieldLabel, hostVal] of hostFields) {
      if (hostVal === undefined) continue;
      const probeUrl = `https://${hostVal}/org/repo.git`;
      const verdict = checkGitRemoteUrl(probeUrl, {
        mode: policy.mode,
        allowedGitHosts: policy.allowedGitHosts,
      });
      if (!verdict.ok) {
        throw new ReleaseError(
          CONFIG_INVALID,
          `发布单元 "${unit.id}" 的 ${fieldLabel} 未列入源策略白名单：${describeGitRemoteUrlFailure(verdict.reason)}`,
          { unitId: unit.id, field: fieldLabel, reason: verdict.reason },
        );
      }
    }
  }

  return {
    enforced: true,
    mode: policy.mode,
    allowedGitHosts: policy.allowedGitHosts,
    allowedNpmRegistries: policy.allowedNpmRegistries,
  };
}

export function redactUrlCredentialsIfPresent(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  let url;
  try {
    url = new URL(value);
  } catch {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*@/.test(value)) {
      return REDACTED_URL_PLACEHOLDER;
    }
    return value;
  }
  if (url.username === '' && url.password === '') return value;
  return redactUrlCredentials(url);
}

const URL_SPAN_RE = /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s'"<>`]+/g;

export function redactEmbeddedUrlCredentials(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  if (!text.includes('://')) return text;
  return text.replace(URL_SPAN_RE, (span) => redactUrlCredentialsIfPresent(span));
}
