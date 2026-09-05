/**
 * Post-publish distribution declaration validation (R1/R2/R3 semantics source).
 *
 * `validatePostPublishDeclaration` is the runtime authority for the per-unit
 * `postPublish` block, shared by prepare (freeze time) and distribute
 * (execution time). The JSON schema is the first gate; this module re-checks
 * every security-critical rule so plans frozen by older schema versions
 * cannot smuggle unsafe declarations through:
 *
 * - hooks are executable + argument arrays only (never shell strings);
 * - envAllowlist entries matching the secret-ish denylist
 *   /TOKEN|SECRET|PASSWORD|PASSPHRASE|API_KEY|CREDENTIAL/i fail closed;
 * - dependsOn must reference an existing payload-mirror target and the
 *   dependency graph must be acyclic;
 * - remoteUrl/branch/commitIdentity are re-checked for git-argument safety;
 * - commitIdentity is mandatory whenever targets exist;
 * - marketplace is mandatory for marketplace-index targets and forbidden on
 *   payload-mirror targets.
 *
 * Every violation throws ReleaseError(GATE_FAILED): the declaration layer is
 * fail-closed and never repairs declarations in place.
 *
 * @module core/postpublish
 */

import { ReleaseError, GATE_FAILED, POSTPUBLISH_HOOK_INVALID } from './errors.mjs';
import {
  postPublishPresetNames,
  validatePresetHook,
  resolvePresetRequiresApproval,
} from './presets.mjs';
import { checkGitRemoteUrl, describeGitRemoteUrlFailure } from './git-url-policy.mjs';

/** Secret-ish environment variable denylist (R3 credential hygiene). */
export const ENV_ALLOWLIST_DENYLIST = /TOKEN|SECRET|PASSWORD|PASSPHRASE|API_KEY|CREDENTIAL/i;

/** Shape every envAllowlist key must satisfy (before the denylist check). */
const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/** Safe target/step id and step name pattern. */
const SAFE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** Branch pattern (leading alphanumeric blocks option-like names). */
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const LOCAL_HOSTS = new Set(['claude', 'codex', 'kimi', 'codebuddy', 'workbuddy']);
const HUB_HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u;
const HUB_REF_RE = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/u;

/** Frozen payload source binding: payload only ever comes from the tag worktree. */
export const PAYLOAD_SOURCE_TAG_WORKTREE = 'tag-worktree';

function fail(message, details = {}) {
  throw new ReleaseError(GATE_FAILED, `postPublish declaration invalid: ${message}`, details);
}

function assertNoControlChars(label, value) {
  if (/[\x00-\x1f\x7f]/.test(value)) {
    fail(`${label} contains control characters`, { label });
  }
}

function validateHookCommand(where, hook) {
  if (!hook || typeof hook !== 'object' || Array.isArray(hook)) {
    fail(`${where} must be a non-null object`);
  }
  if (!Array.isArray(hook.command) || hook.command.length === 0) {
    fail(`${where}.command must be a non-empty array (shell strings are never accepted)`);
  }
  for (const element of hook.command) {
    if (typeof element !== 'string' || element.length === 0) {
      fail(`${where}.command must contain only non-empty strings`);
    }
    assertNoControlChars(`${where}.command`, element);
    if (element.startsWith('-') && element === hook.command[0]) {
      fail(`${where}.command executable must not start with "-"`, { executable: element });
    }
  }
  if (hook.cwd !== undefined) {
    if (typeof hook.cwd !== 'string' || hook.cwd.length === 0) {
      fail(`${where}.cwd must be a non-empty string when provided`);
    }
    if (hook.cwd.startsWith('/') || hook.cwd.startsWith('./') || hook.cwd.includes('..')) {
      fail(`${where}.cwd must be a relative path inside the execution root`, { cwd: hook.cwd });
    }
  }
  if (hook.timeoutMs !== undefined) {
    if (!Number.isInteger(hook.timeoutMs) || hook.timeoutMs < 1000 || hook.timeoutMs > 7200000) {
      fail(`${where}.timeoutMs must be an integer in [1000, 7200000]`, { timeoutMs: hook.timeoutMs });
    }
  }
  if (hook.envAllowlist !== undefined) {
    if (!Array.isArray(hook.envAllowlist)) {
      fail(`${where}.envAllowlist must be an array`);
    }
    const seen = new Set();
    for (const key of hook.envAllowlist) {
      if (typeof key !== 'string' || !ENV_KEY_PATTERN.test(key)) {
        fail(`${where}.envAllowlist key ${JSON.stringify(key)} must be an uppercase [A-Z_][A-Z0-9_]* identifier`);
      }
      if (ENV_ALLOWLIST_DENYLIST.test(key)) {
        fail(
          `${where}.envAllowlist key "${key}" matches the secret-ish denylist (TOKEN/SECRET/PASSWORD/PASSPHRASE/API_KEY/CREDENTIAL); distribute never reads or forwards credentials`,
          { key },
        );
      }
      if (seen.has(key)) {
        fail(`${where}.envAllowlist contains duplicate key "${key}"`);
      }
      seen.add(key);
    }
  }
}

