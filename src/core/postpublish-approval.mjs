/**
 * Checkpoint-level approval for requiresApproval postPublish hooks
 * (v0.6.3 R1, design §2.7 ruling 2).
 *
 * A `requiresApproval: true` hook needs its own approval record binding
 * (planDigest, hookId). The plan-level approval-record schema is NOT
 * extended (its top level is additionalProperties: false); this module owns
 * the separate postpublish-approval-record schema and its validation.
 *
 * Time semantics (24h max window, 5-minute clock-skew tolerance, expiry) are
 * delegated wholesale to core/approval.mjs `validateApprovalTimeWindow` so
 * both approval kinds can never drift apart. Hook config changes change the
 * plan digest, so approvals invalidate naturally with the plan; `runId` is
 * audit-only and never participates in binding.
 *
 * F-02 (architecture gap remediation T2): consumption is bound to the
 * immutable authority minted by commands/approve.mjs
 * `approvePostPublishHook`:
 *
 *     <plan owning .release-skill>/approvals/postpublish/<planDigest>/<approvalDigest>.json
 *
 * `assertPostPublishApprovalAuthority` recomputes planDigest from the
 * current plan and approvalDigest from the consumed raw bytes, requires the
 * consumption path to EQUAL that authority path byte-for-byte (identical
 * content anywhere else is not an approval), and strictly re-reads the file
 * through Foundation `readFileStrict` (existence, containment against every
 * root-escape class, no-follow regular-file identity, digest receipt bound
 * to the recomputed approvalDigest). Symbolic-link semantics are fully
 * delegated to Foundation: anything escaping the root is rejected, a leaf
 * symbolic link is never an authority, and a root-internal ancestor alias
 * is not an independent security failure (2026-08-21 handoff ruling C). The
 * check is strictly read-only: it never creates a directory. After the
 * authority passes, the existing schema/hook/grading/time-window validation
 * continues unchanged.
 *
 * @module core/postpublish-approval
 */

import { basename, dirname, relative, resolve, sep } from 'node:path';

import Ajv from 'ajv';
import addFormats from 'ajv-formats';

import { readFileStrict } from 'skill-family-harness-node';

import { ReleaseError, GATE_FAILED } from './errors.mjs';
import { computePlanDigest } from './plan.mjs';
import { computeApprovalDigest, validateApprovalTimeWindow } from './approval.mjs';
import { resolvePresetRequiresApproval } from './presets.mjs';
import { readTrustedPackageResource } from './trusted-resource.mjs';

const postpublishApprovalSchema = JSON.parse((await readTrustedPackageResource(
  'schemas/postpublish-approval-record.schema.json',
)).toString('utf8'));
const postpublishApprovalAjv = new Ajv({ allErrors: true, strict: false });
addFormats(postpublishApprovalAjv);
const validatePostPublishApprovalSchema = postpublishApprovalAjv.compile(postpublishApprovalSchema);

/**
 * Schema-validate a postpublish checkpoint approval record.
 *
 * @param {object} approval
 * @throws {ReleaseError} GATE_FAILED when the record violates the schema.
 */
export function validatePostPublishApprovalRecordSchema(approval) {
  if (validatePostPublishApprovalSchema(approval)) return;
  const errors = validatePostPublishApprovalSchema.errors ?? [];
  throw new ReleaseError(
    GATE_FAILED,
    `postpublish approval record schema validation failed: ${errors.map((error) => `${error.instancePath || '/'}: ${error.message}`).join('; ')}`,
    { validationErrors: errors },
  );
}

/**
 * Validate a checkpoint approval against the frozen plan.
 *
 * Bindings enforced (all fail-closed with GATE_FAILED):
 * - record shape (postpublish-approval-record schema; additionalProperties
 *   is false, so plan-level fields like approvedActions are rejected);
 * - planDigest equals the computed plan digest;
 * - hookId names a hook declared in the frozen plan's postPublish.hooks;
 * - that hook actually declares requiresApproval: true;
 * - the shared approval time window (24h max, 5-minute skew, unexpired).
 *
 * @param {object} plan - Frozen plan (schema-valid, digest verified by caller).
 * @param {object} approval - Parsed postpublish approval record.
 * @param {object} [options]
 * @param {() => string} [options.clock] - Clock function returning ISO-8601.
 * @param {boolean} [options.requireUnexpired] - Default true.
 * @returns {object} The approved hook declaration.
 * @throws {ReleaseError} GATE_FAILED on any violation.
 */
export function validatePostPublishApproval(plan, approval, options = {}) {
  validatePostPublishApprovalRecordSchema(approval);

  const actualDigest = computePlanDigest(plan);
  if (approval.planDigest !== actualDigest) {
    throw new ReleaseError(
      GATE_FAILED,
      `postpublish approval planDigest mismatch: approval says ${String(approval.planDigest).slice(0, 16)}..., plan is ${actualDigest.slice(0, 16)}...`,
      { approvalPlanDigest: approval.planDigest, planDigest: actualDigest },
    );
  }

  const hooks = plan.postPublish?.hooks ?? [];
  const hook = hooks.find((entry) => entry.id === approval.hookId);
  if (!hook) {
    throw new ReleaseError(
      GATE_FAILED,
      `postpublish approval names hook "${approval.hookId}" which is not declared in the frozen plan`,
      { hookId: approval.hookId, declaredHookIds: hooks.map((entry) => entry.id) },
    );
  }
  // Effective requiresApproval (§2.6 grading): preset hooks may inherit the
  // preset-declared default (proposal-inbox git-push -> true) without an
  // explicit declaration; command hooks carry their declared value.
  const effectiveRequiresApproval = hook.requiresApproval
    ?? (hook.preset !== undefined ? resolvePresetRequiresApproval(hook.preset, hook.config) : false);
  if (effectiveRequiresApproval !== true) {
    throw new ReleaseError(
      GATE_FAILED,
      `postpublish approval names hook "${approval.hookId}" which does not require approval (requiresApproval is not true)`,
      { hookId: approval.hookId, requiresApproval: effectiveRequiresApproval ?? false },
    );
  }

  validateApprovalTimeWindow(approval, {
    clock: options.clock,
    requireUnexpired: options.requireUnexpired,
  });

  return hook;
}

