/**
 * Platform registry — the single source of truth for consumer-platform
 * knowledge (claude / codex / kimi).
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
 * plugin-marketplace.mjs consumes every platform difference through this
 * registry; see the t2-2 deviation record for the step-2 wiring details.
 *
 * @module platforms/registry
 */

import { join } from 'node:path';

import {
  executeKimiManualRequirement,
  readKimiManifest,
  KIMI_MANIFEST_CANDIDATES,
} from './kimi.mjs';

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
  distributionType: 'claude-plugin',
  actionType: 'claude-marketplace-install',
  // Runtime adapter implementing this platform's marketplace-install action.
  // prepare.mjs stamps it onto generated actions; plan.mjs derives its
  // actionType -> adapter map from it (T2.2 step 3).
  adapter: 'plugin-marketplace',
  automatable: true,
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
  knownHostArtifacts: Object.freeze(['.in_use']),
  schemaRequiredFields: Object.freeze(['plugin', 'marketplace', 'entrySkill']),
  skillRendering: Object.freeze({ mode: 'verbatim', preamble: null, placeholder: '${CLAUDE_PLUGIN_ROOT}' }),
  buildAdapter: Object.freeze({
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
  distributionType: 'codex-plugin',
  actionType: 'codex-marketplace-install',
  adapter: 'plugin-marketplace',
  automatable: true,
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
  knownHostArtifacts: Object.freeze(['.git', '.codex-plugin/migrated-command-skills']),
  schemaRequiredFields: Object.freeze(['plugin', 'marketplace', 'entrySkill']),
  skillRendering: Object.freeze({ mode: 'substitute', preamble: 'codex', placeholder: '${CLAUDE_PLUGIN_ROOT}' }),
  buildAdapter: Object.freeze({
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
    buildManualRequirement: null,
    readManifest: null,
  }),
});

const KIMI = Object.freeze({
  id: 'kimi',
  distributionType: 'kimi-plugin',
  actionType: 'kimi-marketplace-install',
  adapter: 'plugin-marketplace',
  automatable: false,
  cli: null,
  jsonProtocol: Object.freeze({
    listOutput: null,
    installPathSource: null,
    marketplaceAddOutput: null,
    pluginInstallOutput: null,
  }),
  isolationEnv: (home) => ({ HOME: home, KIMI_CODE_HOME: home }),
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
  knownHostArtifacts: Object.freeze(['.git']),
  schemaRequiredFields: Object.freeze(['plugin', 'entrySkill']),
  skillRendering: Object.freeze({ mode: 'substitute', preamble: 'kimi', placeholder: '${CLAUDE_PLUGIN_ROOT}' }),
  buildAdapter: Object.freeze({
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

/** Ordered platform registry. Order is significant (claude, codex, kimi). */
export const PLATFORMS = Object.freeze([CLAUDE, CODEX, KIMI]);

const VALID_DISTRIBUTION_TYPES = new Set(['claude-plugin', 'codex-plugin', 'kimi-plugin']);
const VALID_ACTION_TYPES = new Set(['claude-marketplace-install', 'codex-marketplace-install', 'kimi-marketplace-install']);
const VALID_SOURCE_FORMS = new Set(['string', 'local-path-object', null]);
const VALID_LIST_OUTPUTS = new Set(['array', 'installed-object', null]);
const VALID_CLI_OUTPUTS = new Set(['json', null]);
const VALID_ENTRY_VERSION_BINDING = new Set([true, false, null]);

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

/**
 * Validate a registry (defaults to the module registry). Throws on the first
 * malformed description so a registry typo fails at import time.
 *
 * @param {object[]} [registry] - Platform descriptors to validate.
 */
export function assertRegistry(registry = PLATFORMS) {
  const seen = new Set();
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
  }
}

// Self-validate at import time: a malformed registry never reaches runtime.
assertRegistry();