function validateTarget(target, index) {
  const where = `targets[${index}]`;
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    fail(`${where} must be a non-null object`);
  }
  if (typeof target.id !== 'string' || !SAFE_ID_RE.test(target.id)) {
    fail(`${where}.id must match /^[a-z0-9][a-z0-9._-]*$/`, { id: target.id });
  }
  if (target.kind !== 'payload-mirror' && target.kind !== 'marketplace-index') {
    fail(`${where}.kind must be "payload-mirror" or "marketplace-index"`, { kind: target.kind });
  }
  const remoteUrlVerdict = checkGitRemoteUrl(target.remoteUrl);
  if (!remoteUrlVerdict.ok) {
    fail(
      `${where}.remoteUrl ${describeGitRemoteUrlFailure(remoteUrlVerdict.reason)}`,
      { reason: remoteUrlVerdict.reason },
    );
  }
  if (target.visibility !== 'internal' && target.visibility !== 'public') {
    fail(`${where}.visibility must be "internal" or "public"`, { visibility: target.visibility });
  }
  if (typeof target.branch !== 'string' || !BRANCH_RE.test(target.branch)) {
    fail(`${where}.branch is not a safe Git branch name`, { branch: target.branch });
  }
  if (target.branch.includes('..') || target.branch.endsWith('.') || target.branch.endsWith('.lock')) {
    fail(`${where}.branch is not a safe Git branch name`, { branch: target.branch });
  }
  if (target.dependsOn !== undefined) {
    if (typeof target.dependsOn !== 'string' || !SAFE_ID_RE.test(target.dependsOn)) {
      fail(`${where}.dependsOn must match /^[a-z0-9][a-z0-9._-]*$/`, { dependsOn: target.dependsOn });
    }
    if (target.dependsOn === target.id) {
      fail(`${where}.dependsOn references itself; dependency cycles are rejected`);
    }
  }
  if (target.kind === 'marketplace-index') {
    if (!target.marketplace || typeof target.marketplace !== 'object') {
      fail(`${where} is marketplace-index and must carry a marketplace block`);
    }
    const { form, name, owner } = target.marketplace;
    if (form !== 'github' && form !== 'url') {
      fail(`${where}.marketplace.form must be "github" or "url"`, { form });
    }
    if (typeof name !== 'string' || name.length === 0) {
      fail(`${where}.marketplace.name must be a non-empty string`);
    }
    if (typeof owner !== 'string' || owner.length === 0) {
      fail(`${where}.marketplace.owner must be a non-empty string`);
    }
    if (target.marketplace.sourceRepo !== undefined
      && (typeof target.marketplace.sourceRepo !== 'string'
        || !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(target.marketplace.sourceRepo))) {
      fail(`${where}.marketplace.sourceRepo must be owner/repo when provided`);
    }
  } else if (target.marketplace !== undefined) {
    fail(`${where} is payload-mirror and must not carry a marketplace block`);
  }
  if (target.staticFiles !== undefined) {
    if (!Array.isArray(target.staticFiles)) {
      fail(`${where}.staticFiles must be an array`);
    }
    for (const [fileIndex, file] of target.staticFiles.entries()) {
      for (const field of ['from', 'to']) {
        const value = file?.[field];
        if (typeof value !== 'string' || value.length === 0) {
          fail(`${where}.staticFiles[${fileIndex}].${field} must be a non-empty string`);
        }
        if (value.startsWith('/') || value.startsWith('./') || value === '.'
          || value.includes('..') || value.includes('\\') || value.includes(':')) {
          fail(`${where}.staticFiles[${fileIndex}].${field} is not a safe relative path`, { value });
        }
      }
    }
  }
}

function failHook(message, details = {}) {
  throw new ReleaseError(POSTPUBLISH_HOOK_INVALID, `postPublish hook invalid: ${message}`, details);
}

/**
 * Re-check the command-execution safety fields shared by materialize/steps
 * and postPublish command hooks. Throws POSTPUBLISH_HOOK_INVALID (hooks) or
 * GATE_FAILED (materialize/steps, via `fail`) depending on `failFn`.
 */
function validateCommandFields(where, hook, failFn) {
  if (!Array.isArray(hook.command) || hook.command.length === 0) {
    failFn(`${where}.command must be a non-empty array (shell strings are never accepted)`);
  }
  for (const element of hook.command) {
    if (typeof element !== 'string' || element.length === 0) {
      failFn(`${where}.command must contain only non-empty strings`);
    }
    if (/[\x00-\x1f\x7f]/.test(element)) {
      failFn(`${where}.command contains control characters`, { element });
    }
    if (element.startsWith('-') && element === hook.command[0]) {
      failFn(`${where}.command executable must not start with "-"`, { executable: element });
    }
  }
  if (hook.cwd !== undefined) {
    if (typeof hook.cwd !== 'string' || hook.cwd.length === 0) {
      failFn(`${where}.cwd must be a non-empty string when provided`);
    }
    if (hook.cwd.startsWith('/') || hook.cwd.startsWith('./') || hook.cwd.includes('..')) {
      failFn(`${where}.cwd must be a relative path inside the execution root`, { cwd: hook.cwd });
    }
  }
  if (hook.timeoutMs !== undefined) {
    if (!Number.isInteger(hook.timeoutMs) || hook.timeoutMs < 1000 || hook.timeoutMs > 7200000) {
      failFn(`${where}.timeoutMs must be an integer in [1000, 7200000]`, { timeoutMs: hook.timeoutMs });
    }
  }
  if (hook.envAllowlist !== undefined) {
    if (!Array.isArray(hook.envAllowlist)) {
      failFn(`${where}.envAllowlist must be an array`);
    }
    const seen = new Set();
    for (const key of hook.envAllowlist) {
      if (typeof key !== 'string' || !ENV_KEY_PATTERN.test(key)) {
        failFn(`${where}.envAllowlist key ${JSON.stringify(key)} must be an uppercase [A-Z_][A-Z0-9_]* identifier`);
      }
      if (ENV_ALLOWLIST_DENYLIST.test(key)) {
        failFn(
          `${where}.envAllowlist key "${key}" matches the secret-ish denylist (TOKEN/SECRET/PASSWORD/PASSPHRASE/API_KEY/CREDENTIAL); distribute never reads or forwards credentials`,
          { key },
        );
      }
      if (seen.has(key)) {
        failFn(`${where}.envAllowlist contains duplicate key "${key}"`);
      }
      seen.add(key);
    }
  }
}

