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

import { ReleaseError, GATE_FAILED } from './errors.mjs';

/** Secret-ish environment variable denylist (R3 credential hygiene). */
export const ENV_ALLOWLIST_DENYLIST = /TOKEN|SECRET|PASSWORD|PASSPHRASE|API_KEY|CREDENTIAL/i;

/** Shape every envAllowlist key must satisfy (before the denylist check). */
const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/** Safe target/step id and step name pattern. */
const SAFE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** Remote URL pattern: http(s) or file (test transport) and .git-suffixed. */
const REMOTE_URL_RE = /^(?:https?|file):\/\/.+\.git$/;

/** Branch pattern (leading alphanumeric blocks option-like names). */
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

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
  if (typeof target.remoteUrl !== 'string' || !REMOTE_URL_RE.test(target.remoteUrl)) {
    fail(`${where}.remoteUrl must be an http(s)/file URL ending in .git`, { remoteUrl: target.remoteUrl });
  }
  assertNoControlChars(`${where}.remoteUrl`, target.remoteUrl);
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

/**
 * Validate a per-unit postPublish declaration.
 *
 * @param {object} postPublish - The declaration (already schema-checked by
 *   the caller's config layer; this function is the runtime re-check).
 * @param {object} [options]
 * @param {string} [options.unitId] - Unit id for error context.
 * @returns {object} The validated declaration (unmodified).
 * @throws {ReleaseError} GATE_FAILED on any violation (fail-closed).
 */
export function validatePostPublishDeclaration(postPublish, options = {}) {
  const unitLabel = options.unitId ? `unit "${options.unitId}" ` : '';
  if (!postPublish || typeof postPublish !== 'object' || Array.isArray(postPublish)) {
    fail(`${unitLabel}postPublish must be a non-null object`);
  }

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

  if (!Array.isArray(postPublish.targets) || postPublish.targets.length === 0) {
    fail(`${unitLabel}targets must be a non-empty array`);
  }
  const ids = new Set();
  postPublish.targets.forEach((target, index) => {
    validateTarget(target, index);
    if (ids.has(target.id)) {
      fail(`${unitLabel}duplicate target id "${target.id}"`);
    }
    ids.add(target.id);
  });

  // dependsOn references must exist and point at payload-mirror targets.
  const byId = new Map(postPublish.targets.map((target) => [target.id, target]));
  for (const target of postPublish.targets) {
    if (target.dependsOn === undefined) continue;
    const dependency = byId.get(target.dependsOn);
    if (!dependency) {
      fail(`${unitLabel}target "${target.id}" dependsOn unknown target "${target.dependsOn}"`);
    }
    if (dependency.kind !== 'payload-mirror') {
      fail(`${unitLabel}target "${target.id}" dependsOn "${target.dependsOn}" which is not a payload-mirror target`);
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

  return postPublish;
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
