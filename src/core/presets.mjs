/**
 * Post-publish preset registry (v0.6.3 R2 registry / R4 complete, design
 * §2.5/§2.6).
 *
 * A preset = a name + a JSON-Schema-style runtime-validated config + a
 * release-skill built-in implementation. The registry ships with the bundle
 * and is enumerable via `release-skill distribute --list-presets`.
 *
 * Entries:
 * - `git-mirror` (implemented): absorbs the legacy `kind: payload-mirror`
 *   target; the distribute-git mirror semantics (clone -> wipe -> write ->
 *   commit -> push, NO_CHANGE idempotence, same-name tag move ->
 *   REMOTE_CONFLICT, host credential helper stance, dry-run).
 * - `marketplace-index-render` (implemented): absorbs the legacy
 *   `kind: marketplace-index` target (renderMarketplaceIndex + mirror push).
 * - `proposal-inbox` (implemented): both transports — git-push (R3: clone ->
 *   write incoming/<unit>-<version>.json -> commit -> push; ls-remote
 *   cross-check) and local-file (R4: same proposal into the local checkout
 *   at target.workspace; committed locally, NEVER pushed). config.target is
 *   the ONLY optional target among write-downstream presets; absent target
 *   degrades to notify-handoff behavior instead of erroring.
 * - `notify-handoff` (implemented, R4): the zero-write floor; renders the
 *   frozen context into a deterministic downstream sync checklist in
 *   evidence; never accepts a downstream target.
 * - `marketplace-registry-entry` (implemented, R4): direct-edit downstream
 *   registry entry update from frozen plan values + downstream gates.
 * - `docs-refresh` (implemented, R4): refresh one or more independent docs
 *   repositories from payload mappings + docs build gates.
 *
 * Dual addressing (§2.5, review N-B1): write-downstream presets share
 * `config.target` with `remoteUrl` XOR `workspace`. Both or neither ->
 * POSTPUBLISH_HOOK_INVALID. `workspace` paths may leave the repository root
 * (preset-level exception to the runner's cwd containment rule); declaration
 * time rejects control characters and `.release-skill/` runtime paths, and
 * the raw value is plan-digest-bound (auditable at approval time). The
 * three §2.6 execution checks (realpath evidence, TOCTOU re-check, release
 * workspace / runtime directory exclusion) are provided here for the presets
 * that execute against workspaces.
 *
 * requiresApproval grading (§2.6): defaults are declared per preset — public
 * write presets default true; proposal-inbox local-file and notify-handoff
 * default false. proposal-inbox runtime grading follows the EFFECTIVE
 * transport: `config.delivery ?? addressing inference` (a target.remoteUrl
 * without delivery infers git-push, a public write -> true; a
 * target.workspace infers local-file -> false). The target-less
 * notify-handoff degradation is the zero-write floor and always grades false.
 * Projects may tighten (explicit true) but never relax below the preset
 * default.
 *
 * Secret scanning: preset config string values are scanned with the same
 * fail-closed stance as the snapshot scan — private-key blocks and common
 * token prefixes fail with POSTPUBLISH_HOOK_INVALID (values never echoed).
 *
 * @module core/presets
 */

import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { classifyPathInput } from 'skill-family-harness-node';

import { ReleaseError, GATE_FAILED, POSTPUBLISH_HOOK_INVALID } from './errors.mjs';
import { checkGitRemoteUrl, describeGitRemoteUrlFailure } from './git-url-policy.mjs';

/** Branch pattern (leading alphanumeric blocks option-like names). */
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** Safe relative-path shape for staticFiles entries (same as targets). */
function assertSafeStaticFilePath(where, field, value, failFn) {
  if (typeof value !== 'string' || value.length === 0) {
    failFn(`${where}.${field} must be a non-empty string`);
  }
  if (value.startsWith('/') || value.startsWith('./') || value === '.'
    || value.includes('..') || value.includes('\\') || value.includes(':')) {
    failFn(`${where}.${field} is not a safe relative path`, { value });
  }
}

function failHook(message, details = {}) {
  throw new ReleaseError(POSTPUBLISH_HOOK_INVALID, `postPublish hook invalid: ${message}`, details);
}