/**
 * Validate one postPublish hooks[] entry (v0.6.3 R1). Every violation throws
 * POSTPUBLISH_HOOK_INVALID: the hooks layer is fail-closed and never repairs.
 *
 * Rules:
 * - id mandatory, /^[a-z0-9][a-z0-9._-]*$/;
 * - preset XOR command: exactly one must be declared;
 * - preset references must exist in `knownPresets` (R2: defaults to the
 *   built-in preset registry; an explicit empty list keeps the R1
 *   fail-closed stance);
 * - preset configs are validated by the registry (dual addressing,
 *   marketplace/staticFiles shapes, secret scan) — POSTPUBLISH_HOOK_INVALID;
 * - requiresApproval may tighten but never relax below the preset default;
 * - command entries: executable+argument array safety (no shell strings);
 * - phase: "distribute" (default) or "postVerify";
 * - requiresApproval/blocksVerified booleans; blocksVerified: false is a
 *   preset-only permission — custom command hooks can never weaken the
 *   VERIFIED gate;
 * - preset hooks must not declare command-hook execution fields
 *   (cwd/timeoutMs/envAllowlist); command hooks must not declare config.
 *
 * @param {object} hook
 * @param {number} index
 * @param {object} options - { knownPresets: string[] }
 */
function validatePostPublishHookEntry(hook, index, options) {
  const where = `hooks[${index}]`;
  if (!hook || typeof hook !== 'object' || Array.isArray(hook)) {
    failHook(`${where} must be a non-null object`);
  }
  if (typeof hook.id !== 'string' || !SAFE_ID_RE.test(hook.id)) {
    failHook(`${where}.id must match /^[a-z0-9][a-z0-9._-]*$/`, { id: hook.id });
  }

  const hasPreset = hook.preset !== undefined;
  const hasCommand = hook.command !== undefined;
  if (hasPreset && hasCommand) {
    failHook(`${where}: preset and command are mutually exclusive — declare exactly one`, { id: hook.id });
  }
  if (!hasPreset && !hasCommand) {
    failHook(`${where}: declare exactly one of preset or command`, { id: hook.id });
  }

  if (hook.phase !== undefined && hook.phase !== 'distribute' && hook.phase !== 'postVerify') {
    failHook(`${where}.phase must be "distribute" or "postVerify"`, { phase: hook.phase });
  }
  if (hook.requiresApproval !== undefined && typeof hook.requiresApproval !== 'boolean') {
    failHook(`${where}.requiresApproval must be a boolean`, { requiresApproval: hook.requiresApproval });
  }
  if (hook.blocksVerified !== undefined && typeof hook.blocksVerified !== 'boolean') {
    failHook(`${where}.blocksVerified must be a boolean`, { blocksVerified: hook.blocksVerified });
  }

  if (hasPreset) {
    if (typeof hook.preset !== 'string' || !SAFE_ID_RE.test(hook.preset)) {
      failHook(`${where}.preset must match /^[a-z0-9][a-z0-9._-]*$/`, { preset: hook.preset });
    }
    // R2: the built-in preset registry is the default authority; callers may
    // still override with an explicit list (an empty list keeps the R1
    // fail-closed stance where every preset reference is rejected).
    const knownPresets = options.knownPresets ?? postPublishPresetNames();
    if (!knownPresets.includes(hook.preset)) {
      failHook(
        `${where}: unknown preset "${hook.preset}" — the preset registry does not contain it (fail-closed)`,
        { preset: hook.preset, knownPresets },
      );
    }
    if (hook.config !== undefined && (typeof hook.config !== 'object' || Array.isArray(hook.config) || hook.config === null)) {
      failHook(`${where}.config must be a plain object when provided`, { id: hook.id });
    }
    for (const field of ['cwd', 'timeoutMs', 'envAllowlist']) {
      if (hook[field] !== undefined) {
        failHook(`${where}: preset hooks must not declare command-hook execution field "${field}"`, { field });
      }
    }
    // Registry-driven config validation (dual addressing, marketplace block,
    // staticFiles, secret scan) — fail-closed per preset (R2, §2.5/§2.6).
    validatePresetHook(hook, where);
    // requiresApproval grading (§2.6): projects may tighten (explicit true)
    // but never relax below the preset-declared default.
    const presetDefault = resolvePresetRequiresApproval(hook.preset, hook.config);
    if (hook.requiresApproval === false && presetDefault === true) {
      failHook(
        `${where}: requiresApproval cannot be relaxed below the preset default (preset "${hook.preset}" defaults to true; declare true to tighten, never false to relax)`,
        { preset: hook.preset, presetDefault },
      );
    }
  } else {
    // Custom command hook.
    validateCommandFields(where, hook, failHook);
    if (hook.blocksVerified === false) {
      failHook(
        `${where}: custom command hooks must not declare blocksVerified: false — only presets may weaken the VERIFIED gate`,
        { id: hook.id },
      );
    }
    if (hook.config !== undefined) {
      failHook(`${where}: config is a preset-only field`, { id: hook.id });
    }
  }
}

