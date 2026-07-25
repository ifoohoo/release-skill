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

import { createHash } from 'node:crypto';
import { computeFrozenSnapshot, resolveFrozenPath } from '../snapshot/frozen.mjs';
import { PLATFORMS, getPlatform } from '../platforms/registry.mjs';
import {
  KIMI_REQUIREMENT_FILE,
  KIMI_ATTESTATION_FILE,
  KIMI_MANAGED_SUBPATH,
  resolveBoundPlanDigest,
  kimiAuthorityDir,
  validateKimiAttestation,
  readKimiManifest,
} from '../platforms/kimi.mjs';

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
/** Audit cap: at most this many extra installed paths are recorded. */
const EXTRA_INSTALLED_PATHS_CAP = 200;
/** Diagnostic cap: at most this many conflict paths are listed per error. */
const PAYLOAD_CONFLICT_REPORT_CAP = 10;

// Consumer-owned transport metadata written into the plugin install root
// that is not part of the published payload (e.g. codex's root `.git`
// checkout and `.codex-plugin/migrated-command-skills/`, claude's `.in_use`
// marker) lives in each platform's `knownHostArtifacts` registry data. Only
// the legacy payload path (frozen plans without a `payloadContract` marker)
// applies that list; declared-manifest-v1 verification never excludes
// anything — host-added files are recorded as `extraInstalledPaths` instead.

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