/**
 * Derive the immutable checkpoint-approval authority location for a plan.
 *
 * This is the SINGLE source of truth for the authority layout, shared by the
 * minter (commands/approve.mjs `approvePostPublishHook`) and the consumers
 * (`assertPostPublishApprovalAuthority` below): the record lives at
 *
 *     <releaseDir>/approvals/postpublish/<planDigest>/<approvalDigest>.json
 *
 * where `releaseDir` is the directory owning the frozen plan — the
 * `.release-skill` authority root when the plan uses the canonical
 * `plans/<planDigest>.json` naming, otherwise the plan's own directory
 * (non-production aliases), mirroring the minter exactly.
 *
 * @param {string} planPath - Absolute path of the frozen plan.
 * @param {string} planDigest - Plan digest recomputed from the current plan.
 * @param {string} approvalDigest - Digest recomputed from the approval bytes.
 * @returns {{releaseDir: string, authorityPath: string}}
 */
export function derivePostPublishApprovalAuthorityPath(planPath, planDigest, approvalDigest) {
  const absolutePlanPath = resolve(planPath);
  const planDir = dirname(absolutePlanPath);
  const releaseDir = basename(planDir) === 'plans' && basename(absolutePlanPath) === `${planDigest}.json`
    ? dirname(planDir)
    : planDir;
  return {
    releaseDir,
    authorityPath: resolve(releaseDir, 'approvals', 'postpublish', planDigest, `${approvalDigest}.json`),
  };
}

/**
 * Assert that a checkpoint approval is consumed from its immutable authority.
 *
 * Fail-closed checks, in order (all GATE_FAILED):
 * 1. `planDigest` is recomputed from the CURRENT plan;
 * 2. `approvalDigest` is recomputed from the consumed raw approval bytes;
 * 3. the consumption path must EQUAL the expected absolute authority path —
 *    the same bytes copied anywhere else are never an approval;
 * 4. Foundation `readFileStrict` re-reads the record through the authority
 *    root: containment rejects every escape class (lexical traversal, a
 *    final-component symlink pointing out, and any ancestor chain whose
 *    canonical target leaves the root), the record must be one ordinary
 *    file, never a symbolic link (no-follow, O_NOFOLLOW open, dev/ino
 *    identity re-stat), and its bytes must digest to the recomputed
 *    approvalDigest (binding the consumed bytes to the authoritative bytes).
 *    A root-internal ancestor alias is a path alias, not an escape, and is
 *    not an independent security failure (2026-08-21 handoff ruling C).
 *
 * The check is strictly read-only: it never creates a directory or file.
 * Callers continue with `validatePostPublishApproval` (schema, hook,
 * grading, time window) only after this assertion passes.
 *
 * @param {string} planPath - Absolute path of the frozen plan.
 * @param {string} approvalPath - Path the consumer read the approval from.
 * @param {object} plan - Parsed frozen plan (schema-valid).
 * @param {string|Buffer} approvalRaw - Raw approval bytes the consumer read.
 * @returns {Promise<{planDigest: string, approvalDigest: string, authorityPath: string}>}
 * @throws {ReleaseError} GATE_FAILED on any violation.
 */
export async function assertPostPublishApprovalAuthority(planPath, approvalPath, plan, approvalRaw) {
  if (!plan || typeof plan !== 'object') {
    throw new ReleaseError(GATE_FAILED, 'postpublish approval authority check requires the parsed plan');
  }
  if (typeof approvalPath !== 'string' || approvalPath.length === 0) {
    throw new ReleaseError(GATE_FAILED, 'postpublish approval authority check requires a consumption path');
  }

  const planDigest = computePlanDigest(plan);
  const approvalDigest = computeApprovalDigest(approvalRaw);
  const { releaseDir, authorityPath } = derivePostPublishApprovalAuthorityPath(
    planPath,
    planDigest,
    approvalDigest,
  );

  // Exact consumption-path equality: copying the bytes elsewhere never mints
  // an approval. The comparison is lexical on resolve()d paths (no realpath
  // normalization), so aliased spellings fail closed too.
  const consumedPath = resolve(approvalPath);
  if (consumedPath !== authorityPath) {
    throw new ReleaseError(
      GATE_FAILED,
      `postpublish checkpoint approval must be consumed from its immutable authority path; expected ${authorityPath}, got ${consumedPath}`,
      { planDigest, approvalDigest, expectedAuthorityPath: authorityPath, consumedPath },
    );
  }

  // Strict authority read through Foundation (FG-1 semantics, never local):
  // containment (every root-escape class), no-follow leaf, regular-file
  // identity, digest receipt. The expected digest binds the authoritative
  // bytes to the consumed bytes.
  const relPath = relative(releaseDir, authorityPath).split(sep).join('/');
  try {
    await readFileStrict(releaseDir, relPath, { expectedSha256: approvalDigest });
  } catch (cause) {
    if (cause instanceof ReleaseError) throw cause;
    throw new ReleaseError(
      GATE_FAILED,
      `postpublish checkpoint approval authority read failed: ${cause?.message ?? cause}`,
      { authorityPath, kind: cause?.details?.kind },
    );
  }

  return Object.freeze({ planDigest, approvalDigest, authorityPath });
}