/**
 * Validate a per-unit postPublish declaration.
 *
 * @param {object} postPublish - The declaration (already schema-checked by
 *   the caller's config layer; this function is the runtime re-check).
 * @param {object} [options]
 * @param {string} [options.unitId] - Unit id for error context.
 * @param {string[]} [options.knownPresets] - Preset names accepted as known.
 *   Defaults to the built-in R2 preset registry (core/presets.mjs); an
 *   explicit empty list restores the R1 fail-closed stance where every
 *   preset reference is rejected.
 * @returns {object} The validated declaration (unmodified).
 * @throws {ReleaseError} GATE_FAILED on declaration violations;
 *   POSTPUBLISH_HOOK_INVALID on hooks[] violations (fail-closed).
 */
export function validatePostPublishDeclaration(postPublish, options = {}) {
  const unitLabel = options.unitId ? `unit "${options.unitId}" ` : '';
  if (!postPublish || typeof postPublish !== 'object' || Array.isArray(postPublish)) {
    fail(`${unitLabel}postPublish must be a non-null object`);
  }

  // materialize is optional since F-06/T6: a declaration without a consumer
  // materialize hook stages the payload through the frozen publicFiles
  // managed projection (Foundation Engineering Kit). When present, the hook
  // fields stay fail-closed exactly as before.
  if (postPublish.materialize !== undefined) {
    validateHookCommand(`${unitLabel}materialize`, postPublish.materialize);
    if (typeof postPublish.materialize.outputMarker !== 'string'
      || postPublish.materialize.outputMarker.length === 0) {
      fail(`${unitLabel}materialize.outputMarker must be a non-empty string`);
    }
    assertNoControlChars(`${unitLabel}materialize.outputMarker`, postPublish.materialize.outputMarker);
    if (postPublish.materialize.requireReport !== undefined) {
      const { parse, equals } = postPublish.materialize.requireReport ?? {};
      if (parse !== 'stdout-first-json') {
        fail(`${unitLabel}materialize.requireReport.parse must be "stdout-first-json"`);
      }
      if (equals !== undefined && (typeof equals !== 'object' || Array.isArray(equals) || equals === null)) {
        fail(`${unitLabel}materialize.requireReport.equals must be a plain object`);
      }
    }
  }

  // targets: optional since v0.6.3 R1 (hooks-only declarations are legal).
  // An explicitly empty array still fails closed (semantic lock: a present
  // targets array must declare at least one target).
  const targets = postPublish.targets ?? [];
  if (postPublish.targets !== undefined
    && (!Array.isArray(postPublish.targets) || postPublish.targets.length === 0)) {
    fail(`${unitLabel}targets must be a non-empty array when present; omit it entirely for a hooks-only declaration`);
  }
  const ids = new Set();
  targets.forEach((target, index) => {
    validateTarget(target, index);
    if (ids.has(target.id)) {
      fail(`${unitLabel}duplicate target id "${target.id}"`);
    }
    ids.add(target.id);
  });

  // dependsOn references must exist and point at payload-mirror targets.
  const byId = new Map(targets.map((target) => [target.id, target]));
  for (const target of targets) {
    if (target.dependsOn === undefined) continue;
    const dependency = byId.get(target.dependsOn);
    if (!dependency) {
      fail(`${unitLabel}target "${target.id}" dependsOn unknown target "${target.dependsOn}"`);
    }
    if (dependency.kind !== 'payload-mirror') {
      fail(`${unitLabel}target "${target.id}" dependsOn "${target.dependsOn}" which is not a payload-mirror target`);
    }
  }

  // hooks (v0.6.3 R1): per-entry fail-closed validation + unique ids across
  // the normalized target/hook table.
  if (postPublish.hooks !== undefined) {
    if (!Array.isArray(postPublish.hooks)) {
      failHook(`${unitLabel}hooks must be an array`);
    }
    postPublish.hooks.forEach((hook, index) => {
      validatePostPublishHookEntry(hook, index, options);
    });
    const hookIds = new Set();
    for (const hook of postPublish.hooks) {
      if (hookIds.has(hook.id)) {
        failHook(`${unitLabel}duplicate hook id "${hook.id}"`);
      }
      hookIds.add(hook.id);
      if (ids.has(hook.id)) {
        failHook(`${unitLabel}hook id "${hook.id}" conflicts with target id "${hook.id}"; normalized table ids must be unique`);
      }
    }
  }

  // commitIdentity is mandatory whenever targets exist (always, here).
  const identity = postPublish.commitIdentity;
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    fail(`${unitLabel}commitIdentity is required when targets are declared`);
  }
  for (const field of ['name', 'email']) {
    if (typeof identity[field] !== 'string' || identity[field].length === 0) {
      fail(`${unitLabel}commitIdentity.${field} must be a non-empty string`);
    }
    assertNoControlChars(`${unitLabel}commitIdentity.${field}`, identity[field]);
    if (identity[field].startsWith('-')) {
      fail(`${unitLabel}commitIdentity.${field} must not start with "-"`, { value: identity[field] });
    }
  }

  if (postPublish.steps !== undefined) {
    if (!Array.isArray(postPublish.steps)) {
      fail(`${unitLabel}steps must be an array`);
    }
    const stepNames = new Set();
    postPublish.steps.forEach((step, index) => {
      const where = `${unitLabel}steps[${index}]`;
      validateHookCommand(where, step);
      if (typeof step.name !== 'string' || !SAFE_ID_RE.test(step.name)) {
        fail(`${where}.name must match /^[a-z0-9][a-z0-9._-]*$/`, { name: step?.name });
      }
      if (stepNames.has(step.name)) {
        fail(`${unitLabel}duplicate step name "${step.name}"`);
      }
      stepNames.add(step.name);
    });
  }

  if (postPublish.assertMainVersionAhead !== undefined
    && typeof postPublish.assertMainVersionAhead !== 'boolean') {
    fail(`${unitLabel}assertMainVersionAhead must be a boolean`);
  }

  const localHostUpdate = postPublish.localHostUpdate;
  if (localHostUpdate !== undefined) {
    if (!localHostUpdate || typeof localHostUpdate !== 'object' || Array.isArray(localHostUpdate)) {
      fail(`${unitLabel}localHostUpdate must be a non-null object`);
    }
    if (typeof localHostUpdate.plugin !== 'string' || localHostUpdate.plugin.trim().length === 0) {
      fail(`${unitLabel}localHostUpdate.plugin must be a non-empty string`);
    }
    if (!Array.isArray(localHostUpdate.hosts) || localHostUpdate.hosts.length === 0) {
      fail(`${unitLabel}localHostUpdate.hosts must be a non-empty array`);
    }
    const hosts = new Set();
    for (const host of localHostUpdate.hosts) {
      if (typeof host !== 'string' || !LOCAL_HOSTS.has(host)) {
        fail(`${unitLabel}localHostUpdate.hosts contains unsupported host ${JSON.stringify(host)}`);
      }
      if (hosts.has(host)) fail(`${unitLabel}localHostUpdate.hosts contains duplicate host "${host}"`);
      hosts.add(host);
    }
    const hub = localHostUpdate.hub;
    if (!hub || typeof hub !== 'object' || Array.isArray(hub)) {
      fail(`${unitLabel}localHostUpdate.hub must be a non-null object`);
    }
    for (const field of ['name', 'repo', 'ref']) {
      if (typeof hub[field] !== 'string' || hub[field].trim().length === 0) {
        fail(`${unitLabel}localHostUpdate.hub.${field} must be a non-empty string`);
      }
    }
    if (hub.githubHost !== undefined && (typeof hub.githubHost !== 'string' || !HUB_HOST_RE.test(hub.githubHost))) {
      fail(`${unitLabel}localHostUpdate.hub.githubHost must be a non-empty string when provided`);
    }
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u.test(hub.repo)) {
      fail(`${unitLabel}localHostUpdate.hub.repo must be owner/repo`);
    }
    if (!HUB_REF_RE.test(hub.ref)) {
      fail(`${unitLabel}localHostUpdate.hub.ref must be a refs/heads/... reference`);
    }
    if (!(postPublish.hooks ?? []).some((hook) => hook.phase === 'postVerify')) {
      fail(`${unitLabel}localHostUpdate requires at least one postVerify hook`);
    }
    if (typeof options.expectedPlugin === 'string' && localHostUpdate.plugin !== options.expectedPlugin) {
      fail(`${unitLabel}localHostUpdate.plugin must match the frozen public plugin manifest`, {
        expectedPlugin: options.expectedPlugin,
        plugin: localHostUpdate.plugin,
      });
    }
  }

  return postPublish;
}

