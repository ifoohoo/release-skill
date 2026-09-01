/**
 * Platform registry — the single source of truth for consumer-platform
 * knowledge (claude / codex / kimi / codebuddy).
 *
 * T2.2 converges platform facts that were scattered across plugin-marketplace.mjs,
 * build-adapters.mjs, prepare.mjs, plan.mjs and project.yaml into this module.
 * Data that is purely declarative (paths, argv templates, env construction,
 * manifest layout, host-artifact exemptions, schema required fields) lives in
 * each platform's descriptor; protocol LOGIC differences (claude `list` returns
 * an array vs codex returns `{installed:[]}`) live in per-platform strategy
 * functions referenced from the descriptor. Data in tables, logic in functions
 * — neither scattered.
 *
 * Adding a platform is meant to converge on ~3 hand edits: a descriptor +
 * strategy here, a schema enum bump (the schema-contract test turns red until
 * it is done), and a regeneration of the manifest/adapter producers.
 *
 * `assertRegistry()` runs at module load: a malformed registry throws at import
 * time, never at runtime.
 *
 * NOTE (T2.2 step 2): the claude/codex strategy functions (pure list-parse /
 * install-path / identity extraction / list cross-validation) live in this
 * file; kimi's side-effecting manual-requirement and manifest-reading
 * strategies live in ./kimi.mjs (§4.2's per-platform-module option — the only
 * non-trivial strategies) and are referenced from the kimi descriptor below.
 * codebuddy's analogous human-attestation strategies live in ./codebuddy.mjs
 * and are referenced from the codebuddy descriptor below.
 * plugin-marketplace.mjs consumes every platform difference through this
 * registry; see the t2-2 deviation record for the step-2 wiring details.
 *
 * @module platforms/registry
 */

import { join } from 'node:path';

import { bundledHostProfilesRoot, resolveHostId } from 'skill-family-engineering-kit';

import {
  executeKimiManualRequirement,
  readKimiManifest,
  KIMI_MANIFEST_CANDIDATES,
} from './kimi.mjs';
import {
  executeCodeBuddyManualRequirement,
  readCodeBuddyManifest,
} from './codebuddy.mjs';
import {
  executeCodexManualRequirement,
  readCodexManifest,
} from './codex.mjs';

// --- claude strategy -------------------------------------------------------

function claudeParseListOutput(listOutput, pluginId) {
  // Claude `plugin list --json` returns a top-level array; installPath is read
  // from the matching entry.
  if (!Array.isArray(listOutput)) {
    return { ok: false, error: 'Claude plugin list did not return an array' };
  }
  const found = listOutput.find((p) => p.id === pluginId);
  if (!found) {
    return { ok: false, error: `plugin "${pluginId}" not found in Claude plugin list` };
  }
  if (!found.installPath) {
    return { ok: false, error: `plugin "${pluginId}" found but missing installPath` };
  }
  return { ok: true, found, installPath: found.installPath };
}

function claudeExtractInstallPath({ listParsed }) {
  // Claude reports no installedPath at install time; the install path comes from
  // the parsed list entry. Callers only invoke this after parseListOutput
  // returned ok, which guarantees a non-empty installPath (fail-closed there).
  return { ok: true, installPath: listParsed?.installPath };
}

function claudeExtractListIdentity(found) {
  // Claude list may not have name; extract plugin/marketplace from id.
  // Key order (plugin, marketplace, version) is observation-serialization
  // relevant and mirrors the legacy observe backfill byte-for-byte.
  const idParts = found.id.split('@');
  const identity = { plugin: idParts[0], marketplace: idParts.slice(1).join('@') };
  if (found.version) identity.version = found.version;
  return identity;
}

// --- codex strategy --------------------------------------------------------

function codexParseListOutput(listOutput, pluginId) {
  // Codex `plugin list --json` returns `{installed: [...]}`; the list does NOT
  // carry installedPath (that comes from the install evidence).
  const installed = listOutput?.installed;
  if (!Array.isArray(installed)) {
    return { ok: false, error: 'Codex plugin list did not return {installed: [...]}' };
  }
  const found = installed.find((p) => p.pluginId === pluginId);
  if (!found) {
    return { ok: false, error: `plugin "${pluginId}" not found in Codex installed list` };
  }
  return { ok: true, found };
}

function codexExtractInstallPath({ execEvidence }) {
  const installPath = execEvidence?.installOutput?.installedPath;
  if (!installPath) {
    return { ok: false, error: 'evidence install JSON missing installedPath' };
  }
  return { ok: true, installPath };
}

function codexExtractListIdentity(found) {
  // Every field is conditional in the codex list output. Key order (plugin,
  // marketplace, version) mirrors the legacy observe backfill byte-for-byte.
  const identity = {};
  if (found.name) identity.plugin = found.name;
  if (found.marketplaceName) identity.marketplace = found.marketplaceName;
  if (found.version) identity.version = found.version;
  return identity;
}