function assertNoControlChars(label, value) {
  if (/[\x00-\x1f\x7f]/.test(value)) {
    failHook(`${label} contains control characters`, { label });
  }
}

// ---------------------------------------------------------------------------
// Secret scanning over preset config (§2.6: covers preset config + the
// normalized hook table, inheriting the fail-closed scan stance)
// ---------------------------------------------------------------------------

/** Conservative secret shapes; matched values are NEVER echoed back. */
const CONFIG_SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgho_[A-Za-z0-9]{20,}\b/,
  /\bghs_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAKIA[A-Z0-9]{12,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
];

/** Location labels are safe to report; matched secret values never are. */
function scanConfigValueForSecrets(pathLabel, value) {
  if (typeof value !== 'string') return;
  for (const pattern of CONFIG_SECRET_PATTERNS) {
    if (pattern.test(value)) {
      failHook(
        `preset config carries a secret-looking value at "${pathLabel}"; credentials belong to the host keychain, never to postPublish config`,
        { location: pathLabel },
      );
    }
  }
}

function scanConfigForSecrets(config, where) {
  const walk = (node, pathLabel) => {
    if (typeof node === 'string') {
      scanConfigValueForSecrets(pathLabel, node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${pathLabel}[${index}]`));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        walk(value, pathLabel ? `${pathLabel}.${key}` : key);
      }
    }
  };
  walk(config, `${where}.config`);
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Shared config.target validator for write-downstream presets (N-B1):
 * remoteUrl XOR workspace, safe branch, §2.6 workspace declaration rules.
 */
function validateDownstreamTarget(where, target, { targetOptional }) {
  if (target === undefined) {
    if (targetOptional) return; // proposal-inbox: degrade to notify-handoff.
    failHook(`${where}: write-downstream presets require a config.target declaration`, {});
  }
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    failHook(`${where}.config.target must be a plain object`);
  }
  const hasRemoteUrl = target.remoteUrl !== undefined;
  const hasWorkspace = target.workspace !== undefined;
  if (hasRemoteUrl === hasWorkspace) {
    failHook(
      `${where}.config.target must declare exactly one of remoteUrl or workspace (dual addressing)`,
      { hasRemoteUrl, hasWorkspace },
    );
  }
  if (hasRemoteUrl) {
    const remoteUrlVerdict = checkGitRemoteUrl(target.remoteUrl);
    if (!remoteUrlVerdict.ok) {
      failHook(
        `${where}.config.target.remoteUrl ${describeGitRemoteUrlFailure(remoteUrlVerdict.reason)}`,
        { reason: remoteUrlVerdict.reason },
      );
    }
  } else {
    if (typeof target.workspace !== 'string' || target.workspace.length === 0) {
      failHook(`${where}.config.target.workspace must be a non-empty string`);
    }
    assertNoControlChars(`${where}.config.target.workspace`, target.workspace);
    // §2.6: the runtime directory is excluded already at declaration time;
    // relative or absolute paths outside the repository root are allowed
    // (preset-level exception), and the raw value stays plan-digest-bound.
    const segments = target.workspace.split(/[\\/]+/);
    if (segments.includes('.release-skill')) {
      failHook(
        `${where}.config.target.workspace must not point into the .release-skill/ runtime directory`,
        {},
      );
    }
  }
  if (typeof target.branch !== 'string' || !BRANCH_RE.test(target.branch)) {
    failHook(`${where}.config.target.branch is not a safe Git branch name`, { branch: target.branch });
  }
  if (target.branch.includes('..') || target.branch.endsWith('.') || target.branch.endsWith('.lock')) {
    failHook(`${where}.config.target.branch is not a safe Git branch name`, { branch: target.branch });
  }
}

/** Optional config.visibility: keeps the public-write/internal-write split. */
function validateVisibility(where, config) {
  if (config.visibility !== undefined
    && config.visibility !== 'internal' && config.visibility !== 'public') {
    failHook(`${where}.config.visibility must be "internal" or "public"`, {
      visibility: config.visibility,
    });
  }
}

/** Optional config.staticFiles: identical shape to the legacy target field. */
function validateStaticFiles(where, config) {
  if (config.staticFiles === undefined) return;
  if (!Array.isArray(config.staticFiles)) {
    failHook(`${where}.config.staticFiles must be an array`);
  }
  for (const [index, file] of config.staticFiles.entries()) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      failHook(`${where}.config.staticFiles[${index}] must be a plain object`);
    }
    assertSafeStaticFilePath(`${where}.config.staticFiles[${index}]`, 'from', file?.from, failHook);
    assertSafeStaticFilePath(`${where}.config.staticFiles[${index}]`, 'to', file?.to, failHook);
  }
}

function validateMarketplaceBlock(where, config) {
  const marketplace = config.marketplace;
  if (!marketplace || typeof marketplace !== 'object' || Array.isArray(marketplace)) {
    failHook(`${where}: marketplace-index-render requires a config.marketplace block`);
  }
  const { form, name, owner } = marketplace;
  if (form !== 'github' && form !== 'url') {
    failHook(`${where}.config.marketplace.form must be "github" or "url"`, { form });
  }
  if (typeof name !== 'string' || name.length === 0) {
    failHook(`${where}.config.marketplace.name must be a non-empty string`);
  }
  if (typeof owner !== 'string' || owner.length === 0) {
    failHook(`${where}.config.marketplace.owner must be a non-empty string`);
  }
  if (marketplace.sourceRepo !== undefined
    && (typeof marketplace.sourceRepo !== 'string'
      || !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(marketplace.sourceRepo))) {
    failHook(`${where}.config.marketplace.sourceRepo must be owner/repo when provided`);
  }
}

function requirePlainConfig(where, hook) {
  if (hook.config === undefined || typeof hook.config !== 'object'
    || Array.isArray(hook.config) || hook.config === null) {
    failHook(`${where}: this preset requires a config object`, {});
  }
  return hook.config;
}

/**
 * §2.3 context fields accepted as fieldsFromPlan sources: only frozen plan
 * values may flow into a downstream registry entry.
 */
export const FIELDS_FROM_PLAN_SOURCES = new Set([
  'unitId',
  'version',
  'tag',
  'commit',
  'tree',
  'manifestDigest',
  'planDigest',
  'publishedAt',
]);

/** Safe registry-entry field name (also blocks prototype-pollution keys). */
const SAFE_FIELD_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FORBIDDEN_FIELDS = new Set(['__proto__', 'prototype', 'constructor']);

/** Shape of config.fieldsFromPlan (marketplace-registry-entry). */
function validateFieldsFromPlan(where, config) {
  const fieldsFromPlan = config.fieldsFromPlan;
  if (!fieldsFromPlan || typeof fieldsFromPlan !== 'object' || Array.isArray(fieldsFromPlan)) {
    failHook(`${where}.config.fieldsFromPlan must be a plain object mapping entry fields to frozen plan fields`);
  }
  const entries = Object.entries(fieldsFromPlan);
  if (entries.length === 0) {
    failHook(`${where}.config.fieldsFromPlan must map at least one entry field`);
  }
  for (const [entryField, sourceField] of entries) {
    if (!SAFE_FIELD_RE.test(entryField) || FORBIDDEN_FIELDS.has(entryField)) {
      failHook(`${where}.config.fieldsFromPlan field "${entryField}" is not a safe entry field name`, { entryField });
    }
    if (typeof sourceField !== 'string' || !FIELDS_FROM_PLAN_SOURCES.has(sourceField)) {
      failHook(
        `${where}.config.fieldsFromPlan."${entryField}" must map to a frozen plan context field (${[...FIELDS_FROM_PLAN_SOURCES].join('/')})`,
        { entryField, sourceField },
      );
    }
  }
}

/** Secret-ish env denylist for downstream gates (mirrors postpublish.mjs). */
const GATE_ENV_DENYLIST = /TOKEN|SECRET|PASSWORD|PASSPHRASE|API_KEY|CREDENTIAL/i;
const GATE_ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Downstream gates (marketplace-registry-entry / docs-refresh): the same
 * fail-closed safety rules as command hooks — executable + argument arrays
 * (never shell strings), relative cwd, timeout bounds, envAllowlist with the
 * secret-ish denylist. Gates run inside the downstream worktree via the R1
 * hook runner.
 */
function validateGates(where, config) {
  if (config.gates === undefined) return;
  if (!Array.isArray(config.gates)) {
    failHook(`${where}.config.gates must be an array`);
  }
  for (const [index, gate] of config.gates.entries()) {
    const gwhere = `${where}.config.gates[${index}]`;
    if (!gate || typeof gate !== 'object' || Array.isArray(gate)) {
      failHook(`${gwhere} must be a plain object`);
    }
    if (!Array.isArray(gate.command) || gate.command.length === 0) {
      failHook(`${gwhere}.command must be a non-empty array (shell strings are never accepted)`);
    }
    for (const element of gate.command) {
      if (typeof element !== 'string' || element.length === 0) {
        failHook(`${gwhere}.command must contain only non-empty strings`);
      }
      assertNoControlChars(`${gwhere}.command`, element);
      if (element.startsWith('-') && element === gate.command[0]) {
        failHook(`${gwhere}.command executable must not start with "-"`, { executable: element });
      }
    }
    if (gate.cwd !== undefined) {
      if (typeof gate.cwd !== 'string' || gate.cwd.length === 0) {
        failHook(`${gwhere}.cwd must be a non-empty string when provided`);
      }
      if (gate.cwd.startsWith('/') || gate.cwd.startsWith('./') || gate.cwd.includes('..')) {
        failHook(`${gwhere}.cwd must be a relative path inside the downstream repository`, { cwd: gate.cwd });
      }
    }
    if (gate.timeoutMs !== undefined) {
      if (!Number.isInteger(gate.timeoutMs) || gate.timeoutMs < 1000 || gate.timeoutMs > 7200000) {
        failHook(`${gwhere}.timeoutMs must be an integer in [1000, 7200000]`, { timeoutMs: gate.timeoutMs });
      }
    }
    if (gate.envAllowlist !== undefined) {
      if (!Array.isArray(gate.envAllowlist)) {
        failHook(`${gwhere}.envAllowlist must be an array`);
      }
      const seen = new Set();
      for (const key of gate.envAllowlist) {
        if (typeof key !== 'string' || !GATE_ENV_KEY_RE.test(key)) {
          failHook(`${gwhere}.envAllowlist key ${JSON.stringify(key)} must be an uppercase [A-Z_][A-Z0-9_]* identifier`);
        }
        if (GATE_ENV_DENYLIST.test(key)) {
          failHook(
            `${gwhere}.envAllowlist key "${key}" matches the secret-ish denylist (TOKEN/SECRET/PASSWORD/PASSPHRASE/API_KEY/CREDENTIAL); gates never receive credentials`,
            { key },
          );
        }
        if (seen.has(key)) {
          failHook(`${gwhere}.envAllowlist contains duplicate key "${key}"`);
        }
        seen.add(key);
      }
    }
  }
}

const REGISTRY = [
  {
    name: 'git-mirror',
    description:
      'Mirror the frozen release payload to any git remote (clone -> wipe -> write -> commit -> push; NO_CHANGE idempotent; same-name tag move fails closed). Absorbs the legacy kind: payload-mirror target. Credentials come from the host git credential helper/keychain only. Targets-form only: declare it under postPublish.targets (kind: payload-mirror), not postPublish.hooks.',
    writeDownstream: true,
    targetOptional: false,
    implemented: true,
    defaultRequiresApproval: true,
    // R4 review M-2: the executor routes this preset through the targets[]
    // pipeline only; a hooks[] declaration would validate but never execute,
    // so declaration validation rejects it fail-closed (targets-form only).
    targetsFormOnly: true,
    legacyTargetKind: 'payload-mirror',
    validateConfig(where, hook) {
      const config = requirePlainConfig(where, hook);
      validateDownstreamTarget(where, config.target, { targetOptional: false });
      validateVisibility(where, config);
      validateStaticFiles(where, config);
    },
  },
  {
    name: 'marketplace-index-render',
    description:
      'Render .claude-plugin/marketplace.json from the frozen plan and push it to a downstream git remote. Absorbs the legacy kind: marketplace-index target (marketplace.form/name/owner/sourceRepo and staticFiles carry over). Targets-form only: declare it under postPublish.targets (kind: marketplace-index), not postPublish.hooks.',
    writeDownstream: true,
    targetOptional: false,
    implemented: true,
    defaultRequiresApproval: true,
    // R4 review M-2: targets-form only (see git-mirror above).
    targetsFormOnly: true,
    legacyTargetKind: 'marketplace-index',
    validateConfig(where, hook) {
      const config = requirePlainConfig(where, hook);
      validateDownstreamTarget(where, config.target, { targetOptional: false });
      validateMarketplaceBlock(where, config);
      validateVisibility(where, config);
      validateStaticFiles(where, config);
    },
  },
  {
    name: 'proposal-inbox',
    description:
      'Deliver a machine-readable update proposal for autonomous downstream consumption (hub scenarios). Transports: git-push (clone -> write incoming/<unit>-<version>.json -> commit -> push; NO_CHANGE idempotent; ls-remote cross-check) and local-file (write the same proposal into the local checkout at target.workspace and commit it locally; NEVER pushed). config.target is optional: without it the preset degrades to notify-handoff behavior instead of failing.',
    writeDownstream: true,
    targetOptional: true,
    // git-push transport delivered in R3, local-file transport in R4; the
    // description names both shipped behaviors (review minor-2 honesty).
    implemented: true,
    // Graded by transport: git-push is public write (true); local-file and
    // the notify-handoff degradation stay false (§2.6).
    defaultRequiresApproval: false,
    // Followup 7: the registry default is false, but runtime grading is
    // STRICTER per transport — --list-presets must say so plainly. R4 review
    // M-1: grading follows the EFFECTIVE transport (delivery ?? addressing
    // inference), so a remoteUrl-only declaration still grades true.
    requiresApprovalNote:
      'runtime transport grading is stricter than this default: the effective git-push transport (declared delivery, or a remoteUrl address that infers git-push) runs as requiresApproval true (public write); local-file and the target-less notify-handoff degradation stay false',
    validateConfig(where, hook) {
      if (hook.config === undefined) return; // target-less degradation is legal.
      if (typeof hook.config !== 'object' || Array.isArray(hook.config) || hook.config === null) {
        failHook(`${where}.config must be a plain object when provided`);
      }
      const config = hook.config;
      if (config.delivery !== undefined
        && config.delivery !== 'local-file' && config.delivery !== 'git-push') {
        failHook(`${where}.config.delivery must be "local-file" or "git-push"`, {
          delivery: config.delivery,
        });
      }
      validateDownstreamTarget(where, config.target, { targetOptional: true });
      // Transport/addressing coherence (R4): git-push needs a remote to push;
      // local-file needs a local checkout to write.
      if (config.target !== undefined && config.delivery !== undefined) {
        if (config.delivery === 'git-push' && typeof config.target.remoteUrl !== 'string') {
          failHook(`${where}: delivery "git-push" requires a config.target.remoteUrl address`, {});
        }
        if (config.delivery === 'local-file' && typeof config.target.workspace !== 'string') {
          failHook(`${where}: delivery "local-file" requires a config.target.workspace address`, {});
        }
      }
    },
  },
  {
    name: 'notify-handoff',
    description:
      'Zero-write floor: renders the frozen context into a deterministic downstream sync checklist (version/tag/sha/tree/evidence path/suggested actions) in evidence and echoes it. No writes anywhere, zero configuration, usable by any project, never takes a downstream target; every downstream scenario degrades to at least this behavior.',
    writeDownstream: false,
    targetOptional: true,
    implemented: true,
    defaultRequiresApproval: false,
    validateConfig(where, hook) {
      if (hook.config === undefined) return;
      if (typeof hook.config !== 'object' || Array.isArray(hook.config) || hook.config === null) {
        failHook(`${where}.config must be a plain object when provided`);
      }
      if (hook.config.target !== undefined) {
        failHook(
          `${where}: notify-handoff is the zero-write floor and never declares a downstream target`,
          {},
        );
      }
    },
  },
  {
    name: 'marketplace-registry-entry',
    description:
      'Direct-edit marketplace registry entry update for downstreams WITHOUT their own governance/render pipeline: locate the entry by config.entryKey inside config.registryPath, update config.fieldsFromPlan from the frozen plan values, run the declared downstream gates (argument arrays), then push (never --force). NO_CHANGE idempotent; a missing registry file or entry fails closed for human decision. Usually declared phase: postVerify. Hubs with their own governance use proposal-inbox instead.',
    writeDownstream: true,
    targetOptional: false,
    implemented: true,
    defaultRequiresApproval: true,
    validateConfig(where, hook) {
      const config = requirePlainConfig(where, hook);
      validateDownstreamTarget(where, config.target, { targetOptional: false });
      if (config.registryPath !== undefined) {
        assertSafeStaticFilePath(`${where}.config`, 'registryPath', config.registryPath, failHook);
      }
      if (typeof config.entryKey !== 'string' || config.entryKey.length === 0) {
        failHook(`${where}.config.entryKey must be a non-empty string`);
      }
      assertNoControlChars(`${where}.config.entryKey`, config.entryKey);
      validateFieldsFromPlan(where, config);
      validateGates(where, config);
    },
  },
  {
    name: 'docs-refresh',
    description:
      'Refresh one or more independent docs repositories (GitHub Pages style) from the frozen release payload: config.mappings copy payload files into each repository (an optional per-mapping versionMarker placeholder is replaced with the release version), the declared docs build gates run before each push, and every repository in config.repositories is committed and pushed (never --force). NO_CHANGE idempotent; bound to the distribute phase by its payload requirement.',
    writeDownstream: true,
    targetOptional: false,
    implemented: true,
    defaultRequiresApproval: true,
    validateConfig(where, hook) {
      const config = requirePlainConfig(where, hook);
      // One declaration, many repositories (design §2.5): every entry shares
      // the dual-addressing rules with the single-target presets.
      if (!Array.isArray(config.repositories) || config.repositories.length === 0) {
        failHook(`${where}.config.repositories must be a non-empty array of downstream targets`);
      }
      for (const [index, repository] of config.repositories.entries()) {
        validateDownstreamTarget(`${where}.config.repositories[${index}]`, repository, { targetOptional: false });
      }
      if (!Array.isArray(config.mappings) || config.mappings.length === 0) {
        failHook(`${where}.config.mappings must be a non-empty array`);
      }
      for (const [index, mapping] of config.mappings.entries()) {
        const mwhere = `${where}.config.mappings[${index}]`;
        if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
          failHook(`${mwhere} must be a plain object`);
        }
        assertSafeStaticFilePath(mwhere, 'from', mapping?.from, failHook);
        assertSafeStaticFilePath(mwhere, 'to', mapping?.to, failHook);
        if (mapping.versionMarker !== undefined) {
          if (typeof mapping.versionMarker !== 'string' || mapping.versionMarker.length === 0) {
            failHook(`${mwhere}.versionMarker must be a non-empty string when provided`);
          }
          assertNoControlChars(`${mwhere}.versionMarker`, mapping.versionMarker);
        }
      }
      validateGates(where, config);
    },
  },
];

/**
 * List every registered preset with its enumerable metadata
 * (`release-skill distribute --list-presets`).
 *
 * @returns {Array<{ name: string, description: string, writeDownstream: boolean,
 *   targetOptional: boolean, implemented: boolean, defaultRequiresApproval: boolean,
 *   requiresApprovalNote?: string, targetsFormOnly?: boolean }>}
 */
export function listPostPublishPresets() {
  return REGISTRY.map((entry) => ({
    name: entry.name,
    description: entry.description,
    writeDownstream: entry.writeDownstream,
    targetOptional: entry.targetOptional,
    implemented: entry.implemented,
    defaultRequiresApproval: entry.defaultRequiresApproval,
    ...(entry.requiresApprovalNote !== undefined
      ? { requiresApprovalNote: entry.requiresApprovalNote }
      : {}),
    ...(entry.targetsFormOnly === true ? { targetsFormOnly: true } : {}),
  }));
}

/** Registry preset names (the knownPresets surface for declaration validation). */
export function postPublishPresetNames() {
  return REGISTRY.map((entry) => entry.name);
}

/** Look up one registry entry by name (undefined when unregistered). */
export function getPostPublishPreset(name) {
  return REGISTRY.find((entry) => entry.name === name);
}

/**
 * Effective proposal-inbox transport (single authority shared by approval
 * grading and executor routing — the two can never drift apart, R4 review
 * M-1): `config.delivery` pins it; otherwise the addressing infers it
 * (target.remoteUrl -> git-push, target.workspace -> local-file). Returns
 * undefined for the target-less notify-handoff degradation.
 *
 * @param {object} [config] - The proposal-inbox hook config.
 * @returns {'git-push'|'local-file'|undefined}
 */
export function resolveProposalInboxTransport(config = {}) {
  const target = config?.target;
  const hasTarget = target && typeof target === 'object' && !Array.isArray(target);
  // Target-less degradation wins over a literal delivery: the executor
  // degrades to notify-handoff BEFORE any transport resolution, so a
  // delivery value without a target is inert (zero-write floor, R4 m-1).
  if (!hasTarget) return undefined;
  if (config?.delivery !== undefined) return config.delivery;
  return typeof target.remoteUrl === 'string' ? 'git-push' : 'local-file';
}

/**
 * Resolve the preset-declared requiresApproval default (§2.6 grading).
 * proposal-inbox is transport-graded by the EFFECTIVE transport (declared
 * delivery ?? addressing inference, R4 review M-1): a remoteUrl-only target
 * infers git-push, a public write -> true; a workspace target infers
 * local-file -> false. The target-less notify-handoff degradation is the
 * zero-write floor and always grades false, even when a literal delivery
 * says git-push (R4 review m-1). Unknown presets fail safe as public write
 * (true).
 *
 * @param {string} presetName
 * @param {object} [config] - The hook config (transport grading input).
 * @returns {boolean}
 */
export function resolvePresetRequiresApproval(presetName, config = {}) {
  const entry = getPostPublishPreset(presetName);
  if (!entry) return true; // Fail safe: unregistered behaves like public write.
  if (presetName === 'proposal-inbox') {
    return resolveProposalInboxTransport(config) === 'git-push';
  }
  return entry.defaultRequiresApproval;
}

/**
 * Validate one preset hook's config through the registry (fail-closed with
 * POSTPUBLISH_HOOK_INVALID). Called by validatePostPublishDeclaration after
 * the preset existence check; secret scanning covers the whole config tree.
 *
 * Only hooks[] entries reach this seam (targets[] entries validate through
 * validateTarget), so targets-form-only presets (R4 review M-2) are rejected
 * here: they execute through the legacy targets[] pipeline, and accepting a
 * hooks[] declaration would validate a hook the executor can never route.
 *
 * @param {object} hook - The declared hook entry (id/preset/config).
 * @param {string} where - Error-context label, e.g. `hooks[0]`.
 */
export function validatePresetHook(hook, where) {
  const entry = getPostPublishPreset(hook.preset);
  if (!entry) {
    failHook(`${where}: unknown preset "${hook.preset}"`, { preset: hook.preset });
  }
  if (entry.targetsFormOnly === true) {
    failHook(
      `${where}: preset "${hook.preset}" is targets-form only — declare it under postPublish.targets as kind "${entry.legacyTargetKind}", not under postPublish.hooks (the hooks[] form of this preset is not executable in this release)`,
      { preset: hook.preset, legacyTargetKind: entry.legacyTargetKind },
    );
  }
  if (hook.config !== undefined) {
    scanConfigForSecrets(hook.config, where);
  }
  entry.validateConfig(where, hook);
}

// ---------------------------------------------------------------------------
// Workspace preflight + execution checks (§2.6, three execution rules)
//
// F-04 root split: these checks receive `releaseWorkspaceRoot` — the real
// project root the user releases from. It is the ONLY resolution basis for
// preset `config.target.workspace` and the ONLY basis for the release-
// workspace write exclusion. The detached frozen-tag worktree is the
// execution worktree (materialize/steps/custom command hooks) and must never
// be passed here: the two roots never fall back onto each other.
// ---------------------------------------------------------------------------

function failWorkspace(message, details = {}) {
  throw new ReleaseError(GATE_FAILED, `preset workspace invalid: ${message}`, details);
}

/**
 * Resolve a declared workspace path against the release workspace root
 * (F-04). Absolute workspaces pass through (preset-level exception); relative
 * workspaces are lexically classified through Foundation `classifyPathInput`
 * (ambiguous cross-platform shapes fail closed; no parallel path regex here)
 * and resolved from `releaseWorkspaceRoot`.
 *
 * @param {string} workspace - Declared workspace path.
 * @param {string} releaseWorkspaceRoot - The real release workspace root.
 * @returns {string} The resolved (not yet realpathed) workspace path.
 */
function resolvePresetWorkspace(workspace, releaseWorkspaceRoot) {
  if (typeof releaseWorkspaceRoot !== 'string' || releaseWorkspaceRoot.length === 0) {
    failWorkspace(
      'preset workspace checks require the release workspace root (releaseWorkspaceRoot); the detached execution worktree is never the release workspace',
      {},
    );
  }
  if (isAbsolute(workspace)) return workspace;
  const classification = classifyPathInput(workspace);
  if (!classification.ok) {
    failWorkspace('workspace is not an unambiguous path input', {
      workspace,
      kind: classification.kind,
    });
  }
  return resolve(releaseWorkspaceRoot, workspace);
}

/**
 * Preflight a `config.target.workspace` before any write: the path must
 * exist and be a git worktree (a `.git` entry), otherwise fail closed.
 * Returns the resolved realpath for evidence and the TOCTOU re-check.
 *
 * @param {string} workspace - Declared workspace path (relative to
 *   `releaseWorkspaceRoot` or absolute; may leave the release workspace root
 *   by preset-level exception).
 * @param {object} options - { releaseWorkspaceRoot: string }
 * @returns {Promise<{ realpath: string }>}
 */
export async function preflightPresetWorkspace(workspace, { releaseWorkspaceRoot }) {
  const resolved = resolvePresetWorkspace(workspace, releaseWorkspaceRoot);
  let real;
  try {
    real = await realpath(resolved);
  } catch {
    failWorkspace(`path does not resolve to an existing directory: ${workspace}`, { workspace });
  }
  const stats = await stat(real).catch(() => null);
  if (!stats || !stats.isDirectory()) {
    failWorkspace(`path is not a directory: ${workspace}`, { workspace });
  }
  const gitEntry = await stat(resolve(real, '.git')).catch(() => null);
  if (!gitEntry) {
    failWorkspace(`path is not a git worktree (no .git entry): ${workspace}`, { workspace });
  }
  return { realpath: real };
}

/**
 * Execution-time workspace re-checks (§2.6, review N-2), run immediately
 * before the preset writes:
 * 1. the realpath is resolved again and returned for evidence recording;
 * 2. it MUST equal the preflight realpath (TOCTOU: the path may not have
 *    been swapped for a symlink since preflight);
 * 3. it must be neither the release workspace itself nor inside the
 *    `.release-skill/` runtime directory. The release-workspace comparison
 *    uses `releaseWorkspaceRoot` (F-04): comparing against the detached
 *    execution worktree would let a preset write into the real project.
 *
 * @param {string} workspace - Declared workspace path.
 * @param {object} options - { releaseWorkspaceRoot, preflightRealpath }
 * @returns {Promise<{ realpath: string }>}
 */
export async function assertPresetWorkspaceExecution(workspace, { releaseWorkspaceRoot, preflightRealpath }) {
  const resolved = resolvePresetWorkspace(workspace, releaseWorkspaceRoot);
  let real;
  try {
    real = await realpath(resolved);
  } catch {
    failWorkspace(`path no longer resolves at execution time: ${workspace}`, { workspace });
  }
  if (preflightRealpath !== undefined && real !== preflightRealpath) {
    failWorkspace(
      `workspace realpath changed between preflight and execution (TOCTOU guard); refusing to write`,
      { workspace, preflightRealpath, observedRealpath: real },
    );
  }
  let rootReal;
  try {
    rootReal = await realpath(releaseWorkspaceRoot);
  } catch {
    failWorkspace(
      'release workspace root does not resolve to an existing directory; the release-workspace write exclusion fails closed',
      {},
    );
  }
  if (real === rootReal) {
    failWorkspace('workspace must not be the release workspace itself', { workspace });
  }
  const segments = real.split(/[\\/]+/);
  if (segments.includes('.release-skill')) {
    failWorkspace('workspace must not live inside the .release-skill/ runtime directory', { workspace });
  }
  return { realpath: real };
}