/**
 * Version-aware read-only normalization of the frozen plan's postPublish
 * field (multi-release-unit postPublish v3, design §4.2 归一表).
 *
 * This is the SINGLE normalization seam every reader (approve, distribute,
 * postVerify, ship, verify, recovery, publish, reconcile, approval) must use
 * to obtain the declaration array view. The accepted shape is derived from
 * `plan.planVersion` ONLY — readers must never guess the shape from the
 * field value (no shape sniffing), and no second normalizer or compatibility
 * schema may exist. Pure and strictly read-only: never mutates the plan and
 * never rewrites legacy plans, summaries, or evidence.
 *
 * | planVersion | input shape   | result           |
 * |-------------|---------------|------------------|
 * | 1/2         | absent        | []               |
 * | 1/2         | single object | [declaration]    |
 * | 1/2         | array         | rejected         |
 * | 3           | array         | the array itself |
 * | 3           | object/absent | rejected         |
 *
 * Values outside the table (null, primitives, unknown planVersion) fail
 * closed with GATE_FAILED: a schema-valid plan can never produce them, and a
 * reader must never paper over a shape it does not understand.
 *
 * @param {object} plan - Frozen plan (schema-valid by the caller's contract).
 * @returns {object[]} The declaration array view (empty for legacy absent).
 * @throws {ReleaseError} GATE_FAILED on any shape/version mismatch.
 */
