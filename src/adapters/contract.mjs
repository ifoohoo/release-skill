/**
 * Adapter unified interface contract for release-skill.
 *
 * Every platform adapter (git-github, npm, plugin-marketplace) must implement
 * the four lifecycle methods: preflight, execute, observe, verify.
 *
 * Adapters return structured observations and NEVER infer success from
 * command exit codes alone. A checkpoint is successful only when `observe`
 * matches the frozen expected commit/tag/version/digest in the release plan.
 *
 * All write methods MUST require `context.externalWritesAuthorized === true`.
 *
 * @module adapters/contract
 */

import { dirname, basename } from 'node:path';

import { writeFileAtomic } from 'skill-family-harness-node';

import { ReleaseError, AUTH_MISSING } from '../core/errors.mjs';

/**
 * Action status values in the action lifecycle.
 * @enum {string}
 */
export const ActionStatus = Object.freeze({
  PENDING: 'PENDING',
  PREFLIGHT_PASSED: 'PREFLIGHT_PASSED',
  PREFLIGHT_FAILED: 'PREFLIGHT_FAILED',
  EXECUTING: 'EXECUTING',
  EXECUTED: 'EXECUTED',
  EXECUTE_FAILED: 'EXECUTE_FAILED',
  NO_CHANGE: 'NO_CHANGE',
  OBSERVED: 'OBSERVED',
  OBSERVE_MISMATCH: 'OBSERVE_MISMATCH',
  VERIFIED: 'VERIFIED',
  VERIFY_FAILED: 'VERIFY_FAILED',
  SKIPPED: 'SKIPPED',
});

/**
 * Standard action types across all adapters.
 * @enum {string}
 */
export const ActionType = Object.freeze({
  // git-github adapter
  GIT_PUSH: 'git-push',
  GIT_TAG: 'git-tag',
  GITHUB_RELEASE: 'github-release',

  // npm adapter
  NPM_PACK: 'npm-pack',
  NPM_PUBLISH: 'npm-publish',

  // snapshot push
  PUSH_SNAPSHOT: 'push-snapshot',

  // plugin-marketplace adapter
  PLUGIN_MANIFEST_VALIDATE: 'plugin-manifest-validate',
  PLUGIN_INSTALL_CHECK: 'plugin-install-check',

  // consumer marketplace install (production)
  CLAUDE_MARKETPLACE_INSTALL: 'claude-marketplace-install',
  CODEX_MARKETPLACE_INSTALL: 'codex-marketplace-install',
  KIMI_MARKETPLACE_INSTALL: 'kimi-marketplace-install',
  CODEBUDDY_MARKETPLACE_INSTALL: 'codebuddy-marketplace-install',

  // default branch management
  SET_DEFAULT_BRANCH: 'set-default-branch',

  // post-publish distribution (distribute-git adapter)
  DISTRIBUTE_PROBE: 'distribute-probe',
  DISTRIBUTE_MIRROR: 'distribute-mirror',
});

/**
 * Create a structured adapter result object.
 *
 * @param {Object} params
 * @param {string} params.actionType - The ActionType of the action.
 * @param {string} params.status - One of ActionStatus values.
 * @param {Object} [params.observation] - Observed remote state (commit, tag, version, digest, etc.).
 * @param {string} [params.error] - Error message if status indicates failure.
 * @param {Object} [params.details] - Additional machine-readable details.
 * @returns {AdapterResult}
 */
export function createResult({ actionType, status, observation, error, details }) {
  return Object.freeze({
    actionType,
    status,
    observation: observation ?? null,
    error: error ?? null,
    details: details ?? null,
  });
}

/**
 * Check that external writes are authorized. Throws if not.
 *
 * @param {AdapterContext} context
 * @param {string} actionType - The action being guarded.
 * @throws {ReleaseError} AUTH_MISSING if not authorized.
 */
export function assertWritesAuthorized(context, actionType) {
  if (context.externalWritesAuthorized !== true) {
    throw new ReleaseError(
      AUTH_MISSING,
      `External write action '${actionType}' requires externalWritesAuthorized === true`,
      { actionType }
    );
  }
}

/**
 * Check that isolated consumer writes are authorized. Throws if not.
 * Used by marketplace install adapters which only write to isolated
 * consumer directories, not to remote services.
 *
 * @param {AdapterContext} context
 * @param {string} actionType - The action being guarded.
 * @throws {ReleaseError} AUTH_MISSING if not authorized.
 */
export function assertIsolatedConsumerWritesAuthorized(context, actionType) {
  if (context.isolatedConsumerWritesAuthorized !== true) {
    throw new ReleaseError(
      AUTH_MISSING,
      `Marketplace install action '${actionType}' requires isolatedConsumerWritesAuthorized === true`,
      { actionType }
    );
  }
}

/**
 * Validate that an observation matches the expected state from a frozen plan.
 *
 * The expected object comes from the release plan's externalActions[].expected.
 * An observation matches when every key present in expected has the same value
 * in observation. Extra keys in observation are allowed.
 *
 * @param {Object} expected - Expected state from the frozen plan.
 * @param {Object} observation - Observed state from the remote.
 * @returns {{ matches: boolean, mismatches: string[] }}
 */
