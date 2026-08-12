/**
 * Plugin marketplace adapter for release-skill.
 *
 * Validates generated Claude/Codex plugin manifests and installable content.
 * Uses `execFile` to call `node` for manifest validation. Never uses `exec`,
 * `execSync`, or `shell: true`.
 *
 * Marketplace install actions only require
 * `context.isolatedConsumerWritesAuthorized === true`; they write to
 * isolated consumer directories, not to remote services.
 *
 * @module adapters/plugin-marketplace
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat, mkdir, readdir, realpath, lstat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, basename } from 'node:path';

import {
  ActionType,
  ActionStatus,
  createResult,
  assertWritesAuthorized,
  assertIsolatedConsumerWritesAuthorized,
  matchObservation,
  resolveTimeoutMs,
  SAFE_ID_RE,
  writeEvidenceAtomic,
} from './contract.mjs';

import {
  computeInstallationContractDigest,
  INSTALLATION_CONTRACT_ALGORITHM_VERSION,
} from '../core/installation-contract.mjs';

import { createHash } from 'node:crypto';
import { computeFrozenSnapshot, resolveFrozenPath } from '../snapshot/frozen.mjs';
import { PLATFORMS, getPlatform, resolvePlatformRoute, resolveCapabilityConflicts } from '../platforms/registry.mjs';
import {
  KIMI_REQUIREMENT_FILE,
  KIMI_ATTESTATION_FILE,
  resolveBoundPlanDigest,
  kimiAuthorityDir,
  validateKimiAttestation,
  readKimiManifest,
} from '../platforms/kimi.mjs';
import {
  CODEBUDDY_REQUIREMENT_FILE,
  CODEBUDDY_ATTESTATION_FILE,
  resolveCodeBuddyMarketplace,
  resolveCodeBuddyMarketplaceSource,
  resolveCodeBuddyBoundPlanDigest,
  codebuddyAuthorityDir,
  validateCodeBuddyAttestation,
} from '../platforms/codebuddy.mjs';
import {
  CODEX_REQUIREMENT_FILE,
  CODEX_ATTESTATION_FILE,
  resolveCodexBoundPlanDigest,
  codexAuthorityDir,
  validateCodexAttestation,
} from '../platforms/codex.mjs';

const execFile = promisify(execFileCb);

const NAME = 'plugin-marketplace';

function transportPayload(entries) {
  return entries.map(({ path, type, mode, size, contentDigest }) => ({
    path,
    type,
    // The local authority removes write bits when sealing. Git checkout and
    // plugin installation restore owner-write permission, while preserving
    // executable intent. Ignore only write bits; retain every other mode bit.
    mode: mode & ~0o222,
    size,
    contentDigest,
  }));
}

/**
 * Payload verification contract marker written into marketplace install
 * action parameters by prepare. Plans declaring this contract verify the
 * installed payload by declared-manifest containment (every authority file
 * present and byte-identical; host-added files recorded, not failed).
 * Actions without the marker keep the legacy full-tree equality semantics.
 */
const PAYLOAD_CONTRACT_DECLARED_MANIFEST = 'declared-manifest-v1';
/**
 * External independent marketplace contract. The marketplace index lives in an
 * external repository (frozen by prepare via marketplaceCommitSha + add-ref);
 * the unit snapshot carries only the plugin manifest. The installed payload is
 * verified by whole-tree ('.') containment with the same semantics as
 * declared-manifest-v1 (every authority file present and byte-identical;
 * host-added files recorded as extraInstalledPaths, not failed).
 */
const PAYLOAD_CONTRACT_EXTERNAL_MARKETPLACE = 'external-marketplace-v1';
/** Audit cap: at most this many extra installed paths are recorded. */
const EXTRA_INSTALLED_PATHS_CAP = 200;
/** Diagnostic cap: at most this many conflict paths are listed per error. */
const PAYLOAD_CONFLICT_REPORT_CAP = 10;

/** 消费端安装验证配方版本（与 prepare.mjs 一致）。 */
const CONSUMER_INSTALL_RECIPE_VERSION = 'consumer-install-v1';

// Consumer-owned transport metadata written into the plugin install root
// that is not part of the published payload (e.g. codex's root `.git`
// checkout and `.codex-plugin/migrated-command-skills/`, claude's `.in_use`
// marker) lives in each platform's `knownHostArtifacts` registry data. Only
// the legacy payload path (frozen plans without a `payloadContract` marker)
// applies that list; declared-manifest-v1 verification never excludes
// anything — host-added files are recorded as `extraInstalledPaths` instead.

/**
 * Resolve the marketplace root directory within a snapshot.
 *
 * For bundled-family layouts, the marketplace root is the directory that
 * contains the platform's `.claude-plugin/marketplace.json` (or equivalent).
 * Entry `source` paths in the marketplace index are relative to this root.
 *
 * Resolution rules:
 * 1. If no explicit marketplaceIndexPath is provided, the root is "." (root layout).
 * 2. If marketplaceIndexPath equals the platform default, the root is ".".
 * 3. If marketplaceIndexPath ends with "/" + platform default (exact suffix match),
 *    the prefix is the marketplace root.
 * 4. Otherwise, throws: the path is not a valid marketplace index path.
 *
 * Uses exact suffix matching only; never uses string `includes` to guess.
 *
 * @param {object} platform - Platform descriptor from the registry.
 * @param {string} [marketplaceIndexPath] - Explicit marketplace index path override.
 * @returns {string} Normalized marketplace root ("." for root layout).
 * @throws {Error} If marketplaceIndexPath is provided but doesn't match expectations.
 */
export function resolveMarketplaceRoot(platform, marketplaceIndexPath) {
  const defaultMarketplace = platform.manifestPaths.marketplace;
  if (!defaultMarketplace) {
    // Platform has no marketplace (kimi) — root concept doesn't apply.
    return '.';
  }

  if (!marketplaceIndexPath || marketplaceIndexPath === defaultMarketplace) {
    // No override or same as default → root layout.
    return '.';
  }

  // Exact suffix match: marketplaceIndexPath must end with "/" + defaultMarketplace
  const suffix = `/${defaultMarketplace}`;
  if (marketplaceIndexPath.endsWith(suffix)) {
    const root = marketplaceIndexPath.slice(0, -suffix.length);
    if (root.length === 0) return '.';
    // Validate root is a safe relative path (no escape)
    if (root.startsWith('/') || root.includes('..') || root.includes('\\')) {
      throw new Error(
        `derived marketplace root "${root}" from marketplaceIndexPath "${marketplaceIndexPath}" is not a safe relative path`,
      );
    }
    return root;
  }

  throw new Error(
    `marketplaceIndexPath "${marketplaceIndexPath}" does not end with platform default marketplace path "${defaultMarketplace}"`,
  );
}

/**
 * Extract the marketplace plugin entry's declared source as a validated,
 * normalized snapshot-relative subpath ("." for root layouts).
 *
 * The rejection set is preserved verbatim from the preflight safety checks:
 * non-empty string, no absolute paths, no ".." traversal (substring check,
 * deliberately stricter than per-segment), no backslashes, no remote URLs.
 * Normalization runs AFTER validation and collapses "./", ".", and trailing
 * slashes. Throws with the preflight's exact error messages.
 */
function extractDeclaredPluginSource(consumer, entry) {
  const platform = getPlatform(consumer);
  // Source form is registry data: claude declares a plain string, codex an
  // {source:"local",path} object; any other form has no raw source.
  const rawSource = platform.marketplaceSourceForm === 'string'
    ? entry.source
    : platform.marketplaceSourceForm === 'local-path-object'
      ? (entry.source?.source === 'local' ? entry.source?.path : null)
      : null;
  if (typeof rawSource !== 'string' || rawSource.length === 0) {
    throw new Error(`marketplace plugin entry source must be a non-empty relative path${platform.marketplaceSourceForm === 'local-path-object' ? ' (object with source:"local")' : ''}, got ${JSON.stringify(entry.source)}`);
  }
  if (
    rawSource.startsWith('/') ||
    rawSource.includes('..') ||
    rawSource.includes('\\') ||
    /^https?:\/\//i.test(rawSource)
  ) {
    throw new Error(`marketplace plugin entry source "${rawSource}" is not a safe relative path`);
  }
  const segments = rawSource.split('/').filter((segment) => segment !== '' && segment !== '.');
  // Redundant post-normalization invariant: ".." was already rejected by the
  // substring check above; fail closed if it ever survives normalization.
  if (segments.some((segment) => segment === '..')) {
    throw new Error(`marketplace plugin entry source "${rawSource}" is not a safe relative path`);
  }
  return segments.length === 0 ? '.' : segments.join('/');
}

/**
 * 从市场索引中解析插件根目录并读取插件 manifest。
 *
 * 单一权威来源解析逻辑：
 * 1. 从 marketIndex.plugins 中按 pluginName 筛选唯一匹配条目
 * 2. 使用 extractDeclaredPluginSource 安全解析条目 source 字段
 * 3. 将 source 安全拼接到 marketplaceRoot（快照绝对路径）并做逃逸检查
 * 4. 在解析后的插件根目录下读取 platform.manifestPaths.plugin
 *
 * Kimi（无市场）返回 null。其他平台在市场索引为空或条目不唯一时失败关闭。
 *
 * @param {object|null} marketIndex - 市场索引对象（null 表示 Kimi 无市场）
 * @param {string} pluginName - 要查找的插件名称
 * @param {object} platform - 平台注册表条目
 * @param {string} snapshotDir - 快照目录绝对路径
 * @param {string} [marketplaceRootRel] - 市场根相对路径（"." 或如 "adapters/claude"）；
 *   默认 "."（根布局）。条目 source 相对此路径解析，而非快照根。
 * @returns {Promise<{manifest: object, manifestRelativePath: string, pluginRoot: string}|null>}
 */
export async function resolvePluginManifestFromMarketplaceEntrySource(
  marketIndex,
  pluginName,
  platform,
  snapshotDir,
  marketplaceRootRel = '.',
) {
  // Kimi 无市场索引：返回 null（调用方使用平台级 manifest 规则）
  if (platform.manifestPaths.marketplace === null && !marketIndex) {
    return null;
  }

  if (!marketIndex || typeof marketIndex !== 'object') {
    throw new Error('marketplace index is required for non-kimi platforms');
  }

  const plugins = Array.isArray(marketIndex.plugins) ? marketIndex.plugins : [];
  const matches = plugins.filter((entry) => entry && entry.name === pluginName);
  if (matches.length !== 1) {
    throw new Error(
      `marketplace index must contain exactly one plugin entry named "${pluginName}", found ${matches.length}`,
    );
  }

  const entry = matches[0];
  const sourcePath = extractDeclaredPluginSource(platform.id, entry);

  // 安全拼接：source 路径已在 extractDeclaredPluginSource 中验证无逃逸。
  // source 相对市场根解析（marketplaceRootRel），而非快照根。
  // 这里再做 realpath 二次确认防止符号链接逃逸。
  // macOS 的 /var -> /private/var 符号链接会导致 snapshotDir 与 realpath 不同，
  // 因此必须先将 snapshotDir 解析为真实路径再做 containment 检查。
  const snapshotDirReal = await realpath(snapshotDir).catch(() => snapshotDir);
  const marketplaceRootAbs = marketplaceRootRel === '.'
    ? snapshotDirReal
    : resolve(snapshotDirReal, marketplaceRootRel);
  const pluginRootAbs = resolve(marketplaceRootAbs, sourcePath);
  const pluginRootReal = await realpath(pluginRootAbs).catch(() => null);
  if (!pluginRootReal) {
    throw new Error(`marketplace plugin entry source "${sourcePath}" does not exist in snapshot`);
  }

  // 逃逸检查：解析后的插件根必须在快照目录内
  const containment = relative(snapshotDirReal, pluginRootReal);
  const sep = process.platform === 'win32' ? '\\' : '/';
  if (
    containment !== '' &&
    (isAbsolute(containment) || containment === '..' || containment.startsWith(`..${sep}`))
  ) {
    throw new Error(`marketplace plugin entry source "${sourcePath}" escapes the snapshot after symlink resolution`);
  }

  // 读取插件 manifest
  const manifestRelative = platform.manifestPaths.plugin;
  const manifestAbs = resolve(pluginRootReal, manifestRelative);

  // 计算 manifestRelativePath：相对快照根的完整路径
  const pluginRootRelToSnapshot = relative(snapshotDirReal, pluginRootReal);
  const fullManifestRelative = pluginRootRelToSnapshot === ''
    ? manifestRelative
    : `${pluginRootRelToSnapshot}/${manifestRelative}`;

  let raw;
  try {
    raw = await readFile(manifestAbs, 'utf8');
  } catch (err) {
    throw new Error(
      `plugin manifest not found at "${fullManifestRelative}": ${err.message}`,
    );
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `plugin manifest at "${fullManifestRelative}" is not valid JSON: ${err.message}`,
    );
  }

  return {
    manifest,
    manifestRelativePath: fullManifestRelative,
    pluginRoot: pluginRootRelToSnapshot || '.',
  };
}

/**
 * 验证 installationContractDigest：从冻结快照读取插件 manifest，
 * 按平台注册表和来源形态构建安装契约，以 consumer-install-v1 重算摘要并比对。
 *
 * @param {object} action - 展开后的 action（parameters 已展开到顶层）
 * @param {string} snapshotDirReal - 冻结快照的 realpath
 * @param {object} platform - 平台注册表条目
 * @returns {Promise<{valid: boolean, error: string|null}>}
 */
async function validateInstallationContractDigest(action, snapshotDirReal, platform) {
  const form = action.marketplaceSourceType;

  // 1. 确定是否纳入市场条目，并获取条目（manifest 读取依赖条目 source 路径）
  const hasMarketplacePath = platform.manifestPaths.marketplace !== null;
  let includeMarketplaceEntry = false;
  let selectedMarketplaceEntry = null;
  let marketplaceIndexRelative = null;
  let marketIndexParsed = null;

  if (form === 'bundled-family') {
    includeMarketplaceEntry = hasMarketplacePath;
    if (includeMarketplaceEntry) {
      // 从快照中读取 bundled 市场索引，提取唯一匹配条目。
      // marketplaceIndexPath 若存在（嵌套布局），用作完整索引路径；
      // 否则使用平台默认路径（根布局）。
      marketplaceIndexRelative = action.marketplaceIndexPath ?? platform.manifestPaths.marketplace;
      const marketplacePath = resolve(snapshotDirReal, marketplaceIndexRelative);
      const mkResult = await validateManifestFile(marketplacePath, ['name', 'plugins']);
      if (!mkResult.valid) {
        return { valid: false, error: `installationContractDigest 验证失败：市场索引读取失败：${mkResult.error}` };
      }
      const plugins = mkResult.manifest.plugins;
      if (!Array.isArray(plugins)) {
        return { valid: false, error: `installationContractDigest 验证失败：市场索引 plugins 非数组` };
      }
      const matches = plugins.filter((p) => p && p.name === action.plugin);
      if (matches.length !== 1) {
        return { valid: false, error: `installationContractDigest 验证失败：市场索引中匹配 "${action.plugin}" 的条目数量为 ${matches.length}` };
      }
      selectedMarketplaceEntry = matches[0];
      marketIndexParsed = mkResult.manifest;
    }
  } else if (form === 'standalone-index') {
    // 独立市场：Kimi 不纳入市场条目（Kimi 无市场 CLI，selectedEntry
    // 仅供静态校验独立市场身份字段，不进入安装契约摘要）。
    // Claude/Codex/CodeBuddy 使用 action 中的 selectedEntry 和 marketplaceIndexPath。
    if (platform.id !== 'kimi' && action.selectedEntry && action.marketplaceIndexPath) {
      includeMarketplaceEntry = true;
      selectedMarketplaceEntry = action.selectedEntry;
      marketplaceIndexRelative = action.marketplaceIndexPath;
    }
  }

  // 2. 读取插件 manifest：使用市场条目 source 路径解析（单一权威 helper）。
  //    bundled-family + 有市场索引：通过 resolvePluginManifestFromMarketplaceEntrySource
  //    从条目 source 安全解析插件根并读取 manifest。
  //    其他路径：保留原有策略。
  let pluginManifestParsed;
  let pluginManifestRelative;

  if (form === 'bundled-family' && marketIndexParsed && platform.marketplaceSourceForm !== null) {
    // bundled-family 有市场索引且平台支持市场来源解析（Claude/Codex）：
    // 使用权威 helper 从条目 source 解析。
    // 计算市场根：从 marketplaceIndexRelative 推断（精确后缀匹配）。
    const mktRoot = resolveMarketplaceRoot(platform, marketplaceIndexRelative);
    try {
      const resolved = await resolvePluginManifestFromMarketplaceEntrySource(
        marketIndexParsed, action.plugin, platform, snapshotDirReal, mktRoot,
      );
      pluginManifestParsed = resolved.manifest;
      pluginManifestRelative = resolved.manifestRelativePath;
    } catch (err) {
      return { valid: false, error: `installationContractDigest 验证失败：${err.message}` };
    }
  } else if (platform.strategy.readManifest) {
    // Kimi/CodeBuddy/Codex 有自定义 manifest 读取策略
    const readResult = await platform.strategy.readManifest(snapshotDirReal);
    pluginManifestParsed = readResult.manifest;
    pluginManifestRelative = readResult.manifestRelative ?? platform.manifestPaths.plugin;
  } else {
    // Claude fallback（standalone-index 或无市场索引时）
    pluginManifestRelative = platform.manifestPaths.plugin;
    const pluginManifestPath = resolve(snapshotDirReal, pluginManifestRelative);
    const manifestResult = await validateManifestFile(pluginManifestPath, ['name', 'version']);
    if (!manifestResult.valid) {
      return { valid: false, error: `installationContractDigest 验证失败：插件 manifest 读取失败：${manifestResult.error}` };
    }
    pluginManifestParsed = manifestResult.manifest;
  }

  // 3. 使用权威构建/摘要函数重算
  const computedDigest = computeInstallationContractDigest({
    distributionType: platform.distributionType,
    manifestRelativePath: pluginManifestRelative,
    manifest: pluginManifestParsed,
    marketplaceSourceType: form,
    includeMarketplaceEntry,
    ...(includeMarketplaceEntry ? {
      marketplaceIndexRelativePath: marketplaceIndexRelative,
      selectedMarketplaceEntry,
    } : {}),
    verificationRecipeVersion: CONSUMER_INSTALL_RECIPE_VERSION,
  });

  if (computedDigest !== action.installationContractDigest) {
    return {
      valid: false,
      error: `installationContractDigest 不匹配：预期 ${action.installationContractDigest.slice(0, 16)}...，重算 ${computedDigest.slice(0, 16)}...`,
    };
  }

  return { valid: true, error: null };
}