export function normalizePostPublishView(plan) {
  const version = plan?.planVersion;
  const postPublish = plan?.postPublish;
  if (version === 1 || version === 2) {
    if (postPublish === undefined) return [];
    if (Array.isArray(postPublish)) {
      throw new ReleaseError(
        GATE_FAILED,
        `planVersion ${version} plans must not carry a postPublish array; only planVersion 3 accepts the array shape`,
        { planVersion: version, postPublishKind: 'array' },
      );
    }
    if (postPublish === null || typeof postPublish !== 'object') {
      throw new ReleaseError(
        GATE_FAILED,
        `planVersion ${version} plans must carry a single postPublish object or none; found ${postPublish === null ? 'null' : typeof postPublish}`,
        { planVersion: version },
      );
    }
    return [postPublish];
  }
  if (version === 3) {
    if (!Array.isArray(postPublish)) {
      throw new ReleaseError(
        GATE_FAILED,
        `planVersion 3 plans must carry a postPublish array (possibly empty); found ${postPublish === undefined ? 'no postPublish field' : postPublish === null ? 'null' : 'a single object'}`,
        { planVersion: 3, postPublishKind: postPublish === undefined ? 'absent' : postPublish === null ? 'null' : 'object' },
      );
    }
    return postPublish;
  }
  throw new ReleaseError(
    GATE_FAILED,
    `cannot normalize postPublish shape: unknown planVersion ${String(version)}`,
    { planVersion: version },
  );
}

/**
 * Decide whether a frozen plan has work for the distribute phase.
 *
 * A declaration requires distribute when it contains at least one legacy
 * target, an explicit phase:distribute hook, or a hook whose omitted phase
 * keeps the existing distribute default. phase:postVerify hooks belong only
 * to the independent postVerify run and must not allocate an empty
 * distribute predecessor.
 *
 * This is the single release-domain authority used by ship, verify, and
 * recovery. Shape compatibility remains owned by normalizePostPublishView.
 *
 * @param {object} plan - Frozen release plan.
 * @returns {boolean} Whether distribute must precede verify.
 */
export function requiresPostPublishDistribution(plan) {
  return normalizePostPublishView(plan).some((declaration) => (
    (declaration.targets?.length ?? 0) > 0
    || (declaration.hooks ?? []).some((hook) => (
      hook.phase === undefined || hook.phase === 'distribute'
    ))
  ));
}

/**
 * Array-level domain validation: every EXPLICIT hooks[].id must be unique
 * across the whole declaration array (multi-release-unit postPublish v3,
 * design §9.2 rule 3; rework R-02). The (planDigest, hookId) approval
 * contract binds each explicit hook id plan-wide, so a duplicate across
 * units must fail before any approval is minted or consumed and before any
 * side effect — JSON Schema cannot express cross-array business uniqueness,
 * so this function is the SINGLE runtime authority for it.
 *
 * Every entry only normalizes its input to the declaration array view and
 * calls this function: prepare, setup/adoption assessment, approve, the
 * postpublish approval validator, distribute, and postVerify. Target and
 * internal probe local ids may repeat across units (checkpoints are
 * unit-namespaced); explicit hook ids may not.
 *
 * @param {object[]} declarations - The declaration array view
 *   (`normalizePostPublishView()` output, or the per-unit postPublish blocks
 *   collected by prepare/setup).
 * @throws {ReleaseError} GATE_FAILED with details { hookId, unitIds } on the
 *   first cross-unit duplicate.
 */
export function validatePostPublishHookIdUniqueness(declarations) {
  const explicitHookIdOwner = new Map();
  for (const declaration of declarations ?? []) {
    for (const hook of declaration?.hooks ?? []) {
      const owner = explicitHookIdOwner.get(hook.id);
      if (owner !== undefined && owner !== declaration.unitId) {
        throw new ReleaseError(
          GATE_FAILED,
          `postPublish hook id "${hook.id}" is declared by units "${owner}" and "${declaration.unitId}"; explicit hooks[].id must be unique across the whole project (target and probe local ids may repeat across units)`,
          { hookId: hook.id, unitIds: [owner, declaration.unitId] },
        );
      }
      explicitHookIdOwner.set(hook.id, declaration.unitId);
    }
  }
}

/**
 * Deterministically derive the checkpoint action id for one postPublish
 * local action (target probe/mirror or hook) inside one release unit
 * (§4.3 checkpoint binding). planVersion 3 namespaces every action id under
 * the owning declaration's unitId (`unitId/localId`); legacy plans keep the
 * bare local id so pre-existing checkpoint records and approvals stay valid.
 * This is the SINGLE derivation used by every consumer (distribute,
 * postVerify, recovery, verify), so a checkpoint id can never drift between
 * the run records, the recovery mapping, and the approval binding.
 *
 * @param {object} params
 * @param {number} params.planVersion - Frozen plan's planVersion.
 * @param {string} params.unitId - Owning declaration's unitId.
 * @param {string} params.localId - Local action id (`probe-<target.id>`,
 *   `<target.id>`, or the hook id).
 * @returns {string} The checkpoint action id.
 */
export function postPublishActionId({ planVersion, unitId, localId }) {
  return planVersion === 3 ? `${unitId}/${localId}` : localId;
}

/**
 * Order targets so every target comes after its dependsOn target.
 *
 * Deterministic: among ready targets the declaration order is preserved.
 * Dependency cycles and dangling references fail closed (references are also
 * validated by validatePostPublishDeclaration; this guard makes ordering
 * independently safe).
 *
 * @param {object[]} targets - Validated postPublish targets.
 * @returns {object[]} Targets in execution order.
 * @throws {ReleaseError} GATE_FAILED on a cycle or unknown reference.
 */