async function verifyInstalledMarketplacePayload(action, context, installPath, consumer) {
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
  if (payloadContract !== undefined && payloadContract !== PAYLOAD_CONTRACT_DECLARED_MANIFEST) {
    throw new Error(`unsupported marketplace payload contract: ${JSON.stringify(payloadContract)}`);
  }
  if (payloadContract === PAYLOAD_CONTRACT_DECLARED_MANIFEST) {
    // declared-manifest-v1: every authority entry must exist in the installed
    // payload and agree in type/size/bytes/non-write mode bits. Host-added
    // files are NOT failures — they are recorded (relative paths, capped) as
    // audit evidence so host evolution can never break a release, while any
    // missing or altered declared file still fails closed.
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
        `installed marketplace payload differs in path, bytes, size, or non-write mode bits (${PAYLOAD_CONTRACT_DECLARED_MANIFEST}): ${listed}${overflow}`,
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

const SUPPORTED_TYPES = [
  ActionType.PLUGIN_MANIFEST_VALIDATE,
  ActionType.PLUGIN_INSTALL_CHECK,
  ActionType.CLAUDE_MARKETPLACE_INSTALL,
  ActionType.CODEX_MARKETPLACE_INSTALL,
  ActionType.KIMI_MARKETPLACE_INSTALL,
];

/** Safe repo pattern: owner/repo with alphanumeric, hyphens, dots, underscores. */
const SAFE_REPO_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

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
  if (!getPlatform(consumer).automatable) {
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
          actionType === ActionType.KIMI_MARKETPLACE_INSTALL
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

          // 6. Verify frozen snapshot exists and contains required marketplace files
          const consumer = action.consumer;
          const platform = getPlatform(consumer);
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

          // A non-automatable platform (kimi) has no non-interactive
          // marketplace/install API: the whole repo is installed as one
          // plugin. The authoritative manifest is read from the verified
          // snapshot root via the platform strategy's official precedence
          // (kimi.plugin.json over .kimi-plugin/plugin.json).
          if (!platform.automatable) {
            let kimiManifestResult;
            try {
              kimiManifestResult = await platform.strategy.readManifest(snapshotDirReal);
            } catch (manifestErr) {
              return createResult({
                actionType,
                status: ActionStatus.PREFLIGHT_FAILED,
                error: `frozen snapshot kimi manifest invalid: ${manifestErr.message}`,
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

          if (platform.automatable) {
          // Verify marketplace files exist.
          // marketplace.json is at the snapshot root; plugin manifest is
          // resolved relative to the entry's declared source path.
          const marketplaceRelative = platform.manifestPaths.marketplace;

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
          const sourceDirAbs = resolve(snapshotDirReal, sourcePath);
          const sourceDirReal = await realpath(sourceDirAbs).catch(() => null);
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

          // Resolve plugin manifest relative to the declared source path.
          // For root layouts (source: "./"), this resolves to
          //   snapshot/.claude-plugin/plugin.json
          // For subdirectory layouts (source: "./adapters/claude"), this resolves to
          //   snapshot/adapters/claude/.claude-plugin/plugin.json
          const manifestRelative = join(sourcePath, platform.manifestPaths.plugin);
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

          // Verify the entry skill exists in the snapshot.
          // Automatable platforms' manifests always declare ./skills/, so the
          // fixed skills/<entrySkill>/SKILL.md layout is authoritative for
          // them. A non-automatable platform (kimi) resolves the entry skill
          // via the manifest-declared skills root (MAJOR-4): the root is
          // validated + realpath-contained, and omitted `skills` means the
          // official single-skill root SKILL.md.
          if (!platform.automatable) {
            try {
              await resolveKimiEntrySkillFile(snapshotDirReal, kimiSnapshotManifest, action.entrySkill);
            } catch (entryErr) {
              return createResult({
                actionType,
                status: ActionStatus.PREFLIGHT_FAILED,
                error: `entry skill not resolvable in snapshot: ${entryErr.message}`,
              });
            }
          } else {
            const entrySkillFile = resolve(snapshotDirReal, 'skills', action.entrySkill, 'SKILL.md');
            try {
              await stat(entrySkillFile);
            } catch {
              return createResult({
                actionType,
                status: ActionStatus.PREFLIGHT_FAILED,
                error: `entry skill not found in snapshot: skills/${action.entrySkill}/SKILL.md`,
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
        actionType === ActionType.KIMI_MARKETPLACE_INSTALL
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
          // uses a stable plan-digest-keyed home and deliberately SKIPS the
          // per-run isolated consumer dir and its runDir containment check
          // (that model only fits automatable platforms, which exec a real
          // CLI into a per-run HOME).
          const platform = getPlatform(action.consumer);
          if (!platform.automatable) {
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
          actionType === ActionType.KIMI_MARKETPLACE_INSTALL
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
          // Registry-driven platform data. observe historically applies no
          // consumer validation gate (execute/preflight validate it), so an
          // unregistered consumer keeps the legacy fall-through shape: a
          // kimi-shaped env, no attestation branch, and no CLI binary — it
          // still fails closed on the missing execute evidence below.
          const platform = PLATFORMS.find((p) => p.id === consumer) ?? null;
          const cliCmd = platform ? (platform.cli ? platform.cli.binary : null) : 'kimi';
          const baseEnv = { ...process.env, ...(context.env ?? {}) };
          const env = {
            ...baseEnv,
            ...(platform
              ? platform.isolationEnv(isolatedHome)
              : { HOME: isolatedHome, KIMI_CODE_HOME: isolatedHome }),
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
          if (platform && !platform.automatable) {
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
            // so they survive publish PARTIAL -> reconcile -> verify (each of
            // which uses a fresh runDir).
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
            if (
              requirement.planDigest !== boundPlanDigest ||
              requirement.plugin !== action.plugin ||
              requirement.version !== action.version ||
              requirement.entrySkill !== action.entrySkill ||
              requirement.repo !== action.repo ||
              requirement.ref !== expectedRef
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

            // The attested install path must live in the documented managed
            // layout under the STABLE, plan-digest-keyed isolated home (B). The
            // managed root is derived from the authority dir (itself derived from
            // the verified plan digest + plugin), so it is identical across
            // publish/reconcile/verify run dirs. No lexical-containment fallback
            // (C): every path must realpath-resolve and stay contained; a missing
            // home/root, a symlink, or an escape fails closed.
            const kimiCodeHome = resolve(attestationDir, 'kimi-home');
            const kimiCodeHomeReal = await realpath(kimiCodeHome).catch(() => null);
            if (!kimiCodeHomeReal) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: false,
                  error: `KIMI_CODE_HOME does not exist or cannot be resolved: ${kimiCodeHome}`,
                },
              });
            }
            const managedRootReal = await realpath(resolve(kimiCodeHomeReal, KIMI_MANAGED_SUBPATH, action.plugin)).catch(() => null);
            if (!managedRootReal) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: false,
                  error: `kimi managed plugin root does not exist: ${resolve(kimiCodeHomeReal, KIMI_MANAGED_SUBPATH, action.plugin)}`,
                },
              });
            }
            // installPath must be a real directory (not a symlink) that resolves
            // inside the managed root.
            const installPath = resolve(attestation.installPath);
            let installPathStat;
            try {
              installPathStat = await lstat(installPath);
            } catch {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: { installed: false, error: `kimi install path does not exist: ${attestation.installPath}` },
              });
            }
            if (installPathStat.isSymbolicLink()) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: { installed: false, error: `kimi install path must not be a symlink: ${attestation.installPath}` },
              });
            }
            if (!installPathStat.isDirectory()) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: { installed: false, error: `kimi install path must be a directory: ${attestation.installPath}` },
              });
            }
            const installPathReal = await realpath(installPath).catch(() => null);
            if (!installPathReal) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: { installed: false, error: `kimi install path cannot be resolved: ${attestation.installPath}` },
              });
            }
            const sepK = process.platform === 'win32' ? '\\' : '/';
            const relToManaged = relative(managedRootReal, installPathReal);
            if (
              relToManaged !== '' &&
              (isAbsolute(relToManaged) || relToManaged === '..' || relToManaged.startsWith(`..${sepK}`))
            ) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: false,
                  error: `kimi install path escapes the managed root (${managedRootReal}): ${attestation.installPath}`,
                },
              });
            }

            // Read-only payload binding: the installed managed copy must match
            // the sealed frozen authority exactly (transport-normalized).
            let manifestDigest;
            let payloadBinding = null;
            try {
              payloadBinding = await verifyInstalledMarketplacePayload(action, context, installPathReal, consumer);
              manifestDigest = payloadBinding.manifestDigest;
            } catch (digestErr) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: true,
                  installPath: installPathReal,
                  error: `failed to bind installed kimi payload to frozen authority: ${digestErr.message}`,
                },
              });
            }
            if (manifestDigest !== action.manifestDigest) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: true,
                  installPath: installPathReal,
                  error: 'installed kimi payload digest does not match the frozen plan digest',
                },
              });
            }

            // Entry skill must resolve via the installed manifest's skills root
            // (MAJOR-4), with official manifest precedence.
            let installedManifest;
            let entrySkillFound = false;
            try {
              const readManifest = await platform.strategy.readManifest(installPathReal);
              installedManifest = readManifest.manifest;
              await resolveKimiEntrySkillFile(installPathReal, installedManifest, action.entrySkill);
              entrySkillFound = true;
            } catch (entryErr) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: true,
                  installPath: installPathReal,
                  manifestDigest,
                  entrySkillFound: false,
                  error: `kimi entry skill not resolvable in installed copy: ${entryErr.message}`,
                },
              });
            }

            // Installed manifest identity must match the frozen action.
            if (installedManifest.name !== action.plugin) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: true,
                  installPath: installPathReal,
                  manifestDigest,
                  entrySkillFound: true,
                  error: `installed kimi manifest name "${installedManifest.name}" does not match action plugin "${action.plugin}"`,
                },
              });
            }
            if (installedManifest.version !== action.version) {
              return createResult({
                actionType,
                status: ActionStatus.OBSERVED,
                observation: {
                  installed: true,
                  installPath: installPathReal,
                  manifestDigest,
                  entrySkillFound: true,
                  error: `installed kimi manifest version "${installedManifest.version}" does not match action version "${action.version}"`,
                },
              });
            }

            // Build the observation from independently verified fields only.
            // marketplace is intentionally NOT a kimi identity field (MINOR-1).
            const observation = {
              installed: true,
              installPath: installPathReal,
              entrySkillFound: true,
              entrySkill: action.entrySkill,
              manifestDigest,
              consumer,
              plugin: installedManifest.name,
              version: installedManifest.version,
              repo: action.repo,
              ref: expectedRef,
              ...extraInstalledPathsAudit(payloadBinding),
            };
            return createResult({
              actionType,
              status: ActionStatus.OBSERVED,
              observation,
            });
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