export function matchObservation(expected, observation) {
  if (!expected || !observation) {
    return { matches: false, mismatches: ['missing expected or observation'] };
  }

  const mismatches = [];
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (observation[key] !== expectedValue) {
      mismatches.push(`${key}: expected ${JSON.stringify(expectedValue)}, got ${JSON.stringify(observation[key])}`);
    }
  }

  return { matches: mismatches.length === 0, mismatches };
}

/** Safe identifier pattern: lowercase alphanumeric, hyphens, dots, underscores. */
export const SAFE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Resolve and validate the frozen timeoutMs from the expanded adapter action.
 *
 * The publish/reconcile/verify call path expands plan actions as
 * `{ actionType, ...action.parameters }`, so `parameters.timeoutMs` in the
 * plan becomes `action.timeoutMs` at the adapter level. This function reads
 * from the top-level action, not from a nested `parameters` sub-object.
 *
 * Rules:
 * - Missing field (undefined): returns 300000 default (legacy compatibility).
 * - Present but null/invalid (null, string, NaN, Infinity, non-integer,
 *   out of range): fail-closed, throws.
 * - Valid integer in [30000, 900000]: returns the value as-is.
 *
 * @param {object} action - The expanded adapter action (top-level).
 * @returns {number} Validated timeout in milliseconds.
 * @throws {Error} If the value is present but invalid.
 */
export function resolveTimeoutMs(action) {
  const raw = action?.timeoutMs;
  if (raw === undefined) {
    return 300000;
  }
  if (raw === null || typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    throw new Error(
      `action.timeoutMs must be a finite integer, got: ${JSON.stringify(raw)}`,
    );
  }
  if (raw < 30000 || raw > 900000) {
    throw new Error(
      `action.timeoutMs must be between 30000 and 900000, got: ${raw}`,
    );
  }
  return raw;
}

/**
 * Atomically write a JSON evidence/requirement file (mode 0o600, exclusive
 * create, rename into place). Crash-safe: a partial write never replaces an
 * existing file.
 *
 * 机制已委托 Foundation writeFileAtomic（resolveContained 路径包含三层校验 +
 * 独占临时文件 + fsync + rename + 目录 fsync）；文件内容与 mode 保持本地语义。
 *
 * @param {string} filePath - Absolute path to write.
 * @param {object} value
 */
export async function writeEvidenceAtomic(filePath, value) {
  const root = dirname(filePath);
  const relPath = basename(filePath);
  await writeFileAtomic(root, relPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Adapter interface type documentation (not enforced at runtime, but all
 * adapters must follow this shape):
 *
 * @typedef {Object} AdapterResult
 * @property {string} actionType - The action type.
 * @property {string} status - ActionStatus value.
 * @property {Object|null} observation - Observed remote state.
 * @property {string|null} error - Error message if failed.
 * @property {Object|null} details - Additional context.
 *
 * @typedef {Object} AdapterContext
 * @property {boolean} externalWritesAuthorized - Must be true for remote write actions.
 * @property {boolean} [isolatedConsumerWritesAuthorized] - Must be true for marketplace install actions.
 * @property {Object} plan - The frozen release plan.
 * @property {Object} baseline - The captured git baseline.
 * @property {string} root - The project root directory.
 * @property {string} [runDir] - The evidence run directory.
 * @property {Object} [env] - Environment variables.
 *
 * @typedef {Object} Adapter
 * @property {string} name - Adapter display name.
 * @property {string[]} actionTypes - Supported ActionType values.
 * @property {(action: Object, context: AdapterContext) => Promise<AdapterResult>} preflight
 * @property {(action: Object, context: AdapterContext) => Promise<AdapterResult>} execute
 * @property {(action: Object, context: AdapterContext) => Promise<AdapterResult>} observe
 * @property {(action: Object, context: AdapterContext) => Promise<AdapterResult>} verify
 */

/**
 * Create an adapter registry that maps action types to adapter instances.
 *
 * @param {Adapter[]} adapters - Array of adapter instances.
 * @returns {{ getAdapter(actionType: string): Adapter, getAll(): Adapter[] }}
 */
export function createAdapterRegistry(adapters) {
  const actionMap = new Map();

  for (const adapter of adapters) {
    for (const actionType of adapter.actionTypes) {
      if (actionMap.has(actionType)) {
        throw new Error(
          `Duplicate action type '${actionType}' registered by both '${actionMap.get(actionType).name}' and '${adapter.name}'`
        );
      }
      actionMap.set(actionType, adapter);
    }
  }

  return Object.freeze({
    /**
     * Get the adapter responsible for a given action type.
     * @param {string} actionType
     * @returns {Adapter}
     * @throws {Error} if no adapter handles this action type.
     */
    getAdapter(actionType) {
      const adapter = actionMap.get(actionType);
      if (!adapter) {
        throw new Error(`No adapter registered for action type '${actionType}'`);
      }
      return adapter;
    },

    /** Get all registered adapters. */
    getAll() {
      return [...new Set(actionMap.values())];
    },
  });
}