export function orderTargetsByDependency(targets) {
  const byId = new Map(targets.map((target) => [target.id, target]));
  const ordered = [];
  const placed = new Set();
  while (ordered.length < targets.length) {
    let progress = false;
    for (const target of targets) {
      if (placed.has(target.id)) continue;
      if (target.dependsOn !== undefined) {
        if (!byId.has(target.dependsOn)) {
          fail(`target "${target.id}" dependsOn unknown target "${target.dependsOn}"`);
        }
        if (!placed.has(target.dependsOn)) continue;
      }
      ordered.push(target);
      placed.add(target.id);
      progress = true;
    }
    if (!progress) {
      const pending = targets.filter((t) => !placed.has(t.id)).map((t) => t.id);
      fail(`postPublish target dependency cycle detected among: ${pending.join(', ')}`);
    }
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// Hook normalization + context contract (v0.6.3 R1, design §2.3)
// ---------------------------------------------------------------------------

/**
 * Environment variable carrying the read-only postPublish hook context.
 * The JSON projection is injected into the hook process environment AFTER
 * envAllowlist filtering (core/hooks.mjs injectEnv), so declarations can
 * neither opt out of it nor smuggle it through their allowlist.
 */
export const POSTPUBLISH_CONTEXT_ENV = 'RELEASE_SKILL_POSTPUBLISH_CONTEXT';

/**
 * Normalize one declared postPublish hook entry: apply the governance
 * defaults (phase distribute, blocksVerified true, requiresApproval false)
 * and tag the entry kind. Pure function; the declaration is not mutated.
 * This normalized shape is the digest-bound display surface shown at
 * checkpoint approval time (review N-6).
 *
 * @param {object} hook - Declared hook entry (validate first for safety).
 * @returns {object} Normalized entry: { id, kind, phase, blocksVerified,
 *   requiresApproval, + kind-specific fields (command/cwd/timeoutMs/
 *   envAllowlist or preset/config) }.
 */
export function normalizePostPublishHook(hook) {
  const kind = hook.preset !== undefined ? 'preset' : 'command';
  // requiresApproval grading (§2.6): command hooks default false; preset
  // hooks inherit the preset-declared default (public-write presets true,
  // notify-handoff / proposal-inbox local-file false; validation forbids
  // relaxing below the default, so this resolution can only ever confirm or
  // tighten).
  const defaultRequiresApproval = kind === 'preset'
    ? resolvePresetRequiresApproval(hook.preset, hook.config)
    : false;
  const normalized = {
    id: hook.id,
    kind,
    ...(kind === 'preset' ? { preset: hook.preset } : { command: [...hook.command] }),
    phase: hook.phase ?? 'distribute',
    ...(hook.config !== undefined ? { config: hook.config } : {}),
    ...(kind === 'command' && hook.cwd !== undefined ? { cwd: hook.cwd } : {}),
    ...(hook.timeoutMs !== undefined ? { timeoutMs: hook.timeoutMs } : {}),
    ...(hook.envAllowlist !== undefined ? { envAllowlist: [...hook.envAllowlist] } : {}),
    requiresApproval: hook.requiresApproval ?? defaultRequiresApproval,
    blocksVerified: hook.blocksVerified ?? true,
  };
  return normalized;
}

/**
 * Effective requiresApproval (§2.6 grading) for one declared hook: command
 * hooks carry their declared value; preset hooks inherit the preset-declared
 * default (public-write presets true; proposal-inbox graded by transport;
 * notify-handoff / local-file false) unless explicitly tightened. Single
 * authority shared by distribute, postverify, and the ship re-entry gate.
 *
 * @param {object} hook - Declared hook entry.
 * @returns {boolean}
 */
export function effectiveHookRequiresApproval(hook) {
  if (hook.requiresApproval !== undefined) return hook.requiresApproval === true;
  if (hook.preset !== undefined) return resolvePresetRequiresApproval(hook.preset, hook.config) === true;
  return false;
}

/**
 * Build the read-only context projection injected into postPublish hooks
 * (design §2.3). Every field comes from the frozen plan or the sealed source
 * run — never from the live workspace.
 *
 * Phase distinction: `verifyEvidence` is carried ONLY for postVerify-phase
 * hooks; for the distribute phase the key is ABSENT (not null), so hooks can
 * distinguish the phases without trusting a mutable value.
 *
 * @param {object} args
 * @param {object} args.plan - Frozen plan (digest + units + postPublish).
 * @param {object} args.postPublish - THE current declaration the caller is
 *   executing. REQUIRED (rework R-06): callers must pass the declaration
 *   explicitly — the unit identity is never derived from a global
 *   single-object read (contract §4.3). v1/v2 callers pass the single item
 *   obtained from normalizePostPublishView(); v3 callers pass their loop
 *   item. Omitting it fails closed with GATE_FAILED; a declaration ARRAY
 *   (or anything non-object) fails closed too.
 * @param {string} args.runId - Current distribute run id.
 * @param {object} args.sourceRun - Sealed source run (finishedAt = publishedAt).
 * @param {string} args.payloadDir - Materialized payload directory.
 * @param {'distribute'|'postVerify'} args.phase
 * @param {object} [args.verifyEvidence] - Verify evidence (postVerify phase).
 * @returns {object} The context projection.
 * @throws {ReleaseError} GATE_FAILED when no single declaration is in scope.
 */
export function buildPostPublishContext({ plan, postPublish, runId, sourceRun, payloadDir, phase, verifyEvidence }) {
  const declaration = postPublish;
  if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) {
    throw new ReleaseError(
      GATE_FAILED,
      `buildPostPublishContext requires the current postPublish declaration; found ${declaration === undefined ? 'no declaration' : Array.isArray(declaration) ? 'a declaration array' : typeof declaration}`,
      { planVersion: plan?.planVersion, unitId: declaration?.unitId ?? null },
    );
  }
  const unit = (plan.units ?? []).find((entry) => entry.id === declaration.unitId);
  const frozenSnapshot = unit?.frozenSnapshot ?? {};
  return {
    planDigest: plan.digest,
    runId,
    unitId: declaration.unitId,
    version: unit?.targetVersion,
    tag: declaration.tag,
    commit: declaration.tagCommit,
    ...(frozenSnapshot.tree !== undefined ? { tree: frozenSnapshot.tree } : {}),
    ...(frozenSnapshot.manifestDigest !== undefined ? { manifestDigest: frozenSnapshot.manifestDigest } : {}),
    publishedAt: sourceRun?.finishedAt,
    payloadDir,
    ...(phase === 'postVerify' && verifyEvidence !== undefined ? { verifyEvidence } : {}),
  };
}

// ---------------------------------------------------------------------------
// Targets normalization (v0.6.3 R2, design §2.2)
// ---------------------------------------------------------------------------

/** Legacy target kind -> absorbing preset (design §2.5). */
const TARGET_KIND_PRESET = {
  'payload-mirror': 'git-mirror',
  'marketplace-index': 'marketplace-index-render',
};

/**
 * Normalize one legacy targets[] entry into a preset hook entry. Field-level
 * mapping (review N-B2): remoteUrl/branch -> config.target; visibility ->
 * config.visibility (public-write/internal-write semantics preserved);
 * staticFiles -> config.staticFiles; marketplace -> config.marketplace;
 * dependsOn -> hook-level dependency (runtime validates existence + acyclicity,
 * semantics unchanged).
 *
 * @param {object} target - Validated postPublish target entry.
 * @returns {object} Normalized preset hook entry.
 */
function normalizeTargetToPresetHook(target) {
  const preset = TARGET_KIND_PRESET[target.kind];
  return {
    id: target.id,
    kind: 'preset',
    preset,
    origin: 'target',
    originKind: target.kind,
    phase: 'distribute',
    config: {
      target: { remoteUrl: target.remoteUrl, branch: target.branch },
      visibility: target.visibility,
      ...(target.staticFiles !== undefined
        ? { staticFiles: target.staticFiles.map((file) => ({ from: file.from, to: file.to })) }
        : {}),
      ...(target.marketplace !== undefined
        ? { marketplace: structuredClone(target.marketplace) }
        : {}),
    },
    ...(target.dependsOn !== undefined ? { dependsOn: target.dependsOn } : {}),
    requiresApproval: resolvePresetRequiresApproval(preset, {}),
    blocksVerified: true,
  };
}

/**
 * Normalize a validated postPublish declaration into the unified hook table
 * (design §2.2). Pure and deterministic: the table is a projection of the
 * digest-bound declaration, so any targets/hooks list change changes the plan
 * digest and invalidates existing approvals.
 *
 * Shape:
 * - `preGates`: section-level gates injected ahead of all git-write hooks —
 *   assertMainVersionAhead:true becomes `assert-main-version-ahead` (current
 *   distribute semantics preserved);
 * - `defaults`: section-level defaults injected into the relevant presets —
 *   materialize / steps / commitIdentity;
 * - `hooks`: target-derived preset hooks first (declaration order), then the
 *   declared hooks[] entries normalized via normalizePostPublishHook.
 *
 * Validate the declaration BEFORE calling this (id conflicts, dependency
 * references, and preset semantics are fail-closed there, not here).
 *
 * @param {object} postPublish - Validated postPublish declaration.
 * @returns {{ preGates: object[], defaults: object, hooks: object[] }}
 */
export function normalizePostPublishDeclaration(postPublish) {
  const preGates = postPublish.assertMainVersionAhead === true
    ? [{ gate: 'assert-main-version-ahead', before: 'git-write-hooks' }]
    : [];
  const defaults = {
    materialize: structuredClone(postPublish.materialize),
    steps: structuredClone(postPublish.steps ?? []),
    commitIdentity: structuredClone(postPublish.commitIdentity),
  };
  const targetHooks = (postPublish.targets ?? []).map((target) => normalizeTargetToPresetHook(target));
  const declaredHooks = (postPublish.hooks ?? []).map((hook) => normalizePostPublishHook(hook));
  return { preGates, defaults, hooks: [...targetHooks, ...declaredHooks] };
}

/**
 * Order the normalized hook table so every hook runs after its dependsOn
 * hook, preserving declaration order among ready entries (dependency
 * topology + declaration order). Dangling references and cycles fail closed
 * with GATE_FAILED — references are also validated at declaration time; this
 * guard keeps ordering independently safe.
 *
 * @param {object[]} hooks - Normalized hook table.
 * @returns {object[]} Hooks in execution order.
 */
export function orderNormalizedHooks(hooks) {
  const byId = new Map(hooks.map((hook) => [hook.id, hook]));
  const ordered = [];
  const placed = new Set();
  while (ordered.length < hooks.length) {
    let progress = false;
    for (const hook of hooks) {
      if (placed.has(hook.id)) continue;
      if (hook.dependsOn !== undefined) {
        if (!byId.has(hook.dependsOn)) {
          fail(`hook "${hook.id}" dependsOn unknown hook "${hook.dependsOn}"`);
        }
        if (!placed.has(hook.dependsOn)) continue;
      }
      ordered.push(hook);
      placed.add(hook.id);
      progress = true;
    }
    if (!progress) {
      const pending = hooks.filter((hook) => !placed.has(hook.id)).map((hook) => hook.id);
      fail(`postPublish hook dependency cycle detected among: ${pending.join(', ')}`);
    }
  }
  return ordered;
}