/**
 * Resolve the payload subpath the consumer CLI installs for this action,
 * read from the marketplace manifest inside the digest-verified frozen
 * snapshot. Returns "." when the whole snapshot is the installed payload
 * (root layouts, and kimi which has no marketplace manifest).
 *
 * Throws (fail closed) if the manifest is absent from the verified entries,
 * unreadable, names a different marketplace, or does not declare exactly
 * one plugins[] entry for action.plugin. The manifest itself lives inside
 * the digest-sealed snapshot, so the declared subpath is authority-bound:
 * tampering with it fails the snapshot digest revalidation first.
 */
async function resolveInstalledPayloadSubpath(snapshotDir, sourceEntries, action, consumer) {
  // External independent marketplace form: the marketplace index lives in the
  // external repository, not the unit snapshot (which may carry no marketplace
  // manifest). The whole snapshot is the installed payload — short-circuit to
  // "." without reading any marketplace manifest. kimi/codebuddy/inline never
  // carry these markers, so they fall through to their existing branches below.
  if (
    action.payloadContract === PAYLOAD_CONTRACT_EXTERNAL_MARKETPLACE
    || action.marketplaceLocation === 'external'
  ) {
    return '.';
  }
  // Platforms without a marketplace manifest (kimi) install the whole
  // snapshot as the payload.
  const marketplaceRelative = getPlatform(consumer).manifestPaths.marketplace;
  if (marketplaceRelative === null) return '.';
  // Anchor the manifest read to the digest-verified entry walk: the target
  // must be one of the regular files that already passed the fail-closed
  // read checks (O_NOFOLLOW, single link, before/after stat stability).
  const anchored = sourceEntries.some((entry) => entry.type === 'file' && entry.path === marketplaceRelative);
  if (!anchored) {
    throw new Error(`frozen snapshot is missing the marketplace manifest ${marketplaceRelative}`);
  }
  const result = await validateManifestFile(resolve(snapshotDir, marketplaceRelative), ['name', 'plugins']);
  if (!result.valid) {
    throw new Error(`frozen snapshot ${marketplaceRelative} invalid: ${result.error}`);
  }
  if (result.manifest.name !== action.marketplace) {
    throw new Error(`marketplace manifest name "${result.manifest.name}" does not match action marketplace "${action.marketplace}"`);
  }
  const plugins = result.manifest.plugins;
  if (!Array.isArray(plugins)) {
    throw new Error(`${marketplaceRelative} must have a plugins[] array`);
  }
  const matches = plugins.filter((entry) => entry.name === action.plugin);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one plugins[] entry with name "${action.plugin}", found ${matches.length}`);
  }
  return extractDeclaredPluginSource(consumer, matches[0]);
}

export async function verifyInstalledMarketplacePayload(action, context, installPath, consumer) {
  const sourcePath = await resolveFrozenPath(
    context.root,
    action.snapshotPath,
    'frozen marketplace snapshot',
  );
  const sourceSnapshot = await computeFrozenSnapshot(sourcePath);
  if (sourceSnapshot.digest !== action.manifestDigest) {
    throw new Error('frozen marketplace snapshot digest no longer matches the plan');
  }
  // Consumer marketplaces install only the plugin entry's declared source
  // subtree (e.g. "./adapters/claude"), not the whole unit snapshot. The
  // sealed whole-snapshot digest above remains the authority; bind the
  // installed payload to that snapshot's declared subtree. Root layouts
  // and kimi keep the whole-tree comparison ("." subpath, no filtering).
  const payloadSubpath = await resolveInstalledPayloadSubpath(
    sourcePath,
    sourceSnapshot.entries,
    action,
    consumer,
  );
  const prefix = payloadSubpath === '.' ? null : `${payloadSubpath}/`;
  const authorityEntries = prefix === null
    ? sourceSnapshot.entries
    : sourceSnapshot.entries
        // The trailing slash keeps sibling directories (e.g.
        // "adapters/claude-x") out of the comparison set. Prefix removal on
        // a path-sorted array is order-preserving, so no re-sort is needed.
        .filter((entry) => entry.path.startsWith(prefix))
        .map((entry) => ({ ...entry, path: entry.path.slice(prefix.length) }));
  if (authorityEntries.length === 0) {
    throw new Error('frozen snapshot contains no payload under the declared marketplace source');
  }
  // Contract selection is bound by the frozen plan: prepare writes
  // `payloadContract` into marketplace install action parameters; frozen
  // plans without the marker keep the legacy full-tree equality semantics
  // byte-for-byte (including the consumer transport exclusion list).
  const payloadContract = action.payloadContract;
  if (
    payloadContract !== undefined
    && payloadContract !== PAYLOAD_CONTRACT_DECLARED_MANIFEST
    && payloadContract !== PAYLOAD_CONTRACT_EXTERNAL_MARKETPLACE
  ) {
    throw new Error(`unsupported marketplace payload contract: ${JSON.stringify(payloadContract)}`);
  }
  if (
    payloadContract === PAYLOAD_CONTRACT_DECLARED_MANIFEST
    || payloadContract === PAYLOAD_CONTRACT_EXTERNAL_MARKETPLACE
  ) {
    // declared-manifest-v1 / external-marketplace-v1: every authority entry
    // must exist in the installed payload and agree in
    // type/size/bytes/non-write mode bits. Host-added files are NOT failures —
    // they are recorded (relative paths, capped) as audit evidence so host
    // evolution can never break a release, while any missing or altered
    // declared file still fails closed. The two contracts share this
    // containment semantics; they differ only in the authority subtree source
    // (declared-manifest reads the entry's declared source subpath; external
    // short-circuits to the whole tree '.').
    const installedSnapshot = await computeFrozenSnapshot(installPath);
    const authorityPayload = transportPayload(authorityEntries);
    const installedByPath = new Map(
      transportPayload(installedSnapshot.entries).map((entry) => [entry.path, entry]),
    );
    const conflicts = [];
    for (const authorityEntry of authorityPayload) {
      const installedEntry = installedByPath.get(authorityEntry.path);
      if (!installedEntry) {
        conflicts.push(`missing: ${authorityEntry.path}`);
        continue;
      }
      if (installedEntry.type !== authorityEntry.type) {
        conflicts.push(`type mismatch: ${authorityEntry.path}`);
      } else if (
        installedEntry.size !== authorityEntry.size ||
        installedEntry.contentDigest !== authorityEntry.contentDigest
      ) {
        conflicts.push(`content mismatch: ${authorityEntry.path}`);
      } else if (installedEntry.mode !== authorityEntry.mode) {
        conflicts.push(`mode mismatch: ${authorityEntry.path}`);
      }
    }
    if (conflicts.length > 0) {
      const listed = conflicts.slice(0, PAYLOAD_CONFLICT_REPORT_CAP).join('; ');
      const overflow = conflicts.length > PAYLOAD_CONFLICT_REPORT_CAP
        ? `; and ${conflicts.length - PAYLOAD_CONFLICT_REPORT_CAP} more conflicting path(s)`
        : '';
      throw new Error(
        `installed marketplace payload differs in path, bytes, size, or non-write mode bits (${payloadContract}): ${listed}${overflow}`,
      );
    }
    const authorityPaths = new Set(authorityPayload.map((entry) => entry.path));
    const extraPaths = installedSnapshot.entries
      .map((entry) => entry.path)
      .filter((path) => !authorityPaths.has(path));
    const extraInstalledPaths = extraPaths.slice(0, EXTRA_INSTALLED_PATHS_CAP);
    // This is not an expected-value backfill: the sealed authority digest was
    // revalidated above and every declared file was independently compared.
    return {
      manifestDigest: action.manifestDigest,
      extraInstalledPaths,
      ...(extraPaths.length > EXTRA_INSTALLED_PATHS_CAP
        ? { extraInstalledPathsTotal: extraPaths.length }
        : {}),
    };
  }
  // Legacy contract (frozen plans without payloadContract): full-tree
  // equality against the consumer-exclusion-filtered install tree. Behavior
  // is frozen byte-for-byte; do not change.
  const installedSnapshot = await computeFrozenSnapshot(installPath, {
    excludeRootEntries: getPlatform(consumer).knownHostArtifacts,
  });
  if (
    JSON.stringify(transportPayload(authorityEntries))
    !== JSON.stringify(transportPayload(installedSnapshot.entries))
  ) {
    throw new Error('installed marketplace payload differs in path, bytes, size, or non-write mode bits');
  }
  return { manifestDigest: action.manifestDigest };
}

/**
 * Build the audit fields recorded when a declared-manifest-v1 verification
 * observes host-added files in the install tree. Empty for legacy bindings
 * (and for failed bindings), so legacy observations stay byte-identical.
 */
function extraInstalledPathsAudit(binding) {
  if (!binding || !Array.isArray(binding.extraInstalledPaths)) return {};
  return {
    extraInstalledPaths: binding.extraInstalledPaths,
    ...(binding.extraInstalledPathsTotal !== undefined
      ? { extraInstalledPathsTotal: binding.extraInstalledPathsTotal }
      : {}),
  };
}

// The kimi protocol closure (manual-install requirement, human attestation
// validation, manifest reading, shared constants) lives in
// ../platforms/kimi.mjs and is referenced from the platform registry's kimi
// strategy table. Shared adapter primitives (SAFE_ID_RE, resolveTimeoutMs,
// writeEvidenceAtomic) live in ./contract.mjs.

/**
 * Validate that a manifest `skills` value is a safe plugin-root-relative path.
 *
 * Accepts "./" or "./some/dir/" forms. Rejects absolute paths, ".." traversal,
 * backslashes, and URLs. Returns the normalized root-relative path (no leading
 * "./"). Throws on unsafe values.
 *
 * @param {string} skillsRaw
 * @returns {string} normalized relative path ('' for the plugin root itself)
 */
function normalizeKimiSkillsRel(skillsRaw) {
  if (typeof skillsRaw !== 'string' || skillsRaw.length === 0) {
    throw new Error('kimi manifest skills must be a non-empty relative path when present');
  }
  if (
    skillsRaw.startsWith('/') ||
    skillsRaw.includes('..') ||
    skillsRaw.includes('\\') ||
    /^https?:\/\//i.test(skillsRaw)
  ) {
    throw new Error(`kimi manifest skills "${skillsRaw}" is not a safe relative path`);
  }
  let rel = skillsRaw.replace(/^\.\//, '');
  rel = rel.replace(/\/+$/, '');
  if (rel.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`kimi manifest skills "${skillsRaw}" is not a safe relative path`);
  }
  return rel;
}

/**
 * Resolve the entry SKILL.md for a Kimi plugin from its authoritative manifest.
 *
 * - When the manifest declares `skills`, the entry skill resolves under that
 *   skills root (validated + realpath-contained within the plugin root).
 * - When `skills` is omitted, Kimi's official single-skill semantics apply: the
 *   plugin root's own SKILL.md is the single skill.
 *
 * The returned path is realpath-contained within pluginRootReal and is a
 * regular, non-symlink file. Throws on missing/escaping/invalid layouts so the
 * caller fails closed.
 *
 * @param {string} pluginRootReal - realpath of the verified plugin root.
 * @param {object} manifest - parsed kimi plugin manifest.
 * @param {string} entrySkill - expected entry skill id.
 * @returns {Promise<string>} realpath of the entry SKILL.md
 */
async function resolveKimiEntrySkillFile(pluginRootReal, manifest, entrySkill) {
  if (!entrySkill || typeof entrySkill !== 'string' || !SAFE_ID_RE.test(entrySkill)) {
    throw new Error(`unsafe entrySkill: "${entrySkill}"`);
  }
  let entryAbs;
  if (manifest.skills === undefined || manifest.skills === null) {
    // Official single-skill semantics: root SKILL.md is the sole skill.
    entryAbs = resolve(pluginRootReal, 'SKILL.md');
  } else {
    const skillsRel = normalizeKimiSkillsRel(manifest.skills);
    const skillsRootAbs = skillsRel === '' ? pluginRootReal : resolve(pluginRootReal, skillsRel);
    const skillsRootReal = await realpath(skillsRootAbs).catch(() => null);
    if (!skillsRootReal) {
      throw new Error(`kimi manifest skills root does not exist: ${manifest.skills}`);
    }
    const skillsContainment = relative(pluginRootReal, skillsRootReal);
    const sepK = process.platform === 'win32' ? '\\' : '/';
    if (
      skillsContainment !== '' &&
      (isAbsolute(skillsContainment) || skillsContainment === '..' || skillsContainment.startsWith(`..${sepK}`))
    ) {
      throw new Error(`kimi manifest skills "${manifest.skills}" escapes the plugin root after symlink resolution`);
    }
    entryAbs = resolve(skillsRootReal, entrySkill, 'SKILL.md');
  }

  // lstat the LEXICAL entry BEFORE realpath. A symlinked SKILL.md must be
  // rejected outright; lstat-ing the realpath target instead would observe the
  // resolved regular file and silently miss the symlink.
  let entryLexicalStat;
  try {
    entryLexicalStat = await lstat(entryAbs);
  } catch {
    throw new Error(`kimi entry skill not found: ${relative(pluginRootReal, entryAbs) || 'SKILL.md'}`);
  }
  if (entryLexicalStat.isSymbolicLink()) {
    throw new Error('kimi entry skill must not be a symlink');
  }
  if (!entryLexicalStat.isFile()) {
    throw new Error('kimi entry skill is not a regular file');
  }

  const entryReal = await realpath(entryAbs).catch(() => null);
  if (!entryReal) {
    throw new Error(`kimi entry skill not found: ${relative(pluginRootReal, entryAbs) || 'SKILL.md'}`);
  }
  const entryContainment = relative(pluginRootReal, entryReal);
  const sepE = process.platform === 'win32' ? '\\' : '/';
  if (
    entryContainment !== '' &&
    (isAbsolute(entryContainment) || entryContainment === '..' || entryContainment.startsWith(`..${sepE}`))
  ) {
    throw new Error('kimi entry skill escapes the plugin root after symlink resolution');
  }
  return entryReal;
}

/**
 * CodeBuddy equivalent of normalizeKimiSkillsRel (parallel implementation,
 * codebuddy wording; the kimi helper above is intentionally left untouched so
 * its error strings stay byte-identical). Validates a manifest `skills` value
 * as a safe plugin-root-relative path and returns the normalized root-relative
 * path (no leading "./", no trailing "/").
 *
 * @param {string} skillsRaw
 * @returns {string} normalized relative path ('' for the plugin root itself)
 */
function normalizeCodeBuddySkillsRel(skillsRaw) {
  // CodeBuddy real validator accepts array form; extract first element for
  // backward compatibility with string form.
  let skillsPath;
  if (Array.isArray(skillsRaw)) {
    if (skillsRaw.length !== 1) {
      throw new Error(
        `codebuddy manifest skills array must have exactly one element, got ${skillsRaw.length}`,
      );
    }
    skillsPath = skillsRaw[0];
  } else if (typeof skillsRaw === 'string') {
    skillsPath = skillsRaw;
  } else {
    throw new Error('codebuddy manifest skills must be a string or single-element array when present');
  }

  if (typeof skillsPath !== 'string' || skillsPath.length === 0) {
    throw new Error('codebuddy manifest skills must be a non-empty relative path when present');
  }
  if (
    skillsPath.startsWith('/') ||
    skillsPath.includes('..') ||
    skillsPath.includes('\\') ||
    /^https?:\/\//i.test(skillsPath)
  ) {
    throw new Error(`codebuddy manifest skills "${skillsPath}" is not a safe relative path`);
  }
  let rel = skillsPath.replace(/^\.\//, '');
  rel = rel.replace(/\/+$/, '');
  if (rel.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`codebuddy manifest skills "${skillsPath}" is not a safe relative path`);
  }
  return rel;
}

/**
 * CodeBuddy equivalent of resolveKimiEntrySkillFile (parallel implementation,
 * codebuddy wording; the kimi helper above is intentionally left untouched).
 * Resolves the entry SKILL.md from the authoritative codebuddy manifest:
 * - declared `skills`: entry resolves under that validated, realpath-contained
 *   skills root;
 * - omitted `skills`: the plugin root's own SKILL.md is the single skill.
 * The returned path is realpath-contained within pluginRootReal and is a
 * regular, non-symlink file. Throws on missing/escaping/invalid layouts so the
 * caller fails closed.
 *
 * @param {string} pluginRootReal - realpath of the verified plugin root.
 * @param {object} manifest - parsed codebuddy plugin manifest.
 * @param {string} entrySkill - expected entry skill id.
 * @returns {Promise<string>} realpath of the entry SKILL.md
 */
async function resolveCodeBuddyEntrySkillFile(pluginRootReal, manifest, entrySkill) {
  if (!entrySkill || typeof entrySkill !== 'string' || !SAFE_ID_RE.test(entrySkill)) {
    throw new Error(`unsafe entrySkill: "${entrySkill}"`);
  }
  let entryAbs;
  if (manifest.skills === undefined || manifest.skills === null) {
    // Official single-skill semantics: root SKILL.md is the sole skill.
    entryAbs = resolve(pluginRootReal, 'SKILL.md');
  } else {
    const skillsRel = normalizeCodeBuddySkillsRel(manifest.skills);
    const skillsRootAbs = skillsRel === '' ? pluginRootReal : resolve(pluginRootReal, skillsRel);
    const skillsRootReal = await realpath(skillsRootAbs).catch(() => null);
    if (!skillsRootReal) {
      throw new Error(`codebuddy manifest skills root does not exist: ${manifest.skills}`);
    }
    const skillsContainment = relative(pluginRootReal, skillsRootReal);
    const sepK = process.platform === 'win32' ? '\\' : '/';
    if (
      skillsContainment !== '' &&
      (isAbsolute(skillsContainment) || skillsContainment === '..' || skillsContainment.startsWith(`..${sepK}`))
    ) {
      throw new Error(`codebuddy manifest skills "${manifest.skills}" escapes the plugin root after symlink resolution`);
    }
    entryAbs = resolve(skillsRootReal, entrySkill, 'SKILL.md');
  }

  // lstat the LEXICAL entry BEFORE realpath: a symlinked SKILL.md must be
  // rejected outright (lstat-ing the resolved target would miss the symlink).
  let entryLexicalStat;
  try {
    entryLexicalStat = await lstat(entryAbs);
  } catch {
    throw new Error(`codebuddy entry skill not found: ${relative(pluginRootReal, entryAbs) || 'SKILL.md'}`);
  }
  if (entryLexicalStat.isSymbolicLink()) {
    throw new Error('codebuddy entry skill must not be a symlink');
  }
  if (!entryLexicalStat.isFile()) {
    throw new Error('codebuddy entry skill is not a regular file');
  }

  const entryReal = await realpath(entryAbs).catch(() => null);
  if (!entryReal) {
    throw new Error(`codebuddy entry skill not found: ${relative(pluginRootReal, entryAbs) || 'SKILL.md'}`);
  }
  const entryContainment = relative(pluginRootReal, entryReal);
  const sepE = process.platform === 'win32' ? '\\' : '/';
  if (
    entryContainment !== '' &&
    (isAbsolute(entryContainment) || entryContainment === '..' || entryContainment.startsWith(`..${sepE}`))
  ) {
    throw new Error('codebuddy entry skill escapes the plugin root after symlink resolution');
  }
  return entryReal;
}

const SUPPORTED_TYPES = [
  ActionType.PLUGIN_MANIFEST_VALIDATE,
  ActionType.PLUGIN_INSTALL_CHECK,
  ActionType.CLAUDE_MARKETPLACE_INSTALL,
  ActionType.CODEX_MARKETPLACE_INSTALL,
  ActionType.KIMI_MARKETPLACE_INSTALL,
  ActionType.CODEBUDDY_MARKETPLACE_INSTALL,
];

/**
 * Classify whether an error indicates CLI/transport unavailability.
 *
 * ONLY these errors trigger human-attestation fallback for Codex:
 * - ENOENT: binary not found
 * - ETIMEDOUT/ECONNREFUSED/ECONNRESET: connection errors
 * - ENOTFOUND: DNS resolution failure
 * - spawn errors with specific codes
 *
 * All other errors (identity mismatch, malformed JSON, program bugs)
 * are hard failures and NEVER trigger fallback.
 *
 * @param {Error} err
 * @returns {boolean}
 */
function isCliOrTransportUnavailable(err) {
  if (!err || typeof err !== 'object') return false;

  // Node.js system error codes for CLI/transport unavailability
  const UNAVAILABILITY_CODES = new Set([
    'ENOENT',      // binary not found
    'ETIMEDOUT',   // connection timeout
    'ECONNREFUSED', // connection refused
    'ECONNRESET',  // connection reset
    'ENOTFOUND',   // DNS resolution failure
    'EAI_AGAIN',   // DNS temporary failure
    'EHOSTUNREACH', // host unreachable
    'ENETUNREACH',  // network unreachable
  ]);

  if (err.code && UNAVAILABILITY_CODES.has(err.code)) {
    return true;
  }

  // Check error message for spawn/ENOENT patterns
  const msg = err.message || '';
  if (msg.includes('ENOENT') || msg.includes('spawn')) {
    return true;
  }

  return false;
}

/** Safe repo pattern: owner/repo with alphanumeric, hyphens, dots, underscores. */
const SAFE_REPO_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** Safe digest pattern: 64-hex SHA-256. */
const SAFE_DIGEST_RE = /^[0-9a-f]{64}$/;

/** Valid consumer ids, derived from the platform registry (single source). */
const CONSUMER_IDS = new Set(PLATFORMS.map((p) => p.id));

/**
 * Strict semver pattern: supports prerelease and build metadata.
 * Matches: 1.0.0, 1.0.0-beta.1, 1.0.0-rc.1+build.123
 */
const STRICT_SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * Validate a Git ref for injection safety.
 * Rejects: backslash, //, leading/trailing /, trailing ., .lock, @{, standalone @,
 * .., control characters, option-like values.
 *
 * @param {string} ref
 * @returns {{ valid: boolean, error: string|null }}
 */
function validateSafeRef(ref) {
  if (!ref || typeof ref !== 'string') {
    return { valid: false, error: 'ref is required' };
  }
  if (/[\x00-\x1f]/.test(ref)) {
    return { valid: false, error: 'ref contains control characters' };
  }
  if (ref.startsWith('-')) {
    return { valid: false, error: `ref must not start with '-': "${ref}"` };
  }
  if (ref.includes('\\')) {
    return { valid: false, error: 'ref contains backslash' };
  }
  if (ref.includes('//')) {
    return { valid: false, error: 'ref contains //' };
  }
  if (ref.startsWith('/') || ref.endsWith('/')) {
    return { valid: false, error: 'ref must not start or end with /' };
  }
  if (ref.endsWith('.')) {
    return { valid: false, error: 'ref must not end with .' };
  }
  if (ref.endsWith('.lock')) {
    return { valid: false, error: 'ref must not end with .lock' };
  }
  if (ref.includes('@{')) {
    return { valid: false, error: 'ref contains @{' };
  }
  if (ref === '@') {
    return { valid: false, error: 'ref must not be standalone @' };
  }
  if (ref.includes('..')) {
    return { valid: false, error: 'ref contains ..' };
  }
  if (/[;|&`$(){}]/.test(ref)) {
    return { valid: false, error: 'ref contains shell metacharacters' };
  }
  // Must match safe alphanumeric pattern
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(ref)) {
    return { valid: false, error: `unsafe ref: "${ref}"` };
  }
  return { valid: true, error: null };
}