function codexCrossValidateListEntry(found, action) {
  // Cross-validate: list fields must match evidence/action.
  if (found.name !== action.plugin) {
    return { ok: false, error: `list name "${found.name}" does not match action plugin "${action.plugin}"` };
  }
  if (found.marketplaceName !== action.marketplace) {
    return { ok: false, error: `list marketplaceName "${found.marketplaceName}" does not match action marketplace "${action.marketplace}"` };
  }
  if (found.version !== action.version) {
    return { ok: false, error: `list version "${found.version}" does not match action version "${action.version}"` };
  }
  return { ok: true };
}

// --- platform descriptors --------------------------------------------------

const CLAUDE = Object.freeze({
  id: 'claude',
  skillProjectionSurface: 'platforms/claude-code',
  distributionType: 'claude-plugin',
  actionType: 'claude-marketplace-install',
  // Runtime adapter implementing this platform's marketplace-install action.
  // prepare.mjs stamps it onto generated actions; plan.mjs derives its
  // actionType -> adapter map from it (T2.2 step 3).
  adapter: 'plugin-marketplace',
  automatable: true,
  // --- capability contract (平台能力契约) ------------------------------------
  installMethod: 'structured-cli',
  refStrength: 'name-ref',
  outputProtocol: 'text',
  identityEvidence: 'list-record',
  degradationPolicy: 'block',
  cli: Object.freeze({
    binary: 'claude',
    marketplaceAdd: (repo, ref) => ['plugin', 'marketplace', 'add', `${repo}@${ref}`],
    install: (plugin, marketplace) => ['plugin', 'install', `${plugin}@${marketplace}`],
    list: () => ['plugin', 'list', '--json'],
  }),
  jsonProtocol: Object.freeze({
    listOutput: 'array',
    installPathSource: 'list',
    // claude marketplace add / plugin install emit no validated JSON output.
    marketplaceAddOutput: null,
    pluginInstallOutput: null,
  }),
  isolationEnv: (home) => ({ HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude') }),
  // execute pre-creates the claude config dir under the isolated HOME.
  isolationSubdirs: Object.freeze(['.claude']),
  manifestPaths: Object.freeze({
    plugin: '.claude-plugin/plugin.json',
    marketplace: '.claude-plugin/marketplace.json',
  }),
  marketplaceSourceForm: 'string',
  // Claude carries the authoritative version in the marketplace entry: the
  // preflight binds entry.version to the action version.
  marketplaceEntryCarriesVersion: true,
  // External marketplace form: `claude plugin marketplace add repo@<ref>` can
  // only pin a branch/tag NAME (a bare commit sha fails to clone and the
  // resolved sha is not recorded locally) — name-form weak freeze.
  marketplaceRefForm: 'name',
  knownHostArtifacts: Object.freeze(['.in_use']),
  schemaRequiredFields: Object.freeze(['plugin', 'marketplace', 'entrySkill']),
  skillRendering: Object.freeze({ mode: 'verbatim', preamble: null, placeholder: '${CLAUDE_PLUGIN_ROOT}' }),
  buildAdapter: Object.freeze({
    // D6: explicit adapter directory name (adapters/claude/); assertRegistry
    // requires this on every platform.
    name: 'claude',
    pluginDirName: '.claude-plugin',
    templateFileName: 'plugin.json',
    marketplaceFileName: 'marketplace.json',
    hasMarketplace: true,
  }),
  strategy: Object.freeze({
    parseListOutput: claudeParseListOutput,
    extractInstallPath: claudeExtractInstallPath,
    extractListIdentity: claudeExtractListIdentity,
    crossValidateListEntry: null,
    buildManualRequirement: null,
    readManifest: null,
  }),
});

const CODEX = Object.freeze({
  id: 'codex',
  skillProjectionSurface: 'platforms/codex',
  distributionType: 'codex-plugin',
  actionType: 'codex-marketplace-install',
  adapter: 'plugin-marketplace',
  automatable: true,
  // --- capability contract (平台能力契约) ------------------------------------
  installMethod: 'structured-cli',
  refStrength: 'commit-sha',
  outputProtocol: 'structured',
  identityEvidence: 'install-output',
  degradationPolicy: 'human-attestation-with-fallback',
  cli: Object.freeze({
    binary: 'codex',
    marketplaceAdd: (repo, ref) => ['plugin', 'marketplace', 'add', repo, '--ref', ref, '--json'],
    install: (plugin, marketplace) => ['plugin', 'add', `${plugin}@${marketplace}`, '--json'],
    list: () => ['plugin', 'list', '--json'],
  }),
  jsonProtocol: Object.freeze({
    listOutput: 'installed-object',
    installPathSource: 'install-output',
    // codex emits validated JSON for both marketplace add and plugin add.
    marketplaceAddOutput: 'json',
    pluginInstallOutput: 'json',
  }),
  isolationEnv: (home) => ({ HOME: home, CODEX_HOME: home }),
  // execute pre-creates the codex state dir under the isolated HOME.
  isolationSubdirs: Object.freeze(['.codex']),
  manifestPaths: Object.freeze({
    plugin: '.codex-plugin/plugin.json',
    marketplace: '.agents/plugins/marketplace.json',
  }),
  marketplaceSourceForm: 'local-path-object',
  // Codex keeps the authoritative version in .codex-plugin/plugin.json; the
  // marketplace entry version is not bound to the action version.
  marketplaceEntryCarriesVersion: false,
  // External marketplace form: `codex plugin marketplace add repo --ref <ref>`
  // accepts a bare commit sha — sha-form strong freeze.
  marketplaceRefForm: 'sha',
  knownHostArtifacts: Object.freeze(['.git', '.codex-plugin/migrated-command-skills']),
  schemaRequiredFields: Object.freeze(['plugin', 'marketplace', 'entrySkill']),
  skillRendering: Object.freeze({ mode: 'substitute', preamble: 'codex', placeholder: '${CLAUDE_PLUGIN_ROOT}' }),
  buildAdapter: Object.freeze({
    // D6: explicit adapter directory name (adapters/codex/).
    name: 'codex',
    pluginDirName: '.codex-plugin',
    templateFileName: 'plugin.json',
    marketplaceFileName: null,
    hasMarketplace: false,
  }),
  strategy: Object.freeze({
    parseListOutput: codexParseListOutput,
    extractInstallPath: codexExtractInstallPath,
    extractListIdentity: codexExtractListIdentity,
    crossValidateListEntry: codexCrossValidateListEntry,
    // codex's human-attestation fallback strategy lives in ./codex.mjs
    buildManualRequirement: executeCodexManualRequirement,
    readManifest: readCodexManifest,
  }),
});

const KIMI = Object.freeze({
  id: 'kimi',
  skillProjectionSurface: 'platforms/kimi-code',
  distributionType: 'kimi-plugin',
  actionType: 'kimi-marketplace-install',
  adapter: 'plugin-marketplace',
  automatable: false,
  // --- capability contract (平台能力契约) ------------------------------------
  installMethod: 'interactive-only',
  refStrength: 'unfixable',
  outputProtocol: 'none',
  identityEvidence: 'filesystem-payload',
  degradationPolicy: 'human-attestation',
  cli: null,
  jsonProtocol: Object.freeze({
    listOutput: null,
    installPathSource: null,
    marketplaceAddOutput: null,
    pluginInstallOutput: null,
  }),
  isolationEnv: (home) => ({ HOME: home }),
  // kimi never execs a CLI; its stable home is created by the
  // manual-requirement strategy under the attestation authority.
  isolationSubdirs: Object.freeze([]),
  manifestPaths: Object.freeze({
    // kimi.plugin.json takes precedence over .kimi-plugin/plugin.json
    // (strategy.readManifest / readKimiManifest in ./kimi.mjs).
    pluginCandidates: KIMI_MANIFEST_CANDIDATES,
    marketplace: null,
  }),
  marketplaceSourceForm: null,
  // kimi has no marketplace at all, so the entry-version binding does not
  // apply (null = N/A, never consulted: kimi preflight reads its manifest via
  // strategy.readManifest).
  marketplaceEntryCarriesVersion: null,
  // kimi has no marketplace add at all, so the marketplace ref form does not
  // apply (null = N/A, never consulted).
  marketplaceRefForm: null,
  knownHostArtifacts: Object.freeze(['.git']),
  schemaRequiredFields: Object.freeze(['plugin', 'entrySkill']),
  skillRendering: Object.freeze({ mode: 'substitute', preamble: 'kimi', placeholder: '${CLAUDE_PLUGIN_ROOT}' }),
  buildAdapter: Object.freeze({
    // D6: explicit adapter directory name (adapters/kimi/).
    name: 'kimi',
    pluginDirName: '.kimi-plugin',
    templateFileName: 'plugin.json',
    marketplaceFileName: null,
    hasMarketplace: false,
  }),
  strategy: Object.freeze({
    parseListOutput: null,
    extractInstallPath: null,
    extractListIdentity: null,
    crossValidateListEntry: null,
    // kimi's side-effecting manual-requirement builder and manifest reader
    // live in ./kimi.mjs (§4.2 per-platform-module option).
    buildManualRequirement: executeKimiManualRequirement,
    readManifest: readKimiManifest,
  }),
});

// CodeBuddy (desktop product WorkBuddy) is a NON-automatable human-attestation
// platform like kimi: the codebuddy CLI's marketplace add/install cannot pin a
// frozen ref (no ref option; the install tracks the default branch / latest),
// so an automated install checkpoint cannot guarantee frozen-artifact identity.
// Install state has a stable on-disk layout, so the closed loop is proven by a
// human attestation + read-only verification (./codebuddy.mjs), fail-closed at
// the same severity as kimi.
//
// NAMING MAPPING: the platform id is `codebuddy`, but its BUILD adapter keeps
// the historical directory name `workbuddy` (`adapters/workbuddy/`, manifest
// `.codebuddy-plugin/plugin.json`). `buildAdapter.name = 'workbuddy'` drives
// the build-adapters producer + public-file collection; the pipeline identity
// (distributionType/actionType/consumer) stays `codebuddy`.
const CODEBUDDY = Object.freeze({
  id: 'codebuddy',
  skillProjectionSurface: 'platforms/workbuddy',
  distributionType: 'codebuddy-plugin',
  actionType: 'codebuddy-marketplace-install',
  adapter: 'plugin-marketplace',
  automatable: false,
  // --- capability contract (平台能力契约) ------------------------------------
  installMethod: 'human-attestation',
  refStrength: 'unfixable',
  outputProtocol: 'none',
  identityEvidence: 'human-attestation',
  degradationPolicy: 'human-attestation',
  cli: null,
  jsonProtocol: Object.freeze({
    listOutput: null,
    installPathSource: null,
    marketplaceAddOutput: null,
    pluginInstallOutput: null,
  }),
  // The closed loop never execs the codebuddy CLI; HOME is the only isolation
  // input and exists solely so the attestation's isolated cli-channel home has
  // a base. No unverified host env vars are fabricated.
  isolationEnv: (home) => ({ HOME: home }),
  // codebuddy never execs a CLI; its isolated cli home is created by the
  // manual-requirement strategy under the attestation authority.
  isolationSubdirs: Object.freeze([]),
  manifestPaths: Object.freeze({
    // Single authoritative manifest (no precedence chain, unlike kimi).
    plugin: '.codebuddy-plugin/plugin.json',
    // CodeBuddy bundled-family uses the skill-family marketplace path.
    // This ensures bundled-family installation contracts always include a
    // marketplace entry without requiring an explicit marketplaceIndexPath.
    marketplace: '.claude-plugin/marketplace.json',
  }),
  marketplaceSourceForm: null,
  // codebuddy installs from a unified marketplace whose identity is optional
  // on the action: a distribution may declare `marketplace` to override the
  // default constant in ./codebuddy.mjs (resolveCodeBuddyMarketplace); the
  // entry-version binding does not apply either way (null = N/A).
  marketplaceEntryCarriesVersion: null,
  // codebuddy has no marketplace add that can pin a frozen ref (attestation
  // loop instead), so the marketplace ref form does not apply (null = N/A).
  marketplaceRefForm: null,
  knownHostArtifacts: Object.freeze(['.git']),
  schemaRequiredFields: Object.freeze(['plugin', 'entrySkill']),
  // Declarative rendering intent (the build-adapters producer keys on
  // buildAdapter.name = 'workbuddy'): pure ${CLAUDE_PLUGIN_ROOT} ->
  // ${CODEBUDDY_PLUGIN_ROOT} substitution, no entry-resolution preamble
  // (CodeBuddy expands the variable inline in skill content).
  skillRendering: Object.freeze({ mode: 'substitute', preamble: null, placeholder: '${CODEBUDDY_PLUGIN_ROOT}' }),
  buildAdapter: Object.freeze({
    // Build adapter keeps the historical `workbuddy` directory name; the fields
    // are byte-for-byte the legacy BUILD_ONLY workbuddy entry so the generated
    // adapters/workbuddy/ tree is unchanged.
    name: 'workbuddy',
    pluginDirName: '.codebuddy-plugin',
    templateFileName: 'plugin.json',
    marketplaceFileName: null,
    hasMarketplace: false,
  }),
  strategy: Object.freeze({
    parseListOutput: null,
    extractInstallPath: null,
    extractListIdentity: null,
    crossValidateListEntry: null,
    // codebuddy's side-effecting manual-requirement builder and manifest reader
    // live in ./codebuddy.mjs (per-platform-module option, mirroring kimi).
    buildManualRequirement: executeCodeBuddyManualRequirement,
    readManifest: readCodeBuddyManifest,
  }),
});

/** Ordered platform registry. Order is significant (claude, codex, kimi, codebuddy). */
export const PLATFORMS = Object.freeze([CLAUDE, CODEX, KIMI, CODEBUDDY]);

const VALID_DISTRIBUTION_TYPES = new Set(['claude-plugin', 'codex-plugin', 'kimi-plugin', 'codebuddy-plugin']);
const VALID_ACTION_TYPES = new Set(['claude-marketplace-install', 'codex-marketplace-install', 'kimi-marketplace-install', 'codebuddy-marketplace-install']);
const VALID_SOURCE_FORMS = new Set(['string', 'local-path-object', null]);
const VALID_MARKETPLACE_REF_FORMS = new Set(['sha', 'name', null]);
const VALID_LIST_OUTPUTS = new Set(['array', 'installed-object', null]);
const VALID_CLI_OUTPUTS = new Set(['json', null]);
const VALID_ENTRY_VERSION_BINDING = new Set([true, false, null]);
const VALID_INSTALL_METHODS = new Set(['structured-cli', 'interactive-only', 'human-attestation']);
const VALID_REF_STRENGTHS = new Set(['commit-sha', 'name-ref', 'unfixable']);
const VALID_OUTPUT_PROTOCOLS = new Set(['structured', 'text', 'none']);
const VALID_IDENTITY_EVIDENCE = new Set(['list-record', 'install-output', 'filesystem-payload', 'human-attestation']);
const VALID_DEGRADATION_POLICIES = new Set(['block', 'human-attestation', 'human-attestation-with-fallback']);
const SKILL_PROJECTION_SURFACE_PATTERN = /^platforms\/[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/**
 * Look up a platform descriptor by id.
 *
 * @param {string} id
 * @returns {object}
 */
export function getPlatform(id) {
  const platform = PLATFORMS.find((p) => p.id === id);
  if (!platform) throw new Error(`unknown platform: ${id}`);
  return platform;
}

const STANDALONE_SHA_RE = /^[0-9a-f]{40}$/u;

function standaloneIdentityCore(platformOrId, fields) {
  const platform = typeof platformOrId === 'string' ? getPlatform(platformOrId) : platformOrId;
  const id = platform?.id;
  if (id !== 'claude' && id !== 'codex') {
    throw new Error(`standalone-index install identity is unsupported for platform "${id ?? '<unknown>'}"`);
  }
  const { name, source, version } = fields;
  if (typeof name !== 'string' || name.length === 0
    || !source || typeof source !== 'object' || Array.isArray(source)
    || typeof source.source !== 'string'
    || typeof source.ref !== 'string' || source.ref.length === 0
    || typeof source.sha !== 'string' || !STANDALONE_SHA_RE.test(source.sha)) {
    throw new Error(`${id} standalone-index install identity has invalid owned fields`);
  }
  if (id === 'claude') {
    if (source.source !== 'github' || typeof source.repo !== 'string' || source.repo.length === 0
      || typeof version !== 'string' || version.length === 0) {
      throw new Error('Claude standalone-index install identity requires github repo, ref, sha, and version');
    }
    return {
      name,
      source: { source: 'github', repo: source.repo, ref: source.ref, sha: source.sha },
      version,
    };
  }
  if (source.source !== 'url' || typeof source.url !== 'string' || source.url.length === 0) {
    throw new Error('Codex standalone-index install identity requires url, ref, and sha');
  }
  return {
    name,
    source: { source: 'url', url: source.url, ref: source.ref, sha: source.sha },
  };
}

/** Build the expected install identity from the frozen plugin contract. */
export function buildExpectedStandaloneIndexInstallIdentity(platformOrId, frozenIdentity = {}) {
  const platform = typeof platformOrId === 'string' ? getPlatform(platformOrId) : platformOrId;
  const id = platform?.id;
  const { name, repo, tag, sha, version } = frozenIdentity;
  if (typeof repo !== 'string' || repo.length === 0 || typeof tag !== 'string' || tag.length === 0) {
    throw new Error('standalone-index expected identity requires a plugin repository and tag');
  }
  if (id === 'claude') {
    return standaloneIdentityCore(platform, {
      name,
      version,
      source: { source: 'github', repo, ref: tag, sha },
    });
  }
  if (id === 'codex') {
    return standaloneIdentityCore(platform, {
      name,
      source: { source: 'url', url: `https://github.com/${repo}.git`, ref: `refs/tags/${tag}`, sha },
    });
  }
  return standaloneIdentityCore(platform, { name, source: {}, version });
}

/** Project only the actual remote entry; frozen plan fields are never accepted. */
export function projectObservedStandaloneIndexInstallIdentity(platformOrId, entry) {
  const platform = typeof platformOrId === 'string' ? getPlatform(platformOrId) : platformOrId;
  const id = platform?.id;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('standalone-index observed identity requires an entry object');
  }
  const source = entry.source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('standalone-index observed identity requires a source object');
  }
  if (id === 'claude') {
    return standaloneIdentityCore(platform, {
      name: entry.name,
      version: entry.version,
      source: {
        source: source.source,
        repo: source.repo,
        ref: source.ref,
        sha: source.sha,
      },
    });
  }
  if (id === 'codex') {
    return standaloneIdentityCore(platform, {
      name: entry.name,
      source: {
        source: source.source,
        url: source.url,
        ref: source.ref,
        sha: source.sha,
      },
    });
  }
  return standaloneIdentityCore(platform, { name: entry.name, source });
}

/**
 * Resolve a declared skill projection surface to its public host name.
 * The host is always derived from the descriptor's authoritative
 * `buildAdapter.name`; unknown surfaces fail closed with `null`.
 *
 * @param {string} surfaceId
 * @param {object[]} [registry]
 * @returns {string|null}
 */
export function resolveSkillProjectionSurfaceHost(surfaceId, registry = PLATFORMS) {
  const platform = registry.find((item) => item.skillProjectionSurface === surfaceId);
  return platform?.buildAdapter?.name ?? null;
}

/**
 * Validate a registry (defaults to the module registry). Throws on the first
 * malformed description so a registry typo fails at import time.
 *
 * @param {object[]} [registry] - Platform descriptors to validate.
 */
export function assertRegistry(registry = PLATFORMS) {
  const seen = new Set();
  const seenSkillProjectionSurfaces = new Set();
  for (const platform of registry) {
    const label = platform?.id ?? '<missing id>';
    if (typeof platform?.id !== 'string' || platform.id.length === 0) {
      throw new Error('platform registry: every platform needs a string id');
    }
    if (seen.has(platform.id)) {
      throw new Error(`platform registry: ids must be unique, found duplicate "${platform.id}"`);
    }
    seen.add(platform.id);

    if (!VALID_DISTRIBUTION_TYPES.has(platform.distributionType)) {
      throw new Error(`platform registry: ${label} has illegal distributionType "${platform.distributionType}"`);
    }
    if (!VALID_ACTION_TYPES.has(platform.actionType)) {
      throw new Error(`platform registry: ${label} has illegal actionType "${platform.actionType}"`);
    }
    if (typeof platform.adapter !== 'string' || platform.adapter.length === 0) {
      throw new Error(`platform registry: ${label} needs a non-empty adapter id`);
    }
    if (!VALID_ENTRY_VERSION_BINDING.has(platform.marketplaceEntryCarriesVersion)) {
      throw new Error(`platform registry: ${label} has illegal marketplaceEntryCarriesVersion "${platform.marketplaceEntryCarriesVersion}"`);
    }
    if (typeof platform.automatable !== 'boolean') {
      throw new Error(`platform registry: ${label} automatable must be boolean`);
    }
    if (typeof platform.isolationEnv !== 'function') {
      throw new Error(`platform registry: ${label} isolationEnv must be a function`);
    }
    if (!VALID_SOURCE_FORMS.has(platform.marketplaceSourceForm)) {
      throw new Error(`platform registry: ${label} has illegal marketplaceSourceForm "${platform.marketplaceSourceForm}"`);
    }
    if (!VALID_MARKETPLACE_REF_FORMS.has(platform.marketplaceRefForm)) {
      throw new Error(`platform registry: ${label} has illegal marketplaceRefForm "${platform.marketplaceRefForm}"`);
    }
    if (!Array.isArray(platform.knownHostArtifacts)) {
      throw new Error(`platform registry: ${label} knownHostArtifacts must be an array`);
    }
    if (!Array.isArray(platform.schemaRequiredFields)) {
      throw new Error(`platform registry: ${label} schemaRequiredFields must be an array`);
    }
    if (!platform.manifestPaths || typeof platform.manifestPaths !== 'object') {
      throw new Error(`platform registry: ${label} manifestPaths must be an object`);
    }
    if (!platform.buildAdapter || typeof platform.buildAdapter !== 'object') {
      throw new Error(`platform registry: ${label} buildAdapter must be an object`);
    }
    // D6: the adapter directory name is always explicit — prepare's G4
    // declared-host reconciliation and the build producer both key on it.
    if (typeof platform.buildAdapter.name !== 'string' || platform.buildAdapter.name.length === 0) {
      throw new Error(`platform registry: ${label} buildAdapter needs a non-empty name (its adapter directory name)`);
    }
    if (typeof platform.skillProjectionSurface !== 'string'
        || !SKILL_PROJECTION_SURFACE_PATTERN.test(platform.skillProjectionSurface)) {
      throw new Error(`platform registry: ${label} skillProjectionSurface must match platforms/<slug>`);
    }
    if (seenSkillProjectionSurfaces.has(platform.skillProjectionSurface)) {
      throw new Error(`platform registry: duplicate skillProjectionSurface "${platform.skillProjectionSurface}"; aliases must be unique`);
    }
    seenSkillProjectionSurfaces.add(platform.skillProjectionSurface);
    if (resolveSkillProjectionSurfaceHost(platform.skillProjectionSurface, registry) !== platform.buildAdapter.name) {
      throw new Error(`platform registry: ${label} skillProjectionSurface must map to buildAdapter.name`);
    }
    if (!VALID_LIST_OUTPUTS.has(platform.jsonProtocol?.listOutput)) {
      throw new Error(`platform registry: ${label} has illegal jsonProtocol.listOutput "${platform.jsonProtocol?.listOutput}"`);
    }
    if (!VALID_CLI_OUTPUTS.has(platform.jsonProtocol?.marketplaceAddOutput)) {
      throw new Error(`platform registry: ${label} has illegal jsonProtocol.marketplaceAddOutput "${platform.jsonProtocol?.marketplaceAddOutput}"`);
    }
    if (!VALID_CLI_OUTPUTS.has(platform.jsonProtocol?.pluginInstallOutput)) {
      throw new Error(`platform registry: ${label} has illegal jsonProtocol.pluginInstallOutput "${platform.jsonProtocol?.pluginInstallOutput}"`);
    }
    if (!Array.isArray(platform.isolationSubdirs)) {
      throw new Error(`platform registry: ${label} isolationSubdirs must be an array`);
    }

    // --- capability contract validation (能力契约验证) -----------------------
    if (!VALID_INSTALL_METHODS.has(platform.installMethod)) {
      throw new Error(`platform registry: ${label} has illegal installMethod "${platform.installMethod}"`);
    }
    if (!VALID_REF_STRENGTHS.has(platform.refStrength)) {
      throw new Error(`platform registry: ${label} has illegal refStrength "${platform.refStrength}"`);
    }
    if (!VALID_OUTPUT_PROTOCOLS.has(platform.outputProtocol)) {
      throw new Error(`platform registry: ${label} has illegal outputProtocol "${platform.outputProtocol}"`);
    }
    if (!VALID_IDENTITY_EVIDENCE.has(platform.identityEvidence)) {
      throw new Error(`platform registry: ${label} has illegal identityEvidence "${platform.identityEvidence}"`);
    }
    if (!VALID_DEGRADATION_POLICIES.has(platform.degradationPolicy)) {
      throw new Error(`platform registry: ${label} has illegal degradationPolicy "${platform.degradationPolicy}"`);
    }

    if (platform.automatable) {
      if (!platform.cli || typeof platform.cli.marketplaceAdd !== 'function'
          || typeof platform.cli.install !== 'function' || typeof platform.cli.list !== 'function') {
        throw new Error(`platform registry: automatable platform ${label} needs cli template functions`);
      }
      if (typeof platform.cli.binary !== 'string' || platform.cli.binary.length === 0) {
        throw new Error(`platform registry: automatable platform ${label} needs a non-empty cli.binary executable name`);
      }
      if (!platform.strategy || typeof platform.strategy.parseListOutput !== 'function') {
        throw new Error(`platform registry: automatable platform ${label} needs strategy.parseListOutput`);
      }
      if (typeof platform.strategy.extractInstallPath !== 'function') {
        throw new Error(`platform registry: automatable platform ${label} needs strategy.extractInstallPath`);
      }
      // Platforms with degradationPolicy 'human-attestation-with-fallback'
      // (codex) also need manual-requirement strategies for the fallback path.
      if (platform.degradationPolicy === 'human-attestation-with-fallback') {
        if (typeof platform.strategy.buildManualRequirement !== 'function') {
          throw new Error(`platform registry: ${label} with human-attestation-with-fallback needs strategy.buildManualRequirement`);
        }
        if (typeof platform.strategy.readManifest !== 'function') {
          throw new Error(`platform registry: ${label} with human-attestation-with-fallback needs strategy.readManifest`);
        }
      }
    } else {
      if (platform.cli !== null) {
        throw new Error(`platform registry: non-automatable platform ${label} must have cli === null`);
      }
      // The manual-requirement path IS the execute for a non-automatable
      // platform; without it (and its manifest reader) the checkpoint has no
      // execute behaviour at all.
      if (!platform.strategy || typeof platform.strategy.buildManualRequirement !== 'function') {
        throw new Error(`platform registry: non-automatable platform ${label} needs strategy.buildManualRequirement`);
      }
      if (typeof platform.strategy.readManifest !== 'function') {
        throw new Error(`platform registry: non-automatable platform ${label} needs strategy.readManifest`);
      }
    }

    // --- capability contract consistency rules (能力契约一致性规则) -----------
    // automatable === true 必须有 installMethod === 'structured-cli'
    if (platform.automatable === true && platform.installMethod !== 'structured-cli') {
      throw new Error(`platform registry: ${label} is automatable but installMethod is "${platform.installMethod}" (expected "structured-cli")`);
    }
    // automatable === false 必须有 installMethod !== 'structured-cli'
    if (platform.automatable === false && platform.installMethod === 'structured-cli') {
      throw new Error(`platform registry: ${label} is not automatable but installMethod is "structured-cli"`);
    }
    // installMethod === 'structured-cli' 必须有 refStrength !== 'unfixable'
    if (platform.installMethod === 'structured-cli' && platform.refStrength === 'unfixable') {
      throw new Error(`platform registry: ${label} has structured-cli install but unfixable refStrength`);
    }
    // installMethod === 'human-attestation' 必须有 identityEvidence === 'human-attestation'
    if (platform.installMethod === 'human-attestation' && platform.identityEvidence !== 'human-attestation') {
      throw new Error(`platform registry: ${label} has human-attestation install but identityEvidence is "${platform.identityEvidence}"`);
    }
  }
}

// Self-validate at import time: a malformed registry never reaches runtime.
assertRegistry();

// --- capability-driven routing & conflict detection (能力驱动路由与矛盾检测) --

/**
 * 根据平台描述符的 installMethod 决定执行路由。
 *
 * @param {object} platform - 平台描述符
 * @returns {{ route: string, reason: string }}
 * @throws {Error} 无法路由时抛出
 */
export function resolvePlatformRoute(platform) {
  const { installMethod } = platform;
  if (installMethod === 'structured-cli') {
    return { route: 'structured-cli', reason: `installMethod is structured-cli` };
  }
  if (installMethod === 'interactive-only' || installMethod === 'human-attestation') {
    return { route: 'human-attestation', reason: `installMethod is ${installMethod}` };
  }
  throw new Error(
    `platform "${platform?.id ?? '<unknown>'}" with installMethod="${installMethod}" cannot be routed`,
  );
}

/**
 * 检测平台能力描述符中的矛盾。
 *
 * @param {object} platform - 平台描述符
 * @returns {{ hasConflict: boolean, conflicts: string[] }}
 * @throws {Error} 发现矛盾时抛出
 */
export function resolveCapabilityConflicts(platform) {
  const conflicts = [];
  const { id, automatable, installMethod, refStrength, identityEvidence, cli, strategy } = platform;

  // automatable <-> installMethod 一致性
  if (automatable === true && installMethod !== 'structured-cli') {
    conflicts.push(`automatable=true but installMethod="${installMethod}"`);
  }
  if (automatable === false && installMethod === 'structured-cli') {
    conflicts.push(`automatable=false but installMethod="structured-cli"`);
  }

  // installMethod <-> refStrength 一致性
  if (installMethod === 'structured-cli' && refStrength === 'unfixable') {
    conflicts.push(`structured-cli with unfixable refStrength`);
  }

  // installMethod <-> identityEvidence 一致性
  if (installMethod === 'human-attestation' && identityEvidence !== 'human-attestation') {
    conflicts.push(`human-attestation install but identityEvidence="${identityEvidence}"`);
  }

  // 自动化平台必须有 cli 和策略解析函数
  if (automatable === true) {
    if (!cli || typeof cli !== 'object') {
      conflicts.push(`automatable=true but cli is missing`);
    }
    if (!strategy || typeof strategy.parseListOutput !== 'function') {
      conflicts.push(`automatable=true but strategy.parseListOutput is missing`);
    }
    if (!strategy || typeof strategy.extractInstallPath !== 'function') {
      conflicts.push(`automatable=true but strategy.extractInstallPath is missing`);
    }
  }

  // 非自动化平台必须 cli === null，且有手动策略函数
  if (automatable === false) {
    if (cli !== null) {
      conflicts.push(`automatable=false but cli is not null`);
    }
    if (!strategy || typeof strategy.buildManualRequirement !== 'function') {
      conflicts.push(`automatable=false but strategy.buildManualRequirement is missing`);
    }
    if (!strategy || typeof strategy.readManifest !== 'function') {
      conflicts.push(`automatable=false but strategy.readManifest is missing`);
    }
  }

  if (conflicts.length > 0) {
    throw new Error(`capability conflict in platform "${id}": ${conflicts.join('; ')}`);
  }

  return { hasConflict: false, conflicts: [] };
}

/**
 * 从 installMethod 派生 automatable 标志。
 *
 * @param {object} platform - 平台描述符
 * @returns {boolean}
 */
export function deriveAutomatable(platform) {
  return platform.installMethod === 'structured-cli';
}

// ---------------------------------------------------------------------------
// Host identity normalization — Foundation thin entry (0.8.0 R-13)
// ---------------------------------------------------------------------------
// The only host-normalization entry point: read `buildAdapter.name` from this
// registry (or an observed adapter surface directory) and canonicalize it
// through the Foundation host profiles (`resolveHostId`). The profiles
// registry.json + descriptor bytes ship inside the released bundle; the
// absolute profiles root is resolved lazily and never stored in plans or
// receipts. No user-fillable host string and no second host registry exist.
let cachedHostsRoot = null;

/** @type {Map<string, string>} canonicalized hostId cache */
const normalizedHostIds = new Map();

async function foundationHostsRoot() {
  if (cachedHostsRoot === null) {
    cachedHostsRoot = bundledHostProfilesRoot();
  }
  return cachedHostsRoot;
}

/**
 * Normalize a host identity through the Foundation host profiles.
 *
 * Unknown host ids propagate the Foundation SFC2003 error so strict callers —
 * the G4 expected host list, publish/verify registry mappings — fail closed
 * instead of shipping an unregistered identity. The checker's free-form
 * adapter-surface inference passes `{ fallback: true }` so an unregistered
 * adapter directory name degrades to its raw label instead of aborting the
 * scan.
 *
 * @param {string} hostId - raw host identity (registry buildAdapter.name or
 *   an observed adapter surface directory name).
 * @param {object} [options]
 * @param {boolean} [options.fallback] - when true, unknown host ids return
 *   the raw input instead of throwing.
 * @returns {Promise<string>} canonical hostId
 */
export async function normalizeHostId(hostId, { fallback = false } = {}) {
  const key = hostId ?? '';
  if (normalizedHostIds.has(key)) return normalizedHostIds.get(key);
  const root = await foundationHostsRoot();
  try {
    const canonical = await resolveHostId({ hostId, hostsRoot: root });
    normalizedHostIds.set(key, canonical);
    return canonical;
  } catch (err) {
    if (fallback && err?.code === 'SFC2003' && hostId) {
      normalizedHostIds.set(key, hostId);
      return hostId;
    }
    throw err;
  }
}