/**
 * Validate marketplace install parameters for injection-safe values.
 *
 * @param {object} params - The action parameters.
 * @returns {{ valid: boolean, error: string|null }}
 */
function validateMarketplaceParams(params) {
  if (!params || typeof params !== 'object') {
    return { valid: false, error: 'parameters must be an object' };
  }
  const { consumer, plugin, marketplace, repo, version, entrySkill } = params;
  if (!CONSUMER_IDS.has(consumer)) {
    return { valid: false, error: `invalid consumer: "${consumer}"` };
  }
  if (!plugin || !SAFE_ID_RE.test(plugin)) {
    return { valid: false, error: `unsafe plugin identifier: "${plugin}"` };
  }
  // marketplace is a required identity field for Claude/Codex, which have
  // scriptable marketplace add/install interfaces. Kimi Code has an interactive
  // marketplace but NO non-interactive install API, so `marketplace` carries no
  // executable meaning for kimi and is optional (validated only if present); it
  // must not become a required identity condition for kimi execution/observe.
  const consumerPlatform = getPlatform(consumer);
  const consumerRoute = resolvePlatformRoute(consumerPlatform);
  if (consumerRoute.route === 'human-attestation') {
    if (marketplace !== undefined && marketplace !== null && !SAFE_ID_RE.test(marketplace)) {
      return { valid: false, error: `unsafe marketplace identifier: "${marketplace}"` };
    }
  } else if (!marketplace || !SAFE_ID_RE.test(marketplace)) {
    return { valid: false, error: `unsafe marketplace identifier: "${marketplace}"` };
  }
  if (!repo || !SAFE_REPO_RE.test(repo)) {
    return { valid: false, error: `unsafe repo identifier: "${repo}"` };
  }
  if (!version || !STRICT_SEMVER_RE.test(version)) {
    return { valid: false, error: `unsafe version (must be valid semver): "${version}"` };
  }
  if (!entrySkill || !SAFE_ID_RE.test(entrySkill)) {
    return { valid: false, error: `unsafe entrySkill: "${entrySkill}"` };
  }
  return { valid: true, error: null };
}


/**
 * Run a CLI command using execFile (never shell: true).
 */
async function run(cmd, args, options = {}) {
  return execFile(cmd, args, {
    shell: false,
    encoding: 'utf8',
    timeout: 30_000,
    ...options,
  });
}

/**
 * Validate that a manifest file exists and contains required fields.
 *
 * @param {string} manifestPath - Absolute path to the manifest JSON file.
 * @param {string[]} requiredFields - Fields that must be present.
 * @returns {Promise<{ valid: boolean, manifest: Object|null, missing: string[], error: string|null }>}
 */
async function validateManifestFile(manifestPath, requiredFields) {
  try {
    const content = await readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(content);

    const missing = requiredFields.filter((f) => !(f in manifest));

    return {
      valid: missing.length === 0,
      manifest,
      missing,
      error: missing.length > 0 ? `Missing required fields: ${missing.join(', ')}` : null,
    };
  } catch (err) {
    return {
      valid: false,
      manifest: null,
      missing: requiredFields,
      error: `Failed to read manifest: ${err.message}`,
    };
  }
}

/**
 * Check that required files exist in a directory.
 *
 * @param {string} dir - Absolute path to check.
 * @param {string[]} requiredFiles - File paths relative to dir.
 * @returns {Promise<{ allPresent: boolean, missing: string[] }>}
 */
async function checkRequiredFiles(dir, requiredFiles) {
  const missing = [];
  for (const file of requiredFiles) {
    try {
      await stat(resolve(dir, file));
    } catch {
      missing.push(file);
    }
  }
  return { allPresent: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// 市场来源单选模型（DT-D）
// ---------------------------------------------------------------------------

/**
 * 市场来源类型常量。
 *
 * - BUNDLED_FAMILY: 技能族自带市场文件（marketplace.json 与插件代码在同一仓库）
 * - STANDALONE_INDEX: 独立市场仓库（市场索引在外部仓库，插件代码在另一仓库）
 */
export const MARKETPLACE_SOURCE_TYPES = Object.freeze({
  BUNDLED_FAMILY: 'bundled-family',
  STANDALONE_INDEX: 'standalone-index',
});

/**
 * 每个平台支持的市场来源类型。
 *
 * 所有平台均支持 bundled-family 和 standalone-index 两种来源形态。
 * 不得硬编码某个平台只能使用其中一种。
 */
const PLATFORM_SUPPORTED_SOURCES = Object.freeze({
  claude: new Set([MARKETPLACE_SOURCE_TYPES.BUNDLED_FAMILY, MARKETPLACE_SOURCE_TYPES.STANDALONE_INDEX]),
  codex: new Set([MARKETPLACE_SOURCE_TYPES.BUNDLED_FAMILY, MARKETPLACE_SOURCE_TYPES.STANDALONE_INDEX]),
  kimi: new Set([MARKETPLACE_SOURCE_TYPES.BUNDLED_FAMILY, MARKETPLACE_SOURCE_TYPES.STANDALONE_INDEX]),
  codebuddy: new Set([MARKETPLACE_SOURCE_TYPES.BUNDLED_FAMILY, MARKETPLACE_SOURCE_TYPES.STANDALONE_INDEX]),
});

/**
 * 验证市场来源单选约束：每个平台每次发布只允许一种来源。
 *
 * 根据平台能力和配置/计划中的市场来源类型进行校验：
 * 1. 混用两种来源失败关闭
 * 2. 不支持的来源类型失败关闭
 *
 * @param {string} platform - 平台标识（claude / codex / kimi / codebuddy）
 * @param {object} config - 项目配置（releaseUnit.distributions 中的一项）
 * @param {object} plan - 发布计划（units.distributions 中的一项）
 * @returns {{ valid: boolean, error: string|null, selectedSource: string|null }}
 */
export function validateMarketplaceSourceSelection(platform, config, plan) {
  // 每个平台只允许一种来源
  const configSource = config?.marketplaceSourceType ?? null;
  const planSource = plan?.marketplaceSourceType ?? null;

  // 确定选定的来源类型
  const selectedSource = planSource ?? configSource;

  if (configSource && planSource && configSource !== planSource) {
    return {
      valid: false,
      error: `平台 "${platform}" 市场来源混用：配置声明 "${configSource}"，计划声明 "${planSource}"；每次发布只允许一种来源`,
      selectedSource: null,
    };
  }

  // 如果没有声明来源类型，无法验证（向后兼容旧配置）
  if (!selectedSource) {
    return { valid: true, error: null, selectedSource: null };
  }

  // 检查来源类型是否为已知值
  const knownSources = new Set(Object.values(MARKETPLACE_SOURCE_TYPES));
  if (!knownSources.has(selectedSource)) {
    return {
      valid: false,
      error: `未知的市场来源类型 "${selectedSource}"；合法值为 ${[...knownSources].join(', ')}`,
      selectedSource: null,
    };
  }

  // 检查平台是否支持该来源类型
  const supportedSources = PLATFORM_SUPPORTED_SOURCES[platform];
  if (!supportedSources) {
    return {
      valid: false,
      error: `未知的平台 "${platform}"`,
      selectedSource: null,
    };
  }
  if (!supportedSources.has(selectedSource)) {
    const supportedList = [...supportedSources].join(', ');
    return {
      valid: false,
      error: `平台 "${platform}" 不支持市场来源 "${selectedSource}"；该平台仅支持: ${supportedList}`,
      selectedSource: null,
    };
  }

  return { valid: true, error: null, selectedSource };
}

/**
 * Create the plugin-marketplace adapter.
 *
 * @param {Object} [deps]
 * @param {typeof run} [deps.exec] - Injectable exec function for testing.
 * @returns {import('./contract.mjs').Adapter}
 */
export function createPluginMarketplaceAdapter(deps = {}) {
  const exec = deps.exec ?? run;

  return Object.freeze({
    name: NAME,
    actionTypes: SUPPORTED_TYPES,

    /**
     * Preflight: read-only checks before execution.
     * Fail-closed: snapshotPath, ref, manifestDigest are required for
     * marketplace install actions.
     */
    async preflight(action, context) {
      const { actionType } = action;

      try {
        if (actionType === ActionType.PLUGIN_MANIFEST_VALIDATE) {
          const manifestPath = action.manifestPath;
          if (!manifestPath) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: 'manifestPath is required',
            });
          }

          // Read-only check: manifest file exists and is parseable
          const result = await validateManifestFile(manifestPath, [
            'name',
            'version',
            'description',
          ]);

          if (!result.valid) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: result.error,
            });
          }

          return createResult({
            actionType,
            status: ActionStatus.PREFLIGHT_PASSED,
          });
        }

        if (actionType === ActionType.PLUGIN_INSTALL_CHECK) {
          const pluginDir = action.pluginDir;
          if (!pluginDir) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: 'pluginDir is required',
            });
          }

          // Check directory exists
          try {
            const s = await stat(pluginDir);
            if (!s.isDirectory()) {
              return createResult({
                actionType,
                status: ActionStatus.PREFLIGHT_FAILED,
                error: `pluginDir is not a directory: ${pluginDir}`,
              });
            }
          } catch {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `pluginDir does not exist: ${pluginDir}`,
            });
          }

          return createResult({
            actionType,
            status: ActionStatus.PREFLIGHT_PASSED,
          });
        }

        // Marketplace install preflight: fail-closed validation
        if (
          actionType === ActionType.CLAUDE_MARKETPLACE_INSTALL ||
          actionType === ActionType.CODEX_MARKETPLACE_INSTALL ||
          actionType === ActionType.KIMI_MARKETPLACE_INSTALL ||
          actionType === ActionType.CODEBUDDY_MARKETPLACE_INSTALL
        ) {
          // 1. Validate all parameters for injection safety
          const validation = validateMarketplaceParams(action);
          if (!validation.valid) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: validation.error,
            });
          }

          // 2. ref is required and must be safe
          const ref = action.ref;
          if (!ref) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: 'ref is required for marketplace install',
            });
          }
          const refValidation = validateSafeRef(ref);
          if (!refValidation.valid) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: refValidation.error,
            });
          }

          // 3. snapshotPath is required
          const snapshotPath = action.snapshotPath;
          if (!snapshotPath) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: 'snapshotPath is required for marketplace install',
            });
          }

          // 4. manifestDigest is required
          const manifestDigest = action.manifestDigest;
          if (!manifestDigest || typeof manifestDigest !== 'string') {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: 'manifestDigest is required for marketplace install',
            });
          }
          if (!/^[a-f0-9]{64}$/.test(manifestDigest)) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `manifestDigest must be a 64-char lowercase hex string`,
            });
          }

          // 5. Validate context (root and runDir required)
          if (!context?.root) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: 'context.root is required for marketplace install',
            });
          }
          if (!context.runDir) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: 'context.runDir is required for marketplace install',
            });
          }

          // Capability conflict check (before sourceDescriptor validation).
          // If the platform definition is internally inconsistent, fail closed.
          const consumer = action.consumer;
          const consumerPlatform = getPlatform(consumer);
          const capabilityConflicts = resolveCapabilityConflicts(consumerPlatform);
          if (capabilityConflicts.length > 0) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `platform capability conflict: ${capabilityConflicts.join('; ')}`,
            });
          }

          // 6. 统一静态预检：四平台共同执行安装来源与安装契约校验。
          // 旧冻结计划（整组新版字段完全不存在时）保留既有路径。
          // 新版字段组（installationContractDigest、algorithmVersion、marketplaceSourceType 为标志）
          // 出现任一字段时必须完整。0.2.3 已有的 marketplaceForm、sourceDescriptor、sourceCommit
          // 单独出现不得触发新版组。
          const route = resolvePlatformRoute(consumerPlatform);

          // 6a. 新版字段组检测：installationContractDigest、algorithmVersion、marketplaceSourceType
          // 任一存在时走新路径
          const NEW_FIELD_GROUP_MARKERS = ['installationContractDigest', 'algorithmVersion', 'marketplaceSourceType'];
          const hasNewFieldGroup = NEW_FIELD_GROUP_MARKERS.some(
            (f) => action[f] !== undefined && action[f] !== null,
          );

          if (hasNewFieldGroup) {
            // 新版字段组完整性：任一出现则要求全组完整
            const newFields = [
              'marketplaceForm', 'sourceDescriptor', 'installationContractDigest',
              'algorithmVersion', 'sourceCommit', 'marketplaceSourceType',
            ];
            const missingNewFields = newFields.filter((f) => action[f] === undefined || action[f] === null);
            if (missingNewFields.length > 0) {
              return createResult({
                actionType,
                status: ActionStatus.PREFLIGHT_FAILED,
                error: `新版字段组不完整，缺失: ${missingNewFields.join(', ')}；任一出现则要求全组完整`,
              });
            }

            const sd = action.sourceDescriptor;
            if (!sd || typeof sd !== 'object') {
              return createResult({
                actionType,
                status: ActionStatus.PREFLIGHT_FAILED,
                error: 'sourceDescriptor is required when installationContractDigest is present',
              });
            }

            // marketplaceForm 三方一致性
            if (action.marketplaceForm !== sd.form || action.marketplaceForm !== action.marketplaceSourceType) {
              return createResult({
                actionType,
                status: ActionStatus.PREFLIGHT_FAILED,
                error: `marketplaceForm "${action.marketplaceForm}"、sourceDescriptor.form "${sd.form}"、marketplaceSourceType "${action.marketplaceSourceType}" 三者必须一致`,
              });
            }

            // installationContractDigest 格式
            if (!SAFE_DIGEST_RE.test(action.installationContractDigest)) {
              return createResult({
                actionType,
                status: ActionStatus.PREFLIGHT_FAILED,
                error: 'installationContractDigest must be a 64-char lowercase hex string',
              });
            }

            // algorithmVersion
            if (action.algorithmVersion !== INSTALLATION_CONTRACT_ALGORITHM_VERSION) {
              return createResult({
                actionType,
                status: ActionStatus.PREFLIGHT_FAILED,
                error: `algorithmVersion must be ${INSTALLATION_CONTRACT_ALGORITHM_VERSION}, got ${action.algorithmVersion}`,
              });
            }

            // sourceCommit 格式
            if (typeof action.sourceCommit !== 'string' || !/^[0-9a-f]{40}$/.test(action.sourceCommit)) {
              return createResult({
                actionType,
                status: ActionStatus.PREFLIGHT_FAILED,
                error: 'sourceCommit must be a 40-char lowercase hex commit sha',
              });
            }

            // sourceDescriptor 共通字段
            if (typeof sd.form !== 'string' || (sd.form !== 'bundled-family' && sd.form !== 'standalone-index')) {
              return createResult({
                actionType,
                status: ActionStatus.PREFLIGHT_FAILED,
                error: `sourceDescriptor.form must be "bundled-family" or "standalone-index", got "${sd.form}"`,
              });
            }
            if (typeof sd.marketplaceEntry !== 'string' || sd.marketplaceEntry.length === 0) {
              return createResult({
                actionType,
                status: ActionStatus.PREFLIGHT_FAILED,
                error: 'sourceDescriptor.marketplaceEntry is required',
              });
            }
            if (sd.marketplaceEntry !== action.plugin) {
              return createResult({
                actionType,
                status: ActionStatus.PREFLIGHT_FAILED,
                error: `sourceDescriptor.marketplaceEntry "${sd.marketplaceEntry}" does not match action plugin "${action.plugin}"`,
              });
            }

            // 来源形态专属字段校验
            if (sd.form === 'bundled-family') {
              // bundled-family 完整性
              if (!sd.repo || !SAFE_REPO_RE.test(sd.repo)) {
                return createResult({
                  actionType,
                  status: ActionStatus.PREFLIGHT_FAILED,
                  error: 'sourceDescriptor.repo is required and must be a safe repo pattern for bundled-family form',
                });
              }
              if (sd.repo !== action.repo) {
                return createResult({
                  actionType,
                  status: ActionStatus.PREFLIGHT_FAILED,
                  error: `sourceDescriptor.repo "${sd.repo}" does not match action.repo "${action.repo}"`,
                });
              }
              if (typeof sd.commit !== 'string' || !/^[0-9a-f]{40}$/.test(sd.commit)) {
                return createResult({
                  actionType,
                  status: ActionStatus.PREFLIGHT_FAILED,
                  error: 'sourceDescriptor.commit must be a 40-hex commit sha for bundled-family form',
                });
              }
              if (sd.commit !== action.sourceCommit) {
                return createResult({
                  actionType,
                  status: ActionStatus.PREFLIGHT_FAILED,
                  error: `sourceDescriptor.commit "${sd.commit}" does not match action.sourceCommit "${action.sourceCommit}"`,
                });
              }
              if (!sd.payloadDigest || !SAFE_DIGEST_RE.test(sd.payloadDigest)) {
                return createResult({
                  actionType,
                  status: ActionStatus.PREFLIGHT_FAILED,
                  error: 'sourceDescriptor.payloadDigest must be a 64-hex digest for bundled-family form',
                });
              }
              if (sd.payloadDigest !== action.manifestDigest) {
                return createResult({
                  actionType,
                  status: ActionStatus.PREFLIGHT_FAILED,
                  error: 'sourceDescriptor.payloadDigest does not match action.manifestDigest',
                });
              }
              if (typeof sd.pluginSubpath !== 'string' || sd.pluginSubpath.length === 0) {
                return createResult({
                  actionType,
                  status: ActionStatus.PREFLIGHT_FAILED,
                  error: 'sourceDescriptor.pluginSubpath is required for bundled-family form',
                });
              }
              // 不允许独立市场专属字段（sourceDescriptor 层）
              if (sd.marketplaceRepo !== undefined || sd.marketplaceCommitSha !== undefined || sd.pluginRepo !== undefined) {
                return createResult({
                  actionType,
                  status: ActionStatus.PREFLIGHT_FAILED,
                  error: 'bundled-family sourceDescriptor must not contain standalone-index fields (marketplaceRepo, marketplaceCommitSha, pluginRepo)',
                });
              }
              // 不允许 action 顶层独立市场专属字段，避免双来源混用。
              // marketplaceIndexPath 对 bundled-family 嵌套布局也合法（指示市场根位置），
              // 因此仅禁止真正的 standalone-index 专属字段。
              if (action.marketplaceCommitSha !== undefined || action.marketplaceName !== undefined || action.selectedEntry !== undefined) {
                return createResult({
                  actionType,
                  status: ActionStatus.PREFLIGHT_FAILED,
                  error: 'bundled-family action must not contain standalone-index fields (marketplaceCommitSha, marketplaceName, selectedEntry)',
                });
              }
              // bundled-family marketplaceIndexPath 格式校验（可选，嵌套布局时存在）
              if (action.marketplaceIndexPath !== undefined && action.marketplaceIndexPath !== null) {
                if (typeof action.marketplaceIndexPath !== 'string' || action.marketplaceIndexPath.length === 0) {
                  return createResult({
                    actionType,
                    status: ActionStatus.PREFLIGHT_FAILED,
                    error: 'bundled-family marketplaceIndexPath must be a non-empty string when present',
                  });
                }
                if (
                  action.marketplaceIndexPath.startsWith('/') ||
                  action.marketplaceIndexPath.includes('..') ||
                  action.marketplaceIndexPath.includes('\\') ||
                  /^https?:\/\//i.test(action.marketplaceIndexPath)
                ) {
                  return createResult({
                    actionType,
                    status: ActionStatus.PREFLIGHT_FAILED,
                    error: `marketplaceIndexPath "${action.marketplaceIndexPath}" is not a safe relative path`,
                  });
                }
              }
            } else {
              // standalone-index 完整性
              if (!sd.marketplaceRepo || !SAFE_REPO_RE.test(sd.marketplaceRepo)) {
                return createResult({
                  actionType,
                  status: ActionStatus.PREFLIGHT_FAILED,
                  error: 'sourceDescriptor.marketplaceRepo is required for standalone-index form',
                });
              }
              if (!sd.pluginRepo || !SAFE_REPO_RE.test(sd.pluginRepo)) {
                return createResult({
                  actionType,
                  status: ActionStatus.PREFLIGHT_FAILED,
                  error: 'sourceDescriptor.pluginRepo is required for standalone-index form',
                });
              }
              if (sd.marketplaceRepo !== action.repo) {
                return createResult({
                  actionType,
                  status: ActionStatus.PREFLIGHT_FAILED,
                  error: `sourceDescriptor.marketplaceRepo "${sd.marketplaceRepo}" does not match action.repo "${action.repo}"`,
                });
              }
              if (sd.pluginRepo === sd.marketplaceRepo) {
                return createResult({
                  actionType,
                  status: ActionStatus.PREFLIGHT_FAILED,
                  error: `sourceDescriptor.pluginRepo "${sd.pluginRepo}" must differ from marketplaceRepo "${sd.marketplaceRepo}"`,
                });
              }
              if (typeof sd.marketplaceCommitSha !== 'string' || !/^[0-9a-f]{40}$/.test(sd.marketplaceCommitSha)) {
                return createResult({
                  actionType,
                  status: ActionStatus.PREFLIGHT_FAILED,
                  error: 'sourceDescriptor.marketplaceCommitSha must be a 40-hex commit sha for standalone-index form',
                });
              }
              // action 顶层 marketplaceCommitSha 必须存在、为 40 位小写提交 SHA，
              // 且等于 sourceDescriptor.marketplaceCommitSha
              if (typeof action.marketplaceCommitSha !== 'string' || !/^[0-9a-f]{40}$/.test(action.marketplaceCommitSha)) {
                return createResult({
                  actionType,
                  status: ActionStatus.PREFLIGHT_FAILED,
                  error: 'marketplaceCommitSha is required at action top level for standalone-index form',
                });
              }
              if (sd.marketplaceCommitSha !== action.marketplaceCommitSha) {
                return createResult({
                  actionType,
                  status: ActionStatus.PREFLIGHT_FAILED,
                  error: `sourceDescriptor.marketplaceCommitSha does not match action.marketplaceCommitSha`,
                });
              }
              if (typeof sd.ref !== 'string' || sd.ref.length === 0) {
                return createResult({
                  actionType,
                  status: ActionStatus.PREFLIGHT_FAILED,
                  error: 'sourceDescriptor.ref is required for standalone-index form',
                });
              }
              if (sd.ref !== action.ref) {
                return createResult({
                  actionType,
                  status: ActionStatus.PREFLIGHT_FAILED,
                  error: `sourceDescriptor.ref "${sd.ref}" does not match action.ref "${action.ref}"`,
                });
              }
              // payloadDigest 必须存在、为合法摘要且等于 manifestDigest（不能可选）
              if (!sd.payloadDigest || !SAFE_DIGEST_RE.test(sd.payloadDigest)) {
                return createResult({
                  actionType,
                  status: ActionStatus.PREFLIGHT_FAILED,
                  error: 'sourceDescriptor.payloadDigest must be a 64-hex digest for standalone-index form',
                });
              }
              if (sd.payloadDigest !== action.manifestDigest) {
                return createResult({
                  actionType,
                  status: ActionStatus.PREFLIGHT_FAILED,
                  error: 'sourceDescriptor.payloadDigest does not match action.manifestDigest',
                });
              }
              // 不允许 bundled-family 专属字段
              if (sd.commit !== undefined || sd.pluginSubpath !== undefined) {
                return createResult({
                  actionType,
                  status: ActionStatus.PREFLIGHT_FAILED,
                  error: 'standalone-index sourceDescriptor must not contain bundled-family fields (commit, pluginSubpath)',
                });
              }
            }

            // standalone-index 独立市场专属字段校验（action 层）
            if (action.marketplaceSourceType === 'standalone-index') {
              // marketplaceIndexPath 必须是安全非空相对路径
              if (typeof action.marketplaceIndexPath !== 'string' || action.marketplaceIndexPath.length === 0) {
                return createResult({
                  actionType,
                  status: ActionStatus.PREFLIGHT_FAILED,
                  error: 'marketplaceIndexPath is required for standalone-index form',
                });
              }
              if (
                action.marketplaceIndexPath.startsWith('/') ||
                action.marketplaceIndexPath.includes('..') ||
                action.marketplaceIndexPath.includes('\\') ||
                /^https?:\/\//i.test(action.marketplaceIndexPath)
              ) {
                return createResult({
                  actionType,
                  status: ActionStatus.PREFLIGHT_FAILED,
                  error: `marketplaceIndexPath "${action.marketplaceIndexPath}" is not a safe relative path`,
                });
              }
              // marketplaceName 必须是安全非空标识
              if (typeof action.marketplaceName !== 'string' || action.marketplaceName.length === 0) {
                return createResult({
                  actionType,
                  status: ActionStatus.PREFLIGHT_FAILED,
                  error: 'marketplaceName is required for standalone-index form',
                });
              }
              if (!SAFE_ID_RE.test(action.marketplaceName)) {
                return createResult({
                  actionType,
                  status: ActionStatus.PREFLIGHT_FAILED,
                  error: `unsafe marketplaceName identifier: "${action.marketplaceName}"`,
                });
              }
              // 若 action 带 marketplace，两者必须相等
              if (action.marketplace !== undefined && action.marketplace !== null && action.marketplaceName !== action.marketplace) {
                return createResult({
                  actionType,
                  status: ActionStatus.PREFLIGHT_FAILED,
                  error: `marketplaceName "${action.marketplaceName}" does not match action.marketplace "${action.marketplace}"`,
                });
              }
              // selectedEntry 必须是普通对象，name/version 绑定 action
              if (!action.selectedEntry || typeof action.selectedEntry !== 'object' || Array.isArray(action.selectedEntry)) {
                return createResult({
                  actionType,
                  status: ActionStatus.PREFLIGHT_FAILED,
                  error: 'selectedEntry must be a non-null object for standalone-index form',
                });
              }
              if (action.selectedEntry.name !== action.plugin) {
                return createResult({
                  actionType,
                  status: ActionStatus.PREFLIGHT_FAILED,
                  error: `selectedEntry.name "${action.selectedEntry.name}" does not match action.plugin "${action.plugin}"`,
                });
              }
              if (action.selectedEntry.version !== undefined && action.selectedEntry.version !== action.version) {
                return createResult({
                  actionType,
                  status: ActionStatus.PREFLIGHT_FAILED,
                  error: `selectedEntry.version "${action.selectedEntry.version}" does not match action.version "${action.version}"`,
                });
              }
            }
          } else {
            // 6b. 旧路径：sourceDescriptor 必须存在且为对象
            const sd = action.sourceDescriptor;
            if (!sd || typeof sd !== 'object') {
              return createResult({
                actionType,
                status: ActionStatus.PREFLIGHT_FAILED,
                error: 'sourceDescriptor is required for marketplace install actions',
              });
            }
            {
              // Form consistency: marketplaceForm must agree with sourceDescriptor.form.
              if (sd.form !== action.marketplaceForm) {
                return createResult({
                  actionType,
                  status: ActionStatus.PREFLIGHT_FAILED,
                  error: `sourceDescriptor.form "${sd.form}" does not match marketplaceForm "${action.marketplaceForm}"`,
                });
              }

              // payloadDigest: must be a valid 64-char lowercase hex string and
              // must not be the null hash (all zeros).
              if (typeof sd.payloadDigest !== 'string' || sd.payloadDigest.length === 0) {
                return createResult({
                  actionType,
                  status: ActionStatus.PREFLIGHT_FAILED,
                  error: 'sourceDescriptor.payloadDigest is required',
                });
              }
              if (!/^[a-f0-9]{64}$/.test(sd.payloadDigest)) {
                return createResult({
                  actionType,
                  status: ActionStatus.PREFLIGHT_FAILED,
                  error: 'sourceDescriptor.payloadDigest must be a 64-char lowercase hex string',
                });
              }
              if (sd.payloadDigest === '0'.repeat(64)) {
                return createResult({
                  actionType,
                  status: ActionStatus.PREFLIGHT_FAILED,
                  error: 'sourceDescriptor.payloadDigest must not be the null hash',
                });
              }

              // marketplaceEntry: must match the action plugin name.
              if (typeof sd.marketplaceEntry !== 'string' || sd.marketplaceEntry.length === 0) {
                return createResult({
                  actionType,
                  status: ActionStatus.PREFLIGHT_FAILED,
                  error: 'sourceDescriptor.marketplaceEntry is required',
                });
              }
              if (sd.marketplaceEntry !== action.plugin) {
                return createResult({
                  actionType,
                  status: ActionStatus.PREFLIGHT_FAILED,
                  error: `sourceDescriptor.marketplaceEntry "${sd.marketplaceEntry}" does not match action plugin "${action.plugin}"`,
                });
              }

              // Form-specific field validation.
              if (sd.form === 'bundled-family') {
                if (!sd.repo || !SAFE_REPO_RE.test(sd.repo)) {
                  return createResult({
                    actionType,
                    status: ActionStatus.PREFLIGHT_FAILED,
                    error: `sourceDescriptor.repo is required and must be a safe repo pattern`,
                  });
                }
                if (sd.repo !== action.repo) {
                  return createResult({
                    actionType,
                    status: ActionStatus.PREFLIGHT_FAILED,
                    error: `sourceDescriptor.repo "${sd.repo}" does not match action.repo "${action.repo}"`,
                  });
                }
                // commit 可选，但如果存在则必须是 40-hex 格式
                if (sd.commit !== undefined && (typeof sd.commit !== 'string' || !/^[0-9a-f]{40}$/.test(sd.commit))) {
                  return createResult({
                    actionType,
                    status: ActionStatus.PREFLIGHT_FAILED,
                    error: 'sourceDescriptor.commit must be a 40-hex commit sha for bundled-family form',
                  });
                }
                // commit 交叉校验：bundled sourceDescriptor.commit 必须与
                // action.sourceCommit（冻结的插件来源提交）一致
                if (sd.commit !== undefined && action.sourceCommit && sd.commit !== action.sourceCommit) {
                  return createResult({
                    actionType,
                    status: ActionStatus.PREFLIGHT_FAILED,
                    error: `sourceDescriptor.commit "${sd.commit}" does not match action.sourceCommit "${action.sourceCommit}"`,
                  });
                }
                // payloadDigest 格式校验（可选，但如果存在则必须是 64-hex）
                if (sd.payloadDigest !== undefined && (!sd.payloadDigest || !SAFE_DIGEST_RE.test(sd.payloadDigest))) {
                  return createResult({
                    actionType,
                    status: ActionStatus.PREFLIGHT_FAILED,
                    error: 'sourceDescriptor.payloadDigest is required for bundled-family form',
                  });
                }
                // payloadDigest 交叉校验：必须与 action.manifestDigest（冻结的载荷摘要）一致
                if (sd.payloadDigest !== undefined && action.manifestDigest && sd.payloadDigest !== action.manifestDigest) {
                  return createResult({
                    actionType,
                    status: ActionStatus.PREFLIGHT_FAILED,
                    error: `sourceDescriptor.payloadDigest does not match action.manifestDigest`,
                  });
                }
                if (typeof sd.pluginSubpath !== 'string' || sd.pluginSubpath.length === 0) {
                  return createResult({
                    actionType,
                    status: ActionStatus.PREFLIGHT_FAILED,
                    error: 'sourceDescriptor.pluginSubpath is required for bundled-family form',
                  });
                }
              } else if (sd.form === 'standalone-index') {
                if (!sd.pluginRepo || !SAFE_REPO_RE.test(sd.pluginRepo)) {
                  return createResult({
                    actionType,
                    status: ActionStatus.PREFLIGHT_FAILED,
                    error: `sourceDescriptor.pluginRepo is required for standalone-index form`,
                  });
                }
                if (!sd.marketplaceRepo || !SAFE_REPO_RE.test(sd.marketplaceRepo)) {
                  return createResult({
                    actionType,
                    status: ActionStatus.PREFLIGHT_FAILED,
                    error: 'sourceDescriptor.marketplaceRepo is required for standalone-index form',
                  });
                }
                // 独立市场身份交叉校验：
                // 1. marketplaceRepo 必须等于 action.repo（市场仓库身份）
                if (sd.marketplaceRepo !== action.repo) {
                  return createResult({
                    actionType,
                    status: ActionStatus.PREFLIGHT_FAILED,
                    error: `sourceDescriptor.marketplaceRepo "${sd.marketplaceRepo}" does not match action.repo "${action.repo}"`,
                  });
                }
                // 2. pluginRepo 必须与 marketplaceRepo 不同（发布单元仓库 ≠ 市场仓库）
                if (sd.pluginRepo === sd.marketplaceRepo) {
                  return createResult({
                    actionType,
                    status: ActionStatus.PREFLIGHT_FAILED,
                    error: `sourceDescriptor.pluginRepo "${sd.pluginRepo}" must differ from marketplaceRepo "${sd.marketplaceRepo}"`,
                  });
                }
                if (
                  typeof sd.marketplaceCommitSha !== 'string'
                  || !/^[0-9a-f]{40}$/.test(sd.marketplaceCommitSha)
                ) {
                  return createResult({
                    actionType,
                    status: ActionStatus.PREFLIGHT_FAILED,
                    error: 'sourceDescriptor.marketplaceCommitSha must be a 40-hex commit sha for standalone-index form',
                  });
                }
                // 3. marketplaceCommitSha 交叉校验（与 action 层一致）
                if (action.marketplaceCommitSha && sd.marketplaceCommitSha !== action.marketplaceCommitSha) {
                  return createResult({
                    actionType,
                    status: ActionStatus.PREFLIGHT_FAILED,
                    error: `sourceDescriptor.marketplaceCommitSha "${sd.marketplaceCommitSha}" does not match action.marketplaceCommitSha "${action.marketplaceCommitSha}"`,
                  });
                }
                if (typeof sd.ref !== 'string' || sd.ref.length === 0) {
                  return createResult({
                    actionType,
                    status: ActionStatus.PREFLIGHT_FAILED,
                    error: 'sourceDescriptor.ref is required for standalone-index form',
                  });
                }
                // 4. payloadDigest 格式校验（可选，但如果存在则必须是 64-hex）
                if (sd.payloadDigest !== undefined && (!sd.payloadDigest || !SAFE_DIGEST_RE.test(sd.payloadDigest))) {
                  return createResult({
                    actionType,
                    status: ActionStatus.PREFLIGHT_FAILED,
                    error: 'sourceDescriptor.payloadDigest must be a 64-hex digest for standalone-index form',
                  });
                }
                // 5. payloadDigest 交叉校验：必须与 action.manifestDigest（冻结的载荷摘要）一致
                if (sd.payloadDigest !== undefined && action.manifestDigest && sd.payloadDigest !== action.manifestDigest) {
                  return createResult({
                    actionType,
                    status: ActionStatus.PREFLIGHT_FAILED,
                    error: `sourceDescriptor.payloadDigest does not match action.manifestDigest`,
                  });
                }
              } else {
                return createResult({
                  actionType,
                  status: ActionStatus.PREFLIGHT_FAILED,
                  error: `sourceDescriptor.form "${sd.form}" is not a recognized form (expected "bundled-family" or "standalone-index")`,
                });
              }
            }
          }

          // 7. Verify frozen snapshot exists and contains required marketplace files
          const platform = consumerPlatform;
          const platformRoute = route;
          let snapshotDirReal;
          // Authoritative kimi manifest (from the frozen snapshot), used to
          // resolve the entry skill via the manifest-declared skills root.
          let kimiSnapshotManifest = null;
          try {
            snapshotDirReal = await resolveFrozenPath(context.root, snapshotPath, 'frozen snapshot path');
          } catch (frozenErr) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `frozen snapshot validation failed: ${frozenErr.message}`,
            });
          }

          // A human-attestation platform (kimi, codebuddy) has no trustworthy
          // automated install: the whole repo is installed as one plugin. The
          // authoritative manifest is read from the verified snapshot root via
          // the platform strategy (kimi: kimi.plugin.json over
          // .kimi-plugin/plugin.json; codebuddy: .codebuddy-plugin/plugin.json).
          if (platformRoute.route === 'human-attestation') {
            // Error-message label keeps the kimi wording byte-identical while
            // giving codebuddy its own wording.
            const manifestLabel = consumer === 'codebuddy' ? 'codebuddy' : 'kimi';
            let kimiManifestResult;
            try {
              kimiManifestResult = await platform.strategy.readManifest(snapshotDirReal);
            } catch (manifestErr) {
              return createResult({
                actionType,
                status: ActionStatus.PREFLIGHT_FAILED,
                error: `frozen snapshot ${manifestLabel} manifest invalid: ${manifestErr.message}`,
              });
            }
            const kimiManifest = kimiManifestResult.manifest;
            if (typeof kimiManifest.name !== 'string' || kimiManifest.name !== action.plugin) {
              return createResult({
                actionType,
                status: ActionStatus.PREFLIGHT_FAILED,
                error: `plugin manifest name "${kimiManifest.name}" does not match action plugin "${action.plugin}"`,
              });
            }
            if (typeof kimiManifest.version !== 'string' || kimiManifest.version !== action.version) {
              return createResult({
                actionType,
                status: ActionStatus.PREFLIGHT_FAILED,
                error: `plugin manifest version "${kimiManifest.version}" does not match action version "${action.version}"`,
              });
            }
            kimiSnapshotManifest = kimiManifest;
          }

          // pluginRootForEntrySkill: the resolved plugin root directory for
          // entry skill validation. Set inside the structured-cli non-external
          // path; null for external/human-attestation (falls back to snapshotDirReal).
          let pluginRootForEntrySkill = null;

          if (platformRoute.route === 'structured-cli') {
          let sourceDirReal = null;
          if (action.marketplaceLocation === 'external') {
          // External independent marketplace form: the marketplace index lives
          // in the external repository (frozen by prepare), NOT in the unit
          // snapshot, so the snapshot marketplace-manifest section is skipped
          // entirely. The plugin manifest is read directly from the snapshot
          // root and the frozen external identity fields are validated. ref was
          // already injection-checked above (step 2); the entry skill reuses the
          // automatable fixed layout validated below.
          if (
            typeof action.marketplaceCommitSha !== 'string'
            || !/^[0-9a-f]{40}$/.test(action.marketplaceCommitSha)
          ) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `external marketplace marketplaceCommitSha must be a 40-hex commit sha, got ${JSON.stringify(action.marketplaceCommitSha)}`,
            });
          }
          if (
            typeof action.repo !== 'string'
            || !/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(action.repo)
          ) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `external marketplace repo must be an owner/name repository, got ${JSON.stringify(action.repo)}`,
            });
          }
          const externalManifestRelative = platform.manifestPaths.plugin;
          const externalManifestPath = resolve(snapshotDirReal, externalManifestRelative);
          const externalManifestResult = await validateManifestFile(externalManifestPath, ['name', 'version']);
          if (!externalManifestResult.valid) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `frozen snapshot ${externalManifestRelative} invalid: ${externalManifestResult.error}`,
            });
          }
          if (externalManifestResult.manifest.name !== action.plugin) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `plugin manifest name "${externalManifestResult.manifest.name}" does not match action plugin "${action.plugin}"`,
            });
          }
          if (externalManifestResult.manifest.version !== action.version) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `plugin manifest version "${externalManifestResult.manifest.version}" does not match action version "${action.version}"`,
            });
          }
          } else {
          // Verify marketplace files exist.
          // marketplace.json 的路径：嵌套布局使用 action.marketplaceIndexPath，
          // 根布局使用平台默认路径。条目 source 相对市场根解析。
          const marketplaceRelative = action.marketplaceIndexPath ?? platform.manifestPaths.marketplace;

          // 计算市场根（精确后缀匹配）
          let mktRoot;
          try {
            mktRoot = resolveMarketplaceRoot(platform, marketplaceRelative);
          } catch (mktRootErr) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `marketplace root resolution failed: ${mktRootErr.message}`,
            });
          }

          const marketplacePath = resolve(snapshotDirReal, marketplaceRelative);

          // marketplace.json must exist and have root name (no root version required)
          const marketplaceResult = await validateManifestFile(marketplacePath, ['name']);
          if (!marketplaceResult.valid) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `frozen snapshot ${marketplaceRelative} invalid: ${marketplaceResult.error}`,
            });
          }

          // Root name must equal action.marketplace
          if (marketplaceResult.manifest.name !== action.marketplace) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `marketplace.json name "${marketplaceResult.manifest.name}" does not match action marketplace "${action.marketplace}"`,
            });
          }

          // plugins[] must exist with exactly one entry matching action.plugin
          const plugins = marketplaceResult.manifest.plugins;
          if (!Array.isArray(plugins)) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `${marketplaceRelative} must have a plugins[] array`,
            });
          }
          const pluginEntry = plugins.filter((p) => p.name === action.plugin);
          if (pluginEntry.length !== 1) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `expected exactly one plugins[] entry with name "${action.plugin}", found ${pluginEntry.length}`,
            });
          }
          const entry = pluginEntry[0];

          // Entry source must be a safe relative path within the snapshot.
          // Accepts "./" (root-level), "./adapters/claude" (subdirectory),
          // etc. Rejects absolute paths, ".." traversal, remote URLs, and
          // empty strings. Normalized to "." for root layouts; the same
          // helper backs verify-side payload subtree resolution, so both
          // paths can never drift apart.
          // source 相对市场根（mktRoot）解析，而非快照根。
          let sourcePath;
          try {
            sourcePath = extractDeclaredPluginSource(consumer, entry);
          } catch (sourceErr) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: sourceErr.message,
            });
          }
          // Verify the declared source directory exists and contains the
          // expected plugin manifest inside the frozen snapshot.
          // source 相对市场根解析
          const mktRootAbs = mktRoot === '.' ? snapshotDirReal : resolve(snapshotDirReal, mktRoot);
          const sourceDirAbs = resolve(mktRootAbs, sourcePath);
          sourceDirReal = await realpath(sourceDirAbs).catch(() => null);
          if (!sourceDirReal) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `marketplace plugin entry source directory does not exist: ${sourcePath}`,
            });
          }
          // Containment check: source must stay inside the snapshot
          const sourceRelCheck = relative(snapshotDirReal, sourceDirReal);
          if (sourceRelCheck.startsWith('..') || isAbsolute(sourceRelCheck)) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `marketplace plugin entry source "${sourcePath}" escapes the frozen snapshot`,
            });
          }
          // Save plugin root for entry skill validation (visible outside structured-cli block)
          pluginRootForEntrySkill = sourceDirReal;

          // Resolve plugin manifest relative to the declared source path.
          // For root layouts (source: "./"), this resolves to
          //   snapshot/.claude-plugin/plugin.json
          // For nested layouts (marketRoot: "adapters/claude", source: "."),
          //   this resolves to snapshot/adapters/claude/.claude-plugin/plugin.json
          const pluginRootRelToSnapshot = relative(snapshotDirReal, sourceDirReal) || '.';
          const manifestRelative = pluginRootRelToSnapshot === '.'
            ? platform.manifestPaths.plugin
            : `${pluginRootRelToSnapshot}/${platform.manifestPaths.plugin}`;
          const manifestPath = resolve(snapshotDirReal, manifestRelative);

          const manifestResult = await validateManifestFile(manifestPath, ['name', 'version']);
          if (!manifestResult.valid) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `frozen snapshot ${manifestRelative} invalid: ${manifestResult.error}`,
            });
          }

          // Whether the marketplace entry itself carries the authoritative
          // version is a platform protocol split (registry data): claude
          // binds entry.version to the action version, codex keeps the
          // authoritative version in .codex-plugin/plugin.json (the entry
          // version is never bound), kimi has no marketplace.
          if (platform.marketplaceEntryCarriesVersion && entry.version !== action.version) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `marketplace plugin entry version "${entry.version}" does not match action version "${action.version}"`,
            });
          }

          // Verify plugin manifest name/version match marketplace entry
          const pluginManifestResult = await validateManifestFile(manifestPath, ['name', 'version']);
          if (!pluginManifestResult.valid) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `frozen snapshot ${manifestRelative} invalid: ${pluginManifestResult.error}`,
            });
          }
          if (pluginManifestResult.manifest.name !== entry.name) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `plugin manifest name "${pluginManifestResult.manifest.name}" does not match marketplace entry name "${entry.name}"`,
            });
          }
          if (pluginManifestResult.manifest.version !== action.version) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `plugin manifest version "${pluginManifestResult.manifest.version}" does not match action version "${action.version}"`,
            });
          }
          }
          }

          // Verify the entry skill exists in the snapshot.
          // Structured-cli platforms' manifests always declare ./skills/, so the
          // fixed skills/<entrySkill>/SKILL.md layout is authoritative for
          // them. A human-attestation platform (kimi, codebuddy) resolves the
          // entry skill via the manifest-declared skills root (MAJOR-4): the
          // root is validated + realpath-contained, and omitted `skills` means
          // the official single-skill root SKILL.md.
          if (platformRoute.route === 'human-attestation') {
            const resolveEntrySkillFile = consumer === 'codebuddy'
              ? resolveCodeBuddyEntrySkillFile
              : resolveKimiEntrySkillFile;
            try {
              await resolveEntrySkillFile(snapshotDirReal, kimiSnapshotManifest, action.entrySkill);
            } catch (entryErr) {
              return createResult({
                actionType,
                status: ActionStatus.PREFLIGHT_FAILED,
                error: `entry skill not resolvable in snapshot: ${entryErr.message}`,
              });
            }
          } else {
            // Entry skill 相对插件根解析（嵌套布局时 pluginRoot != snapshotRoot）。
            // pluginRootForEntrySkill 在非 external 结构化 CLI 路径中已确定；
            // external 路径或 human-attestation（null）时回退到 snapshotDirReal。
            const pluginRootForSkill = pluginRootForEntrySkill || snapshotDirReal;
            const entrySkillFile = resolve(pluginRootForSkill, 'skills', action.entrySkill, 'SKILL.md');
            try {
              await stat(entrySkillFile);
            } catch {
              const skillRel = relative(snapshotDirReal, entrySkillFile) || `skills/${action.entrySkill}/SKILL.md`;
              return createResult({
                actionType,
                status: ActionStatus.PREFLIGHT_FAILED,
                error: `entry skill not found in snapshot: ${skillRel}`,
              });
            }
          }

          // Verify manifestDigest matches actual snapshot content using frozen algorithm
          try {
            const { digest: actualDigest } = await computeFrozenSnapshot(snapshotDirReal);
            if (actualDigest !== manifestDigest) {
              return createResult({
                actionType,
                status: ActionStatus.PREFLIGHT_FAILED,
                error: `manifestDigest mismatch: expected ${manifestDigest.slice(0, 16)}..., actual ${actualDigest.slice(0, 16)}...`,
              });
            }
          } catch (digestErr) {
            return createResult({
              actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `failed to compute snapshot digest: ${digestErr.message}`,
            });
          }

          // installationContractDigest 摘要校验（新版字段组已通过完整性检查后来到这里）
          // 从冻结快照读取插件 manifest，按平台注册表和来源形态构建安装契约，
          // 以 consumer-install-v1 重算并与 action 携带的摘要比对。
          if (hasNewFieldGroup) {
            try {
              const contractResult = await validateInstallationContractDigest(action, snapshotDirReal, consumerPlatform);
              if (!contractResult.valid) {
                return createResult({
                  actionType,
                  status: ActionStatus.PREFLIGHT_FAILED,
                  error: contractResult.error,
                });
              }
            } catch (contractErr) {
              return createResult({
                actionType,
                status: ActionStatus.PREFLIGHT_FAILED,
                error: `installationContractDigest 验证异常: ${contractErr.message}`,
              });
            }
          }

          return createResult({
            actionType,
            status: ActionStatus.PREFLIGHT_PASSED,
          });
        }

        return createResult({
          actionType,
          status: ActionStatus.PREFLIGHT_FAILED,
          error: `Unsupported action type: ${actionType}`,
        });
      } catch (err) {
        return createResult({
          actionType,
          status: ActionStatus.PREFLIGHT_FAILED,
          error: err.message,
        });
      }
    },

    /**
     * Execute: perform the validation/write action. For marketplace,
     * "execute" means running structured validation.
     * Some actions require authorization (e.g., updating remote metadata).
     */
    async execute(action, context) {
      const { actionType } = action;

      // Plugin validation is read-only; no authorization needed for validate
      // Only actual remote writes require authorization
      if (actionType === ActionType.PLUGIN_MANIFEST_VALIDATE) {
        try {
          const manifestPath = action.manifestPath;
          const requiredFields = action.requiredFields ?? ['name', 'version', 'description'];

          const result = await validateManifestFile(manifestPath, requiredFields);

          if (!result.valid) {
            return createResult({
              actionType,
              status: ActionStatus.EXECUTE_FAILED,
              error: result.error,
              observation: { valid: false, missing: result.missing },
            });
          }

          // Additional structural validation via node --check if a JS entry is specified
          if (action.entryPoint) {
            try {
              await exec(process.execPath, ['--check', action.entryPoint]);
            } catch (checkErr) {
              return createResult({
                actionType,
                status: ActionStatus.EXECUTE_FAILED,
                error: `Entry point syntax check failed: ${checkErr.message}`,
              });
            }
          }

          return createResult({
            actionType,
            status: ActionStatus.EXECUTED,
            observation: {
              valid: true,
              manifest: result.manifest,
              manifestPath,
            },
          });
        } catch (err) {
          return createResult({
            actionType,
            status: ActionStatus.EXECUTE_FAILED,
            error: err.message,
          });
        }
      }

      if (actionType === ActionType.PLUGIN_INSTALL_CHECK) {
        // Install check may involve writing temp files in some cases
        // For now it's read-only, so no authorization check needed
        try {
          const { pluginDir, requiredFiles } = action;
          const check = await checkRequiredFiles(pluginDir, requiredFiles ?? []);

          if (!check.allPresent) {
            return createResult({
              actionType,
              status: ActionStatus.EXECUTE_FAILED,
              error: `Missing required files: ${check.missing.join(', ')}`,
              observation: { allPresent: false, missing: check.missing },
            });
          }

          // Smoke test: try loading the entry point
          if (action.entryPoint) {
            try {
              await exec(process.execPath, ['--check', resolve(pluginDir, action.entryPoint)]);
            } catch (checkErr) {
              return createResult({
                actionType,
                status: ActionStatus.EXECUTE_FAILED,
                error: `Install smoke test failed: ${checkErr.message}`,
              });
            }
          }

          return createResult({
            actionType,
            status: ActionStatus.EXECUTED,
            observation: {
              allPresent: true,
              pluginDir,
              checkedFiles: requiredFiles ?? [],
            },
          });
        } catch (err) {
          return createResult({
            actionType,
            status: ActionStatus.EXECUTE_FAILED,
            error: err.message,
          });
        }
      }

      // Marketplace install execute
      if (
        actionType === ActionType.CLAUDE_MARKETPLACE_INSTALL ||
        actionType === ActionType.CODEX_MARKETPLACE_INSTALL ||
        actionType === ActionType.KIMI_MARKETPLACE_INSTALL ||
        actionType === ActionType.CODEBUDDY_MARKETPLACE_INSTALL
      ) {
        try {
          assertIsolatedConsumerWritesAuthorized(context, actionType);

          const validation = validateMarketplaceParams(action);
          if (!validation.valid) {
            return createResult({
              actionType,
              status: ActionStatus.EXECUTE_FAILED,
              error: validation.error,
            });
          }

          // Validate context
          if (!context?.root) {
            return createResult({
              actionType,
              status: ActionStatus.EXECUTE_FAILED,
              error: 'context.root is required for marketplace install',
            });
          }
          if (!context.runDir) {
            return createResult({
              actionType,
              status: ActionStatus.EXECUTE_FAILED,
              error: 'context.runDir is required for marketplace install',
            });
          }

          // A non-automatable platform (kimi) has NO scriptable install CLI.
          // It is handled entirely by its manual-requirement strategy, which
          // uses a stable plugin-level authority directory and deliberately SKIPS the
          // per-run isolated consumer dir and its runDir containment check
          // (that model only fits structured-cli platforms, which exec a real
          // CLI into a per-run HOME).
          const platform = getPlatform(action.consumer);
          const executeRoute = resolvePlatformRoute(platform);
          if (executeRoute.route === 'human-attestation') {
            return platform.strategy.buildManualRequirement(action, context);
          }

          const consumer = action.consumer;
          const runDir = context.runDir;
          const isolatedHome = resolve(runDir, 'consumers', `${consumer}-${action.plugin}`);

          // Verify consumer directory is inside runDir
          const runDirReal = await realpath(runDir).catch(() => runDir);
          const isolatedHomePreReal = await realpath(isolatedHome).catch(() => isolatedHome);
          const relToRun = relative(runDirReal, isolatedHomePreReal);
          const sepE = process.platform === 'win32' ? '\\' : '/';
          if (relToRun !== '' && (isAbsolute(relToRun) || relToRun === '..' || relToRun.startsWith(`..${sepE}`))) {
            return createResult({
              actionType,
              status: ActionStatus.EXECUTE_FAILED,
              error: `consumer directory escapes runDir: ${isolatedHome}`,
            });
          }

          // Create isolated HOME and the consumer state subdirectories the
          // registry declares for this platform.
          await mkdir(isolatedHome, { recursive: true, mode: 0o700 });
          for (const subdir of platform.isolationSubdirs) {
            await mkdir(resolve(isolatedHome, subdir), { recursive: true, mode: 0o700 });
          }

          const cliCmd = platform.cli.binary;
          const baseEnv = { ...process.env, ...context.env };
          const env = {
            ...baseEnv,
            ...platform.isolationEnv(isolatedHome),
          };
          // Ensure real HOME/CODEX_HOME don't leak back (already overridden
          // above).

          // Resolve frozen timeoutMs from the expanded action (top-level,
          // not action.parameters -- the publish/reconcile/verify call path
          // expands plan action as { actionType, ...action.parameters }).
          // Default to 300000 for old plans that lack the field.
          // Fail closed on invalid values (null, non-integer, non-finite,
          // out of range).
          let frozenTimeoutMs;
          try {
            frozenTimeoutMs = resolveTimeoutMs(action);
          } catch (timeoutErr) {
            return createResult({
              actionType,
              status: ActionStatus.EXECUTE_FAILED,
              error: timeoutErr.message,
            });
          }

          // Step 1: Add marketplace (automatable platforms only; the
          // non-automatable manual-requirement path returned above)
          const ref = action.ref ?? `v${action.version}`;
          let addOutput = null;
          const marketplaceArgs = platform.cli.marketplaceAdd(action.repo, ref);
          try {
            const addResult = await exec(cliCmd, marketplaceArgs, { env, cwd: context.root, timeout: frozenTimeoutMs });
            if (platform.jsonProtocol.marketplaceAddOutput === 'json') {
              try {
                addOutput = JSON.parse(addResult.stdout);
                if (!addOutput || typeof addOutput !== 'object') {
                  return createResult({
                    actionType,
                    status: ActionStatus.EXECUTE_FAILED,
                    error: 'marketplace add returned invalid JSON output',
                  });
                }
                if (addOutput.marketplaceName !== action.marketplace) {
                  return createResult({
                    actionType,
                    status: ActionStatus.EXECUTE_FAILED,
                    error: `marketplace add marketplaceName "${addOutput.marketplaceName}" does not match action marketplace "${action.marketplace}"`,
                  });
                }
              } catch {
                return createResult({
                  actionType,
                  status: ActionStatus.EXECUTE_FAILED,
                  error: 'marketplace add returned malformed JSON',
                });
              }
            }
          } catch (addErr) {
            // Re-throw CLI/transport unavailability errors to outer catch
            // for human-attestation fallback classification
            if (isCliOrTransportUnavailable(addErr)) {
              throw addErr;
            }
            return createResult({
              actionType,
              status: ActionStatus.EXECUTE_FAILED,
              error: `marketplace add failed: ${addErr.message}`,
            });
          }

          // Step 2: Install plugin (the non-automatable manual-requirement
          // path returned above; it has no install CLI).
          let installOutput;
          const installArgs = platform.cli.install(action.plugin, action.marketplace);
          try {
            const installResult = await exec(cliCmd, installArgs, { env, cwd: context.root, timeout: frozenTimeoutMs });
            if (platform.jsonProtocol.pluginInstallOutput === 'json') {
              try {
                installOutput = JSON.parse(installResult.stdout);
                if (!installOutput || typeof installOutput !== 'object') {
                  return createResult({
                    actionType,
                    status: ActionStatus.EXECUTE_FAILED,
                    error: 'plugin install returned invalid JSON output',
                  });
                }
                const expectedPluginId = `${action.plugin}@${action.marketplace}`;
                const installFields = {
                  pluginId: installOutput.pluginId,
                  name: installOutput.name,
                  marketplaceName: installOutput.marketplaceName,
                  version: installOutput.version,
                  installedPath: installOutput.installedPath,
                };
                const expectedFields = {
                  pluginId: expectedPluginId,
                  name: action.plugin,
                  marketplaceName: action.marketplace,
                  version: action.version,
                  installedPath: undefined, // must exist and be non-empty
                };
                for (const [field, expected] of Object.entries(expectedFields)) {
                  if (field === 'installedPath') {
                    if (!installFields.installedPath) {
                      return createResult({
                        actionType,
                        status: ActionStatus.EXECUTE_FAILED,
                        error: `plugin install JSON missing installedPath`,
                      });
                    }
                    // installedPath must be inside isolated HOME
                    const installPathAbs = resolve(installFields.installedPath);
                    const installPathRel = relative(isolatedHome, installPathAbs);
                    if (isAbsolute(installPathRel) || installPathRel === '..' || installPathRel.startsWith(`..${sepE}`)) {
                      return createResult({
                        actionType,
                        status: ActionStatus.EXECUTE_FAILED,
                        error: `plugin install installedPath escapes isolated HOME: ${installFields.installedPath}`,
                      });
                    }
                  } else if (installFields[field] !== expected) {
                    return createResult({
                      actionType,
                      status: ActionStatus.EXECUTE_FAILED,
                      error: `plugin install JSON ${field} "${installFields[field]}" does not match expected "${expected}"`,
                    });
                  }
                }
              } catch {
                return createResult({
                  actionType,
                  status: ActionStatus.EXECUTE_FAILED,
                  error: 'plugin install returned malformed JSON',
                });
              }
            }
          } catch (installErr) {
            // Re-throw CLI/transport unavailability errors to outer catch
            // for human-attestation fallback classification
            if (isCliOrTransportUnavailable(installErr)) {
              throw installErr;
            }
            return createResult({
              actionType,
              status: ActionStatus.EXECUTE_FAILED,
              error: `plugin install failed: ${installErr.message}`,
            });
          }

          // Bind the installed payload to the sealed authority before writing
          // evidence so the evidence file can carry the declared-manifest
          // audit fields (host-added paths). Best-effort: binding failure is
          // caught at verify time. Claude's install CLI reports no
          // installedPath, so claude binds only at observe (via `plugin
          // list`); codex binds here from the validated install JSON.
          const installPath = installOutput?.installedPath;
          let executeManifestDigest = null;
          let executeBinding = null;
          if (installPath) {
            try {
              executeBinding = await verifyInstalledMarketplacePayload(
                action,
                context,
                installPath,
                consumer,
              );
              executeManifestDigest = executeBinding.manifestDigest;
            } catch {
              // Digest computation failure is caught at verify time
            }
          }

          // Build and write structured evidence for observe cross-validation
          const evidence = {
            isolatedHome,
            consumer,
            plugin: action.plugin,
            marketplace: action.marketplace,
            repo: action.repo,
            ref,
            version: action.version,
            addOutput,
            installOutput,
            executedAt: new Date().toISOString(),
            ...extraInstalledPathsAudit(executeBinding),
          };

          // Write evidence file to runDir/evidence/ (outside isolatedHome/installPath digest scope)
          const evidenceDir = resolve(runDir, 'evidence', `${consumer}-${action.plugin}`);
          await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
          const evidencePath = resolve(evidenceDir, 'release-skill-install-evidence.json');
          await writeEvidenceAtomic(evidencePath, evidence);

          // Build expected-compatible observation for executeCheckpoint's
          // matchObservation check.
          const executeObservation = {
            ...evidence,
            installed: true,
            entrySkill: action.entrySkill,
            ...(executeManifestDigest ? { manifestDigest: executeManifestDigest } : {}),
          };

          return createResult({
            actionType,
            status: ActionStatus.EXECUTED,
            observation: executeObservation,
          });
        } catch (err) {
          // Codex human-attestation fallback: ONLY when the CLI interface,
          // binary, environment, or transport is explicitly unavailable.
          // Explicit mismatches (identity, version, payload, marketplace entry),
          // malformed JSON, and program exceptions are hard failures.
          const failedPlatform = getPlatform(action.consumer);
          if (
            failedPlatform.degradationPolicy === 'human-attestation-with-fallback'
            && failedPlatform.strategy.buildManualRequirement
            && isCliOrTransportUnavailable(err)
          ) {
            return failedPlatform.strategy.buildManualRequirement(action, context);
          }
          return createResult({
            actionType,
            status: ActionStatus.EXECUTE_FAILED,
            error: err.message,
          });
        }
      }

      return createResult({
        actionType,
        status: ActionStatus.EXECUTE_FAILED,
        error: `Unsupported action type: ${actionType}`,
      });
    },

    /**
     * Observe: read the current state of the plugin manifest and content.
     * Never infers success from exit code alone.
     *
     * For Claude: uses id === "plugin@marketplace" match in list array,
     * reads installPath from CLI output, verifies install dir is inside
     * isolated HOME, computes real manifestDigest from installed content.
     *
     * For Codex: uses pluginId === "plugin@marketplace" match in installed array,
     * reads installedPath from add/install output or list, verifies install dir
     * is inside isolated HOME, computes real manifestDigest.
     *
     * For Kimi: uses name === plugin match in installed array, reads
     * installedPath from validated install evidence, verifies install dir
     * is inside isolated HOME, computes real manifestDigest.
     */
    async observe(action, context) {
      const { actionType } = action;

      try {
        if (actionType === ActionType.PLUGIN_MANIFEST_VALIDATE) {
          const manifestPath = action.manifestPath;
          try {
            const content = await readFile(manifestPath, 'utf8');
            const manifest = JSON.parse(content);
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: {
                exists: true,
                name: manifest.name,
                version: manifest.version,
                description: manifest.description,
              },
            });
          } catch {
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: { exists: false },
            });
          }
        }

        if (actionType === ActionType.PLUGIN_INSTALL_CHECK) {
          const { pluginDir, requiredFiles } = action;
          const check = await checkRequiredFiles(pluginDir, requiredFiles ?? []);

          return createResult({
            actionType,
            status: ActionStatus.OBSERVED,
            observation: {
              allPresent: check.allPresent,
              missing: check.missing,
              pluginDir,
            },
          });
        }

        // Marketplace install observe
        if (
          actionType === ActionType.CLAUDE_MARKETPLACE_INSTALL ||
          actionType === ActionType.CODEX_MARKETPLACE_INSTALL ||
          actionType === ActionType.KIMI_MARKETPLACE_INSTALL ||
          actionType === ActionType.CODEBUDDY_MARKETPLACE_INSTALL
        ) {
          const consumer = action.consumer;
          const runDir = context.runDir;
          if (!runDir) {
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: { installed: false, error: 'context.runDir is required' },
            });
          }
          const isolatedHome = resolve(runDir, 'consumers', `${consumer}-${action.plugin}`);
          // Registry-driven platform data. An unregistered consumer is a hard
          // error: the platform registry is the single source of truth for
          // consumer-platform knowledge, and silently falling through to a
          // kimi-shaped env would mask configuration mistakes.
          const platform = PLATFORMS.find((p) => p.id === consumer) ?? null;
          if (!platform) {
            throw new Error(
              `Unknown consumer platform "${consumer}" for action "${actionType}". `
              + `Registered platforms: ${PLATFORMS.map((p) => p.id).join(', ')}`,
            );
          }
          const cliCmd = platform.cli ? platform.cli.binary : null;
          const baseEnv = { ...process.env, ...(context.env ?? {}) };
          const env = {
            ...baseEnv,
            ...platform.isolationEnv(isolatedHome),
          };

          // Resolve frozen timeoutMs from the expanded action (top-level).
          // Default to 300000 for old plans. Fail closed on invalid values.
          let frozenTimeoutMs;
          try {
            frozenTimeoutMs = resolveTimeoutMs(action);
          } catch (timeoutErr) {
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: { installed: false, error: timeoutErr.message },
              error: timeoutErr.message,
            });
          }

          // Non-automatable platform protocol capability gap (BLOCKER-1):
          // there is NO `kimi plugins list --json` interface. observe never
          // execs a kimi command. Instead it consumes a structured human
          // attestation (written after the interactive install) bound to the
          // frozen plan digest and expected identity, then performs read-only
          // verification of the installed managed copy: payload digest vs the
          // sealed authority, entry skill resolved via the manifest skills
          // root (MAJOR-4), and manifest name/version.
          // Missing/expired/mismatched/escaping proof fails closed so a kimi
          // unit can never reach VERIFIED without it.
          const kimiRoute = platform ? resolvePlatformRoute(platform) : null;
          if (platform && kimiRoute?.route === 'human-attestation' && actionType === ActionType.KIMI_MARKETPLACE_INSTALL) {
            const expectedRef = action.ref ?? `v${action.version}`;

            // Bind to the REAL frozen plan digest (A). Fail closed if the
            // context does not carry an intact frozen plan.
            let boundPlanDigest;
            try {
              boundPlanDigest = resolveBoundPlanDigest(context);
            } catch (planErr) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: false,
                  error: `cannot bind kimi observation to the frozen plan: ${planErr.message}`,
                },
              });
            }

            // Stable, cross-run attestation authority (B). The requirement and
            // attestation live here, keyed by the verified plan digest + plugin,
            // so they survive across fresh runDirs (publish, verify each use a
            // new runDir).
            let attestationDir;
            try {
              attestationDir = kimiAuthorityDir(context, boundPlanDigest, action.plugin);
            } catch (dirErr) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: { installed: false, error: dirErr.message },
              });
            }

            // The execute-emitted requirement must exist and bind to the action
            // and the frozen plan digest.
            let requirement = null;
            try {
              requirement = JSON.parse(await readFile(resolve(attestationDir, KIMI_REQUIREMENT_FILE), 'utf8'));
            } catch {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: false,
                  manualInstallRequired: true,
                  error: 'kimi manual-install requirement is missing; run execute first',
                },
              });
            }
            // 完整 requirement 绑定验证：所有冻结动作绑定字段必须一致
            if (
              requirement.planDigest !== boundPlanDigest ||
              requirement.plugin !== action.plugin ||
              requirement.version !== action.version ||
              requirement.repo !== action.repo ||
              requirement.ref !== (action.ref ?? `v${action.version}`) ||
              (action.entrySkill && requirement.entrySkill !== action.entrySkill)
            ) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: false,
                  error: 'kimi manual-install requirement does not match the frozen plan/action',
                },
              });
            }

            // The trusted human attestation is mandatory and is read from the
            // stable authority dir. Without it the interactive install has not
            // been proven: fail closed.
            let attestation = null;
            try {
              attestation = JSON.parse(await readFile(resolve(attestationDir, KIMI_ATTESTATION_FILE), 'utf8'));
            } catch {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: false,
                  manualInstallRequired: true,
                  installUrl: requirement.installUrl,
                  attestationDir,
                  error: `kimi attestation is missing; write ${resolve(attestationDir, KIMI_ATTESTATION_FILE)} after the interactive install (${requirement.installUrl})`,
                },
              });
            }

            const attestationCheck = validateKimiAttestation(attestation, action, new Date().toISOString(), boundPlanDigest);
            if (!attestationCheck.valid) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: { installed: false, error: attestationCheck.error },
              });
            }

            // 使用归一化后的 attestation（兼容旧格式）
            const normalizedAttestation = attestationCheck.normalized;
            const requiresInstalledClosure = Boolean(context.plan?.skillResourceClosure);

            // 统一人工判定：如果结果是 failed，直接返回失败
            if (normalizedAttestation.result === 'failed') {
              const errorMsg = `kimi human result: failed${normalizedAttestation.note ? ` (${normalizedAttestation.note})` : ''}`;
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                error: errorMsg,
                observation: {
                  installed: false,
                  humanConfirmed: true,
                  result: 'failed',
                  actor: normalizedAttestation.actor,
                  confirmedAt: normalizedAttestation.confirmedAt,
                  error: errorMsg,
                },
              });
            }

            if (requiresInstalledClosure && !normalizedAttestation.installPath) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: false,
                  error: 'kimi attestation installPath is required by the skill resource closure gate',
                },
              });
            }

            // installPath 验证：必须是真实目录，不得是符号链接。
            // 安装路径不要求位于 attestationDir 内（用户使用实际全局/用户安装目录）。
            let verifiedInstallPath = null;
            if (normalizedAttestation.installPath) {
              const installPathAbs = resolve(normalizedAttestation.installPath);

              // 检查 installPath 词法路径是否存在（lstat 在 realpath 之前）
              let lexicalStat;
              try {
                lexicalStat = await lstat(installPathAbs);
              } catch {
                return createResult({
                  actionType,
                  status: ActionStatus.OBSERVED,
                  observation: {
                    installed: false,
                    error: 'managed plugin root does not exist',
                  },
                });
              }
              if (lexicalStat.isSymbolicLink()) {
                return createResult({
                  actionType,
                  status: ActionStatus.OBSERVED,
                  observation: {
                    installed: false,
                    error: `kimi attestation installPath must not be a symlink: ${normalizedAttestation.installPath}`,
                  },
                });
              }

              const installPathReal = await realpath(installPathAbs).catch(() => null);
              if (!installPathReal) {
                return createResult({
                  actionType,
                  status: ActionStatus.OBSERVED,
                  observation: {
                    installed: false,
                    error: `kimi attestation installPath does not exist: ${normalizedAttestation.installPath}`,
                  },
                });
              }
              verifiedInstallPath = installPathReal;
            }

            // 载荷绑定验证：旧格式含 installPath 时必须绑定冻结载荷并失败关闭。
            // 身份、版本、载荷、市场来源不一致绝不能被人工 passed 覆盖。
            let manifestDigest = action.manifestDigest;
            let payloadBinding = null;
            if (verifiedInstallPath) {
              try {
                payloadBinding = await verifyInstalledMarketplacePayload(
                  action,
                  context,
                  verifiedInstallPath,
                  consumer,
                );
                manifestDigest = payloadBinding.manifestDigest;
              } catch (bindingErr) {
                return createResult({
                  actionType,
                  status: ActionStatus.OBSERVED,
                  error: `kimi payload binding failed: ${bindingErr.message}`,
                  observation: {
                    installed: false,
                    humanConfirmed: true,
                    result: 'passed',
                    actor: normalizedAttestation.actor,
                    confirmedAt: normalizedAttestation.confirmedAt,
                    error: `kimi payload binding failed: ${bindingErr.message}`,
                  },
                });
              }
            }

            // 统一人工判定：返回人工确认成功
            // 新格式不含 installPath 时，成功依赖已通过的 preflight 静态冻结校验和人工结果绑定
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: {
                installed: true,
                humanConfirmed: true,
                result: 'passed',
                actor: normalizedAttestation.actor,
                confirmedAt: normalizedAttestation.confirmedAt,
                consumer,
                plugin: action.plugin,
                version: action.version,
                repo: action.repo,
                ref: expectedRef,
                entrySkill: action.entrySkill,
                entrySkillFound: true,
                manifestDigest,
                planDigest: boundPlanDigest,
                ...(verifiedInstallPath ? { installPath: verifiedInstallPath } : {}),
                ...extraInstalledPathsAudit(payloadBinding),
              },
            });
          }

          // CodeBuddy protocol capability gap (parallel to the kimi branch
          // above). The codebuddy CLI cannot pin a frozen ref, so observe
          // never execs a codebuddy command. It consumes a unified human
          // result bound to the frozen plan digest + identity.
          // Missing/mismatched proof fails closed so a codebuddy unit can
          // never reach VERIFIED without it.
          const codebuddyRoute = platform ? resolvePlatformRoute(platform) : null;
          if (platform && codebuddyRoute?.route === 'human-attestation' && actionType === ActionType.CODEBUDDY_MARKETPLACE_INSTALL) {
            const expectedRef = action.ref ?? `v${action.version}`;

            // Bind to the REAL frozen plan digest (A). Fail closed if the
            // context does not carry an intact frozen plan.
            let boundPlanDigest;
            try {
              boundPlanDigest = await resolveCodeBuddyBoundPlanDigest(context);
            } catch (planErr) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: false,
                  error: `cannot bind codebuddy observation to the frozen plan: ${planErr.message}`,
                },
              });
            }

            // Stable, cross-run attestation authority (B), keyed by the verified
            // plan digest + plugin, so it survives across fresh runDirs.
            let attestationDir;
            try {
              attestationDir = codebuddyAuthorityDir(context, boundPlanDigest, action.plugin);
            } catch (dirErr) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: { installed: false, error: dirErr.message },
              });
            }

            // The execute-emitted requirement must exist and bind to the action
            // and the frozen plan digest.
            let requirement = null;
            try {
              requirement = JSON.parse(await readFile(resolve(attestationDir, CODEBUDDY_REQUIREMENT_FILE), 'utf8'));
            } catch {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: false,
                  manualInstallRequired: true,
                  error: 'codebuddy manual-install requirement is missing; run execute first',
                },
              });
            }
            // 完整 requirement 绑定验证：所有冻结动作绑定字段必须一致
            if (
              requirement.planDigest !== boundPlanDigest ||
              requirement.plugin !== action.plugin ||
              requirement.version !== action.version ||
              requirement.repo !== action.repo ||
              requirement.ref !== (action.ref ?? `v${action.version}`) ||
              (action.entrySkill && requirement.entrySkill !== action.entrySkill)
            ) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: false,
                  error: 'codebuddy manual-install requirement does not match the frozen plan/action',
                },
              });
            }

            // The trusted human attestation is mandatory and is read from the
            // stable authority dir. Without it the manual install has not been
            // proven: fail closed.
            let attestation = null;
            try {
              attestation = JSON.parse(await readFile(resolve(attestationDir, CODEBUDDY_ATTESTATION_FILE), 'utf8'));
            } catch {
              // The marketplace source hint follows the frozen action's
              // resolved marketplace; unknown configured marketplaces cite no
              // fabricated URL.
              const marketplaceSource = resolveCodeBuddyMarketplaceSource(action);
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: false,
                  manualInstallRequired: true,
                  ...(marketplaceSource ? { marketplaceSource } : {}),
                  attestationDir,
                  error: `codebuddy attestation is missing; write ${resolve(attestationDir, CODEBUDDY_ATTESTATION_FILE)} after the manual install${marketplaceSource ? ` (marketplace ${marketplaceSource})` : ''}`,
                },
              });
            }

            const attestationCheck = validateCodeBuddyAttestation(attestation, action, new Date().toISOString(), boundPlanDigest);
            if (!attestationCheck.valid) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: { installed: false, error: attestationCheck.error },
              });
            }

            // 使用归一化后的 attestation（兼容旧格式）
            const normalizedAttestation = attestationCheck.normalized;
            const requiresInstalledClosure = Boolean(context.plan?.skillResourceClosure);

            // 统一人工判定：如果结果是 failed，直接返回失败
            if (normalizedAttestation.result === 'failed') {
              const errorMsg = `codebuddy human result: failed${normalizedAttestation.note ? ` (${normalizedAttestation.note})` : ''}`;
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                error: errorMsg,
                observation: {
                  installed: false,
                  humanConfirmed: true,
                  result: 'failed',
                  actor: normalizedAttestation.actor,
                  confirmedAt: normalizedAttestation.confirmedAt,
                  error: errorMsg,
                },
              });
            }

            let verifiedInstallPath = null;
            if (requiresInstalledClosure) {
              if (!normalizedAttestation.installPath) {
                return createResult({
                  actionType,
                  status: ActionStatus.OBSERVED,
                  observation: {
                    installed: false,
                    error: 'codebuddy attestation installPath is required by the skill resource closure gate',
                  },
                });
              }
              if (!['desktop', 'cli'].includes(normalizedAttestation.installChannel)) {
                return createResult({
                  actionType,
                  status: ActionStatus.OBSERVED,
                  observation: {
                    installed: false,
                    error: 'codebuddy attestation installChannel must be "desktop" or "cli" when the skill resource closure gate is active',
                  },
                });
              }
              const normalizedPath = normalizedAttestation.installPath.replaceAll('\\', '/');
              // The expected suffix follows the frozen action's resolved
              // marketplace (default constant for legacy plans).
              let resolvedMarketplace;
              try {
                resolvedMarketplace = resolveCodeBuddyMarketplace(action);
              } catch (resolveErr) {
                return createResult({
                  actionType,
                  status: ActionStatus.OBSERVED,
                  observation: { installed: false, error: resolveErr.message },
                });
              }
              const expectedSuffix = `.workbuddy/plugins/marketplaces/${resolvedMarketplace}/plugins/${action.plugin}`;
              if (!normalizedPath.endsWith(expectedSuffix)) {
                return createResult({
                  actionType,
                  status: ActionStatus.OBSERVED,
                  observation: {
                    installed: false,
                    error: `codebuddy attestation installPath must end with "${expectedSuffix}"`,
                  },
                });
              }
              const installPathAbs = resolve(normalizedAttestation.installPath);
              let lexicalStat;
              try {
                lexicalStat = await lstat(installPathAbs);
              } catch {
                return createResult({
                  actionType,
                  status: ActionStatus.OBSERVED,
                  observation: {
                    installed: false,
                    error: `codebuddy attestation installPath does not exist: ${normalizedAttestation.installPath}`,
                  },
                });
              }
              if (lexicalStat.isSymbolicLink() || !lexicalStat.isDirectory()) {
                return createResult({
                  actionType,
                  status: ActionStatus.OBSERVED,
                  observation: {
                    installed: false,
                    error: 'codebuddy attestation installPath must be a real directory, not a symlink',
                  },
                });
              }
              verifiedInstallPath = await realpath(installPathAbs);
            }

            // 人工结果仍裁决不可自动化的安装步骤；新资源闭包计划另外
            // 暴露已校验的真实安装目录，供 verify 的内置只读门禁扫描。
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: {
                installed: true,
                humanConfirmed: true,
                result: 'passed',
                actor: normalizedAttestation.actor,
                confirmedAt: normalizedAttestation.confirmedAt,
                consumer,
                plugin: action.plugin,
                version: action.version,
                repo: action.repo,
                ref: expectedRef,
                entrySkill: action.entrySkill,
                entrySkillFound: true,
                manifestDigest: action.manifestDigest,
                planDigest: boundPlanDigest,
                ...(verifiedInstallPath ? { installPath: verifiedInstallPath } : {}),
              },
            });
          }

          // Codex human-attestation fallback: if the CLI was unavailable
          // during execute, a human attestation may exist in the authority dir.
          // Read and validate it instead of the CLI evidence.
          //
          // CRITICAL: observe only reads human results when a bound, validated
          // Codex manual requirement exists. Isolated attestation files must not
          // bypass automatic evidence.
          if (
            platform.degradationPolicy === 'human-attestation-with-fallback'
            && actionType === ActionType.CODEX_MARKETPLACE_INSTALL
          ) {
            const expectedRef = action.ref ?? `v${action.version}`;

            // Try to read the human attestation from the authority dir.
            let codexBoundPlanDigest;
            try {
              codexBoundPlanDigest = await resolveCodexBoundPlanDigest(context);
            } catch {
              // No frozen plan — cannot read attestation
            }
            if (codexBoundPlanDigest) {
              let codexAttestationDir;
              try {
                codexAttestationDir = codexAuthorityDir(context, codexBoundPlanDigest, action.plugin);
              } catch {
                // Authority dir not resolvable
              }
              if (codexAttestationDir) {
                // CRITICAL: Only read attestation if requirement exists and is bound
                let codexRequirement = null;
                try {
                  codexRequirement = JSON.parse(await readFile(resolve(codexAttestationDir, CODEX_REQUIREMENT_FILE), 'utf8'));
                } catch {
                  // No requirement file — must not read the stable attestation
                }

                // Validate requirement binds to this action and plan (完整绑定验证)
                if (
                  codexRequirement
                  && codexRequirement.planDigest === codexBoundPlanDigest
                  && codexRequirement.plugin === action.plugin
                  && codexRequirement.version === action.version
                  && codexRequirement.repo === action.repo
                  && codexRequirement.ref === (action.ref ?? `v${action.version}`)
                  && (!action.entrySkill || codexRequirement.entrySkill === action.entrySkill)
                ) {
                  let codexAttestation = null;
                  try {
                    codexAttestation = JSON.parse(await readFile(resolve(codexAttestationDir, CODEX_ATTESTATION_FILE), 'utf8'));
                  } catch {
                    // No attestation file — fall through to normal CLI evidence path
                  }
                  if (codexAttestation) {
                    const codexCheck = validateCodexAttestation(codexAttestation, action, new Date().toISOString(), codexBoundPlanDigest);
                    if (!codexCheck.valid) {
                      return createResult({
                        actionType,
                        status: ActionStatus.OBSERVED,
                        observation: { installed: false, error: codexCheck.error },
                      });
                    }
                    if (codexAttestation.result === 'failed') {
                      const errorMsg = `codex human result: failed${codexAttestation.note ? ` (${codexAttestation.note})` : ''}`;
                      return createResult({
                        actionType,
                        status: ActionStatus.OBSERVED,
                        error: errorMsg,
                        observation: {
                          installed: false,
                          humanConfirmed: true,
                          result: 'failed',
                          actor: codexAttestation.actor,
                          confirmedAt: codexAttestation.confirmedAt,
                          error: errorMsg,
                        },
                      });
                    }
                    return createResult({
                      actionType,
                      status: ActionStatus.OBSERVED,
                      observation: {
                        installed: true,
                        humanConfirmed: true,
                        result: 'passed',
                        actor: codexAttestation.actor,
                        confirmedAt: codexAttestation.confirmedAt,
                        consumer,
                        plugin: action.plugin,
                        version: action.version,
                        repo: action.repo,
                        ref: expectedRef,
                        entrySkill: action.entrySkill,
                        entrySkillFound: true,
                        manifestDigest: action.manifestDigest,
                        planDigest: codexBoundPlanDigest,
                      },
                    });
                  }
                }
              }
            }
          }

          // Read execute evidence — mandatory for observe validation
          let evidence = null;
          try {
            const evidenceRaw = await readFile(resolve(runDir, 'evidence', `${consumer}-${action.plugin}`, 'release-skill-install-evidence.json'), 'utf8');
            evidence = JSON.parse(evidenceRaw);
          } catch {
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: {
                installed: false,
                error: 'execute evidence file is missing or unreadable',
              },
            });
          }

          if (
            evidence.consumer !== consumer ||
            evidence.plugin !== action.plugin ||
            evidence.marketplace !== action.marketplace ||
            evidence.version !== action.version ||
            evidence.repo !== action.repo ||
            evidence.ref !== action.ref ||
            evidence.isolatedHome !== isolatedHome
          ) {
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: {
                installed: false,
                error: 'execute evidence identity does not match the frozen action',
              },
            });
          }

          // Run list command to verify installation (automatable platforms
          // only; a non-automatable platform has no list CLI and returned via
          // the attestation path above).
          const listArgs = ['plugin', 'list', '--json'];

          let listOutput;
          try {
            const result = await exec(cliCmd, listArgs, { env, cwd: context.root, timeout: frozenTimeoutMs });
            listOutput = JSON.parse(result.stdout);
          } catch (listErr) {
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: {
                installed: false,
                error: `list command failed: ${listErr.message}`,
              },
            });
          }

          const pluginId = `${action.plugin}@${action.marketplace}`;
          let found = null;
          let installPath = null;

          // Protocol differences live in the platform strategy functions.
          // Where the install path comes from install evidence (codex) that
          // check runs BEFORE the list shape check (legacy ordering); where it
          // comes from the parsed list entry (claude), extractInstallPath is
          // only reached after parseListOutput returned ok — which has already
          // fail-closed on a missing installPath, so the lenient
          // claudeExtractInstallPath boundary can never observe an incomplete
          // listParsed (slice-1 review leftover).
          if (platform && platform.jsonProtocol.installPathSource === 'install-output') {
            const extracted = platform.strategy.extractInstallPath({ execEvidence: evidence });
            if (!extracted.ok) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: { installed: false, error: extracted.error },
              });
            }
            installPath = extracted.installPath;
          }
          if (platform && platform.strategy.parseListOutput) {
            const listParsed = platform.strategy.parseListOutput(listOutput, pluginId);
            if (!listParsed.ok) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: { installed: false, error: listParsed.error },
              });
            }
            found = listParsed.found;
            if (platform.jsonProtocol.installPathSource === 'list') {
              const extracted = platform.strategy.extractInstallPath({ listParsed });
              if (!extracted.ok) {
                return createResult({
                  actionType,
                  status: ActionStatus.OBSERVED,
                  observation: { installed: false, error: extracted.error },
                });
              }
              installPath = extracted.installPath;
            }
            // Cross-validate list identity fields against the frozen action
            // where the platform protocol requires it (codex).
            if (platform.strategy.crossValidateListEntry) {
              const crossCheck = platform.strategy.crossValidateListEntry(found, action);
              if (!crossCheck.ok) {
                return createResult({
                  actionType,
                  status: ActionStatus.OBSERVED,
                  observation: { installed: false, error: crossCheck.error },
                });
              }
            }
          }

          // Verify installPath is inside or at isolated HOME (path escape protection)
          const isolatedHomeReal = await realpath(isolatedHome).catch(() => isolatedHome);
          const installPathReal = await realpath(installPath).catch(() => installPath);
          const relToHome = relative(isolatedHomeReal, installPathReal);
          const sep = process.platform === 'win32' ? '\\' : '/';
          if (
            relToHome !== '' &&
            (isAbsolute(relToHome) || relToHome === '..' || relToHome.startsWith(`..${sep}`))
          ) {
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: {
                installed: false,
                error: `install path escapes isolated HOME: ${installPath}`,
              },
            });
          }

          // Verify entry skill exists as a regular file in install dir
          const entrySkillPath = resolve(installPath, 'skills', action.entrySkill, 'SKILL.md');
          let entrySkillFound = false;
          try {
            const skillStat = await lstat(entrySkillPath);
            if (skillStat.isFile() && !skillStat.isSymbolicLink()) {
              entrySkillFound = true;
            }
          } catch {
            // entry skill not found
          }

          if (!entrySkillFound) {
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: {
                installed: true,
                installPath,
                entrySkillFound: false,
                error: `entry skill not found: skills/${action.entrySkill}/SKILL.md`,
              },
            });
          }

          // Bind the installed payload back to the sealed authority while
          // normalizing only transport-restored write permission bits.
          let manifestDigest;
          let manifestError = null;
          let payloadBinding = null;
          try {
            payloadBinding = await verifyInstalledMarketplacePayload(
              action,
              context,
              installPath,
              consumer,
            );
            manifestDigest = payloadBinding.manifestDigest;
          } catch (digestErr) {
            // Preserve independently observed fields for diagnostics. This
            // raw digest is not accepted as plan authority because the error
            // is returned and verify therefore fails closed. The legacy
            // contract filters consumer-owned transport metadata; the
            // declared-manifest contract never excludes anything.
            try {
              const installedSnapshot = await computeFrozenSnapshot(installPath, {
                excludeRootEntries: action.payloadContract === undefined
                  ? getPlatform(consumer).knownHostArtifacts
                  : [],
              });
              manifestDigest = installedSnapshot.digest;
            } catch {
              manifestDigest = undefined;
            }
            manifestError = `failed to bind manifestDigest to frozen authority: ${digestErr.message}`;
          }

          // Build observation with CLI-proven fields only (no action backfill)
          const observation = {
            installed: true,
            installPath,
            entrySkillFound: true,
            entrySkill: action.entrySkill,
            manifestDigest,
            consumer,
            ...extraInstalledPathsAudit(payloadBinding),
          };

          // Fields from CLI evidence only, extracted by the platform strategy
          // (a non-automatable platform observe returns via the attestation
          // path above and never reaches this point). Key insertion order is
          // strategy-owned and mirrors the legacy backfill.
          if (platform && platform.strategy.extractListIdentity) {
            Object.assign(observation, platform.strategy.extractListIdentity(found));
          }

          // Cross-validate version: evidence vs CLI
          if (evidence.version && observation.version && evidence.version !== observation.version) {
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: {
                installed: true,
                installPath,
                entrySkillFound: true,
                manifestDigest,
                error: `version mismatch: CLI reports ${observation.version}, evidence shows ${evidence.version}`,
              },
            });
          }

          // Verify installed manifest name/version matches CLI/evidence
          try {
            const installedManifestPath = resolve(installPath, platform.manifestPaths.plugin);
            const installedManifestContent = await readFile(installedManifestPath, 'utf8');
            const installedManifest = JSON.parse(installedManifestContent);
            const expectedName = observation.plugin;
            if (expectedName && installedManifest.name !== expectedName) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: true,
                  installPath,
                  entrySkillFound: true,
                  manifestDigest,
                  error: `installed manifest name "${installedManifest.name}" does not match CLI plugin "${expectedName}"`,
                },
              });
            }
            if (observation.version && installedManifest.version !== observation.version) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: true,
                  installPath,
                  entrySkillFound: true,
                  manifestDigest,
                  error: `installed manifest version "${installedManifest.version}" does not match CLI version "${observation.version}"`,
                },
              });
            }
          } catch (manifestErr) {
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: {
                installed: true,
                installPath,
                entrySkillFound: true,
                manifestDigest,
                error: `installed plugin manifest is missing or invalid: ${manifestErr.message}`,
              },
            });
          }

          // Cross-validate repo/ref: evidence requested values must match current action
          if (evidence.repo && evidence.repo !== action.repo) {
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: {
                installed: true,
                installPath,
                entrySkillFound: true,
                manifestDigest,
                error: `evidence repo "${evidence.repo}" does not match action repo "${action.repo}"`,
              },
            });
          }
          if (evidence.ref && evidence.ref !== action.ref) {
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation: {
                installed: true,
                installPath,
                entrySkillFound: true,
                manifestDigest,
                error: `evidence ref "${evidence.ref}" does not match action ref "${action.ref}"`,
              },
            });
          }

          // Output repo/ref only after cross-validation
          if (evidence.repo) observation.repo = evidence.repo;
          if (evidence.ref) observation.ref = evidence.ref;

          // External independent marketplace form: bind the frozen external
          // identity markers so verify's expected subset matches. These are
          // frozen plan identity (like repo/ref), never re-derived from the
          // remote at observe time; the install-side entry observation above
          // (CLI list version binding) compensates for the weak name-freeze.
          if (action.marketplaceLocation === 'external') {
            observation.marketplaceLocation = action.marketplaceLocation;
            observation.marketplaceCommitSha = action.marketplaceCommitSha;
          }

          return createResult({
            actionType,
            status: ActionStatus.OBSERVED,
            observation,
            error: manifestError,
          });
        }

        return createResult({
          actionType,
          status: ActionStatus.OBSERVED,
          observation: {},
        });
      } catch (err) {
        return createResult({
          actionType,
          status: ActionStatus.OBSERVED,
          error: err.message,
          observation: {},
        });
      }
    },

    /**
     * Verify: compare observed state against the frozen plan's expected state.
     */
    async verify(action, context) {
      const observed = await this.observe(action, context);

      if (observed.error) {
        return createResult({
          actionType: action.actionType,
          status: ActionStatus.VERIFY_FAILED,
          observation: observed.observation,
          error: observed.error,
        });
      }

      const expected = action.expected ?? {};
      const { matches, mismatches } = matchObservation(expected, observed.observation);

      return createResult({
        actionType: action.actionType,
        status: matches ? ActionStatus.VERIFIED : ActionStatus.VERIFY_FAILED,
        observation: observed.observation,
        error: matches ? null : `Observation mismatch: ${mismatches.join('; ')}`,
      });
    },
  });
}

// Test-support exports: white-box regression tests assert the Kimi entry-skill
// resolution and manifest-reading contracts directly (FU-3 / MAJOR-4).
export { resolveKimiEntrySkillFile, readKimiManifest };
